// 일반 사용자 OAuth — Google + Kakao (admin-auth.js 패턴)
//
// 엔드포인트:
//   GET  /api/auth/google         — Google 인증 redirect
//   GET  /api/auth/google/callback
//   GET  /api/auth/kakao          — Kakao 인증 redirect
//   GET  /api/auth/kakao/callback
//   GET  /api/auth/me             — 현재 로그인 정보 (token header)
//   POST /api/auth/logout
//   GET  /api/auth/status         — 활성 provider 목록 (login.html 버튼 노출 결정용)
//
// 환경변수:
//   GOOGLE_CLIENT_ID · GOOGLE_CLIENT_SECRET (admin과 공유)
//   USER_OAUTH_GOOGLE_REDIRECT (기본: https://app.ntable.kr/api/auth/google/callback)
//   KAKAO_REST_API_KEY
//   USER_OAUTH_KAKAO_REDIRECT (기본: https://app.ntable.kr/api/auth/kakao/callback)

const express = require('express');
const crypto = require('crypto');
const router = express.Router();

let pool;
router.init = (dbPool) => { pool = dbPool; };

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';
const KAKAO_AUTH_URL = 'https://kauth.kakao.com/oauth/authorize';
const KAKAO_TOKEN_URL = 'https://kauth.kakao.com/oauth/token';
const KAKAO_USERINFO_URL = 'https://kapi.kakao.com/v2/user/me';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30일

function googleConfigured() {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}
function kakaoConfigured() {
  return !!process.env.KAKAO_REST_API_KEY;
}
function googleRedirect() {
  return process.env.USER_OAUTH_GOOGLE_REDIRECT || 'https://app.ntable.kr/api/auth/google/callback';
}
function kakaoRedirect() {
  return process.env.USER_OAUTH_KAKAO_REDIRECT || 'https://app.ntable.kr/api/auth/kakao/callback';
}

router.get('/auth/status', (req, res) => {
  res.json({ google: googleConfigured(), kakao: kakaoConfigured() });
});

// 안전한 redirect 경로만 허용 — open redirect 방어
function safeRedirect(raw) {
  if (!raw) return '/';
  if (typeof raw !== 'string') return '/';
  // 동일 origin pathname만 허용 (// · http(s):// · 데이터스킴 차단)
  if (!raw.startsWith('/') || raw.startsWith('//')) return '/';
  // 쿼리·해시 포함 가능한 길이 제한
  if (raw.length > 200) return '/';
  return raw;
}

// ─── Google ──────────────────────────────────────────────────────────────────
router.get('/auth/google', (req, res) => {
  if (!googleConfigured()) return res.status(503).send('Google OAuth 미설정');
  const state = crypto.randomBytes(16).toString('hex');
  const redirectTo = safeRedirect(req.query.redirect);
  res.cookie('user_oauth_state', state, { httpOnly: true, secure: true, sameSite: 'lax', maxAge: 10 * 60 * 1000 });
  res.cookie('user_oauth_redirect', redirectTo, { httpOnly: true, secure: true, sameSite: 'lax', maxAge: 10 * 60 * 1000 });
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: googleRedirect(),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    prompt: 'select_account',
    access_type: 'online',
  });
  res.redirect(`${GOOGLE_AUTH_URL}?${params.toString()}`);
});

