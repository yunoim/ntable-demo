const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const QRCode = require('qrcode');
const { listPacks, getPack, DEFAULT_PACK_ID, getPackFlow } = require('./question-sources');

function generateRoomCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

// POST /api/rooms
router.post('/rooms', async (req, res) => {
  const { uuid, title, host_role } = req.body;
  if (!uuid || !title || !host_role) {
    return res.status(400).json({ error: 'uuid, title, host_role required' });
  }
  if (!['host_only', 'participant'].includes(host_role)) {
    return res.status(400).json({ error: 'host_role must be host_only or participant' });
  }
  if (title.length > 100) {
    return res.status(400).json({ error: 'title max 100 chars' });
  }

  // question_count: 1~15, 기본 10
  let question_count = parseInt(req.body.question_count, 10);
  if (!Number.isFinite(question_count)) question_count = 10;
  if (question_count < 1 || question_count > 15) {
    return res.status(400).json({ error: 'question_count must be between 1 and 15' });
  }

  // 팩 선택 — 기본 icebreaker
  const pack_id = String(req.body.pack_id || DEFAULT_PACK_ID).replace(/[^a-zA-Z0-9_-]/g, '');
  const pack = getPack(pack_id) || getPack(DEFAULT_PACK_ID);
  if (!pack) {
    return res.status(500).json({ error: 'no pack available' });
  }

  // 표시 필드 옵션 (호스트가 정함)
  const ALLOWED_FIELDS = ['birth_year', 'region', 'industry', 'interest'];
  let display_fields = Array.isArray(req.body.display_fields)
    ? req.body.display_fields.filter(f => ALLOWED_FIELDS.includes(f))
    : ALLOWED_FIELDS;
  if (display_fields.length === 0) display_fields = ALLOWED_FIELDS;
  const birth_year_format = ['exact', 'decade_half', 'decade'].includes(req.body.birth_year_format)
    ? req.body.birth_year_format : 'exact';
  const display_mode = ['mobile', 'presenter'].includes(req.body.display_mode)
    ? req.body.display_mode : 'mobile';
  const photo_enabled = req.body.photo_enabled === false ? false : true;
  const region_detail = req.body.region_detail === true ? true : false;
  // 자유대화 옵션
  let fc_timer = parseInt(req.body.free_chat_timer_minutes, 10);
  if (!Number.isFinite(fc_timer) || fc_timer < 0 || fc_timer > 60) fc_timer = 15;
  const fc_chat = req.body.free_chat_chat_enabled === false ? false : true;
  const fc_topic = req.body.free_chat_topic_card_enabled === false ? false : true;
  // 팩별 closing flow (호스트 override 가능)
  const validSteps = ['mvp', 'match', 'explore-result'];
  let closing_steps = Array.isArray(req.body.closing_steps)
    ? req.body.closing_steps.filter(s => validSteps.includes(s))
    : getPackFlow(pack.id);

  // uuid 보장 — 신규 익명 사용자는 자동 등록 (방별 익명 구조)
  await pool.query(
    `INSERT INTO users (uuid) VALUES ($1) ON CONFLICT (uuid) DO NOTHING`,
    [uuid]
  );

  // room_code 중복 없이 생성
  let room_code;
  let attempts = 0;
  while (attempts < 10) {
    const candidate = generateRoomCode();
    const existing = await pool.query('SELECT id FROM rooms WHERE room_code = $1', [candidate]);
    if (existing.rows.length === 0) {
      room_code = candidate;
      break;
    }
    attempts++;
  }
  if (!room_code) {
    return res.status(500).json({ error: 'Failed to generate unique room code' });
  }

  // 팩 스냅샷 — 방 생성 시점에 복사해서 호스트가 자유롭게 편집
  const questionsSeed = pack.questions || [];
  const topicsSeed = pack.topics || [];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const roomResult = await client.query(
      `INSERT INTO rooms (room_code, title, host_uuid, host_role, status, question_count, questions_json, free_topics_json, pack_id, display_fields, birth_year_format, display_mode, photo_enabled, region_detail, closing_steps, free_chat_timer_minutes, free_chat_chat_enabled, free_chat_topic_card_enabled)
       VALUES ($1, $2, $3, $4, 'waiting', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) RETURNING id`,
      [
        room_code, title, uuid, host_role, question_count,
        JSON.stringify(questionsSeed),
        JSON.stringify(topicsSeed),
        pack.id,
        JSON.stringify(display_fields),
        birth_year_format,
        display_mode,
        photo_enabled,
        region_detail,
        JSON.stringify(closing_steps),
        fc_timer,
        fc_chat,
        fc_topic,
      ]
    );
    const room_id = roomResult.rows[0].id;
    await client.query(
      `INSERT INTO room_state (room_id, state_json, updated_at)
       VALUES ($1, $2, NOW())`,
      [room_id, JSON.stringify({ phase: 'waiting', current_tab: 'intro', question_index: 0 })]
    );
    await client.query('COMMIT');
    res.json({ room_code, title, host_role, question_count, pack_id: pack.id, display_fields, birth_year_format, display_mode, photo_enabled, region_detail, closing_steps, free_chat_timer_minutes: fc_timer, free_chat_chat_enabled: fc_chat, free_chat_topic_card_enabled: fc_topic });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /api/rooms error:', err);
    res.status(500).json({ error: 'DB error' });
  } finally {
    client.release();
  }
});

