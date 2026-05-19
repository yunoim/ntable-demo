# ntable-app — 데모 형상 개발 허브

> **Notion 동기화**: 2026-05-12 (모듈화 Phase 1 — PACK_DEFAULTS JSON 추출 / outdated SoT 정리)
> **목적**: 누구나 모임장이 되어 실제 모임을 열고 진행할 수 있는 경량 플랫폼
> **기존 ntable(ns)과 완전 분리된 병렬 프로젝트**
> **🧊 ns 동결 (2026-04-17부)**: ns는 신규 개발 중단. 플랫폼 작업은 이 디렉토리 + `ntable-landing/`에만 집중.

---

## 🔒 MANDATORY RULES (매 세션 절대 준수)

### [R0] 브랜드 자산 참조 — 사용자 대면 텍스트 작성 시 필수
- UI · 에러 메시지 · 온보딩 · 랜딩 카피 작성 시 반드시 [`docs/brand/ntable-brand-guide.md`](docs/brand/ntable-brand-guide.md) 참조.
- 카피 상수는 [`docs/brand/brand.json`](docs/brand/brand.json) 에 구조화 저장 (tagline · cta · error_copy · series · tone). 하드코딩 시 이 파일 값과 일치시킬 것.
- 태그라인·포지셔닝 문구는 단일 소스(위 파일)에서만 정의. 하드코딩 금지.
- 공개 vs 내부 카피 분리 정책 (§2-1): 공개 랜딩·앱 hero·og = "처음이어도 유잼 모임장". 내부 스토리·세일즈 = "노잼 인간도 모임장". 메인 태그라인 "누구나 유잼 모임장이 되도록" 은 공통.
- 노션 업데이트·보고서 작성 시에도 동일 톤 적용.
- 변경 필요 시 Notion 원본(`ntable-brand-guide`) 먼저 수정 → `docs/brand/ntable-brand-guide.md` → `docs/brand/brand.json` → 관련 코드·문서 반영 순서.

### [R1] 작업 시작 전 — Notion 선행 조회
1. Notion "Claude Code 작업 로그" DB에서 관련 작업 검색 (중복 방지)
   - Data Source: `b49ce025-ec70-4ffa-b2cf-d6c57bb5db93`
2. 기술 허브 (`343eff09-d942-81e6-b340-d1247b6f0d84`) + 기획 마스터 허브 (`343eff09-d942-81ff-a339-c39a7d99e614`) 조회

### [R2] 작업 완료 후 — Notion 자동 기록 (필수)
작업이 **파일 수정/생성/삭제를 포함하면** 반드시 로그 DB에 기록. 예외 없음.

**기록 프로세스:**
1. **Dedup Key 생성**: `YYYYMMDD-ntable-app-<slug>` (예: `20260417-ntable-app-ws-fix`)
2. **Data Source에서 Dedup Key 검색** (`data_source_url: collection://b49ce025-ec70-4ffa-b2cf-d6c57bb5db93`)
3. 결과에 따라 분기:
   - **없으면**: `notion-create-pages` 로 신규 생성
   - **있으면**: `notion-update-page` 로 기존 항목 업데이트 (Files Changed 누적, Status 갱신)
4. 필수 필드:
   - `Task` (title): 간결한 작업명
   - `Project`: `ntable-app`
   - `Status`: `in_progress` / `done` / `blocked` / `reverted`
   - `Type` (multi): feature/bugfix/refactor/docs/config/test
   - `date:Date:start`: 오늘 날짜 (ISO-8601)
   - `Files Changed`: 수정한 파일 경로 쉼표 구분
   - `Summary`: 2-3줄 요약 (무엇을 왜 어떻게)
   - `Dedup Key`: 위 규칙
   - `Commit` (URL, 있으면 — GitHub commit URL)

### [R3] 작업 중 상태 변경 시
- 같은 Dedup Key의 페이지를 `update-page` 로 갱신 (새로 만들지 말 것)
- Files Changed는 **누적** (기존 값 읽고 쉼표로 추가)

