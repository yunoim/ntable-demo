# Backlog — 방 참가자 쓰기 엔드포인트 인증 강화

> 상태: **deferred** (2026-04-21 판단)
> 재평가 조건: 아래 트리거 조건 충족 시

## 현재 상태

방 참가자 전용 쓰기 엔드포인트 (`/playlist`, `/me/instagram`, `/me/profile`, `/vote`, `/vote/mvp`, `/vote/match`, `/insta-select`) 는 요청 body 의 `uuid` 를 신뢰한다. `room_members` 테이블에 해당 uuid 가 존재하는지만 검증한다.

## 위협 모델

- **외부 공격자**: 방 코드만 알아서는 `room_members` 에 없으므로 `NOT_PARTICIPANT` 로 차단 ✓
- **같은 방 참가자 (내부 사칭)**: 다른 참가자의 uuid 를 알면 그 사람으로 위장해 투표·인스타·플리 URL 조작 가능

현재 8인 오프라인 이벤트(남산엔테이블) 에서는 참가자가 동일 물리 공간에 있어 공격 유인 ≈ 0. 따라서 이벤트 레벨 리스크 낮음.

## 제안 설계

- `room_members.session_token` 컬럼 신설 (32자 랜덤, `/join` 시 발급)
- 클라이언트 localStorage 에 `room_session_${code}` 키로 저장
- 모든 member-write 엔드포인트 헤더 `x-member-token` 검증 — uuid 와 token 쌍이 일치해야 통과
- 헬퍼 `verifyMember(code, uuid, token)` 로 DRY 유지

## 적용 대상 (일괄 롤아웃 필수)

- `POST /rooms/:code/playlist`
- `DELETE /rooms/:code/playlist`
- `POST /rooms/:code/me/instagram`
- `PATCH /rooms/:code/me/profile`
- `POST /rooms/:code/vote`
- `POST /rooms/:code/vote/mvp`
- `POST /rooms/:code/vote/match`
- `POST /rooms/:code/insta-select`

단일 엔드포인트만 게이트하면 무의미 (공격자는 남은 엔드포인트로 공격). 동시 적용 필수.

## 재평가 트리거

- 팩이 단일 오프라인 이벤트 범위를 벗어남 (원격·소개팅 등 낯선 참가자 다수)
- 방당 참가자 수가 ~20명 초과해서 물리 공간 대응 불가
- 사칭 민원 실제 발생

## 마이그레이션 주의

- 이미 진행 중인 방 참가자는 기존 localStorage 에 토큰 없음 → 배포 순간 쓰기 실패
- 해결: `GET /rooms/:code/me` 가 (본인 uuid 요청 시) 토큰을 재발급·반환하도록 하고, 클라이언트가 빈 토큰 감지 시 자동 재-fetch