// GET /api/packs — 팩 목록 (create.html 선택 UI 용)
router.get('/packs', async (req, res) => {
  res.set('Cache-Control', 'public, max-age=60');
  try {
    res.json({ packs: listPacks() });
  } catch (err) {
    console.error('GET /api/packs error:', err);
    res.status(500).json({ error: 'packs load failed' });
  }
});

// GET /api/rooms/:code
router.get('/rooms/:code', async (req, res) => {
  const { code } = req.params;
  const result = await pool.query(
    'SELECT room_code, title, host_uuid, host_role, status, question_count, pack_id, display_fields, birth_year_format, display_mode, photo_enabled, region_detail, closing_steps, free_chat_timer_minutes, free_chat_chat_enabled, free_chat_topic_card_enabled FROM rooms WHERE room_code = $1',
    [code]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: 'room not found' });
  res.json(result.rows[0]);
});

// GET /api/rooms/:code/preview
// 인증 전(게스트 대기 화면)에서 노출할 최소 공개 정보
router.get('/rooms/:code/preview', async (req, res) => {
  const { code } = req.params;
  const r = await pool.query(
    `SELECT r.room_code, r.title, r.status,
            u.nickname AS host_nickname
     FROM rooms r
     LEFT JOIN users u ON u.uuid = r.host_uuid
     WHERE r.room_code = $1`,
    [code]
  );
  if (r.rows.length === 0) return res.status(404).json({ error: 'room not found' });
  const wsModule = require('./ws');
  const member_count = wsModule.getRoomClients(code).length;
  const row = r.rows[0];
  res.json({
    room_code: row.room_code,
    title: row.title,
    status: row.status,
    host_nickname: row.host_nickname,
    member_count,
  });
});

// GET /api/rooms/:code/members
// host_role === 'host_only' 인 호스트는 응답에서 제외
// ?viewer=<uuid> 로 viewer ≠ member 인 항목은 hide_* 마스킹 (호스트는 마스킹 X — 운영 필요)
router.get('/rooms/:code/members', async (req, res) => {
  const { code } = req.params;
  const viewer = req.query.viewer;
  const room = await pool.query(
    'SELECT id, host_uuid, host_role FROM rooms WHERE room_code = $1',
    [code]
  );
  if (room.rows.length === 0) return res.status(404).json({ error: 'room not found' });
  const hostUuid = room.rows[0].host_uuid;
  const isHostViewer = viewer && hostUuid && viewer === hostUuid;

  const wsModule = require('./ws');
  let clients = wsModule.getRoomClients(code);
  if (room.rows[0].host_role === 'host_only' && hostUuid) {
    clients = clients.filter(u => u !== hostUuid);
  }
  if (clients.length === 0) return res.json([]);

  // room_members 우선 (방별 익명 + hide 정보), 없으면 users fallback
  const placeholders = clients.map((_, i) => `$${i + 2}`).join(',');
  const members = await pool.query(
    `SELECT uuid, nickname, gender, birth_year, region, industry, mbti, interest,
            hide_birth_year, hide_region, hide_industry, hide_interest
       FROM room_members
      WHERE room_id = $1 AND uuid IN (${placeholders})`,
    [room.rows[0].id, ...clients]
  );
  const memberMap = new Map(members.rows.map(m => [m.uuid, m]));
  // legacy fallback for clients not in room_members
  const missing = clients.filter(u => !memberMap.has(u));
  if (missing.length) {
    const ph2 = missing.map((_, i) => `$${i + 1}`).join(',');
    const users = await pool.query(
      `SELECT uuid, nickname, gender, birth_year, region, industry, mbti, interest
         FROM users WHERE uuid IN (${ph2})`,
      missing
    );
    users.rows.forEach(u => memberMap.set(u.uuid, u));
  }
  // viewer 마스킹 (호스트가 viewer면 마스킹 X — 운영용)
  const out = clients.map(u => {
    const m = memberMap.get(u);
    if (!m) return null;
    const row = { ...m };
    if (!isHostViewer && viewer && viewer !== u) {
      if (row.hide_birth_year) row.birth_year = null;
      if (row.hide_region) row.region = null;
      if (row.hide_industry) row.industry = null;
      if (row.hide_interest) row.interest = null;
    }
    // 클라이언트로는 hide 플래그 노출 안 함 (정보 누출 방지)
    delete row.hide_birth_year;
    delete row.hide_region;
    delete row.hide_industry;
    delete row.hide_interest;
    return row;
  }).filter(Boolean);
  res.json(out);
});