router.get('/auth/google/callback', async (req, res) => {
  if (!googleConfigured()) return res.status(503).send('Google OAuth 미설정');
  const { code, state, error: gError } = req.query;
  const cookies = (req.headers.cookie || '').split(';').map(s => s.trim());
  const cookieState = cookies.find(c => c.startsWith('user_oauth_state='))?.split('=')[1];
  const redirectCookie = cookies.find(c => c.startsWith('user_oauth_redirect='))?.split('=')[1];
  const finalRedirect = safeRedirect(redirectCookie ? decodeURIComponent(redirectCookie) : '/');
  res.clearCookie('user_oauth_state');
  res.clearCookie('user_oauth_redirect');
  const sep = finalRedirect.includes('?') ? '&' : '?';
  if (gError) return res.redirect(finalRedirect + sep + 'auth_error=' + encodeURIComponent(gError));
  if (!code || !state || !cookieState || state !== cookieState) {
    return res.redirect(finalRedirect + sep + 'auth_error=state');
  }
  try {
    const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code, client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: googleRedirect(), grant_type: 'authorization_code',
      }),
    });
    if (!tokenRes.ok) throw new Error('token_exchange_failed');
    const tok = await tokenRes.json();
    const uiRes = await fetch(GOOGLE_USERINFO_URL, { headers: { Authorization: `Bearer ${tok.access_token}` } });
    if (!uiRes.ok) throw new Error('userinfo_failed');
    const ui = await uiRes.json();
    if (!ui.email || !ui.email_verified) return res.redirect(finalRedirect + sep + 'auth_error=email_unverified');
    const token = await upsertUserAndIssueSession({
      provider: 'google', sub: ui.sub, email: ui.email, name: ui.name, picture: ui.picture,
      ip: (req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim(),
      user_agent: (req.headers['user-agent'] || '').slice(0, 500),
    });
    res.redirect(finalRedirect + sep + 'auth_token=' + token);
  } catch (err) {
    console.error('[user-auth google]', err);
    res.redirect(finalRedirect + sep + 'auth_error=server');
  }
});

// ─── Kakao ───────────────────────────────────────────────────────────────────
router.get('/auth/kakao', (req, res) => {
  if (!kakaoConfigured()) return res.status(503).send('Kakao OAuth 미설정');
  const state = crypto.randomBytes(16).toString('hex');
  const redirectTo = safeRedirect(req.query.redirect);
  res.cookie('user_oauth_state', state, { httpOnly: true, secure: true, sameSite: 'lax', maxAge: 10 * 60 * 1000 });
  res.cookie('user_oauth_redirect', redirectTo, { httpOnly: true, secure: true, sameSite: 'lax', maxAge: 10 * 60 * 1000 });
  const params = new URLSearchParams({
    client_id: process.env.KAKAO_REST_API_KEY,
    redirect_uri: kakaoRedirect(),
    response_type: 'code',
    state,
  });
  res.redirect(`${KAKAO_AUTH_URL}?${params.toString()}`);
});

router.get('/auth/kakao/callback', async (req, res) => {
  if (!kakaoConfigured()) return res.status(503).send('Kakao OAuth 미설정');
  const { code, state, error: kError } = req.query;
  const cookies = (req.headers.cookie || '').split(';').map(s => s.trim());
  const cookieState = cookies.find(c => c.startsWith('user_oauth_state='))?.split('=')[1];
  const redirectCookie = cookies.find(c => c.startsWith('user_oauth_redirect='))?.split('=')[1];
  const finalRedirect = safeRedirect(redirectCookie ? decodeURIComponent(redirectCookie) : '/');
  res.clearCookie('user_oauth_state');
  res.clearCookie('user_oauth_redirect');
  const sep = finalRedirect.includes('?') ? '&' : '?';
  if (kError) return res.redirect(finalRedirect + sep + 'auth_error=' + encodeURIComponent(kError));
  if (!code || !state || !cookieState || state !== cookieState) {
    return res.redirect(finalRedirect + sep + 'auth_error=state');
  }
  try {
    console.log('[user-auth kakao] callback start, redirect_uri=', kakaoRedirect());
    const tokenParams = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: process.env.KAKAO_REST_API_KEY,
      redirect_uri: kakaoRedirect(),
      code,
    });
    if (process.env.KAKAO_CLIENT_SECRET) {
      tokenParams.set('client_secret', process.env.KAKAO_CLIENT_SECRET);
    }
    const tokenRes = await fetch(KAKAO_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenParams,
    });
    if (!tokenRes.ok) {
      const errBody = await tokenRes.text().catch(() => '');
      console.error('[user-auth kakao] token exchange failed', tokenRes.status, errBody);
      throw new Error('token_exchange:' + tokenRes.status);
    }
    const tok = await tokenRes.json();
    const uiRes = await fetch(KAKAO_USERINFO_URL, { headers: { Authorization: `Bearer ${tok.access_token}` } });
    if (!uiRes.ok) {
      const errBody = await uiRes.text().catch(() => '');
      console.error('[user-auth kakao] userinfo failed', uiRes.status, errBody);
      throw new Error('userinfo:' + uiRes.status);
    }
    const ui = await uiRes.json();
    console.log('[user-auth kakao] userinfo received', { id: ui.id, hasAccount: !!ui.kakao_account });
    const sub = String(ui.id || '');
    if (!sub) throw new Error('no_kakao_id');
    const account = ui.kakao_account || {};
    const profile = account.profile || {};
    const token = await upsertUserAndIssueSession({
      provider: 'kakao', sub,
      email: account.email || null,
      name: profile.nickname || null,
      picture: profile.profile_image_url || null,
      ip: (req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim(),
      user_agent: (req.headers['user-agent'] || '').slice(0, 500),
    });
    res.redirect(finalRedirect + sep + 'auth_token=' + token);
  } catch (err) {
    console.error('[user-auth kakao] FATAL', err.message, err.stack);
    res.redirect(finalRedirect + sep + 'auth_error=' + encodeURIComponent(err.message || 'server'));
  }
});