### [R4] 기술 허브 업데이트 트리거
다음의 경우 기술 허브 (`343eff09-d942-81e6-b340-d1247b6f0d84`)도 같이 업데이트:
- DB 스키마 변경 → 기술 허브 "DB 스키마" 테이블 갱신
- 새 WebSocket 이벤트 추가 → "WebSocket 이벤트" 테이블 갱신
- 구현 현황 항목 완료 → "구현 진행 현황" 테이블 체크

### [R5] 금지 — 중복 생성 방지
- 같은 Dedup Key로 페이지 2개 만들지 말 것
- 모호하면 사용자에게 "기존 로그 업데이트? 신규?" 확인

### [R6] advisor 양끝 점검 (2단계 이상 개발 작업)
- **설계 advisor**: 요구사항 파악 후 설계안(엔드포인트·스키마·UI·엣지케이스) 정리 → advisor 호출 → 구현 착수
- **검증 advisor**: 파일 수정 durable 반영 후 → advisor 호출 → 사용자 보고/커밋/배포
- 1줄 수정·단순 탐색·질문은 예외. 세부 기준: memory `feedback_advisor_dev_cycle.md`

---

## 기본 정보

| 항목 | 내용 |
|------|------|
| 로컬 경로 | `C:\Users\quite\Documents\ntable-app\` |
| GitHub | `yunoim/ntable-app` |
| 배포 | Railway (GitHub push → 자동 배포) |
| 도메인 | https://app.ntable.kr (Cloudflare DNS only + Railway SSL) · demo.ntable.kr 는 전환기 301 redirect |
| 스택 | Node.js / Express / PostgreSQL / WebSocket(ws) |
| DB | Railway PostgreSQL 서비스 (DATABASE_URL 자동 주입) |
| 로컬 포트 | 3000 |

## 핵심 설계 (확정)

- **인증** (2026-04-18 OAuth 활성화): 호스트는 Google/Kakao OAuth (선택) + 게스트는 닉네임 + 브라우저 UUID (localStorage). OAuth 로그인 시 device uuid → user.uuid 마이그레이션. 닉네임 재로그인 지원 (localStorage 유실 시 복구).
- **홈 진입** (2026-04-23 T-34 개편): `app.ntable.kr` = 역할 분기 홈 — "모임을 열고 싶어요"(호스트 카드 → `/create`) vs "초대받아 들어가요"(게스트 카드 → 참여 코드 6자리 모달 → `/room/:code`). `?next=/room/CODE` / `?role=guest` / `?code=XXXXXX` 쿼리 파라미터 지원. (이전 규칙 "무조건 모임장·로비 없음" 폐기 — 게스트가 코드만 알고 QR 못 연 케이스를 웰컴 화면에서 구제해야 함.)
- **게스트 진입**: 오프라인(QR 스캔 · `/room/:code` 직접) / 온라인(URL 공유) / 홈 코드 입력 3경로. 슬림 온보딩 = 닉네임(2–8자 한글·영문) + 아바타 12개 curated pool. 나머지 7필드는 `guest.html` 의 lazy prompt 카드가 점진 수집.
- **입장 URL**: 방 생성 시 `https://app.ntable.kr/room/:code` 자동 생성 + QR + URL 복사 버튼
- **승인** (2026-04-19 자동 입장으로 변경 — 수동 승인 폐기): 게스트는 닉네임 + 아바타만 입력하면 즉시 입장. 호스트는 강퇴만 가능 (isSelf 제외).
- **모임장 역할**: 방 생성 시 선택 — 진행 전담 / 게스트 겸임
- **결제/계좌/SMS/Discord 없음**
- **동시 모임 수 제한 없음**, 최대 참가자 제한 없음
- **모임장 자격**: 누구나 (prod에서는 게스트 3회 이상 시 자동 부여)
- **관리자 페이지**: `/admin` (Google OAuth + admin_users 화이트리스트, super_admin: skb.yunho.im@gmail.com)

## 프론트엔드 스타일 정책 (2026-04-21 개정)

