const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { getPackDefaults } = require('./question-sources');

const VALID_TAGS = [
  'conversation', 'host', 'matching', 'questions', 'space', 'people', 'pacing',
];

// POST /api/survey — 본설문 (호스트 평가·카테고리·본문 포함)
router.post('/survey', async (req, res) => {
  const {
    uuid, room_code,
    satisfaction, revisit, nps,
    best_moment, regret, review,
    host_rating, host_comment, liked_tags,
  } = req.body;
  if (!uuid || !room_code) return res.status(400).json({ error: 'uuid, room_code required' });

  try {
    const roomRes = await pool.query(
      'SELECT id, host_uuid FROM rooms WHERE room_code = $1',
      [room_code]
    );
    if (roomRes.rows.length === 0) return res.status(404).json({ error: 'room not found' });
    const { id: room_id, host_uuid } = roomRes.rows[0];

    // 참여 이력 검증 — 모임에 join 한 사람이면 OK (투표 안 했어도 후기 작성 가능)
    const part = await pool.query(
      'SELECT 1 FROM room_members WHERE uuid = $1 AND room_id = $2',
      [uuid, room_id]
    );
    if (part.rows.length === 0) {
      return res.status(403).json({ error: 'NOT_PARTICIPANT', message: '이 모임에 참여한 기록이 없어 후기를 남길 수 없어요' });
    }

    // 중복 제출 가드
    const dup = await pool.query(
      'SELECT 1 FROM survey_responses WHERE uuid = $1 AND room_id = $2',
      [uuid, room_id]
    );
    if (dup.rows.length > 0) {
      return res.status(409).json({ error: 'ALREADY_SUBMITTED', message: '이미 후기를 제출했어요' });
    }

    // 호스트 본인은 자기 자신 평가 제외 (저장하되 무시)
    const isHost = uuid === host_uuid;
    const finalHostRating = isHost ? null : (Number.isInteger(host_rating) ? host_rating : null);
    const finalHostComment = isHost ? null : (host_comment || null);

    // liked_tags 정규화 — 화이트리스트 필터
    const tagsArr = Array.isArray(liked_tags)
      ? liked_tags.filter(t => VALID_TAGS.includes(t)).slice(0, VALID_TAGS.length)
      : [];

    await pool.query(
      `INSERT INTO survey_responses
         (uuid, room_id, satisfaction, revisit, nps, best_moment, regret, review,
          host_rating, host_comment, liked_tags)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (uuid, room_id) DO NOTHING`,
      [
        uuid, room_id, satisfaction, revisit ? true : false, nps,
        best_moment || null, regret || null, review || null,
        finalHostRating, finalHostComment, JSON.stringify(tagsArr),
      ]
    );
    res.json({ success: true, is_host: isHost });
  } catch (err) {
    console.error('POST /api/survey error:', err);
    res.status(500).json({ error: 'db error' });
  }
});

// GET /api/survey/eligibility?room=&uuid= — 후기 제출 가능 상태 (재진입 플로우)
router.get('/survey/eligibility', async (req, res) => {
  const { room, uuid } = req.query;
  if (!room || !uuid) return res.status(400).json({ error: 'room, uuid required' });
  try {
    const roomRes = await pool.query(
      'SELECT id, host_uuid, title FROM rooms WHERE room_code = $1',
      [room]
    );
    if (roomRes.rows.length === 0) return res.json({ eligible: false, reason: 'ROOM_NOT_FOUND' });
    const { id: room_id, host_uuid, title } = roomRes.rows[0];

    // 모임 join 여부만 체크 — 투표 없이 들어왔다 나간 사람도 후기 가능
    const part = await pool.query(
      'SELECT 1 FROM room_members WHERE uuid = $1 AND room_id = $2',
      [uuid, room_id]
    );
    if (part.rows.length === 0) return res.json({ eligible: false, reason: 'NOT_PARTICIPANT' });

    const dup = await pool.query(
      'SELECT 1 FROM survey_responses WHERE uuid = $1 AND room_id = $2',
      [uuid, room_id]
    );
    if (dup.rows.length > 0) return res.json({ eligible: false, reason: 'ALREADY_SUBMITTED' });

    res.json({ eligible: true, is_host: uuid === host_uuid, room_title: title });
  } catch (err) {
    console.error('eligibility error:', err);
    res.status(500).json({ error: 'db error' });
  }
});