// ─── 공용 — user upsert + session 발급 ────────────────────────────────────────
async function upsertUserAndIssueSession({ provider, sub, email, name, picture, ip, user_agent }) {
  const subCol = provider === 'google' ? 'google_sub' : 'kakao_sub';
  // 기존 user 찾기
  const existing = await pool.query(`SELECT uuid FROM users WHERE ${subCol} = $1`, [sub]);
  let uuid;
  if (existing.rows.length) {
    uuid = existing.rows[0].uuid;
    await pool.query(
      `UPDATE users SET email = COALESCE($1, email), name = COALESCE($2, name), picture = COALESCE($3, picture), last_login_at = NOW() WHERE uuid = $4`,
      [email, name, picture, uuid]
    );
  } else {
    uuid = (crypto.randomUUID && crypto.randomUUID()) || ('u-' + crypto.randomBytes(8).toString('hex'));
    await pool.query(
      `INSERT INTO users (uuid, ${subCol}, email, name, picture, last_login_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (uuid) DO UPDATE SET ${subCol} = EXCLUDED.${subCol}, email = EXCLUDED.email, name = EXCLUDED.name, picture = EXCLUDED.picture, last_login_at = NOW()`,
      [uuid, sub, email, name, picture]
    );
  }
  const token = crypto.randomBytes(48).toString('hex');
  await pool.query(
    `INSERT INTO user_sessions (token, user_uuid, expires_at, ip, user_agent) VALUES ($1, $2, $3, $4, $5)`,
    [token, uuid, new Date(Date.now() + SESSION_TTL_MS), ip || null, user_agent || null]
  );
  return token;
}

// ─── /api/auth/me ────────────────────────────────────────────────────────────
router.get('/auth/me', async (req, res) => {
  const token = req.headers['x-user-token'] || req.query.token;
  if (!token) return res.json({ authed: false });
  try {
    const r = await pool.query(
      `SELECT u.uuid, u.email, u.name, u.picture,
              u.google_sub IS NOT NULL AS google,
              u.kakao_sub IS NOT NULL AS kakao,
              u.gender, u.birth_year, u.region, u.industry, u.mbti, u.interest, u.instagram
         FROM user_sessions s JOIN users u ON u.uuid = s.user_uuid
        WHERE s.token = $1 AND s.expires_at > NOW()`,
      [token]
    );
    if (r.rows.length === 0) return res.json({ authed: false });
    res.json({ authed: true, ...r.rows[0] });
  } catch (err) {
    console.error('[user-auth me]', err);
    res.status(500).json({ error: 'db' });
  }
});

router.post('/auth/logout', async (req, res) => {
  const token = req.headers['x-user-token'];
  if (token) { try { await pool.query('DELETE FROM user_sessions WHERE token = $1', [token]); } catch (_) {} }
  res.json({ ok: true });
});

