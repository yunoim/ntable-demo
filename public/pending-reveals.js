// ntable pending reveals helper — 인스타 mutual 공개 보류된 모임 추적
// localStorage 키: 'pending_reveals' = JSON array of room_code
// 다른 페이지(login, create 등)에서 보류된 결과 페이지 링크 노출

window.ntablePendingReveals = (function () {
  function read() {
    try { return JSON.parse(localStorage.getItem('pending_reveals') || '[]'); }
    catch (_) { return []; }
  }
  function write(arr) {
    try { localStorage.setItem('pending_reveals', JSON.stringify(arr.slice(-10))); } catch (_) {}
  }
  return {
    add(room_code) {
      if (!room_code) return;
      const arr = read();
      if (!arr.includes(room_code)) { arr.push(room_code); write(arr); }
    },
    remove(room_code) {
      const arr = read().filter(c => c !== room_code);
      write(arr);
    },
    list() { return read(); },
    clearAll() { try { localStorage.removeItem('pending_reveals'); } catch (_) {} },
  };
})();

// 페이지 진입 시 자동 노출 — body 가장 위에 배너 삽입 (data-no-pending-banner 속성으로 페이지가 disable 가능)
(function () {
  if (document.body && document.body.dataset.noPendingBanner === 'true') return;
  function show() {
    const list = window.ntablePendingReveals.list();
    if (!list.length) return;
    if (document.getElementById('pending-reveals-banner')) return;
    // 가장 최근 항목만 노출
    const code = list[list.length - 1];
    const uuid = (() => { try { return localStorage.getItem('demo_uuid') || ''; } catch (_) { return ''; } })();
    if (!uuid) return;
    const banner = document.createElement('a');
    banner.id = 'pending-reveals-banner';
    banner.href = `/result?room=${encodeURIComponent(code)}&uuid=${encodeURIComponent(uuid)}`;
    banner.style.cssText = 'display:flex;align-items:center;justify-content:center;gap:8px;padding:11px 16px;background:linear-gradient(135deg,rgba(212,168,67,0.18),rgba(212,168,67,0.08));border-bottom:1px solid rgba(212,168,67,0.4);color:#e8b84b;font-size:13px;font-weight:600;text-decoration:none;font-family:inherit;cursor:pointer;letter-spacing:0.02em;z-index:1000;position:relative;';
    banner.innerHTML = `💌 이전 모임 (#${code})에서 매칭이 있었어요 — 결과 확인하기 →`;
    document.body.insertBefore(banner, document.body.firstChild);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', show);
  } else {
    show();
  }
})();