// GET /api/survey/participants?room=&uuid= — 본인 제외 참여자 리스트 (연결 투표용)
router.get('/survey/participants', async (req, res) => {
  const { room, uuid } = req.query;
  if (!room || !uuid) return res.status(400).json({ error: 'room, uuid required' });
  try {
    const roomRes = await pool.query('SELECT id FROM rooms WHERE room_code = $1', [room]);
    if (roomRes.rows.length === 0) return res.status(404).json({ error: 'room not found' });
    const room_id = roomRes.rows[0].id;

    // room_members 우선 (방별 닉네임·프로필), users 는 legacy fallback
    const rows = await pool.query(
      `SELECT mr.uuid,
              COALESCE(rm.nickname, u.nickname) AS nickname,
              COALESCE(rm.gender,   u.gender)   AS gender,
              COALESCE(rm.birth_year, u.birth_year) AS birth_year,
              COALESCE(rm.mbti,     u.mbti)     AS mbti,
              COALESCE(rm.emoji,    u.emoji)    AS emoji
         FROM member_results mr
         LEFT JOIN room_members rm ON rm.room_id = mr.room_id AND rm.uuid = mr.uuid
         LEFT JOIN users u ON u.uuid = mr.uuid
        WHERE mr.room_id = $1 AND mr.uuid != $2
        ORDER BY COALESCE(rm.nickname, u.nickname)`,
      [room_id, uuid]
    );
    res.json(rows.rows);
  } catch (err) {
    console.error('participants error:', err);
    res.status(500).json({ error: 'db error' });
  }
});

// POST /api/connections — 후기 단계 "또 만나고 싶은 사람" 투표
router.post('/connections', async (req, res) => {
  const { uuid, room_code, picks } = req.body;
  if (!uuid || !room_code || !Array.isArray(picks)) {
    return res.status(400).json({ error: 'uuid, room_code, picks[] required' });
  }
  try {
    const roomRes = await pool.query('SELECT id FROM rooms WHERE room_code = $1', [room_code]);
    if (roomRes.rows.length === 0) return res.status(404).json({ error: 'room not found' });
    const room_id = roomRes.rows[0].id;

    // 참여자 검증 — 모임에 join 한 사람이면 OK (투표 없어도 사랑의 작대기 가능)
    const part = await pool.query(
      'SELECT 1 FROM room_members WHERE uuid = $1 AND room_id = $2',
      [uuid, room_id]
    );
    if (part.rows.length === 0) return res.status(403).json({ error: 'NOT_PARTICIPANT' });

    // 기존 내 선택 삭제 후 재삽입 (덮어쓰기)
    await pool.query(
      'DELETE FROM room_connections WHERE room_id = $1 AND from_uuid = $2',
      [room_id, uuid]
    );

    const cleanPicks = picks.filter(p => p && p !== uuid); // 인원 제한 해제 (전원 선택 가능)
    for (const to_uuid of cleanPicks) {
      await pool.query(
        'INSERT INTO room_connections (room_id, from_uuid, to_uuid) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
        [room_id, uuid, to_uuid]
      );
    }

    // 쌍방 매칭 탐색 — room_members 우선, users 는 legacy fallback
    const mutuals = await pool.query(
      `SELECT c.from_uuid AS uuid,
              COALESCE(rm.nickname, u.nickname) AS nickname
         FROM room_connections c
         LEFT JOIN room_members rm ON rm.room_id = c.room_id AND rm.uuid = c.from_uuid
         LEFT JOIN users u ON u.uuid = c.from_uuid
        WHERE c.room_id = $1
          AND c.to_uuid = $2
          AND c.from_uuid = ANY($3::varchar[])`,
      [room_id, uuid, cleanPicks]
    );

    // 새로 성사된 상호 선택에 대해 WS broadcast — 이미 제출한 상대도 실시간으로 '서로 선택' 뱃지 갱신.
    if (mutuals.rows.length > 0) {
      const selfRes = await pool.query(
        `SELECT COALESCE(rm.nickname, u.nickname) AS nickname
           FROM room_members rm
           LEFT JOIN users u ON u.uuid = rm.uuid
          WHERE rm.room_id = $1 AND rm.uuid = $2
          UNION ALL
          SELECT nickname FROM users WHERE uuid = $2
          LIMIT 1`,
        [room_id, uuid]
      );
      const myNick = selfRes.rows[0]?.nickname || '익명';
      try {
        const wsModule = require('./ws');
        for (const m of mutuals.rows) {
          wsModule.broadcastToRoom(room_code, {
            type: 'connection_mutual',
            a: { uuid, nickname: myNick },
            b: { uuid: m.uuid, nickname: m.nickname },
          });
        }
      } catch (_) {}
    }

    res.json({ saved: cleanPicks.length, mutuals: mutuals.rows });
  } catch (err) {
    console.error('connections error:', err);
    res.status(500).json({ error: 'db error' });
  }
});