> 이전: "단일 HTML · 외부 CSS 없음 · 인라인 스타일". 솔로 개발 + 컴포넌트 라이브러리 일관성 요구로 전환.

- **공통 스타일**: 외부 CSS 파일 — `public/styles/theme.css`(토큰·색·폰트), `public/styles/components.css`(버튼·카드·입력·칩·모달)
- **화면별 특화**: 해당 HTML 파일 내 `<style>` 블록 허용 (공통 컴포넌트로 감당 안 되는 1회성 레이아웃만)
- **인라인 `style="..."` 속성**: 지양. 동적 값(JS 연산 결과)·1회성 미세 조정만 예외
- **변경 SoT 순서**: Notion 브랜드 가이드 → `docs/brand/brand.json` → `public/styles/*.css` → HTML `<style>` → 인라인
- **이전 정책 배경**: 초기 병렬 개발 + Claude 프롬프트 파일 단위 공유 편의. 현재는 해당 없음.

## 방(Pack) 별 UI 분기 구조 (2026-05-12 — 모듈화 Phase 1 완료, Phase 2 진행 중)

방 종류(`pack_id`)마다 대기실·탐구·자유대화·마무리 탭 UI 가 달라질 수 있도록 fragment partial 기반으로 전환 중.

### Phase 1 (완료 — 2026-05-12)
- **PACK_DEFAULTS JSON 추출**: 코드 hard-coded 였던 9개 pack 정의를 `config/pack-defaults.json` 으로 이동. 신규 pack 추가 = JSON entry + `questions/packs/{id}.md` (코드 변경 불필요).
- `routes/question-sources.js` 의 PACK_DEFAULTS · PACK_FLOW_DEFAULTS 는 JSON 에서 derived. exports API 호환 유지.

### Phase 2 POC (완료 — 2026-05-13)
- `GET /pack/:id/:phase` server route (`routes/pack-fragments.js`) — whitelist + cache 300s + `_default` fallback + 204 No Content silent skip.
- `ntPackFragment.load({pack_id, phase, slotId})` client helper (`public/js/pack-fragment-loader.js`) — fetch 메모리 캐시 + AbortSignal 2.5s timeout + inject 후 `applyCopyToDOM` 자동 호출.
- `config/pack-ui-overrides.json` manifest. `public/packs/_default/intro.html` fragment.
- host.html intro panel 에 `#pack-intro-card-slot` 추가 + loader script tag.

### Phase 3 (완료 — 2026-05-13, `f6f0bfe`)
- 첫 실제 영역 추출: host.html `#no-approved` → `_default/intro.html` fragment.
- 신규 pack 은 `public/packs/{id}/intro.html` 작성해 안내 텍스트 override 가능.
- `renderProfiles` null safety + fragment load 후 재호출 (race 회피).

### Phase 4-6 (진행 중 — 2026-05-13)
- explore / free / ending 3 phase 에 안내·tip slot 동시 보급: `#pack-explore-card-slot`, `#pack-free-card-slot`, `#pack-ending-card-slot`.
- `_default/explore.html`, `_default/free.html`, `_default/ending.html` 빈 fragment (zero regression).
- `loadRoomInfo` 에서 4-phase 모두 eager load (intro 는 P3 추출이라 재호출 콜백 포함, 나머지는 신규 영역이라 콜백 없음).
- 신규 pack 이 phase tip 원하면 `public/packs/{id}/{phase}.html` 작성.

### Phase 7 (완료 — 2026-05-13)
- 신규 pack 추가 가이드 문서: `docs/PACK_GUIDE.md`.
- `routes/question-sources.js` 의 임시 dead block (`if (false) { _REMOVED = {...} }`) 제거 — 574→374 line.

