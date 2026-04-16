const { WebSocketServer } = require('ws');
const { pool } = require('../db');

// rooms[room_code] = { clients: Map<uuid, ws> }
const rooms = {};

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
        'SELECT id FROM rooms WHERE room_code = $1',
        [room_code]
      );
      if (roomResult.rows.length === 0) {
        ws.close(4001, 'Room not found');
        return;
      }
      const userResult = await pool.query(
        'SELECT uuid, nickname FROM users WHERE uuid = $1',
        [uuid]
      );
      if (userResult.rows.length === 0) {
        ws.close(4002, 'User not found');
        return;
      }

      const nickname = userResult.rows[0].nickname;

      // 방 초기화
      if (!rooms[room_code]) {
        rooms[room_code] = { clients: new Map() };
      }
      rooms[room_code].clients.set(uuid, ws);

      // user_joined broadcast (자신 제외)
      broadcastToRoom(room_code, { type: 'user_joined', uuid, nickname }, uuid);

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'ping') {
            ws.send(JSON.stringify({ type: 'pong' }));
          }
        } catch (e) {
          // ignore malformed messages
        }
      });

      ws.on('close', () => {
        if (rooms[room_code]) {
          rooms[room_code].clients.delete(uuid);
          if (rooms[room_code].clients.size === 0) {
            delete rooms[room_code];
          } else {
            broadcastToRoom(room_code, { type: 'user_left', uuid });
          }
        }
      });

      ws.on('error', (err) => {
        console.error(`WS error [${room_code}/${uuid}]:`, err.message);
      });

    } catch (err) {
      console.error('WS connection error:', err);
      ws.close(5000, 'Server error');
    }
  });

  console.log('WebSocket server initialized');
}

module.exports = { init, broadcastToRoom, getRoomClients };
