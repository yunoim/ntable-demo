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

// 호스트별 라우팅
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

// Routes
app.use('/api', authRouter);
app.use('/api', roomsRouter);
app.use('/api', adminRouter);
app.use('/api', surveyRouter);
app.use('/api', aiRouter);
app.use('/api', panelRouter);

// Page routes
app.get('/room/:code/host', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'host.html'));
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

const PORT = process.env.PORT || 8080;

// Init DB then start server
initDB()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`[server] Running on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('[server] Failed to initialize DB:', err);
    process.exit(1);
  });

module.exports = server;