### Phase 9 (완료 — 2026-05-19)
- 첫 큰 영역 + JS 모듈 분리: `playlist-share` 의 `#playlist-player-card` (HTML 32줄) + `refreshPlaylistMap` · PP 네임스페이스 · 16개 `pp*` 함수 (JS 258줄) 통째 추출.
- 신규 파일 2개: `public/packs/playlist-share/free.html`, `public/js/packs/playlist-share.js` (IIFE → `window.ntPack['playlist-share']`).
- `pack-fragment-loader.js` 확장: `loadModule(pack_id)` (동적 `<script>` 주입 + 404 silent skip + Promise cache), `pack(pack_id, method, ...args)` dispatcher.
- host.html 의 인라인 `if (pack_id === 'playlist-share') ...` 4곳 → `ntPackFragment.pack(...)` dispatcher 로 일원화. host.html: 6797 → 6514 line (-283).
- `#pack-free-card-slot` 위치 이동 (free-grid 아래 → 위) — playlist-share 진입 시 플리 카드를 질문 카드보다 먼저 보이도록.
- 다른 8개 pack: 모듈 파일 없음 → loadModule 404 silent skip + `_default/free.html` 빈 fragment 그대로 → zero regression.
- 모듈 API 규약: `init({state})`, `refreshMap`, `onEnterFreeChat` 등 도메인 메서드. 호출자는 `ntPackFragment.pack(pack_id, 'methodName', ...)` 만 알면 됨 (`if (pack_id === '…')` 분기 불필요).

### 신규 Pack 추가 흐름 (현재 가능한 영역)
1. `questions/packs/{id}.md` — 탐구 질문·자유대화 주제 (4-tier · 3-group).
2. `config/pack-defaults.json` — 메타 entry (series, content_kind, flow, wizard_*, result_sections, labels 등).
3. (선택) `public/packs/{id}/intro.html` — 빈 방 안내 텍스트 override.
4. (선택) `public/packs/{id}/{explore|free|ending}.html` — 각 phase 안내·tip 카드.
5. (선택) `config/pack-ui-overrides.json` — 향후 UI override manifest 필요 시.

위 1-2번이 필수, 3-5번이 optional. **Phase 9 (2026-05-19) 추가**: pack-specific JS 모듈은 `public/js/packs/{id}.js` 작성 → IIFE 로 `window.ntPack[pack_id] = { init, ...methods }` 노출 → host.html 의 `loadRoomInfo` 가 자동 `loadModule` + dispatcher 호출. **남은 한계**: host.html 의 기타 큰 영역 (lobby tabs, profile carousel, vote bars 등) 은 여전히 in-place — pack-specific 변경 시 host.html 직접 수정 필요.

### 합의된 규약 (다음 PR 의 fragment 로더가 이 규약 전제로 구현)

1. **URL**: `/pack/:id/:tab` — HTML fragment 반환 (e.g. `/pack/couples/intro`, `/pack/playlist-share/explore`)
2. **Fragment 형태**: `<section class="pack-panel" id="panel-${tab}-pack-${id}">…</section>` 단일 root. `<html>/<head>/<body>` 없음.
3. **ID prefix**: fragment 내부의 모든 element id 는 기존 host.html/guest.html 과 충돌 안 나도록 `${something}-pack-${id}` 로 suffix. 예: `panel-intro-pack-couples`.

### 이미 심어둔 hook (이번 PR)

- `document.body.classList.add('pack-${pack_id}')` — host.html (loadRoomInfo), guest.html (loadRoom). CSS 에서 `body.pack-couples .nt-lobby-topbar { ... }` 같은 pack-scoped 스타일 분기 가능.
- `opt-in to hero` 원칙: 기본값 최소, pack 별로 명시 opt-in. 신규 pack 추가 시 "왜 이건 특이하지" 대신 "이 pack 은 hero 선언" 이 드러나게.

### 아직 안 만든 것 (imaginary hook 금지 원칙)

- `PACK_UI_OVERRIDES` manifest · `packUI(path, fallback)` helper — **fragment 로더와 함께 태어나야 함** (advisor 30분 검토 결과). 지금 behavior flag 쌓으면 B 철학에 역행.
- Fragment 로더 JS · `/pack/:id/:tab` server route · 첫 intro POC — 다음 PR 에서 advisor 호출과 함께 설계.