// POST /api/rooms/:code/approve
router.post('/rooms/:code/approve', async (req, res) => {
  const { code } = req.params;
  const { host_uuid, target_uuid, approve_all } = req.body;

  const room = await pool.query(
    'SELECT id, host_uuid FROM rooms WHERE room_code = $1',
    [code]
  );
  if (room.rows.length === 0) return res.status(404).json({ error: 'room not found' });
  if (room.rows[0].host_uuid !== host_uuid) {
    return res.status(403).json({ error: 'not authorized' });
  }

  const wsModule = require('./ws');

  if (approve_all) {
    const clients = wsModule.getRoomClients(code);
    for (const uuid of clients) {
      // 모든 클라이언트에게 broadcast (호스트·게스트 전부) — 호스트 UI 동기화 필수
      wsModule.broadcastToRoom(code, { type: 'approved', uuid });
    }
    return res.json({ approved: clients });
  }

  if (!target_uuid) return res.status(400).json({ error: 'target_uuid required' });
  wsModule.broadcastToRoom(code, { type: 'approved', uuid: target_uuid });
  res.json({ approved: [target_uuid] });
});

// GET /api/rooms/:code/members/:uuid — 특정 멤버 프로필 조회 (방별 익명 — room_members 우선)
// ?viewer=<uuid> 로 viewer ≠ target이면 hide_* 필드 마스킹. 호스트 viewer는 마스킹 X (운영 필요).
router.get('/rooms/:code/members/:uuid', async (req, res) => {
  const { code, uuid } = req.params;
  const viewer = req.query.viewer;
  const room = await pool.query('SELECT id, host_uuid FROM rooms WHERE room_code = $1', [code]);
  if (room.rows.length === 0) return res.status(404).json({ error: 'room not found' });
  const isHostViewer = viewer && room.rows[0].host_uuid && viewer === room.rows[0].host_uuid;
  const m = await pool.query(
    `SELECT uuid, nickname, gender, birth_year, region, industry, mbti, interest, instagram,
            hide_birth_year, hide_region, hide_industry, hide_interest
       FROM room_members WHERE room_id = $1 AND uuid = $2`,
    [room.rows[0].id, uuid]
  );
  if (m.rows.length === 0) {
    const u = await pool.query(
      `SELECT uuid, nickname, gender, birth_year, region, industry, mbti, interest, instagram
         FROM users WHERE uuid = $1`,
      [uuid]
    );
    if (u.rows.length === 0) return res.status(404).json({ error: 'not found' });
    return res.json(u.rows[0]);
  }
  const row = { ...m.rows[0] };
  // 본인이 아니고 호스트도 아닌 viewer가 보면 hide 적용
  if (viewer && viewer !== uuid && !isHostViewer) {
    if (row.hide_birth_year) row.birth_year = null;
    if (row.hide_region) row.region = null;
    if (row.hide_industry) row.industry = null;
    if (row.hide_interest) row.interest = null;
  }
  // hide 플래그는 본인 응답일 때만 클라이언트로 노출 (확인 화면 🔒 마크용)
  if (viewer !== uuid) {
    delete row.hide_birth_year;
    delete row.hide_region;
    delete row.hide_industry;
    delete row.hide_interest;
  }
  res.json(row);
});

