// 공용 Sentry 브라우저 초기화.
// 각 HTML 페이지에서 <script src="/sentry-init.js" data-page="host|guest|create|..."></script> 로 로드.
// /api/sentry-config 에서 DSN·environment·release 를 런타임에 받아옴 (환경변수 노출 방지).

(function () {
  'use strict';

  async function init() {
    try {
      const res = await fetch('/api/sentry-config', { cache: 'no-store' });
      if (!res.ok) return;
      const cfg = await res.json();
      if (!cfg || !cfg.dsn) return;

      // Sentry CDN 로드 — 패키지 번들 없이 script 태그만으로 동작
      await loadScript('https://browser.sentry-cdn.com/10.49.0/bundle.min.js', {
        integrity: '',
        crossorigin: 'anonymous',
      });

      if (!window.Sentry) return;

      const page = (document.currentScript && document.currentScript.dataset.page) || 'unknown';

      window.Sentry.init({
        dsn: cfg.dsn,
        environment: cfg.environment || 'development',
        release: cfg.release || '0.1.0',
        integrations: [],
        tracesSampleRate: 0.05,
        beforeSend(event) {
          // 로컬·file:// 환경은 전송 안 함
          if (location.hostname === 'localhost' || location.protocol === 'file:') return null;
          return event;
        },
      });
      window.Sentry.setTag('page', page);
    } catch (_) {
      // 조용히 실패 — 페이지 동작엔 영향 없음
    }
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.crossOrigin = 'anonymous';
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  init();
})();