// POST /api/auth/link-device — OAuth 로그인된 사용자가 device의 demo_uuid를 user.uuid로 묶음
// body: { old_uuid }, headers: x-user-token
// 효과: rooms.host_uuid · room_members.uuid · member_results.uuid 전체를 user.uuid로 마이그레이션
router.post('/auth/link-device', async (req, res) => {
  const token = req.headers['x-user-token'];
  if (!token) return res.status(401).json({ error: 'no_token' });
  const { old_uuid } = req.body || {};
  if (!old_uuid) return res.status(400).json({ error: 'old_uuid required' });
  try {
    const sess = await pool.query(
      'SELECT user_uuid FROM user_sessions WHERE token = $1 AND expires_at > NOW()',
      [token]
    );
    if (sess.rows.length === 0) return res.status(401).json({ error: 'invalid_token' });
    const user_uuid = sess.rows[0].user_uuid;
    if (user_uuid === old_uuid) return res.json({ ok: true, user_uuid, migrated: false });

    // rooms.host_uuid 마이그레이션
    const roomsUpd = await pool.query(
      'UPDATE rooms SET host_uuid = $1 WHERE host_uuid = $2',
      [user_uuid, old_uuid]
    );
    // room_members.uuid 마이그레이션 — 충돌 가능 (같은 방에 양쪽 uuid로 join한 경우): 그 행은 skip
    const conflictRows = await pool.query(
      `SELECT rm1.room_id FROM room_members rm1
        WHERE rm1.uuid = $1
          AND EXISTS (SELECT 1 FROM room_members rm2 WHERE rm2.room_id = rm1.room_id AND rm2.uuid = $2)`,
      [old_uuid, user_uuid]
    );
    const conflictRoomIds = conflictRows.rows.map(r => r.room_id);
    if (conflictRoomIds.length > 0) {
      await pool.query(
        `UPDATE room_members SET uuid = $1
          WHERE uuid = $2 AND room_id NOT IN (${conflictRoomIds.map((_, i) => '$' + (i + 3)).join(',')})`,
        [user_uuid, old_uuid, ...conflictRoomIds]
      );
    } else {
      await pool.query('UPDATE room_members SET uuid = $1 WHERE uuid = $2', [user_uuid, old_uuid]);
    }
    // member_results.uuid 마이그레이션 — 동일 충돌 방어
    const mrConflict = await pool.query(
      `SELECT mr1.room_id FROM member_results mr1
        WHERE mr1.uuid = $1
          AND EXISTS (SELECT 1 FROM member_results mr2 WHERE mr2.room_id = mr1.room_id AND mr2.uuid = $2)`,
      [old_uuid, user_uuid]
    );
    const mrConflictIds = mrConflict.rows.map(r => r.room_id);
    if (mrConflictIds.length > 0) {
      await pool.query(
        `UPDATE member_results SET uuid = $1
          WHERE uuid = $2 AND room_id NOT IN (${mrConflictIds.map((_, i) => '$' + (i + 3)).join(',')})`,
        [user_uuid, old_uuid, ...mrConflictIds]
      );
    } else {
      await pool.query('UPDATE member_results SET uuid = $1 WHERE uuid = $2', [user_uuid, old_uuid]);
    }
    res.json({
      ok: true,
      user_uuid,
      migrated: true,
      rooms_updated: roomsUpd.rowCount,
      conflicts_skipped: conflictRoomIds.length + mrConflictIds.length,
    });
  } catch (err) {
    console.error('[user-auth link-device]', err);
    res.status(500).json({ error: 'db' });
  }
});

// PUT /api/auth/profile — 방 입장 시 입력한 profile 을 user 에도 저장 (다음 모임 prefill 용)
router.put('/auth/profile', async (req, res) => {
  const token = req.headers['x-user-token'];
  if (!token) return res.status(401).json({ error: 'no_token' });
  const session = await pool.query(
    'SELECT user_uuid FROM user_sessions WHERE token = $1 AND expires_at > NOW()',
    [token]
  );
  if (session.rows.length === 0) return res.status(401).json({ error: 'invalid_session' });
  const uuid = session.rows[0].user_uuid;
  const { gender, birth_year, region, industry, mbti, interest, instagram } = req.body || {};
  try {
    await pool.query(
      `UPDATE users SET
         gender = COALESCE($1, gender),
         birth_year = COALESCE($2, birth_year),
         region = COALESCE($3, region),
         industry = COALESCE($4, industry),
         mbti = COALESCE($5, mbti),
         interest = COALESCE($6, interest),
         instagram = COALESCE($7, instagram)
       WHERE uuid = $8`,
      [gender || null, birth_year || null, region || null, industry || null, mbti || null, interest || null, instagram || null, uuid]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[user-auth profile]', err);
    res.status(500).json({ error: 'db' });
  }
});

module.exports = router;