// GET /api/rooms/:code/explore-result — 탐구 단계 결과 (각 질문별 멤버들의 답변)
router.get('/rooms/:code/explore-result', async (req, res) => {
  const { code } = req.params;
  const room = await pool.query(
    'SELECT id, questions_json, question_count FROM rooms WHERE room_code = $1', [code]
  );
  if (room.rows.length === 0) return res.status(404).json({ error: 'room not found' });
  const room_id = room.rows[0].id;
  const allQuestions = room.rows[0].questions_json || [];
  const qcount = Number.isFinite(room.rows[0].question_count) ? room.rows[0].question_count : allQuestions.length;
  const questions = allQuestions.slice(0, qcount); // 호스트가 정한 문항 수만큼만
  const members = await pool.query(
    `SELECT mr.uuid, mr.votes_json,
            COALESCE(rm.nickname, '익명') AS nickname
       FROM member_results mr
       LEFT JOIN room_members rm ON rm.room_id = mr.room_id AND rm.uuid = mr.uuid
      WHERE mr.room_id = $1`,
    [room_id]
  );
  // 모든 멤버 닉네임 (vote 안 한 사람도 표시 위해 room_members 별도 fetch)
  const allMembers = await pool.query(
    `SELECT uuid, nickname FROM room_members WHERE room_id = $1`,
    [room_id]
  );
  // member_results에 없는 사람 추가
  const haveUuids = new Set(members.rows.map(m => m.uuid));
  for (const am of allMembers.rows) {
    if (!haveUuids.has(am.uuid)) {
      members.rows.push({ uuid: am.uuid, nickname: am.nickname, votes_json: {} });
    }
  }
  res.json({ questions, members: members.rows });
});

// GET /api/rooms/:code/me?uuid=X — 본인이 이 방에 join 했는지 확인 (200 + joined boolean)
router.get('/rooms/:code/me', async (req, res) => {
  const { code } = req.params;
  const uuid = req.query.uuid;
  if (!uuid) return res.status(400).json({ error: 'uuid required' });
  const room = await pool.query('SELECT id FROM rooms WHERE room_code = $1', [code]);
  if (room.rows.length === 0) return res.status(404).json({ error: 'room not found' });
  const me = await pool.query(
    `SELECT nickname, gender, birth_year, region, industry, mbti, interest, instagram
       FROM room_members WHERE room_id = $1 AND uuid = $2`,
    [room.rows[0].id, uuid]
  );
  if (me.rows.length === 0) return res.json({ joined: false });
  res.json({ joined: true, ...me.rows[0] });
});

// POST /api/rooms/:code/join — 방 입장 시 nickname + profile 스냅샷 등록 (방별 익명)
// body: { uuid, nickname, profile?: { gender, birth_year, region, industry, mbti, interest, instagram } }
router.post('/rooms/:code/join', async (req, res) => {
  const { code } = req.params;
  const { uuid, nickname } = req.body || {};
  const profile = req.body?.profile || {};
  if (!uuid || !nickname) return res.status(400).json({ error: 'uuid, nickname required' });
  const nick = String(nickname).trim().slice(0, 20);
  if (!nick) return res.status(400).json({ error: 'nickname empty' });

  const room = await pool.query('SELECT id, status FROM rooms WHERE room_code = $1', [code]);
  if (room.rows.length === 0) return res.status(404).json({ error: 'room not found' });
  if (room.rows[0].status === 'closed') return res.status(410).json({ error: 'room closed' });
  const room_id = room.rows[0].id;

  // 같은 방·다른 uuid가 같은 nickname 사용 중인지 체크
  const dup = await pool.query(
    'SELECT uuid FROM room_members WHERE room_id = $1 AND nickname = $2',
    [room_id, nick]
  );
  if (dup.rows.length && dup.rows[0].uuid !== uuid) {
    return res.status(409).json({ error: 'NICKNAME_TAKEN', message: '이 방에서 이미 사용 중인 닉네임이에요' });
  }

  try {
    await pool.query(
      `INSERT INTO room_members (room_id, uuid, nickname, gender, birth_year, region, industry, mbti, interest, instagram, hide_birth_year, hide_region, hide_industry, hide_interest)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (room_id, uuid)
       DO UPDATE SET nickname = EXCLUDED.nickname,
                     gender = EXCLUDED.gender,
                     birth_year = EXCLUDED.birth_year,
                     region = EXCLUDED.region,
                     industry = EXCLUDED.industry,
                     mbti = EXCLUDED.mbti,
                     interest = EXCLUDED.interest,
                     instagram = EXCLUDED.instagram,
                     hide_birth_year = EXCLUDED.hide_birth_year,
                     hide_region = EXCLUDED.hide_region,
                     hide_industry = EXCLUDED.hide_industry,
                     hide_interest = EXCLUDED.hide_interest`,
      [
        room_id, uuid, nick,
        profile.gender || null,
        profile.birth_year || null,
        profile.region || null,
        profile.industry || null,
        profile.mbti || null,
        profile.interest || null,
        profile.instagram || null,
        profile.hide_birth_year === true,
        profile.hide_region === true,
        profile.hide_industry === true,
        profile.hide_interest === true,
      ]
    );
    // users 테이블에 uuid 만 보장 (FK 제약 호환). nickname 은 room_members 에서 관리.
    await pool.query(
      `INSERT INTO users (uuid) VALUES ($1) ON CONFLICT (uuid) DO NOTHING`,
      [uuid]
    );
    res.json({ ok: true, room_code: code, nickname: nick });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'NICKNAME_TAKEN' });
    console.error('join error:', err);
    res.status(500).json({ error: 'db error' });
  }
});

