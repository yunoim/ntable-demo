// Google OAuth 2.0 관리자 로그인 플로우
// 엔드포인트:
//   GET  /api/admin/auth/google           — Google 인증 URL 로 리다이렉트
//   GET  /api/admin/auth/google/callback  — code → token → userinfo → 세션 발급
//   POST /api/admin/auth/logout           — 현재 세션 무효화
//   GET  /api/admin/me                    — 현재 로그인한 관리자 정보
//
// 환경변수:
//   GOOGLE_CLIENT_ID · GOOGLE_CLIENT_SECRET · ADMIN_OAUTH_REDIRECT_URI
//
// 세션 발급 시 admin_sessions 에 토큰 저장 + httpOnly 쿠키 + JSON 응답.
// 클라이언트는 localStorage('admin_token') 에 토큰 저장 (기존 password 방식과 호환).

const express = require('express');
const crypto = require('crypto');
const router = express.Router();

let pool;

router.init = (dbPool) => { pool = dbPool; };

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7일

function oauthConfigured() {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

function getRedirectUri() {
  return process.env.ADMIN_OAUTH_REDIRECT_URI
    || 'https://admin.ntable.kr/api/admin/auth/google/callback';
}

// GET /api/admin/auth/status — OAuth 활성 여부 (UI 에서 버튼 노출 결정용)
router.get('/admin/auth/status', (req, res) => {
  res.json({ oauth_available: oauthConfigured() });
});

// GET /api/admin/auth/google
router.get('/admin/auth/google', (req, res) => {
  if (!oauthConfigured()) {
    return res.status(503).json({ error: 'OAUTH_UNCONFIGURED', message: 'Google OAuth 환경변수가 설정되지 않았어요' });
  }
  const state = crypto.randomBytes(16).toString('hex');
  // 단순화: state 를 쿠키로 전달 (httpOnly). production 에선 반드시 사용 확인.
  res.cookie('admin_oauth_state', state, {
    httpOnly: true, secure: true, sameSite: 'lax', maxAge: 10 * 60 * 1000,
  });
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: getRedirectUri(),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    prompt: 'select_account',
    access_type: 'online',
  });
  res.redirect(`${GOOGLE_AUTH_URL}?${params.toString()}`);
});

// GET /api/admin/auth/google/callback
router.get('/admin/auth/google/callback', async (req, res) => {
  if (!oauthConfigured()) {
    return res.status(503).send('OAuth 미설정');
  }
  const { code, state, error: gError } = req.query;
  const cookieState = (req.headers.cookie || '')
    .split(';').map(s => s.trim())
    .find(c => c.startsWith('admin_oauth_state='))?.split('=')[1];
  res.clearCookie('admin_oauth_state');

  if (gError) return res.redirect('/admin?error=' + encodeURIComponent(gError));
  if (!code) return res.redirect('/admin?error=no_code');
  if (!state || !cookieState || state !== cookieState) {
    return res.redirect('/admin?error=state_mismatch');
  }

  try {
    // code → access_token
    const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: getRedirectUri(),
        grant_type: 'authorization_code',
      }),
    });
    if (!tokenRes.ok) throw new Error('token_exchange_failed');
    const tok = await tokenRes.json();

    // access_token → userinfo
    const uiRes = await fetch(GOOGLE_USERINFO_URL, {
      headers: { Authorization: `Bearer ${tok.access_token}` },
    });
    if (!uiRes.ok) throw new Error('userinfo_failed');
    const ui = await uiRes.json();
    // ui: { sub, email, email_verified, name, picture, ... }

    if (!ui.email || !ui.email_verified) {
      return res.redirect('/admin?error=email_unverified');
    }

    // 화이트리스트 검증
    const lookup = await pool.query(
      'SELECT id, email, role, active FROM admin_users WHERE email = $1',
      [ui.email]
    );
    if (lookup.rows.length === 0 || !lookup.rows[0].active) {
      return res.redirect('/admin?error=not_allowed');
    }
    const admin_id = lookup.rows[0].id;

    // 계정 정보 최신화
    await pool.query(
      `UPDATE admin_users
          SET google_sub = $1, name = $2, picture = $3, last_login_at = NOW()
        WHERE id = $4`,
      [ui.sub, ui.name || null, ui.picture || null, admin_id]
    );

    // 세션 발급
    const token = crypto.randomBytes(48).toString('hex');
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await pool.query(
      `INSERT INTO admin_sessions (token, admin_id, expires_at, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        token, admin_id, expiresAt,
        (req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim(),
        (req.headers['user-agent'] || '').slice(0, 500),
      ]
    );

    // admin.html 이 URL 해시로 토큰 받아서 localStorage 저장하도록
    res.redirect(`/admin#token=${token}`);
  } catch (err) {
    console.error('[admin-auth] callback error:', err);
    res.redirect('/admin?error=server');
  }
});

// POST /api/admin/auth/logout
router.post('/admin/auth/logout', async (req, res) => {
  const token = req.headers['x-admin-token'];
  if (token) {
    try {
      await pool.query('DELETE FROM admin_sessions WHERE token = $1', [token]);
    } catch (_) {}
  }
  res.json({ success: true });
});

// GET /api/admin/me
router.get('/admin/me', async (req, res) => {
  const token = req.headers['x-admin-token'];
  if (!token) return res.status(401).json({ error: 'no_token' });
  try {
    const r = await pool.query(
      `SELECT a.id, a.email, a.name, a.picture, a.role, a.tenant_id
         FROM admin_sessions s
         JOIN admin_users a ON a.id = s.admin_id
        WHERE s.token = $1 AND s.expires_at > NOW() AND a.active = true`,
      [token]
    );
    if (r.rows.length === 0) return res.status(401).json({ error: 'invalid_session' });
    res.json(r.rows[0]);
  } catch (err) {
    console.error('[admin-auth] me error:', err);
    res.status(500).json({ error: 'db_error' });
  }
});

// Middleware — OAuth 세션 토큰 검증 (panel.js 에서 사용)
async function verifyOAuthToken(token) {
  if (!token) return null;
  try {
    const r = await pool.query(
      `SELECT a.id, a.email, a.role, a.tenant_id
         FROM admin_sessions s
         JOIN admin_users a ON a.id = s.admin_id
        WHERE s.token = $1 AND s.expires_at > NOW() AND a.active = true`,
      [token]
    );
    return r.rows[0] || null;
  } catch {
    return null;
  }
}

router.verifyOAuthToken = verifyOAuthToken;

module.exports = router;
