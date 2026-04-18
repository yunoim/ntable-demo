// Sentry 서버 초기화 — server.js 최상단에서 require 해야 함.
// SENTRY_DSN_SERVER 환경변수 없으면 조용히 no-op (로컬·미설정 환경 안전).

const Sentry = require('@sentry/node');
const { nodeProfilingIntegration } = require('@sentry/profiling-node');

const dsn = process.env.SENTRY_DSN_SERVER;

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT || 'development',
    release: process.env.SENTRY_RELEASE || '0.1.0',
    // 프로파일링·트레이싱은 초기엔 10% 샘플링 — 쿼터 보호
    integrations: [nodeProfilingIntegration()],
    tracesSampleRate: 0.1,
    profilesSampleRate: 0.1,
    // 민감 정보 자동 스크러빙 보강
    beforeSend(event) {
      if (event.request?.headers) {
        delete event.request.headers.cookie;
        delete event.request.headers.authorization;
      }
      return event;
    },
    // 기본적으로 PII 전송 차단 (설정에서 IP 저장도 OFF 해둔 상태)
    sendDefaultPii: false,
    ignoreErrors: [
      // 브라우저 확장 프로그램·스크립트 잡음 (서버엔 거의 안 나오지만 안전장치)
      'ResizeObserver loop limit exceeded',
    ],
  });
  console.log(`[sentry] initialized (env=${process.env.SENTRY_ENVIRONMENT || 'development'})`);
} else {
  console.log('[sentry] SENTRY_DSN_SERVER not set — skipping');
}

module.exports = Sentry;
