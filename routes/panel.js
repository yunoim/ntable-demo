// routes/panel.js
// 플랫폼 운영자용 관리자 API
// 인증: ADMIN_PASSWORD 환경변수 (미설정 시 'admin123')

const express = require('express');
const router = express.Router();
const { pool } = require('../db');

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (!token || token !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'UNAUTHORIZED' });
  }
  next();
}

// POST /api/panel/login
router.post('/panel/login', (req, res) => {
  const { password } = req.body || {};
  if (!password || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'INVALID_PASSWORD' });
  }
  // 간단히 password 자체를 토큰으로 사용 (단일 관리자 가정)
  res.json({ token: ADMIN_PASSWORD });
});

// GET /api/panel/stats
router.get('/panel/stats', requireAdmin, async (req, res) => {
  try {
    const [users, rooms, surveys, memberResults] = await Promise.all([
      pool.query('SELECT COUNT(*)::int AS cnt FROM users'),
      pool.query(`SELECT status, COUNT(*)::int AS cnt FROM rooms GROUP BY status`),
      pool.query(`SELECT
          COUNT(*)::int AS cnt,
          AVG(satisfaction)::float AS avg_sat,
          AVG(nps)::float AS avg_nps,
          SUM(CASE WHEN revisit THEN 1 ELSE 0 END)::int AS revisit_yes
        FROM survey_responses`),
      pool.query('SELECT COUNT(*)::int AS cnt FROM member_results'),
    ]);

    const roomsByStatus = { waiting: 0, open: 0, closed: 0 };
    for (const row of rooms.rows) {
      roomsByStatus[row.status] = row.cnt;
    }

    res.json({
      users: users.rows[0].cnt,
      rooms: {
        total: rooms.rows.reduce((a, r) => a + r.cnt, 0),
        ...roomsByStatus,
      },
      surveys: {
        total: surveys.rows[0].cnt,
        avg_satisfaction: Number((surveys.rows[0].avg_sat || 0).toFixed(2)),
        avg_nps: Number((surveys.rows[0].avg_nps || 0).toFixed(2)),
        revisit_yes: surveys.rows[0].revisit_yes || 0,
      },
      member_results: memberResults.rows[0].cnt,
    });
  } catch (err) {
    console.error('[panel] stats error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/panel/rooms?status=&limit=
router.get('/panel/rooms', requireAdmin, async (req, res) => {
  const { status } = req.query;
  const limit = Math.min(parseInt(req.query.limit || '100', 10) || 100, 500);
  try {
    let sql = `
      SELECT r.id, r.room_code, r.title, r.host_role, r.status, r.created_at,
             u.nickname AS host_nickname, u.uuid AS host_uuid,
             (SELECT COUNT(*)::int FROM member_results mr WHERE mr.room_id = r.id) AS participants
        FROM rooms r
        LEFT JOIN users u ON u.uuid = r.host_uuid`;
    const args = [];
    if (status) { sql += ` WHERE r.status = $1`; args.push(status); }
    sql += ` ORDER BY r.created_at DESC LIMIT ${limit}`;
    const { rows } = await pool.query(sql, args);
    res.json(rows);
  } catch (err) {
    console.error('[panel] rooms error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/panel/rooms/:code
router.get('/panel/rooms/:code', requireAdmin, async (req, res) => {
  const { code } = req.params;
  try {
    const room = await pool.query(
      `SELECT r.*, u.nickname AS host_nickname
         FROM rooms r LEFT JOIN users u ON u.uuid = r.host_uuid
        WHERE r.room_code = $1`,
      [code]
    );
    if (!room.rows.length) return res.status(404).json({ error: 'room not found' });

    const state = await pool.query('SELECT state_json, updated_at FROM room_state WHERE room_id = $1', [room.rows[0].id]);
    const members = await pool.query(
      `SELECT mr.uuid, mr.votes_json, mr.match_json, mr.fi_count, u.nickname, u.gender, u.birth_year, u.mbti
         FROM member_results mr LEFT JOIN users u ON u.uuid = mr.uuid
        WHERE mr.room_id = $1`,
      [room.rows[0].id]
    );
    const surveys = await pool.query(
      'SELECT * FROM survey_responses WHERE room_id = $1 ORDER BY created_at DESC',
      [room.rows[0].id]
    );

    res.json({
      room: room.rows[0],
      state: state.rows[0] || null,
      members: members.rows,
      surveys: surveys.rows,
    });
  } catch (err) {
    console.error('[panel] room detail error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/panel/rooms/:code/close
router.post('/panel/rooms/:code/close', requireAdmin, async (req, res) => {
  const { code } = req.params;
  try {
    const result = await pool.query(
      "UPDATE rooms SET status = 'closed' WHERE room_code = $1 RETURNING id",
      [code]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'room not found' });

    const wsModule = require('./ws');
    try { wsModule.broadcastToRoom(code, { type: 'room_closed' }); } catch {}
    res.json({ status: 'closed' });
  } catch (err) {
    console.error('[panel] close room error:', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/panel/rooms/:code
router.delete('/panel/rooms/:code', requireAdmin, async (req, res) => {
  const { code } = req.params;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query('SELECT id FROM rooms WHERE room_code = $1', [code]);
    if (!r.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'room not found' });
    }
    const room_id = r.rows[0].id;
    await client.query('DELETE FROM member_results WHERE room_id = $1', [room_id]);
    await client.query('DELETE FROM survey_responses WHERE room_id = $1', [room_id]);
    await client.query('DELETE FROM room_state WHERE room_id = $1', [room_id]);
    await client.query('DELETE FROM rooms WHERE id = $1', [room_id]);
    await client.query('COMMIT');
    res.json({ deleted: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[panel] delete room error:', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// GET /api/panel/users?limit=
router.get('/panel/users', requireAdmin, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '200', 10) || 200, 1000);
  const search = (req.query.q || '').trim();
  try {
    let sql = `
      SELECT u.*,
             (SELECT COUNT(*)::int FROM rooms r WHERE r.host_uuid = u.uuid) AS hosted_rooms,
             (SELECT COUNT(*)::int FROM member_results mr WHERE mr.uuid = u.uuid) AS participations
        FROM users u`;
    const args = [];
    if (search) { sql += ` WHERE u.nickname ILIKE $1`; args.push(`%${search}%`); }
    sql += ` ORDER BY u.created_at DESC LIMIT ${limit}`;
    const { rows } = await pool.query(sql, args);
    res.json(rows);
  } catch (err) {
    console.error('[panel] users error:', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/panel/users/:uuid
router.delete('/panel/users/:uuid', requireAdmin, async (req, res) => {
  const { uuid } = req.params;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // 해당 유저의 흔적 정리
    await client.query('DELETE FROM member_results WHERE uuid = $1', [uuid]);
    await client.query('DELETE FROM survey_responses WHERE uuid = $1', [uuid]);
    // 호스트로 등록된 방도 닫기 (삭제 대신 안전)
    await client.query("UPDATE rooms SET status = 'closed' WHERE host_uuid = $1 AND status != 'closed'", [uuid]);
    await client.query('DELETE FROM users WHERE uuid = $1', [uuid]);
    await client.query('COMMIT');
    res.json({ deleted: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[panel] delete user error:', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// GET /api/panel/surveys?limit=
router.get('/panel/surveys', requireAdmin, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '50', 10) || 50, 500);
  try {
    const { rows } = await pool.query(
      `SELECT s.*, u.nickname, r.room_code, r.title AS room_title
         FROM survey_responses s
         LEFT JOIN users u ON u.uuid = s.uuid
         LEFT JOIN rooms r ON r.id = s.room_id
        ORDER BY s.created_at DESC
        LIMIT ${limit}`
    );
    res.json(rows);
  } catch (err) {
    console.error('[panel] surveys error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