// GET /api/result?uuid=&room_code=
router.get('/result', async (req, res) => {
  const { uuid, room_code } = req.query;
  if (!uuid || !room_code) return res.status(400).json({ error: 'uuid, room_code required' });

  try {
    const roomRes = await pool.query('SELECT id, pack_id FROM rooms WHERE room_code = $1', [room_code]);
    if (roomRes.rows.length === 0) return res.status(404).json({ error: 'room not found' });
    const room_id = roomRes.rows[0].id;
    const pack_id = roomRes.rows[0].pack_id;
    const pack_defaults = getPackDefaults(pack_id);

    const mrRes = await pool.query(
      'SELECT match_json, votes_json, fi_count FROM member_results WHERE uuid = $1 AND room_id = $2',
      [uuid, room_id]
    );
    const mr = mrRes.rows[0] || {};
    const match_json = mr.match_json || {};
    const fi_count = mr.fi_count || 0;
    const myVotes = mr.votes_json || {};

    // 베스트 매칭 = 본인과 votes 일치율 1위 (전체 참여자 중)
    // 추가로 top 3 호환도 순위도 함께 반환 (결과 페이지 "또 잘 맞았던 사람들" 섹션용)
    let match_nickname = null;
    let match_uuid = null;
    let top_matches = []; // [{uuid, nickname, score, common, same}, ...] sorted desc
    {
      const allVotesRes = await pool.query(
        `SELECT mr.uuid, mr.votes_json,
                COALESCE(rm.nickname, u.nickname) AS nickname,
                COALESCE(rm.emoji, u.emoji) AS emoji
           FROM member_results mr
           LEFT JOIN room_members rm ON rm.room_id = mr.room_id AND rm.uuid = mr.uuid
           LEFT JOIN users u ON u.uuid = mr.uuid
          WHERE mr.room_id = $1 AND mr.uuid != $2`,
        [room_id, uuid]
      );
      const scored = [];
      for (const row of allVotesRes.rows) {
        const v = row.votes_json || {};
        let same = 0; let common = 0;
        for (const [qid, ans] of Object.entries(myVotes)) {
          if (v[qid] != null) {
            common += 1;
            if (v[qid] === ans) same += 1;
          }
        }
        if (common === 0) continue;
        scored.push({ uuid: row.uuid, nickname: row.nickname, emoji: row.emoji, score: same / common, common, same });
      }
      scored.sort((a, b) => b.score - a.score);
      if (scored[0]) { match_uuid = scored[0].uuid; match_nickname = scored[0].nickname; }
      // top 3 (베스트 포함)
      top_matches = scored.slice(0, 3).map(s => ({
        uuid: s.uuid,
        nickname: s.nickname,
        emoji: s.emoji || null,
        same: s.same,
        common: s.common,
        pct: Math.round(s.score * 100),
      }));
    }
    // 베스트 매칭 상대 emoji
    const match_emoji = (top_matches[0] && top_matches[0].emoji) || null;

    // 매칭 상대와의 공통 답변 수 + 대표 픽 (최대 2개)
    let match_common = 0;
    let match_total_answered = 0;
    let match_common_picks = [];
    if (match_uuid) {
      const partnerRes = await pool.query(
        'SELECT votes_json FROM member_results WHERE uuid = $1 AND room_id = $2',
        [match_uuid, room_id]
      );
      const partnerVotes = (partnerRes.rows[0] && partnerRes.rows[0].votes_json) || {};

      // 질문 텍스트 lookup
      const qRes = await pool.query(
        'SELECT questions_json, question_count FROM rooms WHERE id = $1',
        [room_id]
      );
      const allQs = (qRes.rows[0] && qRes.rows[0].questions_json) || [];
      // enabled=true 만 집계 대상 (레거시 enabled 없으면 true 간주)
      const enabledQs = allQs.filter(q => q && q.enabled !== false);
      const qcount = Number.isFinite(qRes.rows[0]?.question_count) ? qRes.rows[0].question_count : enabledQs.length;
      const qById = new Map();
      for (const q of enabledQs.slice(0, qcount)) qById.set(String(q.id), q);

      const matchedPicks = [];
      for (const [qid, ans] of Object.entries(myVotes)) {
        if (partnerVotes[qid] != null) {
          match_total_answered += 1;
          if (partnerVotes[qid] === ans) {
            match_common += 1;
            const q = qById.get(String(qid));
            if (q) {
              const opts = q.options || [];
              const idx = ans === 'A' ? 0 : 1;
              const choiceText = String(opts[idx] || '').replace(/^[AB]\.\s*/, '');
              matchedPicks.push({
                question: q.question || '',
                choice: choiceText,
                letter: ans,
              });
            }
          }
        }
      }
      // 최대 2개만 노출
      match_common_picks = matchedPicks.slice(0, 2);
    }

    // 참가자 수
    const countRes = await pool.query(
      'SELECT COUNT(*) as cnt FROM member_results WHERE room_id = $1',
      [room_id]
    );
    const participants = parseInt(countRes.rows[0].cnt, 10);

    // 문항 하이라이트
    const allVotesRes = await pool.query(
      'SELECT votes_json FROM member_results WHERE room_id = $1',
      [room_id]
    );
    const tally = {};
    for (const row of allVotesRes.rows) {
      const v = row.votes_json || {};
      for (const [qid, ans] of Object.entries(v)) {
        if (!tally[qid]) tally[qid] = {};
        tally[qid][ans] = (tally[qid][ans] || 0) + 1;
      }
    }
    const question_highlights = Object.entries(tally).map(([qid, counts]) => {
      const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
      return { question_id: qid, top_answer: top[0], count: top[1] };
    });

    // 호스트 평가 집계 (평균만 공개, 개별 코멘트는 관리자만)
    const hostAgg = await pool.query(
      `SELECT AVG(host_rating)::float AS avg_host_rating,
              COUNT(host_rating)::int AS host_rating_count,
              AVG(nps)::float AS avg_nps,
              AVG(satisfaction)::float AS avg_satisfaction
         FROM survey_responses
        WHERE room_id = $1 AND host_rating IS NOT NULL`,
      [room_id]
    );
    const host_summary = {
      avg_host_rating: hostAgg.rows[0].avg_host_rating ? Number(hostAgg.rows[0].avg_host_rating.toFixed(2)) : null,
      host_rating_count: hostAgg.rows[0].host_rating_count || 0,
      avg_nps: hostAgg.rows[0].avg_nps ? Number(hostAgg.rows[0].avg_nps.toFixed(2)) : null,
      avg_satisfaction: hostAgg.rows[0].avg_satisfaction ? Number(hostAgg.rows[0].avg_satisfaction.toFixed(2)) : null,
    };

    // 사랑의 작대기 상호 지명 커플 (전체 공개)
    const allPairs = Array.isArray(match_json.pairs) ? match_json.pairs : [];
    const mutual_pairs = allPairs.filter(p => p && p.type === 'mutual').map(p => ({
      a: { uuid: p.a?.uuid || null, nickname: p.a?.nickname || null },
      b: { uuid: p.b?.uuid || null, nickname: p.b?.nickname || null },
    }));

    // couples 팩은 매칭 로직이 없어 mutual_pairs 가 비어있음 — member_results 에서 나 외 첫 멤버를 자동 파트너로
    let couple_partner_uuid = null;
    if (pack_id === 'couples') {
      const otherRes = await pool.query(
        'SELECT uuid FROM member_results WHERE room_id = $1 AND uuid != $2 ORDER BY created_at ASC LIMIT 1',
        [room_id, uuid]
      );
      couple_partner_uuid = otherRes.rows[0]?.uuid || null;
    }

    res.json({ match_nickname, match_uuid, match_emoji, fi_count, match_common, match_total_answered, match_common_picks, top_matches, participants, question_highlights, host_summary, mutual_pairs, pack_id, pack_defaults, couple_partner_uuid });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'db error' });
  }
});