// POST /api/tv/attach — 호스트가 페어링 코드 입력해서 TV를 자기 방에 연결
router.post('/tv/attach', async (req, res) => {
  const { code, room_code, host_uuid } = req.body || {};
  if (!code || !room_code || !host_uuid) {
    return res.status(400).json({ error: 'code, room_code, host_uuid required' });
  }
  // 권한 검증
  const room = await pool.query(
    'SELECT host_uuid FROM rooms WHERE room_code = $1', [room_code]
  );
  if (room.rows.length === 0) return res.status(404).json({ error: 'room not found' });
  if (room.rows[0].host_uuid !== host_uuid) return res.status(403).json({ error: 'not authorized' });

  const wsModule = require('./ws');
  const result = wsModule.attachTVToRoom(String(code).toUpperCase(), room_code);
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json({ ok: true });
});

// POST /api/rooms/:code/kick — 호스트가 특정 참가자를 방에서 추방
router.post('/rooms/:code/kick', async (req, res) => {
  const { code } = req.params;
  const host_uuid = req.body.host_uuid || req.body.uuid;
  const target_uuid = req.body.target_uuid;
  if (!target_uuid) return res.status(400).json({ error: 'target_uuid required' });

  const room = await pool.query(
    'SELECT id, host_uuid FROM rooms WHERE room_code = $1', [code]
  );
  if (room.rows.length === 0) return res.status(404).json({ error: 'room not found' });
  if (room.rows[0].host_uuid !== host_uuid) return res.status(403).json({ error: 'not authorized' });
  if (target_uuid === host_uuid) return res.status(400).json({ error: 'cannot kick host' });

  const wsModule = require('./ws');
  // 1) 모든 참가자에게 사용자 강퇴 broadcast (호스트는 list 갱신, 게스트들은 user_left 로 인식)
  wsModule.broadcastToRoom(code, {
    type: 'kicked',
    target_uuid,
    by: 'host',
  });
  // 2) 강퇴된 사용자 ws close (4006) — guest 가 onclose 에서 redirect 처리
  try { wsModule.closeUserWS(code, target_uuid, 4006, 'Kicked by host'); } catch (_) {}

  res.json({ ok: true });
});

// POST /api/rooms/:code/close
router.post('/rooms/:code/close', async (req, res) => {
  const { code } = req.params;
  // host_uuid 또는 uuid 둘 다 허용 (클라이언트 파라미터 호환)
  const host_uuid = req.body.host_uuid || req.body.uuid;

  const room = await pool.query(
    'SELECT id, host_uuid FROM rooms WHERE room_code = $1',
    [code]
  );
  if (room.rows.length === 0) return res.status(404).json({ error: 'room not found' });
  if (room.rows[0].host_uuid !== host_uuid) {
    return res.status(403).json({ error: 'not authorized' });
  }

  await pool.query("UPDATE rooms SET status = 'closed' WHERE room_code = $1", [code]);

  const wsModule = require('./ws');
  wsModule.broadcastToRoom(code, { type: 'room_closed' });

  res.json({ status: 'closed' });
});

