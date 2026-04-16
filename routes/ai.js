// routes/ai.js
// 담당: 4-A번 개발자 (AI 퍼실리테이션 엔지니어)
// 역할: GET /api/personality — 규칙 기반 성향 분석 텍스트 생성
// v2: Claude API → 규칙 기반 로직으로 교체 (2026-04-16)

const express = require('express');
const router = express.Router();
const pool = require('../db');

// ─────────────────────────────────────────
// [Claude API - 추후 활성화 가능]
// ─────────────────────────────────────────
/*
  [Claude API - 추후 활성화 가능]

  const Anthropic = require('@anthropic-ai/sdk');
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  async function callClaudeAPI(profile, votes) {
    if (!process.env.ANTHROPIC_API_KEY) return null;

    const currentYear = new Date().getFullYear();
    const age = profile.birth_year ? currentYear - profile.birth_year : '미상';

    let votesSummary = '';
    if (votes && Array.isArray(votes) && votes.length > 0) {
      votesSummary = votes
        .map((v, i) => `Q${i + 1}. ${v.question || '질문'} → ${v.answer || '응답 없음'}`)
        .join('\n');
    } else {
      votesSummary = '투표 데이터 없음';
    }

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: `다음은 소셜 모임 참가자의 프로필과 연애 밸런스 게임 투표 결과야.
[프로필]
- 닉네임: ${profile.nickname}
- 성별: ${profile.gender === 'M' ? '남성' : profile.gender === 'F' ? '여성' : '미상'}
- 나이: ${age}세
- MBTI: ${profile.mbti || '미입력'}
- 관심사: ${profile.interest || '미입력'}
[밸런스 게임 투표 결과]
${votesSummary}
위 정보를 바탕으로 이 사람의 연애/소통 성향을 200자 내외 한국어로 분석해줘.
- 따뜻하고 재미있는 톤으로
- 구체적인 성향 묘사 (이론적 설명 금지)
- 마지막에 짧은 한 줄 매력 포인트 추가
- JSON, 마크다운, 따옴표 없이 텍스트만 출력`
      }]
    });

    return response.content?.[0]?.text?.trim() || null;
  }
*/

// ─────────────────────────────────────────
// 유형 정의 (emoji, name, text)
// ─────────────────────────────────────────
const PERSONALITY_TYPES = {
  탐구형: {
    emoji: '🔍',
    text: '🔍 깊이 있는 탐구자예요. 대화에서 본질을 파고드는 편이고, 처음엔 조용해 보여도 주제가 맞으면 누구보다 열정적으로 이야기해요. 오늘 모임에서 가장 인상 깊은 질문을 던진 사람일 거예요.'
  },
  공감형: {
    emoji: '💛',
    text: '💛 따뜻한 공감자예요. 상대방의 감정을 잘 읽고, 대화가 깊어질수록 빛을 발해요. 오늘 모임에서 누군가의 이야기를 가장 진지하게 들어준 사람일 거예요.'
  },
  리더형: {
    emoji: '⚡',
    text: '⚡ 자연스러운 리더예요. 대화의 흐름을 만들고 분위기를 끌어가는 역할을 자처해요. 오늘 모임에서 첫 마디를 꺼낸 사람일 거예요.'
  },
  관찰형: {
    emoji: '🌿',
    text: '🌿 조용한 관찰자예요. 말보다 눈치가 빠르고, 한번 입을 열면 핵심을 찌르는 편이에요. 오늘 모임에서 가장 인상 깊은 한마디를 남긴 사람일 거예요.'
  },
  활력형: {
    emoji: '🎉',
    text: '🎉 모임의 활력소예요. 분위기를 밝게 만들고, 처음 만난 사람과도 금방 친해져요. 오늘 모임에서 웃음을 가장 많이 만들어낸 사람일 거예요.'
  },
  균형형: {
    emoji: '⚖️',
    text: '⚖️ 균형 잡힌 연결자예요. 어느 쪽에도 치우치지 않고 다양한 사람과 자연스럽게 어울려요. 오늘 모임에서 가장 많은 사람과 대화를 나눈 사람일 거예요.'
  },
  신중형: {
    emoji: '🎯',
    text: '🎯 신중한 선택자예요. 쉽게 마음을 열진 않지만 한번 연결되면 깊은 관계를 만들어요. 오늘 모임에서 가장 기억에 남는 눈빛을 가진 사람일 거예요.'
  },
  자유형: {
    emoji: '🌈',
    text: '🌈 자유로운 탐험가예요. 틀에 얽매이지 않고 매 순간을 즐기는 스타일이에요. 오늘 모임에서 가장 예상치 못한 이야기를 꺼낸 사람일 거예요.'
  }
};