// GET /api/rooms/:code/couple-card?uuid=&partner_uuid=
// 사랑의 작대기 상호 매칭 커플 A/B 선택 비교 (인스타 공유 카드 데이터).
// 서버 검증: mutual pair 아닌 경우 403.
router.get('/rooms/:code/couple-card', async (req, res) => {
  const { code } = req.params;
  const { uuid, partner_uuid } = req.query;
  if (!uuid || !partner_uuid) return res.status(400).json({ error: 'uuid, partner_uuid required' });
  if (uuid === partner_uuid) return res.status(400).json({ error: 'same uuid' });

  try {
    const roomRes = await pool.query('SELECT id FROM rooms WHERE room_code = $1', [code]);
    if (roomRes.rows.length === 0) return res.status(404).json({ error: 'room not found' });
    const room_id = roomRes.rows[0].id;

    // mutual pair 검증 — member_results.match_json.pairs 에 type=mutual 존재 확인
    const myMr = await pool.query(
      'SELECT match_json, votes_json FROM member_results WHERE uuid = $1 AND room_id = $2',
      [uuid, room_id]
    );
    if (myMr.rows.length === 0) return res.status(404).json({ error: 'not a member' });
    const pairs = Array.isArray(myMr.rows[0].match_json?.pairs) ? myMr.rows[0].match_json.pairs : [];
    const isMutualPair = pairs.some(p => p && p.type === 'mutual'
      && ((p.a?.uuid === uuid && p.b?.uuid === partner_uuid)
        || (p.a?.uuid === partner_uuid && p.b?.uuid === uuid)));
    // couples 팩은 매칭 단계가 없어 match_json.pairs 가 비어있음 — 2인 멤버 자동 통과
    let allowed = isMutualPair;
    if (!allowed) {
      const pkRes = await pool.query('SELECT pack_id FROM rooms WHERE id = $1', [room_id]);
      if (pkRes.rows[0]?.pack_id === 'couples') {
        const ct = await pool.query(
          'SELECT COUNT(*)::int AS cnt FROM room_members WHERE room_id = $1 AND uuid = ANY($2)',
          [room_id, [uuid, partner_uuid]]
        );
        allowed = ct.rows[0].cnt === 2;
      }
    }
    if (!allowed) return res.status(403).json({ error: 'not a mutual pair' });

    const myVotes = myMr.rows[0].votes_json || {};
    const pRes = await pool.query(
      'SELECT votes_json FROM member_results WHERE uuid = $1 AND room_id = $2',
      [partner_uuid, room_id]
    );
    const partnerVotes = (pRes.rows[0] && pRes.rows[0].votes_json) || {};

    const nickRes = await pool.query(
      `SELECT uuid, nickname FROM room_members WHERE room_id = $1 AND uuid = ANY($2)`,
      [room_id, [uuid, partner_uuid]]
    );
    const nickMap = {};
    for (const r of nickRes.rows) nickMap[r.uuid] = r.nickname;

    const qRes = await pool.query(
      'SELECT questions_json, question_count FROM rooms WHERE id = $1',
      [room_id]
    );
    const allQs = (qRes.rows[0] && qRes.rows[0].questions_json) || [];
    const enabledQs = allQs.filter(q => q && q.enabled !== false);
    const qcount = Number.isFinite(qRes.rows[0]?.question_count) ? qRes.rows[0].question_count : enabledQs.length;
    const usedQs = enabledQs.slice(0, qcount);

    const questions = [];
    let matched = 0;
    for (const q of usedQs) {
      const qid = String(q.id);
      const mine = myVotes[qid] || null;
      const theirs = partnerVotes[qid] || null;
      const opts = q.options || [];
      const optA = String(opts[0] || '').replace(/^A\.\s*/, '');
      const optB = String(opts[1] || '').replace(/^B\.\s*/, '');
      const match = mine != null && theirs != null && mine === theirs;
      if (match) matched += 1;
      questions.push({ q: q.question || '', optA, optB, mine, theirs, match });
    }

    res.json({
      me: { uuid, nickname: nickMap[uuid] || '나' },
      partner: { uuid: partner_uuid, nickname: nickMap[partner_uuid] || '상대' },
      total: questions.length,
      matched,
      questions,
    });
  } catch (err) {
    console.error('couple-card error:', err);
    res.status(500).json({ error: 'db error' });
  }
});

module.exports = router;
