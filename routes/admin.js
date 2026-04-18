const express = require('express');
const router = express.Router();
const { parseQuestions, parseFreeTopics } = require('./question-sources');

let pool, broadcastToRoom, getRoomClients;

// 의존성 주입 (server.js에서 호출)
router.init = (dbPool, wsModule) => {
  pool = dbPool;
  broadcastToRoom = wsModule.broadcastToRoom;
  getRoomClients = wsModule.getRoomClients;
};

// ─── 헬퍼 ───────────────────────────────────────────────────────────────────

async function verifyHost(room_code, host_uuid) {
  const { rows } = await pool.query(
    'SELECT * FROM rooms WHERE room_code = $1',
    [room_code]
  );
  if (!rows.length) return null;
  const room = rows[0];
  if (room.host_uuid !== host_uuid) return null;
  return room;
}

// 방이 phase='waiting' 상태인지 (아직 모임 시작 안함)
async function isWaitingPhase(room_id) {
  const { rows } = await pool.query(
    'SELECT state_json FROM room_state WHERE room_id = $1',
    [room_id]
  );
  if (!rows.length) return true; // 초기 상태는 waiting
  const phase = rows[0].state_json?.phase;
  return !phase || phase === 'waiting';
}

// ─── GET /api/rooms/:code/questions ─────────────────────────────────────────

router.get('/rooms/:code/questions', async (req, res) => {
  const { code } = req.params;
  try {
    const r = await pool.query(
      'SELECT question_count, questions_json FROM rooms WHERE room_code = $1',
      [code]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'room not found' });
    const row = r.rows[0];
    // 방별 DB 스냅샷 우선, 없으면 md 폴백
    if (Array.isArray(row.questions_json) && row.questions_json.length) {
      const limit = Number.isFinite(row.question_count) ? row.question_count : row.questions_json.length;
      return res.json(row.questions_json.slice(0, limit));
    }
    const questions = parseQuestions();
    const limit = Number.isFinite(row.question_count) ? row.question_count : 10;
    res.json(questions.slice(0, limit));
  } catch (err) {
    console.error('questions parse error:', err);
    res.status(500).json({ error: 'questions 파싱 실패' });
  }
});

// ─── GET /api/rooms/:code/free-topics ───────────────────────────────────────

router.get('/rooms/:code/free-topics', async (req, res) => {
  const { code } = req.params;
  try {
    const r = await pool.query(
      'SELECT free_topics_json FROM rooms WHERE room_code = $1',
      [code]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'room not found' });
    const stored = r.rows[0].free_topics_json;
    if (Array.isArray(stored) && stored.length) {
      return res.json({ topics: stored });
    }
    res.json({ topics: parseFreeTopics() });
  } catch (err) {
    console.error('free-topics parse error:', err);
    res.status(500).json({ error: 'free-topics 파싱 실패' });
  }
});

