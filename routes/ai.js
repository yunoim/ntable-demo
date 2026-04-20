// routes/ai.js
// 담당: 4-A번 개발자 (AI 퍼실리테이션 엔지니어)
// 역할: GET /api/personality — 규칙 기반 성향 분석 텍스트 생성
// v2: Claude API → 규칙 기반 로직으로 교체 (2026-04-16)

const express = require('express');
const router = express.Router();
const { pool } = require('../db');

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
    // 1) 유저 프로필 조회 (방별 nickname/emoji 우선 — room_members)
    const memberResult = await pool.query(
      `SELECT rm.uuid, rm.nickname, rm.emoji, rm.gender, rm.birth_year, rm.mbti, rm.interest
         FROM room_members rm
         JOIN rooms r ON r.id = rm.room_id
        WHERE rm.uuid = $1 AND r.room_code = $2`,
      [uuid, room_code]
    );
    let profile;
    if (memberResult.rows.length > 0) {
      profile = memberResult.rows[0];
    } else {
      const userResult = await pool.query(
        'SELECT uuid, nickname, emoji, gender, birth_year, mbti, interest FROM users WHERE uuid = $1',
        [uuid]
      );
      if (userResult.rows.length === 0) {
        return res.status(404).json({ error: '유저를 찾을 수 없습니다.' });
      }
      profile = userResult.rows[0];
    }

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
      emoji: result.emoji,
      my_emoji: profile.emoji || null, // 사용자가 wizard에서 선택한 본인 이모지
    });

  } catch (err) {
    console.error('[ai.js] /api/personality 오류:', err.message);
    return res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

// ─────────────────────────────────────────
// couple_love: MBTI 궁합 + 탐구 답변 기반 커플 연애 분석
// GET /api/rooms/:code/couple-love?uuid=&partner_uuid=
// 서버 검증: mutual pair 가 아니면 403.
// ─────────────────────────────────────────
function mbtiCompat(a, b) {
  if (!a || !b) return null;
  const A = String(a).toUpperCase().trim();
  const B = String(b).toUpperCase().trim();
  if (A.length !== 4 || B.length !== 4) return null;
  const axisNames = ['외향/내향(E/I)', '감각/직관(S/N)', '사고/감정(T/F)', '판단/인식(J/P)'];
  const detail = [];
  let same = 0;
  for (let i = 0; i < 4; i++) {
    const match = A[i] === B[i];
    if (match) same += 1;
    detail.push({ axis: axisNames[i], me: A[i], partner: B[i], match });
  }
  const labels = {
    4: { title: '거울 듀오', sub: '네 가지 축이 똑같은 쌍둥이형. 말 안 해도 통하는 대신, 둘 다 같은 맹점에 빠지기 쉬워요.' },
    3: { title: '닮은꼴 커플', sub: '성향이 대체로 같아 편안해요. 한 축만 달라서 서로를 살짝 보완해주는 균형.' },
    2: { title: '보완 콤비', sub: '닮은 점·다른 점이 반반. 배울 거리 많고 대화가 다채로워요.' },
    1: { title: '반대 매력', sub: '꽤 다른 조합. 서로 새로운 세계를 열어주는 자극적 관계.' },
    0: { title: '정반대 자석', sub: '완전 반대 성향. 오히려 끌리지만 소통엔 의식적 노력이 필요해요.' },
  };
  return { same_axes: same, label: labels[same].title, sub: labels[same].sub, axes: detail };
}

router.get('/rooms/:code/couple-love', async (req, res) => {
  const { code } = req.params;
  const { uuid, partner_uuid } = req.query;
  if (!uuid || !partner_uuid) return res.status(400).json({ error: 'uuid, partner_uuid required' });
  if (uuid === partner_uuid) return res.status(400).json({ error: 'same uuid' });

  try {
    const roomRes = await pool.query('SELECT id, questions_json, question_count FROM rooms WHERE room_code = $1', [code]);
    if (roomRes.rows.length === 0) return res.status(404).json({ error: 'room not found' });
    const room_id = roomRes.rows[0].id;

    // mutual pair 검증 (match_json.pairs 중 type=mutual)
    const myMr = await pool.query(
      'SELECT match_json, votes_json FROM member_results WHERE uuid = $1 AND room_id = $2',
      [uuid, room_id]
    );
    if (myMr.rows.length === 0) return res.status(404).json({ error: 'not a member' });
    const pairs = Array.isArray(myMr.rows[0].match_json?.pairs) ? myMr.rows[0].match_json.pairs : [];
    const isMutual = pairs.some(p => p && p.type === 'mutual'
      && ((p.a?.uuid === uuid && p.b?.uuid === partner_uuid)
        || (p.a?.uuid === partner_uuid && p.b?.uuid === uuid)));
    // couples 팩은 항상 2인이고 매칭 로직 없음 — match_json.pairs 가 비어있음.
    // 이 경우 pack_id 로 우회 검증 (couples 팩이면 two members 자동 통과).
    let allowed = isMutual;
    if (!allowed) {
      const pkRes = await pool.query('SELECT pack_id FROM rooms WHERE id = $1', [room_id]);
      const pack_id = pkRes.rows[0]?.pack_id;
      if (pack_id === 'couples') {
        const ct = await pool.query('SELECT COUNT(*) AS cnt FROM room_members WHERE room_id = $1 AND uuid = ANY($2)', [room_id, [uuid, partner_uuid]]);
        allowed = parseInt(ct.rows[0].cnt, 10) === 2;
      }
    }
    if (!allowed) return res.status(403).json({ error: 'not a mutual pair' });

    const myVotes = myMr.rows[0].votes_json || {};
    const pRes = await pool.query(
      'SELECT votes_json FROM member_results WHERE uuid = $1 AND room_id = $2',
      [partner_uuid, room_id]
    );
    const partnerVotes = (pRes.rows[0] && pRes.rows[0].votes_json) || {};

    const profRes = await pool.query(
      'SELECT uuid, nickname, gender, mbti, emoji FROM room_members WHERE room_id = $1 AND uuid = ANY($2)',
      [room_id, [uuid, partner_uuid]]
    );
    const me = profRes.rows.find(r => r.uuid === uuid) || {};
    const partner = profRes.rows.find(r => r.uuid === partner_uuid) || {};

    const allQs = Array.isArray(roomRes.rows[0].questions_json) ? roomRes.rows[0].questions_json : [];
    const enabled = allQs.filter(q => q && q.enabled !== false);
    const qcount = Number.isFinite(roomRes.rows[0].question_count) ? roomRes.rows[0].question_count : enabled.length;
    const used = enabled.slice(0, qcount);

    const details = [];
    let total = 0, matched = 0;
    for (const q of used) {
      const qid = String(q.id);
      const mine = myVotes[qid] || null;
      const theirs = partnerVotes[qid] || null;
      if (!mine || !theirs) continue;
      total += 1;
      const match = mine === theirs;
      if (match) matched += 1;
      const opts = q.options || [];
      details.push({
        question: q.question || '',
        my_answer: mine,
        partner_answer: theirs,
        my_text: String(opts[mine === 'A' ? 0 : 1] || '').replace(/^[AB]\.\s*/, ''),
        partner_text: String(opts[theirs === 'A' ? 0 : 1] || '').replace(/^[AB]\.\s*/, ''),
        match,
      });
    }
    const pct = total > 0 ? Math.round(matched / total * 100) : 0;

    // 하이라이트: 일치 1~2 · 불일치 1개 — 대화거리 제공
    const matches = details.filter(d => d.match);
    const mismatches = details.filter(d => !d.match);
    const highlights = [];
    if (matches[0]) highlights.push({ ...matches[0], verdict: 'match' });
    if (matches[1]) highlights.push({ ...matches[1], verdict: 'match' });
    if (mismatches[0]) highlights.push({ ...mismatches[0], verdict: 'mismatch' });

    const mbti = mbtiCompat(me.mbti, partner.mbti);

    // 분석 텍스트 (규칙 기반 — Claude API 는 옵션으로 나중에)
    const summary = [];
    if (mbti) summary.push(`MBTI: ${me.mbti} × ${partner.mbti} — ${mbti.label}. ${mbti.sub}`);
    else summary.push('MBTI 정보가 부족해서 성격 축 비교는 생략했어요.');
    if (total > 0) {
      summary.push(`탐구 ${total}문항 중 ${matched}개 같은 선택 (${pct}% 일치).`);
      if (pct >= 80) summary.push('가치관이 거의 같은 편 — 큰 갈등이 적은 안정형.');
      else if (pct >= 60) summary.push('통하는 부분이 많아 편안한 조합.');
      else if (pct >= 40) summary.push('다른 부분도 꽤 있어 서로 배울 거리가 많음.');
      else summary.push('다른 게 더 많아서 대화로 조율하는 맛이 큰 관계.');
    }

    res.json({
      me: { uuid: me.uuid, nickname: me.nickname || '나', gender: me.gender || null, mbti: me.mbti || null, emoji: me.emoji || null },
      partner: { uuid: partner.uuid, nickname: partner.nickname || '상대', gender: partner.gender || null, mbti: partner.mbti || null, emoji: partner.emoji || null },
      mbti_compat: mbti,
      total,
      matched,
      pct,
      highlights,
      summary: summary.join(' '),
    });
  } catch (err) {
    console.error('[ai.js] /couple-love error:', err);
    res.status(500).json({ error: 'server error' });
  }
});

module.exports = router;
