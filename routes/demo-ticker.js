// routes/demo-ticker.js
//
// 영구 데모방 자동 진행 ticker.
// 단일 setInterval 이 모든 demo_kind IS NOT NULL 방을 5초마다 sweep.
//
// 동작:
//   - 75초마다 문항 자동 전환 (총 5문항).
//   - 5문항 끝나면 closing 10초 표시 → cycle_id++, question_index=0 재시작.
//   - host_active=true 인 방은 sweep 에서 건너뜀 (호스트 takeover 중).
//   - state_json.demo_tick_started_at == null 이면 즉시 sweep 시 sweep tick 시각으로 초기화.
//
// 게스트가 들어와도 들어오지 않아도 cycle 은 24시간 무한 진행 (member_results 행은
// 게스트가 투표할 때만 쌓이므로 빈 방에서는 비용 0).
//
// 환경변수:
//   DEMO_TICK_INTERVAL_MS (기본 5000)   sweep 주기
//   DEMO_EXPLORE_SECONDS  (기본 75)     문항당 시간
//   DEMO_CLOSING_SECONDS  (기본 10)     사이클 결과 표시 시간
//   DEMO_TICKER_ENABLED   ('0'=비활성)  기본 ON
//
// server.js 에서 init(wsModule) 호출.

const Sentry = require('../sentry');
const { pool } = require('../db');

let wsModule = null;
let timer = null;

const TICK_INTERVAL_MS = Math.max(1000, parseInt(process.env.DEMO_TICK_INTERVAL_MS || '5000', 10) || 5000);
const EXPLORE_SECONDS = Math.max(5, parseInt(process.env.DEMO_EXPLORE_SECONDS || '15', 10) || 15);
const CLOSING_SECONDS = Math.max(5, parseInt(process.env.DEMO_CLOSING_SECONDS || '10', 10) || 10);
const HOST_ACTIVE_TIMEOUT_SEC = Math.max(60, parseInt(process.env.DEMO_HOST_ACTIVE_TIMEOUT_SEC || '1800', 10) || 1800); // 기본 30분
const ENABLED = process.env.DEMO_TICKER_ENABLED !== '0';

function countEnabledQuestions(questionsJson) {
  if (!questionsJson) return 0;
  if (Array.isArray(questionsJson)) {
    return questionsJson.filter(q => q && q.enabled !== false).length;
  }
  return 0;
}

