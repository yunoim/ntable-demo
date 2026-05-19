// Pack fragment loader (2026-05-12 모듈화 Phase 2 POC).
// host.html / guest.html 에서 phase 진입 시 호출 → /pack/:id/:phase fragment 를 fetch → 지정 slot 에 inject.
// fragment 없으면 silent skip (zero regression).
//
// 사용 예:
//   await ntPackFragment.load({ pack_id: 'dating', phase: 'intro', slotId: 'pack-intro-card-slot' });
//
// 서버 응답: HTML fragment (200) 또는 204 No Content (fragment 없음 — 정상 skip).
// 클라이언트 에러는 console.warn 만 (모임 진행 차단 X).
//
// packUI helper: pack 메타 + slot 안전 query 추상화.
//   ntPackFragment.packUI('intro-card-slot', fallback) → slot element or fallback
(function (root) {
  'use strict';

  const cache = new Map(); // `${pack_id}/${phase}` → fragment HTML string ('' 면 없음)

  async function fetchFragment(pack_id, phase) {
    const key = `${pack_id}/${phase}`;
    if (cache.has(key)) return cache.get(key);
    try {
      const r = await fetch(`/pack/${encodeURIComponent(pack_id)}/${encodeURIComponent(phase)}`, {
        signal: (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) ? AbortSignal.timeout(2500) : undefined,
      });
      if (r.status === 204) { cache.set(key, ''); return ''; }
      if (!r.ok) { console.warn('[pack-fragment] fetch fail', pack_id, phase, r.status); cache.set(key, ''); return ''; }
      const html = await r.text();
      cache.set(key, html);
      return html;
    } catch (err) {
      console.warn('[pack-fragment] fetch error', pack_id, phase, err && err.message);
      cache.set(key, '');
      return '';
    }
  }

  async function load(opts) {
    const { pack_id, phase, slotId, replace = true } = opts || {};
    if (!pack_id || !phase || !slotId) return false;
    const slot = document.getElementById(slotId);
    if (!slot) return false;
    const html = await fetchFragment(pack_id, phase);
    if (!html) return false;
    if (replace) slot.innerHTML = html;
    else slot.insertAdjacentHTML('beforeend', html);
    // P3 (2026-05-13): inject 된 element 의 data-copy 치환 — brand.js 의 applyCopyToDOM 자동 호출.
    // 호출 안 하면 DOMContentLoaded 이후 inject 된 fragment 의 data-copy 가 raw 마크다운으로 노출됨.
    try {
      if (typeof window.applyCopyToDOM === 'function') window.applyCopyToDOM(slot);
    } catch (err) { console.warn('[pack-fragment] applyCopyToDOM skipped', err && err.message); }
    return true;
  }

  function packUI(slotId, fallback) {
    const el = document.getElementById(slotId);
    return el || fallback || null;
  }

  // 2026-05-19 Phase 9: Pack-specific JS 모듈 동적 로드.
  // public/js/packs/{pack_id}.js 가 존재하면 <script> 주입 → onload 후 resolve.
  // 모듈은 IIFE 로 window.ntPack[pack_id] = { ... } 노출 규약.
  // 404 (모듈 파일 없음) 는 silent skip — 모든 pack 에 모듈이 있을 필요는 없음.
  const moduleCache = new Map(); // pack_id → Promise<boolean>
  function loadModule(pack_id) {
    if (!pack_id) return Promise.resolve(false);
    if (moduleCache.has(pack_id)) return moduleCache.get(pack_id);
    const p = new Promise((resolve) => {
      // 이미 등록돼있으면 즉시 resolve (HMR / 재호출 방어).
      if (root.ntPack && root.ntPack[pack_id]) { resolve(true); return; }
      const safe = String(pack_id).replace(/[^a-z0-9_-]/gi, '');
      if (!safe) { resolve(false); return; }
      const url = `/js/packs/${safe}.js`;
      const tag = document.createElement('script');
      tag.src = url;
      tag.async = false;
      tag.onload = () => resolve(!!(root.ntPack && root.ntPack[pack_id]));
      tag.onerror = () => { console.warn('[pack-module] not found', url); resolve(false); };
      document.head.appendChild(tag);
    });
    moduleCache.set(pack_id, p);
    return p;
  }

  // Pack 모듈 API dispatcher.
  // - 모듈 자체 없음 → silent skip (정상: 모든 pack 에 모듈이 있을 필요 없음)
  // - 모듈 있는데 method 없음 → console.warn (오타·시그니처 변경 디버깅성, validation advisor W4 fix)
  // 예: ntPackFragment.pack('playlist-share', 'refreshMap')
  function pack(pack_id, method, ...args) {
    const mod = root.ntPack && root.ntPack[pack_id];
    if (!mod) return undefined;
    if (typeof mod[method] !== 'function') {
      console.warn('[pack-module]', pack_id, 'method missing:', method);
      return undefined;
    }
    try { return mod[method](...args); }
    catch (err) { console.warn('[pack-module]', pack_id, method, 'threw', err && err.message); }
  }

  root.ntPackFragment = { load, packUI, fetchFragment, loadModule, pack };
})(typeof window !== 'undefined' ? window : globalThis);
