// routes/panel.js
// 플랫폼 운영자용 관리자 API
// 인증: Google OAuth 세션 토큰 (권장) 또는 ADMIN_PASSWORD (레거시, OAuth 확인 후 제거 예정)

const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const adminAuth = require('./admin-auth');

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

// 인증 미들웨어 — OAuth 우선, password 폴백
async function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (!token) return res.status(401).json({ error: 'UNAUTHORIZED' });

  // 1) OAuth 토큰 검증
  const oauthUser = await adminAuth.verifyOAuthToken(token);
  if (oauthUser) {
    req.admin = oauthUser;
    return next();
  }

  // 2) 레거시 password 토큰 허용 (OAuth 설정 전 환경)
  if (token === ADMIN_PASSWORD) {
    req.admin = { email: 'legacy-admin', role: 'super_admin', legacy: true };
    return next();
  }

  return res.status(401).json({ error: 'UNAUTHORIZED' });
}

// POST /api/panel/login — 비밀번호 로그인 (레거시)
router.post('/panel/login', (req, res) => {
  const { password } = req.body || {};
  if (!password || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'INVALID_PASSWORD' });
  }
  res.json({ token: ADMIN_PASSWORD, method: 'password' });
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

// GET /api/panel/live-snapshot — 실시간 방·참가자 (WS 메모리)
router.get('/panel/live-snapshot', requireAdmin, async (req, res) => {
  try {
    const wsModule = require('./ws');
    const codes = wsModule.getActiveRoomCodes ? wsModule.getActiveRoomCodes() : [];
    let participants = 0;
    const rooms = [];
    for (const code of codes) {
      const members = wsModule.getRoomClients(code);
      participants += members.length;
      rooms.push({ room_code: code, members: members.length });
    }
    // 오늘 0시 이후 생성된 방 수
    const today = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM rooms WHERE created_at >= CURRENT_DATE`
    );
    res.json({
      active_rooms: codes.length,
      participants,
      rooms_created_today: today.rows[0].cnt,
      rooms,
      updated_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[panel] live-snapshot error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/panel/packs-usage — 팩별 방 생성 분포
router.get('/panel/packs-usage', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT COALESCE(pack_id, '(unknown)') AS pack_id,
              COUNT(*)::int AS rooms,
              COUNT(*) FILTER (WHERE status = 'closed')::int AS closed,
              COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE - INTERVAL '7 days')::int AS last_7d
         FROM rooms
        GROUP BY pack_id
        ORDER BY rooms DESC`
    );
    res.json(rows);
  } catch (err) {
    console.error('[panel] packs-usage error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/panel/nps-trend — 주간 NPS 평균·응답수
router.get('/panel/nps-trend', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT DATE_TRUNC('week', created_at)::date AS week,
              COUNT(*)::int AS responses,
              AVG(nps)::float AS avg_nps,
              AVG(satisfaction)::float AS avg_satisfaction,
              SUM(CASE WHEN revisit THEN 1 ELSE 0 END)::int AS revisit_yes
         FROM survey_responses
        WHERE created_at >= NOW() - INTERVAL '12 weeks'
        GROUP BY week
        ORDER BY week ASC`
    );
    res.json(rows.map(r => ({
      week: r.week,
      responses: r.responses,
      avg_nps: r.avg_nps ? Number(r.avg_nps.toFixed(2)) : null,
      avg_satisfaction: r.avg_satisfaction ? Number(r.avg_satisfaction.toFixed(2)) : null,
      revisit_rate: r.responses ? Number((r.revisit_yes / r.responses).toFixed(2)) : null,
    })));
  } catch (err) {
    console.error('[panel] nps-trend error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/panel/hosts-leaderboard — 호스트별 평균 NPS·만족도·호스트 별점
router.get('/panel/hosts-leaderboard', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT u.uuid, u.nickname,
              COUNT(DISTINCT r.id)::int AS rooms_hosted,
              COUNT(sr.id)::int AS responses,
              AVG(sr.nps)::float AS avg_nps,
              AVG(sr.satisfaction)::float AS avg_satisfaction,
              AVG(sr.host_rating)::float AS avg_host_rating
         FROM users u
         JOIN rooms r ON r.host_uuid = u.uuid
         LEFT JOIN survey_responses sr ON sr.room_id = r.id AND sr.uuid != u.uuid
        GROUP BY u.uuid, u.nickname
       HAVING COUNT(sr.id) > 0
        ORDER BY avg_nps DESC NULLS LAST
        LIMIT 50`
    );
    res.json(rows.map(r => ({
      uuid: r.uuid,
      nickname: r.nickname,
      rooms_hosted: r.rooms_hosted,
      responses: r.responses,
      avg_nps: r.avg_nps != null ? Number(r.avg_nps.toFixed(2)) : null,
      avg_satisfaction: r.avg_satisfaction != null ? Number(r.avg_satisfaction.toFixed(2)) : null,
      avg_host_rating: r.avg_host_rating != null ? Number(r.avg_host_rating.toFixed(2)) : null,
    })));
  } catch (err) {
    console.error('[panel] hosts-leaderboard error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/panel/match-success — 매칭 성공률 (match_json.pairs 의 mutual 비율)
router.get('/panel/match-success', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT r.room_code, r.title, r.created_at,
              (SELECT COUNT(*)::int FROM member_results mr WHERE mr.room_id = r.id) AS participants,
              COALESCE(
                (SELECT jsonb_array_length(mr2.match_json->'pairs')
                   FROM member_results mr2
                  WHERE mr2.room_id = r.id AND mr2.match_json ? 'pairs'
                  LIMIT 1),
                0
              )::int AS pair_count
         FROM rooms r
        WHERE r.status = 'closed'
          AND r.created_at >= NOW() - INTERVAL '30 days'
        ORDER BY r.created_at DESC
        LIMIT 50`
    );
    // 요약 집계
    const totalRooms = rows.length;
    const roomsWithPairs = rows.filter(r => r.pair_count > 0).length;
    res.json({
      rooms: rows,
      summary: {
        total_rooms_30d: totalRooms,
        rooms_with_match_30d: roomsWithPairs,
        match_rate: totalRooms ? Number((roomsWithPairs / totalRooms).toFixed(2)) : null,
      },
    });
  } catch (err) {
    console.error('[panel] match-success error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
