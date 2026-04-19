const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const { pool } = require('../db');
const Sentry = require('../sentry');

// rooms[room_code] = {
//   clients: Map<uuid, ws>,
//   observers: Set<ws>,        // TV 등 read-only 화면
//   hostUuid: string,
//   hostGraceTimer: Timeout|null,
//   hostDisconnectedAt: number|null,
//   photoBanned: Set<uuid>
// }
const rooms = {};

// TV 페어링 세션 — tvSessions[token] = { ws, code, room_code|null, expires }
const tvSessions = new Map();
const pairCodeToToken = new Map(); // 'ABC123' → tv_token
const PAIR_CODE_TTL_MS = 5 * 60 * 1000;

function genPairCode() {
  // 6자리 영숫자 (혼동 글자 제외)
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

// 호스트 재접속 grace period (3시간 — 자유토킹 고려)
const HOST_GRACE_MS = 3 * 60 * 60 * 1000;

function broadcastToRoom(room_code, message, excludeUuid = null, targetUuid = null) {
  const room = rooms[room_code];
  if (!room) return;
  const payload = JSON.stringify(message);

  if (targetUuid) {
    // 특정 uuid에게만 전송
    const ws = room.clients.get(targetUuid);
    if (ws && ws.readyState === ws.OPEN) {
      ws.send(payload);
    }
    return;
  }

  for (const [uuid, ws] of room.clients.entries()) {
    if (excludeUuid && uuid === excludeUuid) continue;
    if (ws.readyState === ws.OPEN) {
      ws.send(payload);
    }
  }

  // TV/observer 들에게도 전송 (read-only 디스플레이)
  if (room.observers && room.observers.size) {
    for (const ws of room.observers) {
      if (ws.readyState === ws.OPEN) {
        try { ws.send(payload); } catch (_) {}
      }
    }
  }
}

function getRoomClients(room_code) {
  const room = rooms[room_code];
  if (!room) return [];
  return [...room.clients.keys()];
}

// 활성 WS 세션이 하나 이상 있는 방 코드 목록
function getActiveRoomCodes() {
  const codes = [];
  for (const code in rooms) {
    if (rooms[code].clients.size > 0) codes.push(code);
  }
  return codes;
}

// 지정 uuid가 현재 어떤 방에든 WS OPEN 상태로 접속 중인지
function isUserActive(uuid) {
  for (const code in rooms) {
    const ws = rooms[code].clients.get(uuid);
    if (ws && ws.readyState === ws.OPEN) return true;
  }
  return false;
}

function init(server) {
  const wss = new WebSocketServer({ server, path: undefined });

  wss.on('connection', async (ws, req) => {
    // TV 페어링 WS: /ws/tv/{token}
    const tvMatch = req.url.match(/^\/ws\/tv\/([0-9a-fA-F-]{8,})$/);
    if (tvMatch) {
      handleTVConnection(ws, tvMatch[1]);
      return;
    }

    // Observer/Presenter WS: /ws/observer/{room_code}
    const obsMatch = req.url.match(/^\/ws\/observer\/([A-Z0-9]{6})$/);
    if (obsMatch) {
      handleObserverConnection(ws, obsMatch[1]);
      return;
    }

    // URL: /ws/:room_code/:uuid
    const match = req.url.match(/^\/ws\/([A-Z0-9]{6})\/(.+)$/);
    if (!match) {
      ws.close(4000, 'Invalid URL');
      return;
    }
    const room_code = match[1];
    const uuid = decodeURIComponent(match[2]);

    // DB 검증
    try {
      const roomResult = await pool.query(
        'SELECT id, host_uuid, status FROM rooms WHERE room_code = $1',
        [room_code]
      );
      if (roomResult.rows.length === 0) {
        ws.close(4001, 'Room not found');
        return;
      }
      if (roomResult.rows[0].status === 'closed') {
        ws.close(4005, 'Room closed');
        return;
      }
      const hostUuid = roomResult.rows[0].host_uuid;

      // 방별 익명 구조 — room_members 에서 nickname 우선 조회. 없으면 legacy users.
      const memberResult = await pool.query(
        'SELECT nickname FROM room_members WHERE room_id = $1 AND uuid = $2',
        [roomResult.rows[0].id, uuid]
      );
      let nickname = memberResult.rows[0]?.nickname;
      if (!nickname) {
        const userResult = await pool.query(
          'SELECT nickname FROM users WHERE uuid = $1', [uuid]
        );
        if (userResult.rows.length === 0) {
          ws.close(4002, 'User not found');
          return;
        }
        nickname = userResult.rows[0].nickname;
      }

      // 같은 uuid가 이미 어디든 연결돼 있으면 기존 세션 종료 후 신규 세션이 인수
      // (네트워크 블립/새로고침/탭 전환 후 재접속 허용)
      for (const code in rooms) {
        const oldWs = rooms[code].clients.get(uuid);
        if (oldWs && oldWs !== ws) {
          oldWs._replaced = true;  // close 핸들러가 user_left broadcast 하지 않게
          try { oldWs.close(4004, 'Replaced by new session'); } catch (e) {}
          rooms[code].clients.delete(uuid);
        }
      }

      // 방 초기화
      if (!rooms[room_code]) {
        rooms[room_code] = {
          clients: new Map(),
          observers: new Set(),
          hostUuid,
          hostGraceTimer: null,
          hostDisconnectedAt: null,
          photoBanned: new Set(),
          photoCache: new Map(), // uuid → dataURL (메모리 휘발, 방 close 시 GC)
          introCache: new Map(), // uuid → 한줄 자기소개 (동일)
        };
      } else {
        rooms[room_code].hostUuid = hostUuid;
        if (!rooms[room_code].photoBanned) rooms[room_code].photoBanned = new Set();
        if (!rooms[room_code].observers) rooms[room_code].observers = new Set();
        if (!rooms[room_code].photoCache) rooms[room_code].photoCache = new Map();
        if (!rooms[room_code].introCache) rooms[room_code].introCache = new Map();
      }
      rooms[room_code].clients.set(uuid, ws);
      // 사진/소개 sync는 클라이언트의 'request_photos' 메시지에 응답하는 방식으로 처리 (onmessage 준비 후 트리거)

      // 호스트 재접속 → grace timer 취소
      if (uuid === hostUuid && rooms[room_code].hostGraceTimer) {
        clearTimeout(rooms[room_code].hostGraceTimer);
        rooms[room_code].hostGraceTimer = null;
        rooms[room_code].hostDisconnectedAt = null;
        broadcastToRoom(room_code, { type: 'host_reconnected', uuid }, uuid);
      }

      // user_joined broadcast (자신 제외)
      broadcastToRoom(room_code, { type: 'user_joined', uuid, nickname }, uuid);
      // 자동 입장 (2026-04-19) — 호스트 승인 절차 폐지. 참가자는 즉시 approved.
      // 호스트는 강퇴 권한 유지. 부적절 사용자는 사후 차단.
      // (호스트 본인은 approved broadcast 받지만 무시 — 호스트 화면에는 자기 카드 항상 표시)
      if (uuid !== hostUuid) {
        broadcastToRoom(room_code, { type: 'approved', uuid });
      }

      ws.on('message', async (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'ping') {
            ws.send(JSON.stringify({ type: 'pong' }));
          } else if (msg.type === 'chat') {
            // 익명 채팅 — nickname 송출하지 않음 (uuid만 전달, 클라이언트에서 익명 라벨 매핑)
            const text = String(msg.message || '').slice(0, 500).trim();
            if (!text) return;
            broadcastToRoom(room_code, {
              type: 'chat',
              uuid,
              message: text,
              ts: Date.now(),
            });
          } else if (msg.type === 'waiting_too_long') {
            // 게스트가 일정 시간 이상 대기 → 호스트에게만 알림
            try {
              const r = await pool.query(
                'SELECT host_uuid FROM rooms WHERE room_code = $1',
                [room_code]
              );
              if (r.rows.length === 0) return;
              const host_uuid = r.rows[0].host_uuid;
              const minutes = Math.max(1, Math.min(60, parseInt(msg.minutes, 10) || 5));
              broadcastToRoom(
                room_code,
                { type: 'waiting_too_long', uuid, nickname, minutes },
                null,
                host_uuid
              );
            } catch (e) {
              console.error('waiting_too_long handler error:', e.message);
            }
          } else if (msg.type === 'photo_update') {
            // 클라이언트 base64 사진 broadcast + 방별 메모리 캐시 (방 close 시 GC, DB 미사용)
            const photo = String(msg.photo || '');
            if (photo.length > 250000) return; // ~180KB 안전 한계
            if (photo && !photo.startsWith('data:image/')) return;
            const room = rooms[room_code];
            if (photo && room && room.photoBanned && room.photoBanned.has(uuid)) {
              // 차단된 사용자는 본인에게만 차단 알림
              broadcastToRoom(room_code, {
                type: 'photo_blocked',
                reason: 'host_banned',
              }, null, uuid);
              return;
            }
            // 캐시 갱신 (신규 입장자 sync용)
            if (room) {
              if (photo) room.photoCache.set(uuid, photo);
              else room.photoCache.delete(uuid);
            }
            broadcastToRoom(room_code, {
              type: 'photo_update',
              uuid,
              photo,
            }, uuid);
          } else if (msg.type === 'request_photos') {
            // 신규 입장자에게 캐시된 사진/소개 직접 전송 (수신자 onmessage 준비 후 트리거)
            const room = rooms[room_code];
            if (room && room.photoCache) {
              for (const [pUuid, pPhoto] of room.photoCache.entries()) {
                if (pUuid === uuid) continue;
                try { ws.send(JSON.stringify({ type: 'photo_update', uuid: pUuid, photo: pPhoto })); } catch (_) {}
              }
            }
            if (room && room.introCache) {
              for (const [iUuid, iIntro] of room.introCache.entries()) {
                if (iUuid === uuid) continue;
                try { ws.send(JSON.stringify({ type: 'intro_update', uuid: iUuid, intro: iIntro })); } catch (_) {}
              }
            }
            // 캐시에 없는 경우 대비 — 기존 사용자에게 재공유 요청도 broadcast
            broadcastToRoom(room_code, {
              type: 'photo_request',
              requester_uuid: uuid,
            }, uuid);
          } else if (msg.type === 'photo_kick') {
            // 호스트만 가능 — 부적절 사진 강제 제거 + 모임 동안 재업로드 차단
            const room = rooms[room_code];
            if (!room || uuid !== room.hostUuid) return;
            const target = String(msg.target_uuid || '');
            if (!target) return;
            room.photoBanned.add(target);
            room.photoCache.delete(target); // 캐시도 정리
            broadcastToRoom(room_code, {
              type: 'photo_update',
              uuid: target,
              photo: '',
              kicked: true,
            });
            // 호스트에게만 banlist 갱신
            broadcastToRoom(room_code, {
              type: 'photo_banlist',
              banned: [...room.photoBanned],
            }, null, room.hostUuid);
          } else if (msg.type === 'photo_unban') {
            // 호스트만 가능 — 차단 해제
            const room = rooms[room_code];
            if (!room || uuid !== room.hostUuid) return;
            const target = String(msg.target_uuid || '');
            if (!target) return;
            room.photoBanned.delete(target);
            broadcastToRoom(room_code, {
              type: 'photo_banlist',
              banned: [...room.photoBanned],
            }, null, room.hostUuid);
            // 차단 해제된 사용자에게 알림 (재업로드 가능 안내)
            broadcastToRoom(room_code, {
              type: 'photo_unblocked',
            }, null, target);
          } else if (msg.type === 'request_banlist') {
            // 호스트가 reconnect 시 현재 차단 상태 요청
            const room = rooms[room_code];
            if (!room || uuid !== room.hostUuid) return;
            broadcastToRoom(room_code, {
              type: 'photo_banlist',
              banned: [...(room.photoBanned || [])],
            }, null, room.hostUuid);
          } else if (msg.type === 'intro_update') {
            // 한줄 자기소개 broadcast + 방별 메모리 캐시 (방 close 시 GC)
            const intro = String(msg.intro || '').slice(0, 80).trim();
            const room = rooms[room_code];
            if (room) {
              if (intro) room.introCache.set(uuid, intro);
              else room.introCache.delete(uuid);
            }
            broadcastToRoom(room_code, {
              type: 'intro_update',
              uuid,
              intro,
            }, uuid);
          }
        } catch (e) {
          // ignore malformed messages
        }
      });

      ws.on('close', () => {
        if (!rooms[room_code]) return;

        // 신규 세션이 인수한 경우 정리 스킵 (이미 위에서 제거됨)
        if (ws._replaced) return;

        rooms[room_code].clients.delete(uuid);

        // 호스트 이탈 → 3시간 grace timer 시작, 방은 유지
        if (uuid === rooms[room_code].hostUuid) {
          rooms[room_code].hostDisconnectedAt = Date.now();
          if (rooms[room_code].hostGraceTimer) {
            clearTimeout(rooms[room_code].hostGraceTimer);
          }
          rooms[room_code].hostGraceTimer = setTimeout(async () => {
            try {
              await pool.query(
                "UPDATE rooms SET status = 'closed' WHERE room_code = $1 AND status != 'closed'",
                [room_code]
              );
              broadcastToRoom(room_code, {
                type: 'room_closed',
                reason: 'host_grace_expired',
              });
            } catch (e) {
              console.error(`[ws] host grace auto-close error [${room_code}]:`, e.message);
            }
            delete rooms[room_code];
          }, HOST_GRACE_MS);

          broadcastToRoom(room_code, {
            type: 'host_disconnected',
            uuid,
            grace_minutes: Math.round(HOST_GRACE_MS / 60000),
          });
          return;
        }

        // 일반 게스트 이탈
        broadcastToRoom(room_code, { type: 'user_left', uuid });

        // 방에 아무도 없고 호스트도 grace 아님 → 메모리 정리
        if (rooms[room_code].clients.size === 0 && !rooms[room_code].hostGraceTimer) {
          delete rooms[room_code];
        }
      });

      ws.on('error', (err) => {
        console.error(`WS error [${room_code}/${uuid}]:`, err.message);
        Sentry.captureException(err, {
          tags: { component: 'websocket' },
          contexts: { ws: { room_code, uuid } },
        });
      });

    } catch (err) {
      console.error('WS connection error:', err);
      Sentry.captureException(err, {
        tags: { component: 'websocket-connect' },
        contexts: { ws: { room_code, uuid } },
      });
      ws.close(5000, 'Server error');
    }
  });

  console.log('WebSocket server initialized');
}