async function sweepOnce() {
  let demoRooms = [];
  try {
    const { rows } = await pool.query(
      `SELECT r.id, r.room_code, r.demo_kind, r.questions_json,
              rs.state_json
         FROM rooms r
         LEFT JOIN room_state rs ON rs.room_id = r.id
        WHERE r.demo_kind IS NOT NULL
          AND r.status = 'open'`
    );
    demoRooms = rows;
  } catch (err) {
    try { Sentry.captureException(err, { extra: { route: 'demo-ticker.select' } }); } catch {}
    console.error('[demo-ticker] select error', err && err.message);
    return;
  }

  const now = Date.now();

  for (const room of demoRooms) {
    try {
      // ai 데모는 호스트가 핸드폰으로 직접 진행 — ticker 건너뜀.
      if (room.demo_kind === 'ai') continue;
      const state = room.state_json || {};
      // 호스트 takeover timeout 처리 — host_active=true 인데 host_active_at 이
      // 30분 이전이면 자동으로 풀고 진행 재개 (호스트가 브라우저 닫고 안 돌아온 경우).
      if (state.host_active === true) {
        const hostActiveAt = state.host_active_at ? Date.parse(state.host_active_at) : null;
        if (!hostActiveAt || (Date.now() - hostActiveAt) <= HOST_ACTIVE_TIMEOUT_SEC * 1000) {
          continue; // 아직 호스트 활성 — sweep 스킵
        }
        // timeout 초과 → host_active=false 로 풀고 normal sweep 진입
        state.host_active = false;
      }

      const questionCount = countEnabledQuestions(room.questions_json);
      if (questionCount === 0) continue; // 시드 안 됨

      let cycleId = Number.isFinite(state.demo_cycle_id) ? state.demo_cycle_id : 1;
      let qi = Number.isFinite(state.demo_question_index) ? state.demo_question_index : 0;
      let startedAt = state.demo_tick_started_at ? Date.parse(state.demo_tick_started_at) : null;

      let changed = false;
      let phase = qi >= questionCount ? 'closing' : 'explore';

      if (!startedAt) {
        // 첫 진입 — 즉시 1번 문항 표시
        startedAt = now;
        qi = 0;
        phase = 'explore';
        changed = true;
      } else {
        const elapsedSec = (now - startedAt) / 1000;
        if (phase === 'explore' && elapsedSec >= EXPLORE_SECONDS) {
          qi += 1;
          startedAt = now;
          changed = true;
          phase = qi >= questionCount ? 'closing' : 'explore';
        } else if (phase === 'closing' && elapsedSec >= CLOSING_SECONDS) {
          cycleId += 1;
          qi = 0;
          startedAt = now;
          phase = 'explore';
          changed = true;
        }
      }

      if (!changed) continue;

      const nextState = {
        ...state,
        current_tab: phase === 'closing' ? 'closing' : 'explore',
        // 기존 게스트/호스트 화면 호환 — current_question_id 1-indexed.
        current_question_id: phase === 'closing' ? questionCount : qi + 1,
        // guest.html state_update 핸들러가 보는 키 (0-indexed array index 용).
        question_index: qi,
        demo_phase: phase,
        demo_cycle_id: cycleId,
        demo_question_index: qi,
        demo_tick_started_at: new Date(startedAt).toISOString(),
        host_active: false,
        host_active_at: null,
      };

      try {
        await pool.query(
          `UPDATE room_state SET state_json = $1::jsonb, updated_at = NOW() WHERE room_id = $2`,
          [JSON.stringify(nextState), room.id]
        );
      } catch (err) {
        try { Sentry.captureException(err, { extra: { route: 'demo-ticker.update', room_code: room.room_code } }); } catch {}
        console.error('[demo-ticker] update error', err && err.message);
        continue;
      }

      // broadcast — guest.html · host.html 양쪽 동일 이벤트 받음
      try {
        if (wsModule && typeof wsModule.broadcastToRoom === 'function') {
          wsModule.broadcastToRoom(room.room_code, {
            type: 'state_update',
            state: nextState,
            demo: {
              kind: room.demo_kind,
              cycle_id: cycleId,
              question_index: qi,
              question_count: questionCount,
              phase,
              tick_seconds: phase === 'closing' ? CLOSING_SECONDS : EXPLORE_SECONDS,
              tick_started_at: nextState.demo_tick_started_at,
            },
          });
        }
      } catch (err) {
        console.error('[demo-ticker] broadcast error', err && err.message);
      }
    } catch (err) {
      try { Sentry.captureException(err, { extra: { route: 'demo-ticker.room-loop', room_id: room.id } }); } catch {}
      console.error('[demo-ticker] room loop error', err && err.message);
    }
  }
}

function init(wsModuleRef) {
  wsModule = wsModuleRef || null;
  if (!ENABLED) {
    console.log('[demo-ticker] disabled (DEMO_TICKER_ENABLED == 0)');
    return;
  }
  if (timer) return; // idempotent
  // 서버 시작 5초 후 첫 sweep
  setTimeout(() => {
    sweepOnce().catch(err => console.error('[demo-ticker] initial sweep error', err));
    timer = setInterval(() => {
      sweepOnce().catch(err => console.error('[demo-ticker] sweep error', err));
    }, TICK_INTERVAL_MS);
  }, 5000);
  console.log(`[demo-ticker] enabled — interval ${TICK_INTERVAL_MS}ms · explore ${EXPLORE_SECONDS}s · closing ${CLOSING_SECONDS}s`);
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { init, stop, sweepOnce };
