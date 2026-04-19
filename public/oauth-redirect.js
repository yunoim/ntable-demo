// ntable OAuth helper — 공통 동작:
// 1. 페이지 로드 직후 ?auth_token= 감지 → user_token 저장 + device uuid 마이그레이션 → URL 정리 + reload
// 2. window.ntableOAuthHref(provider) — OAuth 링크에 현재 페이지로 복귀 redirect 자동 부여
// 모든 page <head> 에서 <script src="/oauth-redirect.js" defer></script> 로 로드

(async function () {
  try {
    const url = new URL(location.href);
    const tok = url.searchParams.get('auth_token');
    if (!tok) return;
    try {
      localStorage.setItem('user_token', tok);
      localStorage.setItem('login_remember', 'true');
    } catch (_) {}
    try {
      const oldUuid = localStorage.getItem('demo_uuid');
      if (oldUuid) {
        const r = await fetch('/api/auth/link-device', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-user-token': tok },
          body: JSON.stringify({ old_uuid: oldUuid }),
        });
        if (r.ok) {
          const data = await r.json();
          if (data.user_uuid && data.user_uuid !== oldUuid) {
            try { localStorage.setItem('demo_uuid', data.user_uuid); } catch (_) {}
          }
        }
      }
    } catch (_) {}
    url.searchParams.delete('auth_token');
    location.replace(url.pathname + (url.search || '') + (url.hash || ''));
  } catch (_) {}
})();

window.ntableOAuthHref = function (provider) {
  const back = encodeURIComponent(location.pathname + location.search);
  return '/api/auth/' + provider + '?redirect=' + back;
};
