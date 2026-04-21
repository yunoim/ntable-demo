// brand.js — T-18 (2026-04-22) · brand.json 런타임 로더
// 사용법:
//   <script src="/js/brand.js"></script>
//   await loadBrand();
//   const label = t("buttons.open_room");             // "모임 열기"
//   const msg   = t("toasts.welcome_guest", {nick});  // "{nick} 님, 환영해요 🎉"
//   applyCopyToDOM();                                 // data-copy 자동 치환
//
// SoT: docs/brand/brand.json (server.js 가 /brand.json 으로 노출)

(function (global) {
  let _cache = null;
  let _loading = null;

  async function loadBrand() {
    if (_cache) return _cache;
    if (_loading) return _loading;
    _loading = fetch('/brand.json', { cache: 'default' })
      .then(function (r) {
        if (!r.ok) throw new Error('brand.json ' + r.status);
        return r.json();
      })
      .then(function (data) {
        _cache = data;
        _loading = null;
        return data;
      })
      .catch(function (err) {
        _loading = null;
        console.warn('[brand] load failed:', err);
        _cache = {};
        return _cache;
      });
    return _loading;
  }

  function resolvePath(obj, path) {
    if (!obj || !path) return undefined;
    return path.split('.').reduce(function (acc, key) {
      return acc && acc[key] !== undefined ? acc[key] : undefined;
    }, obj);
  }

  function interpolate(str, vars) {
    if (!vars || typeof str !== 'string') return str;
    return str.replace(/\{(\w+)\}/g, function (_, k) {
      return vars[k] !== undefined ? vars[k] : '{' + k + '}';
    });
  }

  function t(path, vars) {
    if (!_cache) {
      console.warn('[brand] t() called before loadBrand() — returned path:', path);
      return path;
    }
    var val = resolvePath(_cache, path);
    if (val === undefined) {
      console.warn('[brand] missing key:', path);
      return path;
    }
    return interpolate(val, vars);
  }

  // data-copy="path" 요소의 텍스트를 t() 결과로 교체.
  // data-copy-attr="placeholder|title|aria-label" 있으면 속성에 대신 설정.
  function applyCopyToDOM(root) {
    root = root || document;
    if (!_cache) return;
    var nodes = root.querySelectorAll('[data-copy]');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var p = el.getAttribute('data-copy');
      var attr = el.getAttribute('data-copy-attr');
      var val = t(p);
      if (val === p) continue;
      if (attr) el.setAttribute(attr, val);
      else el.textContent = val;
    }
  }

  global.loadBrand = loadBrand;
  global.t = t;
  global.applyCopyToDOM = applyCopyToDOM;
})(window);