## 파일 구조 (병렬 개발 — 담당 파일만 수정)

```
ntable-app/
├── server.js           # 앱 진입점
├── db.js               # DB 연결
├── routes/
│   ├── auth.js         # 인증 API (닉네임 로그인/재로그인)
│   ├── rooms.js        # 방 생성/조회/QR/승인/종료
│   ├── ws.js           # WebSocket (chat broadcast 포함)
│   ├── admin.js        # 모임장 진행 (투표/매칭/넛지/인스타공개)
│   ├── survey.js       # POST /api/survey, GET /api/result
│   ├── ai.js           # GET /api/personality (규칙 기반)
│   └── panel.js        # 관리자 API (/api/panel/*)
├── public/
│   ├── login.html      # 닉네임 재로그인 지원
│   ├── create.html     # 방 생성 (로그아웃)
│   ├── host.html       # 모임장 (로그아웃, MVP 실시간)
│   ├── guest.html      # 게스트 (매칭/인스타/채팅)
│   ├── survey.html, result.html, admin.html
├── questions/packs/*.md  # 9개 팩 (couples/dating/icebreaker/workshop/playlist-share/...)
├── config/pack-defaults.json  # 2026-05-12 신설 — pack 메타 SoT
├── docs/brand/   # brand.json + brand-guide.md
├── lib/          # 공용 헬퍼 (mailer 등)
├── public/styles/  # tokens.css + components.css
├── public/js/      # 클라이언트 공용 (brand.js 등)
├── .husky/         # 2026-05-09 신설 — pre-commit lock 동기화
├── nixpacks.toml   # Railway 빌드 설정 (npm ci 강제)
├── package.json, .env.example, README.md
```

**병렬 개발 규칙**: 각 개발자는 담당 파일만 건드림. `server.js`는 1번만 수정.

## DB 스키마 (PostgreSQL)

| 테이블 | 주요 컬럼 |
|--------|-----------|
| `users` | uuid(PK), nickname(UNIQUE), gender, birth_year, region, industry, mbti, interest, instagram |
| `rooms` | id(PK), room_code(UNIQUE), title, host_uuid, host_role(host_only/participant), status(waiting/open/closed) |
| `room_state` | room_id(PK), state_json, updated_at |
| `survey_responses` | id, uuid, room_id, satisfaction, revisit, nps, best_moment, regret, review |
| `member_results` | id, uuid, room_id, room_code, votes_json, match_json, fi_count — UNIQUE(uuid, room_id) |

### 중요 포맷 규칙 (통합 디버깅 결과)

- **`votes_json`**: Object 형태 `{ "1": "A", "2": "B" }` 로 통일 (Array 아님)
- **`match_json`**: `{ pairs: [{ type: 'mutual'|'recommended', a: {uuid, nickname}, b: {uuid, nickname} }], mvp: {uuid, nickname, fi_count} }`
- **`db.js` import**: `const { pool } = require('../db')` (구조분해 필수)

## WebSocket 이벤트

엔드포인트: `WS /ws/{room_code}/{uuid}`

| 이벤트 | payload | 용도 |
|--------|---------|------|
| `user_joined` | uuid, nickname | 입장 알림 |
| `user_left` | uuid | 퇴장 알림 |
| `approved` | uuid | 모임장 승인 (**전체 broadcast**) |
| `state_update` | state_json | 탭/단계 전환 |
| `vote_result` | question_id, counts | 투표 집계 |
| `nudge` | message | 자리 셔플 |
| `question_card` | text | 질문 카드 팝업 |
| `matching_result` | match_json | 매칭 발표 |
| `chat` | uuid, nickname, message, ts | 익명 채팅 broadcast |
| `mvp_update` | mvp_list | MVP 투표 실시간 집계 |
| `insta_mutual` | a_uuid, b_uuid, a, b | 인스타 상호공개 완료 |
| `room_closed` | - | 모임 종료 |

## 환경변수 (Railway)