// ─── PUT /api/rooms/:code/questions ─────────────────────────────────────────
// 호스트가 waiting 단계에서 질문/문항수 편집
router.put('/rooms/:code/questions', async (req, res) => {
  const { code } = req.params;
  const { host_uuid, questions, question_count } = req.body;
  if (!host_uuid) return res.status(400).json({ error: 'host_uuid 필수' });

  try {
    const room = await verifyHost(code, host_uuid);
    if (!room) return res.status(403).json({ error: '권한 없음' });
    if (room.status !== 'waiting' || !(await isWaitingPhase(room.id))) {
      return res.status(400).json({ error: 'WAITING_ONLY', message: '모임 시작 전에만 편집할 수 있어요' });
    }

    if (!Array.isArray(questions) || questions.length === 0) {
      return res.status(400).json({ error: '질문 목록이 비어있어요' });
    }

    // 정규화: { id, question, options: ["A. ...", "B. ..."] }
    const normalized = [];
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i] || {};
      const text = String(q.question || '').trim();
      if (!text) continue;
      let options = Array.isArray(q.options) ? q.options.map(String) : [];
      if (options.length < 2) {
        const a = String(q.a || '').trim();
        const b = String(q.b || '').trim();
        if (!a || !b) continue;
        options = [`A. ${a}`, `B. ${b}`];
      }
      normalized.push({
        id: Number.isFinite(q.id) ? q.id : i + 1,
        question: text,
        options: options.slice(0, 2),
      });
    }
    if (!normalized.length) return res.status(400).json({ error: '유효한 질문이 없어요' });

    let qcount = parseInt(question_count, 10);
    if (!Number.isFinite(qcount)) qcount = normalized.length;
    if (qcount < 1 || qcount > 15) {
      return res.status(400).json({ error: 'question_count must be between 1 and 15' });
    }
    if (qcount > normalized.length) qcount = normalized.length;

    await pool.query(
      'UPDATE rooms SET questions_json = $1, question_count = $2 WHERE id = $3',
      [JSON.stringify(normalized), qcount, room.id]
    );
    res.json({ ok: true, questions: normalized, question_count: qcount });
  } catch (err) {
    console.error('PUT questions error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── PUT /api/rooms/:code/host-role ──────────────────────────────────────────
// 호스트가 자기 참여 여부를 토글 (waiting phase 에서만)
router.put('/rooms/:code/host-role', async (req, res) => {
  const { code } = req.params;
  const { host_uuid, host_role } = req.body;
  if (!host_uuid) return res.status(400).json({ error: 'host_uuid 필수' });
  if (!['host_only', 'participant'].includes(host_role)) {
    return res.status(400).json({ error: "host_role must be 'host_only' or 'participant'" });
  }

  try {
    const room = await verifyHost(code, host_uuid);
    if (!room) return res.status(403).json({ error: '권한 없음' });
    if (room.status !== 'waiting' || !(await isWaitingPhase(room.id))) {
      return res.status(400).json({ error: 'WAITING_ONLY', message: '모임 시작 전에만 변경할 수 있어요' });
    }
    await pool.query('UPDATE rooms SET host_role = $1 WHERE id = $2', [host_role, room.id]);
    res.json({ ok: true, host_role });
  } catch (err) {
    console.error('PUT host-role error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── PUT /api/rooms/:code/free-topics ───────────────────────────────────────
router.put('/rooms/:code/free-topics', async (req, res) => {
  const { code } = req.params;
  const { host_uuid, topics } = req.body;
  if (!host_uuid) return res.status(400).json({ error: 'host_uuid 필수' });

  try {
    const room = await verifyHost(code, host_uuid);
    if (!room) return res.status(403).json({ error: '권한 없음' });
    if (room.status !== 'waiting' || !(await isWaitingPhase(room.id))) {
      return res.status(400).json({ error: 'WAITING_ONLY', message: '모임 시작 전에만 편집할 수 있어요' });
    }

    if (!Array.isArray(topics)) return res.status(400).json({ error: 'topics 배열 필수' });

    const normalized = [];
    let id = 1;
    for (const t of topics) {
      const text = String((t && t.text) || t || '').trim();
      if (!text) continue;
      normalized.push({ id: id++, text });
    }
    if (!normalized.length) return res.status(400).json({ error: '유효한 주제가 없어요' });

    await pool.query(
      'UPDATE rooms SET free_topics_json = $1 WHERE id = $2',
      [JSON.stringify(normalized), room.id]
    );
    res.json({ ok: true, topics: normalized });
  } catch (err) {
    console.error('PUT free-topics error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/rooms/:code/state ─────────────────────────────────────────────

router.post('/rooms/:code/state', async (req, res) => {
  const { code } = req.params;
  const { host_uuid, state } = req.body;
  if (!host_uuid || !state) return res.status(400).json({ error: 'host_uuid, state 필수' });

  try {
    const room = await verifyHost(code, host_uuid);
    if (!room) return res.status(403).json({ error: '권한 없음' });

    // 최소 2명(호스트 포함) 가드 — waiting → 활성 phase 전환 시 적용
    if (state.phase && state.phase !== 'waiting') {
      const memberCount = getRoomClients(code).length;
      if (memberCount < 2) {
        return res.status(400).json({
          error: 'MIN_MEMBERS',
          message: '호스트 포함 최소 2명이 있어야 시작할 수 있어요.',
          current: memberCount,
          required: 2,
        });
      }
    }

    await pool.query(
      `INSERT INTO room_state (room_id, state_json, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (room_id) DO UPDATE SET state_json = $2, updated_at = NOW()`,
      [room.id, JSON.stringify(state)]
    );

    broadcastToRoom(code, { type: 'state_update', state });
    res.json({ ok: true });
  } catch (err) {
    console.error('state error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/rooms/:code/vote ───────────────────────────────────────────────

router.post('/rooms/:code/vote', async (req, res) => {
  const { code } = req.params;
  const { uuid, question_id, answer } = req.body;
  if (!uuid || question_id == null || !answer)
    return res.status(400).json({ error: 'uuid, question_id, answer 필수' });

  try {
    // 방 확인
    const roomRes = await pool.query('SELECT id FROM rooms WHERE room_code = $1', [code]);
    if (!roomRes.rows.length) return res.status(404).json({ error: '방 없음' });
    const room_id = roomRes.rows[0].id;

    // member_results upsert
    await pool.query(
      `INSERT INTO member_results (uuid, room_id, room_code, votes_json, match_json, fi_count)
       VALUES ($1, $2, $3, '{}', '{}', 0)
       ON CONFLICT (uuid, room_id) DO NOTHING`,
      [uuid, room_id, code]
    );

    // 기존 votes_json 읽기
    const mr = await pool.query(
      'SELECT votes_json FROM member_results WHERE uuid = $1 AND room_id = $2',
      [uuid, room_id]
    );
    const votes = mr.rows[0].votes_json || {};
    votes[String(question_id)] = answer;

    await pool.query(
      'UPDATE member_results SET votes_json = $1 WHERE uuid = $2 AND room_id = $3',
      [JSON.stringify(votes), uuid, room_id]
    );

    // 전체 집계
    const allRes = await pool.query(
      'SELECT votes_json FROM member_results WHERE room_id = $1',
      [room_id]
    );
    const counts = {};
    for (const row of allRes.rows) {
      const v = row.votes_json || {};
      const ans = v[String(question_id)];
      if (ans) counts[ans] = (counts[ans] || 0) + 1;
    }

    broadcastToRoom(code, { type: 'vote_result', question_id, counts });
    res.json({ counts });
  } catch (err) {
    console.error('vote error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/rooms/:code/nudge ─────────────────────────────────────────────

router.post('/rooms/:code/nudge', async (req, res) => {
  const { code } = req.params;
  const { host_uuid, message } = req.body;
  if (!host_uuid) return res.status(400).json({ error: 'host_uuid 필수' });

  try {
    const room = await verifyHost(code, host_uuid);
    if (!room) return res.status(403).json({ error: '권한 없음' });

    const msg = message || '자리를 이동해볼까요 🔀';
    broadcastToRoom(code, { type: 'nudge', message: msg });
    res.json({ ok: true });
  } catch (err) {
    console.error('nudge error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/rooms/:code/question-card ─────────────────────────────────────

router.post('/rooms/:code/question-card', async (req, res) => {
  const { code } = req.params;
  const { host_uuid, text } = req.body;
  if (!host_uuid || !text) return res.status(400).json({ error: 'host_uuid, text 필수' });

  try {
    const room = await verifyHost(code, host_uuid);
    if (!room) return res.status(403).json({ error: '권한 없음' });

    broadcastToRoom(code, { type: 'question_card', text });
    res.json({ ok: true });
  } catch (err) {
    console.error('question-card error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/rooms/:code/vote/mvp ──────────────────────────────────────────

router.post('/rooms/:code/vote/mvp', async (req, res) => {
  const { code } = req.params;
  const { uuid, target_uuid } = req.body;
  if (!uuid || !target_uuid) return res.status(400).json({ error: 'uuid, target_uuid 필수' });

  try {
    const roomRes = await pool.query('SELECT id FROM rooms WHERE room_code = $1', [code]);
    if (!roomRes.rows.length) return res.status(404).json({ error: '방 없음' });
    const room_id = roomRes.rows[0].id;

    // target upsert 후 fi_count ++
    await pool.query(
      `INSERT INTO member_results (uuid, room_id, room_code, votes_json, match_json, fi_count)
       VALUES ($1, $2, $3, '{}', '{}', 0)
       ON CONFLICT (uuid, room_id) DO NOTHING`,
      [target_uuid, room_id, code]
    );
    await pool.query(
      'UPDATE member_results SET fi_count = fi_count + 1 WHERE uuid = $1 AND room_id = $2',
      [target_uuid, room_id]
    );

    // 실시간 MVP 순위 브로드캐스트
    const mvpRows = await pool.query(
      `SELECT mr.uuid, mr.fi_count, u.nickname
         FROM member_results mr
         LEFT JOIN users u ON u.uuid = mr.uuid
        WHERE mr.room_id = $1
        ORDER BY mr.fi_count DESC, u.nickname ASC`,
      [room_id]
    );
    broadcastToRoom(code, {
      type: 'mvp_update',
      mvp_list: mvpRows.rows.map(r => ({
        uuid: r.uuid, nickname: r.nickname || '익명', fi_count: r.fi_count || 0,
      })),
    });

    res.json({ success: true });
  } catch (err) {
    console.error('mvp vote error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/rooms/:code/mvp-finalize ──────────────────────────────────────
// 호스트가 MVP 결과 발표 단계로 진입할 때 호출. 1위 mvp 산정 + broadcast 'mvp_announce'.
router.post('/rooms/:code/mvp-finalize', async (req, res) => {
  const { code } = req.params;
  const { host_uuid } = req.body;
  try {
    const room = await pool.query(
      'SELECT id, host_uuid FROM rooms WHERE room_code = $1', [code]
    );
    if (!room.rows.length) return res.status(404).json({ error: '방 없음' });
    if (room.rows[0].host_uuid !== host_uuid) return res.status(403).json({ error: '권한 없음' });
    const room_id = room.rows[0].id;

    const top = await pool.query(
      `SELECT mr.uuid, mr.fi_count, u.nickname
         FROM member_results mr
         LEFT JOIN users u ON u.uuid = mr.uuid
        WHERE mr.room_id = $1 AND mr.fi_count > 0
        ORDER BY mr.fi_count DESC, u.nickname ASC
        LIMIT 1`,
      [room_id]
    );
    const mvp = top.rows[0]
      ? { uuid: top.rows[0].uuid, nickname: top.rows[0].nickname || '익명', fi_count: top.rows[0].fi_count || 0 }
      : null;

    broadcastToRoom(code, { type: 'mvp_announce', mvp });
    res.json({ success: true, mvp });
  } catch (err) {
    console.error('mvp-finalize error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/rooms/:code/insta-reveal ──────────────────────────────────────
// 상호 동의 후 인스타그램 공개. body: { uuid }
// 내 매칭 상대를 match_json.pairs 에서 찾고, 양쪽 모두 instagram_revealed=true 면 상대 instagram 반환
router.post('/rooms/:code/insta-reveal', async (req, res) => {
  const { code } = req.params;
  const { uuid } = req.body;
  if (!uuid) return res.status(400).json({ error: 'uuid 필수' });

  try {
    const roomRes = await pool.query('SELECT id FROM rooms WHERE room_code = $1', [code]);
    if (!roomRes.rows.length) return res.status(404).json({ error: '방 없음' });
    const room_id = roomRes.rows[0].id;

    // 내 매칭 상대 uuid 탐색 — 모든 멤버의 match_json.pairs 검사
    const allRes = await pool.query(
      'SELECT uuid, match_json FROM member_results WHERE room_id = $1',
      [room_id]
    );

    // 1) 방장(호스트)이 발표한 pairs 우선 — 모든 row에 동일 pairs가 broadcast 후 저장될 수도 있으니
    //    각 row의 match_json.pairs 를 전부 합쳐 유니크하게 본다.
    let partnerUuid = null;
    for (const row of allRes.rows) {
      const pairs = row.match_json?.pairs;
      if (!Array.isArray(pairs)) continue;
      for (const p of pairs) {
        if (p.a?.uuid === uuid) { partnerUuid = p.b?.uuid || null; break; }
        if (p.b?.uuid === uuid) { partnerUuid = p.a?.uuid || null; break; }
      }
      if (partnerUuid) break;
    }
    // 2) pairs 기록이 없으면 본인의 match_json.pick 폴백 (단방향 관심 표시)
    if (!partnerUuid) {
      const myRow = allRes.rows.find(r => r.uuid === uuid);
      partnerUuid = myRow?.match_json?.pick || null;
    }

    if (!partnerUuid) {
      return res.json({ mutual: false, pending: false, partner: null });
    }

    // 내 match_json.instagram_revealed = true 기록
    await pool.query(
      `INSERT INTO member_results (uuid, room_id, room_code, votes_json, match_json, fi_count)
       VALUES ($1, $2, $3, '{}', '{}', 0)
       ON CONFLICT (uuid, room_id) DO NOTHING`,
      [uuid, room_id, code]
    );
    await pool.query(
      `UPDATE member_results
          SET match_json = jsonb_set(COALESCE(match_json, '{}'::jsonb), '{instagram_revealed}', 'true'::jsonb)
        WHERE uuid = $1 AND room_id = $2`,
      [uuid, room_id]
    );

    // 상대도 공개했는지 확인
    const partnerRow = await pool.query(
      'SELECT match_json FROM member_results WHERE uuid = $1 AND room_id = $2',
      [partnerUuid, room_id]
    );
    const partnerRevealed = !!partnerRow.rows[0]?.match_json?.instagram_revealed;

    if (!partnerRevealed) {
      return res.json({ mutual: false, pending: true, partner: { uuid: partnerUuid } });
    }

    // 상호 공개 완료 → 상대 instagram + nickname 반환
    const partnerUser = await pool.query(
      'SELECT nickname, instagram FROM users WHERE uuid = $1',
      [partnerUuid]
    );
    const u = partnerUser.rows[0] || {};

    // 내 insta도 상대에게 broadcast해줄 수 있게 WS 전송
    const meUser = await pool.query(
      'SELECT nickname, instagram FROM users WHERE uuid = $1',
      [uuid]
    );
    broadcastToRoom(code, {
      type: 'insta_mutual',
      a_uuid: uuid,
      b_uuid: partnerUuid,
      a: { nickname: meUser.rows[0]?.nickname || '', instagram: meUser.rows[0]?.instagram || '' },
      b: { nickname: u.nickname || '', instagram: u.instagram || '' },
    });

    return res.json({
      mutual: true,
      pending: false,
      partner: {
        uuid: partnerUuid,
        nickname: u.nickname || '',
        instagram: u.instagram || '',
      },
    });
  } catch (err) {
    console.error('insta-reveal error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/rooms/:code/vote/match ────────────────────────────────────────

router.post('/rooms/:code/vote/match', async (req, res) => {
  const { code } = req.params;
  const { uuid, target_uuid } = req.body;
  if (!uuid || !target_uuid) return res.status(400).json({ error: 'uuid, target_uuid 필수' });

  try {
    const roomRes = await pool.query('SELECT id FROM rooms WHERE room_code = $1', [code]);
    if (!roomRes.rows.length) return res.status(404).json({ error: '방 없음' });
    const room_id = roomRes.rows[0].id;

    await pool.query(
      `INSERT INTO member_results (uuid, room_id, room_code, votes_json, match_json, fi_count)
       VALUES ($1, $2, $3, '{}', '{}', 0)
       ON CONFLICT (uuid, room_id) DO NOTHING`,
      [uuid, room_id, code]
    );

    const mr = await pool.query(
      'SELECT match_json FROM member_results WHERE uuid = $1 AND room_id = $2',
      [uuid, room_id]
    );
    const matchData = mr.rows[0].match_json || {};
    matchData.pick = target_uuid;

    await pool.query(
      'UPDATE member_results SET match_json = $1 WHERE uuid = $2 AND room_id = $3',
      [JSON.stringify(matchData), uuid, room_id]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('match vote error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/rooms/:code/match ─────────────────────────────────────────────

router.post('/rooms/:code/match', async (req, res) => {
  const { code } = req.params;
  const { host_uuid } = req.body;
  if (!host_uuid) return res.status(400).json({ error: 'host_uuid 필수' });

  try {
    const room = await verifyHost(code, host_uuid);
    if (!room) return res.status(403).json({ error: '권한 없음' });

    const allRes = await pool.query(
      'SELECT uuid, votes_json, match_json, fi_count FROM member_results WHERE room_id = $1',
      [room.id]
    );

    // 유저 정보 (닉네임)
    const members = allRes.rows;
    if (!members.length) {
      broadcastToRoom(code, { type: 'matching_result', match_json: [] });
      return res.json({ match_json: [] });
    }

    const uuids = members.map(m => m.uuid);
    const usersRes = await pool.query(
      'SELECT uuid, nickname, gender FROM users WHERE uuid = ANY($1)',
      [uuids]
    );
    const userMap = {};
    for (const u of usersRes.rows) userMap[u.uuid] = u;

    // 매칭 알고리즘
    // 1) 상호 픽 (match_json.pick 기준)
    const pickMap = {};
    for (const m of members) {
      if (m.match_json?.pick) pickMap[m.uuid] = m.match_json.pick;
    }

    // 2) fi_count 기준 정렬 (MVP)
    const sorted = [...members].sort((a, b) => (b.fi_count || 0) - (a.fi_count || 0));

    // 3) 투표 유사도 계산
    function similarity(v1, v2) {
      const keys = new Set([...Object.keys(v1), ...Object.keys(v2)]);
      if (!keys.size) return 0;
      let match = 0;
      for (const k of keys) if (v1[k] && v1[k] === v2[k]) match++;
      return match / keys.size;
    }

    // 4) 매칭 페어 구성 (상호 픽 우선, 없으면 유사도 + fi_count)
    const matched = new Set();
    const pairs = [];

    // 상호 픽 먼저
    for (const m of members) {
      if (matched.has(m.uuid)) continue;
      const pick = pickMap[m.uuid];
      if (pick && pickMap[pick] === m.uuid && !matched.has(pick)) {
        pairs.push({
          type: 'mutual',
          a: { uuid: m.uuid, nickname: userMap[m.uuid]?.nickname },
          b: { uuid: pick, nickname: userMap[pick]?.nickname }
        });
        matched.add(m.uuid);
        matched.add(pick);
      }
    }

    // 남은 사람들 유사도 매칭
    const remaining = members.filter(m => !matched.has(m.uuid));
    for (let i = 0; i < remaining.length; i++) {
      if (matched.has(remaining[i].uuid)) continue;
      let bestScore = -1;
      let bestIdx = -1;
      for (let j = i + 1; j < remaining.length; j++) {
        if (matched.has(remaining[j].uuid)) continue;
        const score = similarity(remaining[i].votes_json || {}, remaining[j].votes_json || {})
          + (remaining[j].fi_count || 0) * 0.1;
        if (score > bestScore) { bestScore = score; bestIdx = j; }
      }
      if (bestIdx !== -1) {
        pairs.push({
          type: 'recommended',
          a: { uuid: remaining[i].uuid, nickname: userMap[remaining[i].uuid]?.nickname },
          b: { uuid: remaining[bestIdx].uuid, nickname: userMap[remaining[bestIdx].uuid]?.nickname }
        });
        matched.add(remaining[i].uuid);
        matched.add(remaining[bestIdx].uuid);
      }
    }

    // 홀수 처리 (남은 1명)
    for (const m of remaining) {
      if (!matched.has(m.uuid)) {
        pairs.push({ type: 'solo', a: { uuid: m.uuid, nickname: userMap[m.uuid]?.nickname } });
      }
    }

    // MVP (fi_count 1위)
    const mvp = sorted[0] ? { uuid: sorted[0].uuid, nickname: userMap[sorted[0].uuid]?.nickname, fi_count: sorted[0].fi_count } : null;

    const match_json = { pairs, mvp };

    // 각 멤버의 match_json에 pairs/mvp 저장 — insta-reveal 등 후속 조회용
    // 기존 pick 값은 유지하면서 pairs/mvp 키만 병합
    for (const m of members) {
      await pool.query(
        `UPDATE member_results
            SET match_json = COALESCE(match_json, '{}'::jsonb)
                              || jsonb_build_object('pairs', $1::jsonb, 'mvp', $2::jsonb)
          WHERE uuid = $3 AND room_id = $4`,
        [JSON.stringify(pairs), JSON.stringify(mvp), m.uuid, room.id]
      );
    }

    broadcastToRoom(code, { type: 'matching_result', match_json });
    res.json({ match_json });
  } catch (err) {
    console.error('match error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
