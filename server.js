require('dotenv').config();

// Sentry 는 다른 import 보다 먼저 초기화 — auto-instrumentation 위해.
const Sentry = require('./sentry');

const express = require('express');
const http = require('http');
const cors = require('cors');
const path = require('path');
const { initDB } = require('./db');
const authRouter = require('./routes/auth');
const roomsRouter = require('./routes/rooms');
const wsRouter = require('./routes/ws');
const adminRouter = require('./routes/admin');
const surveyRouter = require('./routes/survey');
const aiRouter = require('./routes/ai');
const panelRouter = require('./routes/panel');
const adminAuthRouter = require('./routes/admin-auth');
const userAuthRouter = require('./routes/user-auth');

const app = express();

// CORS — app 우선, demo/ntable.kr/admin 도 포함
app.use(cors({
  origin: [
    'https://app.ntable.kr',
    'https://admin.ntable.kr',
    'https://demo.ntable.kr',
    'https://ntable.kr',
    'https://www.ntable.kr',
    'http://localhost:3000',
    'http://localhost:3001',
  ],
  credentials: true,
}));

// 모임장별 라우팅
// - demo.ntable.kr → app.ntable.kr 로 301 redirect (기존 QR·공유 링크 보호)
// - admin.ntable.kr → /admin·/api/* 외 경로는 /admin 으로 정돈 (관리자 전용 도메인)
app.use((req, res, next) => {
  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').toLowerCase();
  if (host === 'demo.ntable.kr') {
    return res.redirect(301, `https://app.ntable.kr${req.originalUrl}`);
  }
  if (host === 'admin.ntable.kr') {
    const p = req.path;
    const isAdminPath = p === '/admin' || p.startsWith('/admin/');
    const isApi = p.startsWith('/api/');
    const isStaticAsset = /\.(css|js|png|jpg|jpeg|svg|ico|woff2?|ttf|map)$/i.test(p);
    const isSentryConfig = p === '/api/sentry-config';
    if (!isAdminPath && !isApi && !isStaticAsset && !isSentryConfig) {
      return res.redirect(301, `https://admin.ntable.kr/admin${req.originalUrl === '/' ? '' : req.originalUrl}`);
    }
  }
  next();
});

// Body parser
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// Sentry 브라우저 config (DSN 을 런타임에 주입 — 코드에 하드코딩 금지)
app.get('/api/sentry-config', (req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json({
    dsn: process.env.SENTRY_DSN_CLIENT || '',
    environment: process.env.SENTRY_ENVIRONMENT || 'development',
    release: process.env.SENTRY_RELEASE || '0.1.0',
  });
});

// 외부 공유 SDK 키 (없으면 빈 값 → 클라이언트가 graceful fallback)
app.get('/api/share-config', (req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json({
    kakaoJsKey: process.env.KAKAO_JS_KEY || '',
  });
});

// brand.json SoT — docs/brand/brand.json 을 클라이언트 런타임 로더(public/js/brand.js)에 노출
app.get('/brand.json', (req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.sendFile(path.join(__dirname, 'docs', 'brand', 'brand.json'));
});

// Routes
app.use('/api', authRouter);
app.use('/api', roomsRouter);
app.use('/api', adminRouter);
app.use('/api', surveyRouter);
app.use('/api', aiRouter);
app.use('/api', panelRouter);
app.use('/api', adminAuthRouter);
app.use('/api', userAuthRouter);

// Page routes
// OAuth 콜백 호환 wrapper — 카카오/Google 콘솔에 등록된 짧은 URI(/auth/...) 를 /api/auth/... 로 forward
app.get('/auth/kakao/callback', (req, res) => {
  const qs = new URLSearchParams(req.query).toString();
  res.redirect('/api/auth/kakao/callback' + (qs ? '?' + qs : ''));
});
app.get('/auth/google/callback', (req, res) => {
  const qs = new URLSearchParams(req.query).toString();
  res.redirect('/api/auth/google/callback' + (qs ? '?' + qs : ''));
});

