# ntable-app — 데모 형상 개발 허브

> **Notion 동기화**: 2026-04-17
> **목적**: 누구나 호스트가 되어 실제 모임을 열고 진행할 수 있는 경량 플랫폼
> **기존 ntable(ns)과 완전 분리된 병렬 프로젝트**
> **🧊 ns 동결 (2026-04-17부)**: ns는 신규 개발 중단. 플랫폼 작업은 이 디렉토리 + `ntable-landing/`에만 집중.

---

## 🔒 MANDATORY RULES (매 세션 절대 준수)

### [R0] 브랜드 자산 참조 — 사용자 대면 텍스트 작성 시 필수
- UI · 에러 메시지 · 온보딩 · 랜딩 카피 작성 시 반드시 [`docs/brand/ntable-brand-guide.md`](docs/brand/ntable-brand-guide.md) 참조.
- 태그라인·포지셔닝 문구는 단일 소스(위 파일)에서만 정의. 하드코딩 금지.
- 노션 업데이트·보고서 작성 시에도 동일 톤 적용.
- 변경 필요 시 Notion 원본(`ntable-brand-guide`) 먼저 수정 → 레포 사본 동기화 → 관련 코드·문서 반영 순서.

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

- **인증**: OAuth 없음. 닉네임 + 브라우저 UUID (localStorage)
  - 닉네임 재로그인 지원 (localStorage 유실 시 복구 가능)
- **호스트 진입**: `app.ntable.kr` 접속 = 무조건 호스트. 로비 없음.
- **게스트 진입**: 오프라인(QR 스캔) / 온라인(URL 공유) 동시 혼합 가능
- **입장 URL**: 방 생성 시 `https://app.ntable.kr/room/:code` 자동 생성 + QR + URL 복사 버튼
- **승인**: 호스트 수동 승인 (개별/전체)
- **호스트 역할**: 방 생성 시 선택 — 진행 전담 / 게스트 겸임
- **결제/계좌/SMS/Discord 없음**
- **동시 모임 수 제한 없음**, 최대 참가자 제한 없음
- **호스트 자격**: 누구나 (prod에서는 게스트 3회 이상 시 자동 부여)
- **관리자 페이지**: `/admin` (Google OAuth + admin_users 화이트리스트, super_admin: skb.yunho.im@gmail.com)

## 파일 구조 (병렬 개발 — 담당 파일만 수정)

```
ntable-app/
├── server.js           # 앱 진입점
├── db.js               # DB 연결
├── routes/
│   ├── auth.js         # 인증 API (닉네임 로그인/재로그인)
│   ├── rooms.js        # 방 생성/조회/QR/승인/종료
│   ├── ws.js           # WebSocket (chat broadcast 포함)
│   ├── admin.js        # 호스트 진행 (투표/매칭/넛지/인스타공개)
│   ├── survey.js       # POST /api/survey, GET /api/result
│   ├── ai.js           # GET /api/personality (규칙 기반)
│   └── panel.js        # 관리자 API (/api/panel/*)
├── public/
│   ├── login.html      # 닉네임 재로그인 지원
│   ├── create.html     # 방 생성 (로그아웃)
│   ├── host.html       # 호스트 (로그아웃, MVP 실시간)
│   ├── guest.html      # 게스트 (매칭/인스타/채팅)
│   ├── survey.html, result.html, admin.html
├── questions/season1.md  # 연애 밸런스 게임 13문항
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
| `approved` | uuid | 호스트 승인 (**전체 broadcast**) |
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
- `KAKAO_JS_KEY` — 호스트 카카오 공유 (선택, 없으면 카카오 버튼 숨김)
- `PUBLIC_ORIGIN` — 선택

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