// GET /api/rooms/:code/qr
router.get('/rooms/:code/qr', async (req, res) => {
  const { code } = req.params;
  const room = await pool.query('SELECT id FROM rooms WHERE room_code = $1', [code]);
  if (room.rows.length === 0) return res.status(404).json({ error: 'room not found' });

  // Request host + protocol 기반 동적 URL (로컬/스테이징/프로덕션 공통 지원)
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const origin = process.env.PUBLIC_ORIGIN || `${proto}://${host}`;
  const url = `${origin}/room/${code}`;
  try {
    const qr_data_url = await QRCode.toDataURL(url, { width: 300, margin: 2 });
    res.json({ qr_data_url, url });
  } catch (err) {
    console.error('QR error:', err);
    res.status(500).json({ error: 'QR generation failed' });
  }
});

// GET /api/stats — 랜딩 등 공개 페이지용 집계
// live: 현재 열려있는 방 + 활성 참가자 / cumulative: 누적 모임·참여자 (room_members 합산)
router.get('/stats', async (req, res) => {
  res.set('Cache-Control', 'public, max-age=10');
  res.set('Access-Control-Allow-Origin', '*');
  try {
    const wsModule = require('./ws');
    const activeRooms = wsModule.getActiveRoomCodes ? wsModule.getActiveRoomCodes() : [];
    let participants = 0;
    for (const code of activeRooms) {
      participants += wsModule.getRoomClients(code).length;
    }
    // 누적 통계: 의미 있는 모임만 카운트 — 최소 2명 이상 참여한 방 (호스트 단독 테스트 제외)
    // unique_people: 실제 사람 수 (DISTINCT uuid)
    const [totalRoomsRow, totalAttendRow, uniquePeopleRow] = await Promise.all([
      pool.query('SELECT COUNT(*)::int AS cnt FROM rooms r WHERE (SELECT COUNT(*) FROM room_members rm WHERE rm.room_id = r.id) >= 2'),
      pool.query('SELECT COUNT(*)::int AS cnt FROM room_members'),
      pool.query('SELECT COUNT(DISTINCT uuid)::int AS cnt FROM room_members'),
    ]);
    res.json({
      active_rooms: activeRooms.length,
      participants,
      total_rooms: totalRoomsRow.rows[0].cnt,
      total_attendances: totalAttendRow.rows[0].cnt,
      unique_people: uniquePeopleRow.rows[0].cnt,
      updated_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('stats error:', err);
    res.status(500).json({ error: 'stats failed' });
  }
});

// PATCH /api/rooms/:code/display — 호스트가 join wizard 'display' step에서 결정
// body: { uuid, display_fields, birth_year_format, region_detail, photo_enabled }
router.patch('/rooms/:code/display', async (req, res) => {
  const { code } = req.params;
  const { uuid } = req.body;
  if (!uuid) return res.status(400).json({ error: 'uuid required' });
  const room = await pool.query('SELECT id, host_uuid FROM rooms WHERE room_code = $1', [code]);
  if (room.rows.length === 0) return res.status(404).json({ error: 'room not found' });
  if (room.rows[0].host_uuid !== uuid) return res.status(403).json({ error: 'host only' });
  const ALLOWED_FIELDS = ['birth_year', 'region', 'industry', 'interest'];
  let display_fields = Array.isArray(req.body.display_fields)
    ? req.body.display_fields.filter(f => ALLOWED_FIELDS.includes(f))
    : null;
  const birth_year_format = ['exact', 'decade_half', 'decade'].includes(req.body.birth_year_format)
    ? req.body.birth_year_format : null;
  const region_detail = typeof req.body.region_detail === 'boolean' ? req.body.region_detail : null;
  const photo_enabled = typeof req.body.photo_enabled === 'boolean' ? req.body.photo_enabled : null;
  if (!display_fields && !birth_year_format && region_detail === null && photo_enabled === null) {
    return res.status(400).json({ error: 'nothing to update' });
  }
  const updates = [];
  const params = [];
  let i = 1;
  if (display_fields) { updates.push(`display_fields = $${i++}`); params.push(JSON.stringify(display_fields)); }
  if (birth_year_format) { updates.push(`birth_year_format = $${i++}`); params.push(birth_year_format); }
  if (region_detail !== null) { updates.push(`region_detail = $${i++}`); params.push(region_detail); }
  if (photo_enabled !== null) { updates.push(`photo_enabled = $${i++}`); params.push(photo_enabled); }
  params.push(code);
  await pool.query(`UPDATE rooms SET ${updates.join(', ')} WHERE room_code = $${i}`, params);
  res.json({ ok: true });
});

module.exports = router;