app.get('/room/:code/host', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'host.html'));
});
app.get('/room/:code/presenter', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'presenter.html'));
});
app.get('/room/:code/join', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'join.html'));
});
app.get('/tv', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'tv.html'));
});
app.get('/room/:code', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'guest.html'));
});
app.get('/survey', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'survey.html'));
});
app.get('/result', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'result.html'));
});
app.get('/create', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'create.html'));
});
app.get('/profile', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'profile.html'));
});
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Fallback: serve login.html for non-api routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Sentry 에러 핸들러 — 모든 라우트 뒤에 붙여야 함
Sentry.setupExpressErrorHandler(app);

// 마지막 fallback 에러 핸들러 (Sentry 가 먼저 에러 캡처)
app.use((err, req, res, next) => {
  console.error('[server] unhandled error:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'internal server error' });
});

// 프로세스 레벨 방어막
process.on('unhandledRejection', (reason) => {
  console.error('[server] unhandledRejection:', reason);
  Sentry.captureException(reason);
});
process.on('uncaughtException', (err) => {
  console.error('[server] uncaughtException:', err);
  Sentry.captureException(err);
});

// HTTP server
const server = http.createServer(app);

wsRouter.init(server);
adminRouter.init(require('./db').pool, wsRouter);
adminAuthRouter.init(require('./db').pool);
userAuthRouter.init(require('./db').pool);

const PORT = process.env.PORT || 8080;

// ── 보관 기간 cron: N일 경과한 status=closed 방 + 연관 테이블 자동 파기 ──
// 기본 OFF (destructive). Railway env 에서 ROOM_RETENTION_ENABLED=1 설정 시 하루 1회 실행.
// ROOM_RETENTION_DAYS (기본 30) 경과 후 closed 상태 방만 대상.
const RETENTION_DAYS = Math.max(1, parseInt(process.env.ROOM_RETENTION_DAYS || '30', 10) || 30);
const RETENTION_ENABLED = process.env.ROOM_RETENTION_ENABLED === '1';

async function cleanExpiredRooms() {
  try {
    const pool = require('./db').pool;
    const { rows } = await pool.query(
      `SELECT id FROM rooms
        WHERE status = 'closed'
          AND created_at < NOW() - ($1 || ' days')::interval`,
      [String(RETENTION_DAYS)]
    );
    if (rows.length === 0) return;
    const ids = rows.map(r => r.id);
    // FK ON DELETE CASCADE 가 없는 테이블 수동 DELETE (member_results, survey_responses, room_connections, room_state 는 FK 있지만 명시적 cascade X)
    await pool.query('DELETE FROM insta_selects WHERE room_id = ANY($1)', [ids]);
    await pool.query('DELETE FROM room_connections WHERE room_id = ANY($1)', [ids]);
    await pool.query('DELETE FROM member_results WHERE room_id = ANY($1)', [ids]);
    await pool.query('DELETE FROM survey_responses WHERE room_id = ANY($1)', [ids]);
    await pool.query('DELETE FROM room_state WHERE room_id = ANY($1)', [ids]);
    await pool.query('DELETE FROM room_members WHERE room_id = ANY($1)', [ids]);
    await pool.query('DELETE FROM rooms WHERE id = ANY($1)', [ids]);
    console.log(`[retention] deleted ${ids.length} rooms older than ${RETENTION_DAYS} days`);
  } catch (err) {
    console.error('[retention] cron error:', err && err.message);
  }
}

// Init DB then start server
initDB()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`[server] Running on http://localhost:${PORT}`);
      if (RETENTION_ENABLED) {
        console.log(`[retention] cron enabled — ${RETENTION_DAYS}일 경과 closed 방 자동 파기`);
        setTimeout(cleanExpiredRooms, 30 * 1000); // 서버 시작 30초 후 첫 실행
        setInterval(cleanExpiredRooms, 24 * 60 * 60 * 1000); // 매일
      } else {
        console.log('[retention] cron disabled (ROOM_RETENTION_ENABLED != 1)');
      }
    });
  })
  .catch((err) => {
    console.error('[server] Failed to initialize DB:', err);
    process.exit(1);
  });

module.exports = server;