- `SESSION_SECRET` — 랜덤 문자열
- `ANTHROPIC_API_KEY` — sk-ant-... (없으면 규칙 기반 폴백)
- `DATABASE_URL` — Railway 자동 주입
- `PORT` — Railway 자동
- `GOOGLE_CLIENT_ID` · `GOOGLE_CLIENT_SECRET` · `ADMIN_OAUTH_REDIRECT_URI` — 관리자 OAuth (필수)
- `KAKAO_JS_KEY` — 모임장 카카오 공유 (선택, 없으면 카카오 버튼 숨김)
- `PUBLIC_ORIGIN` — 선택

> **부트 시 env 누락 자동 감지** (2026-05-04, `e399b70`): `server.js` 의 `logEnvStatus()` 가 initDB 직후 required/optional 분리해 콘솔 출력. Railway 배포 후 누락 즉시 가시화.

## 코드 패턴 / 헬퍼 (2026-05-04 신설)

### `routes/_db-errors.js` — DB 에러 관측성 헬퍼

모든 라우트의 generic-500 catch 표준. PG 에러 필드 구조화 + Sentry 캡처 + 정규화 응답.

```js
const { logDbError, captureDbError } = require('./_db-errors');

// 신규 라우트 / 응답 표준화 OK 인 경우
try { ... } catch (err) {
  logDbError(res, 'POST /api/foo', err, { uuid, room_code });
  // 응답: 500 + {error:'db error', code:<SQLSTATE>}
}

// 기존 응답 포맷 유지해야 하는 경우 (클라이언트 호환)
try { ... } catch (err) {
  captureDbError('POST /api/legacy', err, { ctx });
  return res.status(500).json({ error: 'INTERNAL_ERROR' });
}
```

- 두 헬퍼 모두 `code · detail · constraint · routine · table · message` 구조화 console.error + `Sentry.captureException(err, { extra: { route, ...pgFields, ctx } })`
- `logDbError` 만 응답 표준화 (`{error:'db error', code:<SQLSTATE>}`)
- 23505 같은 에러 서브타입 분기는 catch 진입 후 분기 먼저 처리하고 generic 500 leg 에서만 헬퍼 호출
- 트랜잭션 내부면 `client.query('ROLLBACK')` 먼저, 그 다음 헬퍼 호출
- ws.js 같은 비-HTTP 핸들러도 `captureDbError` 사용 가능 (응답 없으므로 logDbError 부적합)
- 적용 현황 (2026-05-04): rooms · survey · auth · ai · admin · panel · admin-auth · ws.js — 50+ catch 통일

### `routes/question-sources.js` — 'final' tier 콘텐츠 패턴

탐구 질문 풀에서 마지막 자리에 항상 같은 문항이 오게 하려면:

```markdown
## 탐구 질문 - Final

Q1. 결혼은 나에게?
A. 꼭 하고 싶은 것
B. 인연 따라 (꼭은 아님)
```

- 헤더는 `Final` / `마지막` / `고정` 모두 인식
- 풀에 여러 문항 두면 `final[0]` 만 선택됨 (셔플 X — 의도된 고정)
- `buildRoomQuestions()` 가 final 풀 차있으면 count -= 1 → 다른 tier 분배 후 final[0] 을 명확한 마지막에 배치
- 미사용 팩(섹션 없음)은 기존 surface→preference→deep arc 그대로 (zero regression)
- `compat_rule` 자동 전달 (couples 역대응 도 적용 가능)

### 게스트 catch-up 패턴 (mobile WS 좀비 대응)

WS onclose 에서 reason 만으로 redirect 결정 금지 — 브라우저 기본 reason 이 정규식 false-positive 잡을 수 있음. 명시 코드 (4005 등) 외엔 REST 로 server state 재검증:

