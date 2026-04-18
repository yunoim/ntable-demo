const { WebSocketServer } = require('ws');
const { pool } = require('../db');
const Sentry = require('../sentry');

// rooms[room_code] = {
//   clients: Map<uuid, ws>,
//   hostUuid: string,
//   hostGraceTimer: Timeout|null,
//   hostDisconnectedAt: number|null
// }
const rooms = {};

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

      const userResult = await pool.query(
        'SELECT uuid, nickname FROM users WHERE uuid = $1',
        [uuid]
      );
      if (userResult.rows.length === 0) {
        ws.close(4002, 'User not found');
        return;
      }

      const nickname = userResult.rows[0].nickname;

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
          hostUuid,
          hostGraceTimer: null,
          hostDisconnectedAt: null,
        };
      } else {
        rooms[room_code].hostUuid = hostUuid;
      }
      rooms[room_code].clients.set(uuid, ws);

      // 호스트 재접속 → grace timer 취소
      if (uuid === hostUuid && rooms[room_code].hostGraceTimer) {
        clearTimeout(rooms[room_code].hostGraceTimer);
        rooms[room_code].hostGraceTimer = null;
        rooms[room_code].hostDisconnectedAt = null;
        broadcastToRoom(room_code, { type: 'host_reconnected', uuid }, uuid);
      }

      // user_joined broadcast (자신 제외)
      broadcastToRoom(room_code, { type: 'user_joined', uuid, nickname }, uuid);

      ws.on('message', async (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'ping') {
            ws.send(JSON.stringify({ type: 'pong' }));
          } else if (msg.type === 'chat') {
            const text = String(msg.message || '').slice(0, 500).trim();
            if (!text) return;
            broadcastToRoom(room_code, {
              type: 'chat',
              uuid,
              nickname,
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

module.exports = { init, broadcastToRoom, getRoomClients, getActiveRoomCodes, isUserActive };