// ─────────────────────────────────────────
// MBTI → 유형 매핑
// ─────────────────────────────────────────
const MBTI_MAP = {
  INTJ: '탐구형', INTP: '탐구형',
  INFJ: '공감형', INFP: '공감형', ENFJ: '공감형', ESFJ: '공감형',
  ENTJ: '리더형', ESTJ: '리더형',
  ISTJ: '관찰형', ISFJ: '관찰형',
  ENFP: '활력형', ESFP: '활력형',
  ENTP: '균형형', ESTP: '균형형',
  ISTP: '신중형', ISFP: '신중형'
};

// ─────────────────────────────────────────
// votes_json → A/B 비율 계산
// votes_json 확정 구조: { "1": "A", "2": "B", ... }
// ─────────────────────────────────────────
function calcVoteRatio(votes) {
  if (!votes || typeof votes !== 'object' || Array.isArray(votes)) {
    return { aRatio: 0, bRatio: 0, total: 0 };
  }
  const answers = Object.values(votes);
  const total = answers.length;
  if (total === 0) return { aRatio: 0, bRatio: 0, total: 0 };
  const aCount = answers.filter(a => a === 'A').length;
  const bCount = answers.filter(a => a === 'B').length;
  return {
    aRatio: aCount / total,
    bRatio: bCount / total,
    total
  };
}

// ─────────────────────────────────────────
// 유형 판단 로직
// 우선순위: MBTI 명시 → votes 비율 → 자유형
// ─────────────────────────────────────────
function determinePersonality(mbti, votes) {
  const { aRatio, bRatio, total } = calcVoteRatio(votes);
  const mbtiUpper = mbti ? mbti.toUpperCase().trim() : null;

  // 1) MBTI 기반 판단 (votes 없을 때도 작동)
  if (mbtiUpper && MBTI_MAP[mbtiUpper]) {
    return MBTI_MAP[mbtiUpper];
  }

  // 2) votes 없으면 자유형
  if (total === 0) return '자유형';

  // 3) votes 비율 기반 판단
  if (aRatio >= 0.7) return '탐구형';
  if (bRatio >= 0.7) return '공감형';
  if (aRatio >= 0.6) return '리더형';
  if (bRatio >= 0.6) return '활력형';

  // 응답 적음 (3개 미만) — 균형 분포 체크보다 먼저
  if (total < 3) return '신중형';

  // A/B 고른 분포 (45~55%)
  const isBalanced = aRatio >= 0.45 && aRatio <= 0.55;
  if (isBalanced) return total >= 5 ? '균형형' : '관찰형';

  return '자유형';
}

// ─────────────────────────────────────────
// GET /api/personality?uuid=&room_code=
// ─────────────────────────────────────────
router.get('/personality', async (req, res) => {
  const { uuid, room_code } = req.query;

  if (!uuid || !room_code) {
    return res.status(400).json({ error: 'uuid와 room_code가 필요합니다.' });
  }

  try {
    // 1) 유저 프로필 조회
    const userResult = await pool.query(
      'SELECT uuid, nickname, gender, birth_year, mbti, interest FROM users WHERE uuid = $1',
      [uuid]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: '유저를 찾을 수 없습니다.' });
    }

    const profile = userResult.rows[0];

    // 2) 투표 결과 조회
    const resultRow = await pool.query(
      'SELECT votes_json FROM member_results WHERE uuid = $1 AND room_code = $2 ORDER BY created_at DESC LIMIT 1',
      [uuid, room_code]
    );

    let votes = [];
    if (resultRow.rows.length > 0 && resultRow.rows[0].votes_json) {
      try {
        const raw = resultRow.rows[0].votes_json;
        votes = typeof raw === 'string' ? JSON.parse(raw) : raw;
      } catch (e) {
        console.warn('[ai.js] votes_json 파싱 실패:', e.message);
      }
    }

    // 3) 유형 결정
    const personalityKey = determinePersonality(profile.mbti, votes);
    const result = PERSONALITY_TYPES[personalityKey];

    return res.json({
      uuid: profile.uuid,
      nickname: profile.nickname,
      personality: personalityKey,
      text: result.text,
      emoji: result.emoji
    });

  } catch (err) {
    console.error('[ai.js] /api/personality 오류:', err.message);
    return res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

module.exports = router;