// 특정 사용자의 ws 연결을 닫음 (kick 등에서 사용)
function closeUserWS(room_code, uuid, code = 4006, reason = 'Closed') {
  const room = rooms[room_code];
  if (!room) return false;
  const ws = room.clients.get(uuid);
  if (!ws) return false;
  try { ws.close(code, reason); } catch (_) {}
  return true;
}

// TV WS — 페어링 코드 발급, attach 대기
function handleTVConnection(ws, token) {
  const code = genPairCode();
  const expires = Date.now() + PAIR_CODE_TTL_MS;
  tvSessions.set(token, { ws, code, room_code: null, expires });
  pairCodeToToken.set(code, token);

  // TTL 만료 정리
  setTimeout(() => {
    const s = tvSessions.get(token);
    if (s && !s.room_code) {
      pairCodeToToken.delete(s.code);
      tvSessions.delete(token);
      try { ws.close(4007, 'Pair code expired'); } catch (_) {}
    }
  }, PAIR_CODE_TTL_MS);

  try { ws.send(JSON.stringify({ type: 'pair_code', code, expires_in: Math.floor(PAIR_CODE_TTL_MS / 1000) })); } catch (_) {}

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
    } catch (_) {}
  });

  ws.on('close', () => {
    const s = tvSessions.get(token);
    if (s) {
      pairCodeToToken.delete(s.code);
      // 이미 attach 됐으면 observers Set에서 제거
      if (s.room_code && rooms[s.room_code]) {
        rooms[s.room_code].observers?.delete(ws);
      }
      tvSessions.delete(token);
    }
  });
}

