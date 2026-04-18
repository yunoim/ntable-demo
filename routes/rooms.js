const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const QRCode = require('qrcode');
const { listPacks, getPack, DEFAULT_PACK_ID } = require('./question-sources');

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

  // uuid 검증
  const userCheck = await pool.query('SELECT uuid FROM users WHERE uuid = $1', [uuid]);
  if (userCheck.rows.length === 0) {
    return res.status(404).json({ error: 'user not found' });
  }

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
      `INSERT INTO rooms (room_code, title, host_uuid, host_role, status, question_count, questions_json, free_topics_json, pack_id)
       VALUES ($1, $2, $3, $4, 'waiting', $5, $6, $7, $8) RETURNING id`,
      [
        room_code, title, uuid, host_role, question_count,
        JSON.stringify(questionsSeed),
        JSON.stringify(topicsSeed),
        pack.id,
      ]
    );
    const room_id = roomResult.rows[0].id;
    await client.query(
      `INSERT INTO room_state (room_id, state_json, updated_at)
       VALUES ($1, $2, NOW())`,
      [room_id, JSON.stringify({ phase: 'waiting', current_tab: 'intro', question_index: 0 })]
    );
    await client.query('COMMIT');
    res.json({ room_code, title, host_role, question_count, pack_id: pack.id });
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
    'SELECT room_code, title, host_uuid, host_role, status, question_count, pack_id FROM rooms WHERE room_code = $1',
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
router.get('/rooms/:code/members', async (req, res) => {
  const { code } = req.params;
  const room = await pool.query('SELECT id FROM rooms WHERE room_code = $1', [code]);
  if (room.rows.length === 0) return res.status(404).json({ error: 'room not found' });

  const wsModule = require('./ws');
  const clients = wsModule.getRoomClients(code); // [uuid, ...]

  if (clients.length === 0) return res.json([]);

  const placeholders = clients.map((_, i) => `$${i + 1}`).join(',');
  const users = await pool.query(
    `SELECT uuid, nickname, gender, birth_year, mbti, interest
     FROM users WHERE uuid IN (${placeholders})`,
    clients
  );
  res.json(users.rows);
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

// GET /api/stats — 랜딩 등 공개 페이지용 라이브 집계
// 현재 열려있는 방 수 + 활성 참가자 총합 (waiting/열림 상태 기준)
router.get('/stats', async (req, res) => {
  res.set('Cache-Control', 'public, max-age=10');
  res.set('Access-Control-Allow-Origin', '*');
  try {
    const wsModule = require('./ws');
    // 메모리 기준 활성 방 — WS 세션이 하나 이상 붙어있는 방
    const activeRooms = wsModule.getActiveRoomCodes ? wsModule.getActiveRoomCodes() : [];
    let participants = 0;
    for (const code of activeRooms) {
      participants += wsModule.getRoomClients(code).length;
    }
    res.json({
      active_rooms: activeRooms.length,
      participants,
      updated_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('stats error:', err);
    res.status(500).json({ error: 'stats failed' });
  }
});

module.exports = router;