```js
if (e.code === 4005 || /closed/i.test(e.reason || '')) {
  let serverConfirmed = e.code === 4005;
  if (!serverConfirmed) {
    const opts = AbortSignal.timeout
      ? { signal: AbortSignal.timeout(2000) }
      : undefined;
    const r = await fetch(`/api/rooms/${code}`, opts).catch(() => null);
    serverConfirmed = r && r.ok && (await r.json()).status === 'closed';
  }
  if (serverConfirmed) location.replace(...);
  // else: fall-through to reconnect — transient mobile sleep
}
```

A1 (`6af02d1`), B (`9a5fb6f`) 모두 이 패턴 사용.

### 호스트 WS 재접속 catch-up 패턴

좀비 WS 동안 누락된 broadcast 풀카운트 복원:

```js
// forceReconnectHost 에서 pre-clear (race 제거)
state.currentVotes = {};
connectWS();

// ws.onopen 에서 REST catch-up
async function catchUpVoteCounts() {
  const r = await fetch(`/api/rooms/${code}/explore-result`, {
    signal: AbortSignal.timeout(3000)
  }).catch(() => null);
  if (!r || !r.ok) return;
  const data = await r.json();
  // 재계산 → state 풀 덮어쓰기 → 현재 화면 재렌더
}
```

A2 (`d13bb8c`) 적용. cache 가 새 broadcast 와 race 안 나도록 forceReconnect 단계에서 비우는 게 핵심.

## 구현 완료 현황

- [x] GitHub + Railway + Cloudflare 인프라
- [x] Railway PostgreSQL 서비스
- [x] server.js + db.js + auth.js + login.html
- [x] rooms.js + ws.js + create.html (QR base64 PNG 반환)
- [x] host.html + admin.js
- [x] guest.html (단일 파일, WS 재연결 + ping 30s)
- [x] ai.js (규칙 기반 성향 분석 — 8유형)
- [x] survey.html + result.html + survey.js
- [x] 통합 디버깅 (votes_json 포맷 통일)
- [x] 닉네임 재로그인 + 로그아웃
- [x] 관리자 페이지 /admin
- [ ] 전체 플로우 통합 테스트

## 작업 원칙

1. **R1 선행 조회** — Notion 허브 + 작업 로그 DB
2. **R2 작업 완료 후 Notion 자동 기록** (예외 없음)
3. **담당 파일만 수정** — 다른 파일 건드리지 말 것
4. **전체 파일 출력** — 부분 patch 금지, 내가 로컬에 덮어씀
5. **완료 시 변경 파일 목록 정리**
6. **이전 파트 코드는 내가 직접 붙여줌** — 물어보지 말고 기다릴 것
7. **기존 ntable(ns) 코드 절대 수정 금지**

## 금지 사항

- R2 건너뛰기 (작업 후 Notion 로그 미기록)
- 같은 Dedup Key로 신규 페이지 생성 (반드시 검색 후 업데이트)
- 다른 파일 수정 / server.js 중복 수정
- 부분 patch 제안
- 기존 ntable(ns) 코드 수정

## Windows 주의

- 로컬 실행: `npm install` → `npm start`
- `.env`는 `.gitignore` 등록 필수

## 관련 Notion 페이지

| 용도 | ID |
|------|-----|
| 기술 허브 | `343eff09-d942-81e6-b340-d1247b6f0d84` |
| 기획 마스터 허브 | `343eff09-d942-81ff-a339-c39a7d99e614` |
| 상위 허브 (ntable 전체) | `340eff09-d942-81e1-b31d-d190cfab0fef` |
| **Claude Code 작업 로그 DB** | **`collection://b49ce025-ec70-4ffa-b2cf-d6c57bb5db93`** |

## 작업 로그 기록 템플릿 (참고)

```
Task: "ws.js chat broadcast 누락 수정"
Project: ntable-app
Status: done
Type: [bugfix]
date:Date:start: 2026-04-17
Files Changed: routes/ws.js
Summary: ping만 처리하던 ws.js에 chat 메시지 broadcast 핸들러 추가. 자유대화 채팅 복구.
Dedup Key: 20260417-ntable-app-ws-chat-broadcast
Commit: https://github.com/yunoim/ntable-app/commit/abc123
```
