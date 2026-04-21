// ntable 공통 auth header — 모든 페이지에 동일한 인증 UI 제공
// 인증 상태에서만 우상단에 떠 있는 pill 노출: 토글 + ✓ Google/Kakao 계정 연결됨
// 토글 OFF = 즉시 로그아웃 + 페이지 리로드
// 페이지에 이미 #loginToggle (login.html) 이 있으면 주입 생략해 중복 방지

(async function () {
  if (document.getElementById('loginToggle')) return;
  if (document.getElementById('ntAuthPill')) return;

  // provider 활성 여부 — 둘 다 비활성이면 주입하지 않음
  let cfgGoogle = false, cfgKakao = false;
  try {
    const r = await fetch('/api/auth/status');
    const cfg = r.ok ? await r.json() : {};
    cfgGoogle = !!cfg.google;
    cfgKakao = !!cfg.kakao;
  } catch (_) {}
  if (!cfgGoogle && !cfgKakao) return;

  // 현재 인증 상태 — 로그인된 경우에만 pill 노출
  let me = null;
  try {
    const tok = localStorage.getItem('user_token');
    if (tok) {
      const r = await fetch('/api/auth/me', { headers: { 'x-user-token': tok } });
      const data = r.ok ? await r.json() : {};
      if (data.authed) me = data;
      else { try { localStorage.removeItem('user_token'); } catch (_) {} }
    }
  } catch (_) {}
  if (!me) return;

  // CSS 주입 (scoped prefix `nt-auth-` 로 충돌 방지)
  // 크기는 app.ntable.kr login.html 의 .login-toggle + .login-connected-mini 와 일치시켜 통일감 유지
  const style = document.createElement('style');
  style.textContent = `
    .nt-auth-pill {
      position: fixed;
      top: calc(10px + env(safe-area-inset-top));
      /* ntable.kr 랜딩 .nav-inner(max-width:1100px, padding:0 32px) 우측 끝과 동일 선상 정렬 */
      right: max(32px, calc((100vw - 1100px) / 2 + 32px));
      z-index: 9999;
      display: flex; flex-direction: column; align-items: flex-end;
      gap: 2px;
      padding: 8px 14px 7px;
      background: rgba(14,22,40,0.92);
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      border: 1px solid rgba(212,168,67,0.35);
      border-radius: 16px;
      font-family: var(--font-body);
      box-shadow: 0 2px 8px rgba(0,0,0,0.18);
      pointer-events: auto;
    }
    /* login.html .login-toggle 와 동일한 치수 */
    .nt-auth-toggle {
      display: inline-flex; align-items: center; gap: 10px;
      font-size: 11.5px; color: #7ee8a2;
      cursor: pointer; background: none; border: none;
      padding: 0;
      font-family: inherit;
      line-height: 1.2;
      transition: color 0.2s;
    }
    .nt-auth-toggle:hover { color: #a8f5c1; }
    .nt-auth-toggle .sw {
      width: 30px; height: 16px;
      background: rgba(126,232,162,0.45);
      border-radius: 999px; position: relative;
      transition: background 0.2s;
      flex-shrink: 0;
    }
    .nt-auth-toggle .sw::after {
      content: ''; position: absolute; top: 2px; left: 16px;
      width: 12px; height: 12px;
      background: #7ee8a2; border-radius: 50%;
      transition: left 0.2s, background 0.2s;
    }
    /* login.html .login-connected-mini 와 동일한 치수 */
    .nt-auth-mini {
      font-size: 10.5px;
      color: #7ee8a2;
      letter-spacing: 0.02em;
      padding-right: 4px;
      line-height: 1.2;
      font-weight: 500;
    }
    @media (max-width: 768px) {
      .nt-auth-pill { right: 20px; }
    }
  `;
  document.head.appendChild(style);

  // Pill DOM
  const pill = document.createElement('div');
  pill.className = 'nt-auth-pill';
  pill.id = 'ntAuthPill';
  const provider = me.google ? 'Google' : me.kakao ? '카카오' : '계정';
  pill.innerHTML = [
    '<button type="button" class="nt-auth-toggle" aria-pressed="true" title="내 정보 기억하기 · 끄면 로그아웃">',
    '<span>내 정보 기억하기</span>',
    '<span class="sw" aria-hidden="true"></span>',
    '</button>',
    '<div class="nt-auth-mini">✓ ' + provider + ' 계정 연결됨</div>',
  ].join('');

  // body 없으면 대기 (script defer 보장용 안전장치)
  if (document.body) {
    document.body.appendChild(pill);
  } else {
    document.addEventListener('DOMContentLoaded', () => document.body.appendChild(pill), { once: true });
  }

  // 토글 클릭 = 즉시 로그아웃 + reload
  pill.querySelector('.nt-auth-toggle').addEventListener('click', async () => {
    try {
      localStorage.setItem('login_remember', 'false');
      localStorage.removeItem('profile_snapshot');
      localStorage.removeItem('preferred_nickname');
    } catch (_) {}
    const tok = localStorage.getItem('user_token');
    if (tok) {
      try {
        await fetch('/api/auth/logout', { method: 'POST', headers: { 'x-user-token': tok } });
      } catch (_) {}
    }
    try { localStorage.removeItem('user_token'); } catch (_) {}
    location.reload();
  });
})();
