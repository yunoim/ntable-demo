// playlist-share pack module (2026-05-19 모듈화 Phase 9).
// host.html 에서 추출된 PP 네임스페이스 + refreshPlaylistMap + renderPlaylistPlayer + ppBindControls + 11 helpers.
// 로드 시점: ntPackFragment.loadModule('playlist-share') — pack_id 가 playlist-share 일 때만.
// 노출 API (host.html 이 호출): window.ntPack['playlist-share'] = { init, refreshMap, renderPlayer, onEnterFreeChat }
//
// 의존: window.state (host.html 의 const state) — refreshMap 호출 전 host.html 이 setState() 로 주입.
//       window.escHtml · window.renderProfiles — 이미 host.html 에 정의된 전역 헬퍼.
(function (root) {
  'use strict';

  let _state = null;
  // Phase 9 fix (validation advisor B3): root.state 폴백 제거. host.html 의 const state 는 script scope
  // 라 window.state 로 노출 안 됨 — 폴백이 사실상 죽은 코드라 위험 마스킹. init({state}) 호출 강제.
  function getState() { return _state; }
  function escHtml(s) {
    if (typeof root.escHtml === 'function') return root.escHtml(s);
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }
  function callRenderProfiles() {
    if (typeof root.renderProfiles === 'function') { try { root.renderProfiles(); } catch (_) {} }
  }

  // ── playlist_links 테이블에서 방 전체의 플레이리스트 URL 맵 가져오기 ────
  async function refreshMap() {
    const state = getState();
    if (!state || !state.roomCode) {
      if (!state) console.warn('[playlist-share] refreshMap called before init({state})');
      return;
    }
    try {
      const res = await fetch(`/api/rooms/${state.roomCode}/playlist`);
      if (res.ok) {
        const j = await res.json();
        state.playlistByUuid = (j && j.links) || {};
        callRenderProfiles();
        try { renderPlayer(); } catch (_) {}
      }
    } catch (_) {}
  }

  // ── 자유대화 플리 랜덤 순차재생 ────────────────────
  const PP = {
    queue: [],   // [{ uuid, nickname, url, service }]
    idx: 0,
    started: false,
    ytPlayer: null,
    ytApiLoaded: false,
  };

  function ppDetectService(url) {
    if (!url) return null;
    try {
      const host = new URL(url).hostname.toLowerCase();
      if (/spotify\.com$/.test(host)) return 'spotify';
      if (/music\.apple\.com$/.test(host)) return 'apple';
      if (/music\.youtube\.com$/.test(host)) return 'youtube_music';
      if (/(^|\.)youtube\.com$/.test(host) || /(^|\.)youtu\.be$/.test(host)) return 'youtube';
      return 'other';
    } catch (_) { return null; }
  }

  function ppExtractYTList(url) {
    try {
      const u = new URL(url);
      return u.searchParams.get('list') || null;
    } catch (_) { return null; }
  }

  function ppExtractYTVideoId(url) {
    try {
      const u = new URL(url);
      if (u.hostname.includes('youtu.be')) return u.pathname.slice(1) || null;
      return u.searchParams.get('v') || null;
    } catch (_) { return null; }
  }

  function ppExtractSpotifyEmbed(url) {
    // https://open.spotify.com/playlist/ID 또는 album/track 등
    try {
      const u = new URL(url);
      const m = u.pathname.match(/^\/(playlist|album|track)\/([^/?]+)/);
      if (!m) return null;
      return `https://open.spotify.com/embed/${m[1]}/${m[2]}`;
    } catch (_) { return null; }
  }

  function ppExtractAppleEmbed(url) {
    try {
      const u = new URL(url);
      if (!u.hostname.endsWith('music.apple.com')) return null;
      return `https://embed.music.apple.com${u.pathname}${u.search || ''}`;
    } catch (_) { return null; }
  }

  function ppShuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function ppBuildQueue() {
    const state = getState();
    const links = (state && state.playlistByUuid) || {};
    const items = [];
    for (const [uuid, url] of Object.entries(links)) {
      if (!url) continue;
      const member = (state && (state.approvedUsers || []).find(u => u && u.uuid === uuid))
                  || (state && (state.waitingUsers || []).find(u => u && u.uuid === uuid));
      const nickname = (member && member.nickname) || '익명';
      items.push({ uuid, nickname, url, service: ppDetectService(url) });
    }
    return ppShuffle(items);
  }

  function renderPlayer() {
    const card = document.getElementById('playlist-player-card');
    if (!card) return;
    // Phase 9: fragment 가 playlist-share 일 때만 inject 되므로 pack_id 분기 불필요.
    card.hidden = false;

    const empty = document.getElementById('pp-empty');
    const main = document.getElementById('pp-main');
    if (!empty || !main) return;
    // 큐가 비어있으면 빌드. 이미 있으면 새 항목만 추가 (재셔플은 사용자가 명시적으로).
    if (!PP.queue.length) PP.queue = ppBuildQueue();
    if (!PP.queue.length) { empty.hidden = false; main.hidden = true; return; }
    empty.hidden = true;
    main.hidden = false;

    const cur = PP.queue[PP.idx] || null;
    document.getElementById('pp-progress').textContent = `${PP.idx + 1} / ${PP.queue.length}`;
    document.getElementById('pp-current-nick').textContent = cur ? cur.nickname : '—';
    const svcLabels = { spotify: '🟢 Spotify', apple: '🍎 Apple Music', youtube: '▶︎ YouTube', youtube_music: '⚠️ YouTube Music (영상 없음)', other: '🎵 기타' };
    document.getElementById('pp-current-svc').textContent = cur ? (svcLabels[cur.service] || cur.service) : '—';

    // 큐 미리보기
    const queueEl = document.getElementById('pp-queue');
    if (queueEl) {
      queueEl.innerHTML = PP.queue.map((it, i) => {
        const isCur = i === PP.idx;
        const dot = isCur ? '▶︎' : (i < PP.idx ? '✓' : '·');
        const color = isCur ? 'color:var(--gold-light);font-weight:600;' : (i < PP.idx ? 'color:var(--text-muted);text-decoration:line-through;opacity:0.6;' : 'color:var(--text-muted);');
        return `<div style="${color}">${dot} ${escHtml(it.nickname)} <span style="font-size:10.5px;opacity:0.7;">(${(svcLabels[it.service] || it.service || '').replace(/^[^\s]*\s/, '')})</span></div>`;
      }).join('');
    }
  }

  function ppLoadYTApiOnce(callback) {
    if (PP.ytApiLoaded && window.YT && window.YT.Player) { callback(); return; }
    if (!PP.ytApiLoaded) {
      PP.ytApiLoaded = true;
      const tag = document.createElement('script');
      tag.src = 'https://www.youtube.com/iframe_api';
      document.head.appendChild(tag);
    }
    const wait = setInterval(() => {
      if (window.YT && window.YT.Player) { clearInterval(wait); callback(); }
    }, 200);
    setTimeout(() => clearInterval(wait), 10000);
  }

  function ppEmbedCurrent() {
    const wrap = document.getElementById('pp-embed-wrap');
    if (!wrap) return;
    // 기존 임베드 정리
    if (PP.ytPlayer) { try { PP.ytPlayer.destroy(); } catch (_) {} PP.ytPlayer = null; }
    wrap.innerHTML = '<div id="pp-placeholder" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--text-muted);font-size:13px;text-align:center;padding:16px;">로딩 중…</div>';
    const cur = PP.queue[PP.idx];
    if (!cur) return;

    // YouTube Music 도 list 만 떼서 일반 YouTube 임베드로 자동 변환 (advisor 제안)
    if (cur.service === 'youtube' || cur.service === 'youtube_music') {
      const listId = ppExtractYTList(cur.url);
      const videoId = ppExtractYTVideoId(cur.url);
      const div = document.createElement('div');
      div.id = 'pp-yt-player';
      div.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;';
      wrap.innerHTML = '';
      wrap.appendChild(div);
      ppLoadYTApiOnce(() => {
        try {
          const playerVars = { autoplay: 1, playsinline: 1, rel: 0 };
          if (listId) { playerVars.listType = 'playlist'; playerVars.list = listId; }
          const opts = {
            width: '100%', height: '100%', playerVars,
            events: {
              onStateChange: (e) => {
                if (e.data === 0) {
                  console.log('[host] yt ended → next person');
                  ppNext();
                }
              },
              onError: (e) => {
                console.warn('[host] yt error', e.data, '— fallback to external link');
                const wrap2 = document.getElementById('pp-embed-wrap');
                if (wrap2) {
                  wrap2.innerHTML = `<div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:16px;text-align:center;background:#000;color:#fff;">
                    <div style="font-size:13px;color:var(--text-muted);">이 플리는 임베드에서 안 열려요${cur.service === 'youtube_music' ? ' (YouTube Music 전용 플리)' : ''}</div>
                    <a href="${cur.url}" target="_blank" rel="noopener noreferrer" style="padding:10px 18px;background:linear-gradient(135deg,var(--gold),#a07828);color:var(--navy);border-radius:8px;text-decoration:none;font-weight:700;font-size:13px;">↗ 새 창에서 듣기</a>
                    <div style="font-size:11px;color:var(--text-muted);">끝나면 "다음 사람 →"</div>
                  </div>`;
                }
              },
            },
          };
          if (!listId && videoId) opts.videoId = videoId;
          PP.ytPlayer = new YT.Player('pp-yt-player', opts);
        } catch (e) { console.warn('[host] yt player init failed', e); }
      });
      return;
    }

    if (cur.service === 'spotify') {
      const src = ppExtractSpotifyEmbed(cur.url);
      if (src) {
        wrap.innerHTML = `<iframe src="${src}" style="position:absolute;inset:0;width:100%;height:100%;border:0;" allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture" loading="lazy"></iframe>`;
        return;
      }
    }
    if (cur.service === 'apple') {
      const src = ppExtractAppleEmbed(cur.url);
      if (src) {
        wrap.innerHTML = `<iframe src="${src}" style="position:absolute;inset:0;width:100%;height:100%;border:0;" allow="autoplay *; encrypted-media *;" sandbox="allow-forms allow-popups allow-same-origin allow-scripts allow-storage-access-by-user-activation allow-top-navigation-by-user-activation"></iframe>`;
        return;
      }
    }
    // 임베드 못 만들면 외부 링크 안내
    wrap.innerHTML = `<div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:16px;text-align:center;">
      <div style="font-size:13px;color:var(--text-muted);">이 서비스는 임베드 미지원</div>
      <a href="${cur.url}" target="_blank" rel="noopener noreferrer" style="padding:10px 18px;background:linear-gradient(135deg,var(--gold),#a07828);color:var(--navy);border-radius:8px;text-decoration:none;font-weight:700;font-size:13px;">↗ 새 창에서 듣기</a>
      <div style="font-size:11px;color:var(--text-muted);">끝나면 "다음 사람 →"</div>
    </div>`;
  }

  function ppPlay() {
    if (!PP.queue.length) return;
    PP.started = true;
    ppEmbedCurrent();
    const btn = document.getElementById('pp-play-btn');
    if (btn) btn.textContent = '⏸ 일시정지';
  }

  function ppPause() {
    PP.started = false;
    if (PP.ytPlayer && PP.ytPlayer.pauseVideo) { try { PP.ytPlayer.pauseVideo(); } catch (_) {} }
    const wrap = document.getElementById('pp-embed-wrap');
    if (wrap && !PP.ytPlayer) wrap.innerHTML = '<div id="pp-placeholder" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--text-muted);font-size:13px;">⏸ 일시정지</div>';
    const btn = document.getElementById('pp-play-btn');
    if (btn) btn.textContent = '▶ 재생 시작';
  }

  function ppNext() {
    if (!PP.queue.length) return;
    PP.idx = (PP.idx + 1) % PP.queue.length;
    renderPlayer();
    if (PP.started) ppEmbedCurrent();
  }

  function ppReshuffle() {
    PP.queue = ppBuildQueue();
    PP.idx = 0;
    renderPlayer();
    if (PP.started) ppEmbedCurrent();
  }

  function ppOpenExternal() {
    const cur = PP.queue[PP.idx];
    if (cur && cur.url) window.open(cur.url, '_blank', 'noopener');
  }

  function bindControls() {
    const playBtn = document.getElementById('pp-play-btn');
    const nextBtn = document.getElementById('pp-next-btn');
    const shuffleBtn = document.getElementById('pp-shuffle-btn');
    const openBtn = document.getElementById('pp-open-btn');
    if (playBtn && !playBtn._bound) {
      playBtn._bound = true;
      playBtn.addEventListener('click', () => { PP.started ? ppPause() : ppPlay(); });
    }
    if (nextBtn && !nextBtn._bound) { nextBtn._bound = true; nextBtn.addEventListener('click', ppNext); }
    if (shuffleBtn && !shuffleBtn._bound) { shuffleBtn._bound = true; shuffleBtn.addEventListener('click', ppReshuffle); }
    if (openBtn && !openBtn._bound) { openBtn._bound = true; openBtn.addEventListener('click', ppOpenExternal); }
  }

  // 공개 API
  // Phase 9 fix (validation advisor B1): init 안에서 refreshMap 자동 호출 → 첫 동기화 보장.
  // 호스트 첫 진입 시 host.html 의 setTimeout(refreshMap) race 제거.
  function init(opts) {
    if (opts && opts.state) _state = opts.state;
    if (_state && _state.roomCode) { try { refreshMap(); } catch (_) {} }
  }
  function onEnterFreeChat() {
    try { refreshMap(); } catch (_) {}
    try { bindControls(); } catch (_) {}
    try { renderPlayer(); } catch (_) {}
  }

  root.ntPack = root.ntPack || {};
  root.ntPack['playlist-share'] = { init, refreshMap, renderPlayer, onEnterFreeChat, bindControls };
})(typeof window !== 'undefined' ? window : globalThis);