// Observer WS (room presenter 전용 read-only)
function handleObserverConnection(ws, room_code) {
  if (!rooms[room_code]) {
    rooms[room_code] = {
      clients: new Map(),
      observers: new Set(),
      hostUuid: null,
      hostGraceTimer: null,
      hostDisconnectedAt: null,
      photoBanned: new Set(),
    };
  }
  if (!rooms[room_code].observers) rooms[room_code].observers = new Set();
  rooms[room_code].observers.add(ws);

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
      // observer는 read-only — request_photos/request_intros 만 허용 (입장 후 sync 위해)
      if (msg.type === 'request_photos') {
        // observer 자신은 사진 없으니 그냥 broadcast (다른 참가자가 다시 보냄)
        broadcastToRoom(room_code, { type: 'photo_request', requester_uuid: '_observer_' });
      }
    } catch (_) {}
  });

  ws.on('close', () => {
    if (rooms[room_code]?.observers) rooms[room_code].observers.delete(ws);
  });
}

// 페어링 코드 → room_code 연결 (호스트 attach API에서 호출)
function attachTVToRoom(pairCode, room_code) {
  const token = pairCodeToToken.get(pairCode);
  if (!token) return { ok: false, error: 'INVALID_CODE' };
  const session = tvSessions.get(token);
  if (!session) return { ok: false, error: 'SESSION_GONE' };
  if (session.expires < Date.now()) return { ok: false, error: 'EXPIRED' };
  if (session.room_code) return { ok: false, error: 'ALREADY_ATTACHED' };

  // observers Set에 추가하지 않음 (presenter.html에서 별도 observer ws 새로 연결)
  session.room_code = room_code;
  pairCodeToToken.delete(pairCode);

  try {
    session.ws.send(JSON.stringify({ type: 'attached', room_code }));
  } catch (_) {}
  return { ok: true };
}

module.exports = { init, broadcastToRoom, getRoomClients, getActiveRoomCodes, isUserActive, closeUserWS, attachTVToRoom };
