# 신규 Pack 추가 가이드

> ntable-app 의 새 모임 종류(pack)를 추가하는 방법.
> 2026-05-13 모듈화 Phase 1-7 완료 시점 기준.

---

## 한 줄 요약

- **콘텐츠만** 다르면 → `.md` 파일 1개 + JSON entry 1개 추가로 끝 (코드 수정 0).
- **UI 안내·tip 카드**를 phase 별로 따로 두고 싶으면 → `public/packs/{id}/{phase}.html` 추가.
- **기존 큰 UI 영역** (lobby tabs · vote bars · matching cards 등) 을 pack-specific 으로 다르게 만들고 싶으면 → 현재는 host.html 직접 수정 필요 (Phase 8+ 영역).

---

## 1. 필수 — 콘텐츠 + 메타 entry

### 1-1. `questions/packs/{pack_id}.md` 작성

```markdown
---
id: corporate
title: 회사 워크숍
description: 동료의 의외의 면을 발견하는 10문항
icon: 💼
recommended: 8-15명
tone: 부드럽고 안전한
category: workplace
---

## 탐구 질문 - Warm-up

Q1. 점심 메뉴는?
A. 정해두고 가는 편
B. 그날 분위기 보고 정함

## 탐구 질문 - Preference

Q2. 회식 자리가 길어지면?
A. 끝까지 자리 지킴
B. 적당히 빠지는 편

## 탐구 질문 - Final

Q3. 우리 팀이 더 잘되려면?
A. 정해진 절차 강화
B. 자유도 + 책임 강화

## 자유대화 주제 - 물어보기

- 회사 와서 가장 의외였던 동료의 모습은?
- 일하면서 가장 보람 있었던 순간?

## 자유대화 주제 - 꺼내기

- 내가 가장 잘하는 일 하나 자랑하기
```

- **Tier 헤더**: `## 탐구 질문 - Warm-up` / `- Preference` / `- Deep` / `- Final`. Final 은 풀의 첫 항목이 항상 마지막 자리에 고정.
- **Topic group**: `## 자유대화 주제 - 물어보기` / `- 꺼내기` / `- 상상하기`.
- **Compat rule**: 질문 끝에 `[반대]` 또는 `[opposite]` 태그 추가하면 반대 답이 호환 (커플 매칭 역대응).
- 미사용 섹션은 생략 가능 — `## 탐구 질문` 단일 섹션도 하위호환 인식.

### 1-2. `config/pack-defaults.json` entry 추가

```json
"corporate": {
  "series": null,
  "content_kind": "conversation",
  "flow": ["mvp", "explore-result"],
  "wizard_fields": ["nickname", "emoji", "industry", "mbti", "interest"],
  "wizard_required": ["nickname"],
  "wizard_prompt_after_join": ["industry", "mbti", "interest"],
  "display_fields_default": ["industry", "mbti", "interest"],
  "result_sections": ["ai_personality", "mvp", "explore_result", "summary"],
  "skip_free_chat": false,
  "insta_exchange_enabled": false,
  "best_match_enabled": false,
  "mvp_enabled": true,
  "match_pairs_enabled": false,
  "chat_reactions": ["👍 좋은 의견", "📝 메모", "❓ 질문 있음", "✅ 동의", "😄 재밌네요"],
  "labels": {
    "page2_card_title": "🎯 오늘의 주인공",
    "best_match_eyebrow": "비슷한 답을 고른 동료"
  }
}
```

- **`series`**: 상위 카테고리 (`ntable-nights` / `ntable-plays` / `null` 등).
- **`content_kind`**: `conversation` / `playlist` / `performance` / `creation` [skeleton] / `pitch` [skeleton] / `record` [skeleton].
- **`flow`**: 마무리 단계 배열. `['mvp', 'match', 'explore-result']` 조합.
- **`wizard_fields`**: 입장 마법사가 수집 가능한 필드 (`nickname` / `emoji` / `gender` / `birth_year` / `region` / `industry` / `mbti` / `interest` / `instagram` / `playlist`).
- **`wizard_required`**: 그 중 입장 *시* 필수 (`nickname` 외엔 게스트 lazy prompt 로 사후 수집).
- **`result_sections`**: 결과 페이지 섹션 화이트리스트 (`ai_personality` / `couple_love` / `couple_card` / `best_match` / `mutual_pairs` / `mvp` / `explore_result` / `summary`).

### 1-3. (선택) `public/create.html` ROOM_KITS 에 신규 pack 노출

`ROOM_KITS` 배열에 entry 추가하면 모임장이 방 만들 때 UI 카드로 선택 가능. 추가 안 하면 코드 leverage 만.

---

## 2. 선택 — Pack-specific 안내·tip 카드

각 phase 진입 시 host.html slot 에 inject 되는 작은 카드. 4 phase 모두 override 가능.

| 파일 경로 | Slot | 노출 시점 |
|---|---|---|
| `public/packs/{id}/intro.html` | `#pack-intro-card-slot` | 대기실 |
| `public/packs/{id}/explore.html` | `#pack-explore-card-slot` | 탐구 단계 |
| `public/packs/{id}/free.html` | `#pack-free-card-slot` | 자유대화 |
| `public/packs/{id}/ending.html` | `#pack-ending-card-slot` | 마무리 |

### Fragment 형식

```html
<!-- public/packs/corporate/intro.html -->
<section class="pack-panel" id="panel-intro-pack-corporate">
  <div class="empty-msg" style="text-align:center; padding:24px 0; font-size:14px;">
    초대 링크를 팀 채널에 공유하세요. 익명으로 솔직한 의견을 들을 수 있어요.
  </div>
</section>
```

- `<section class="pack-panel" id="panel-{phase}-pack-{id}">` root 1개.
- `<html>/<head>/<body>` 없이 partial HTML.
- 내부 element id 충돌 회피 — `${something}-pack-${id}` suffix 권장.
- `data-copy="brand.path"` 사용 시 brand.json 의 카피 자동 치환됨 (`applyCopyToDOM` hook).

### 파일 없으면 어떻게 되나
- `public/packs/{id}/{phase}.html` 없음 → `_default/{phase}.html` 로 fallback.
- `_default/{phase}.html` 도 없음 → 204 No Content → 클라이언트 silent skip (zero regression).

### 보안·운영 가드
- pack_id whitelist: `/^[a-z0-9_-]{1,40}$/`. 디렉토리 traversal 차단.
- phase whitelist: `intro` / `explore` / `free` / `ending` 만.
- Cache-Control 300s (5분). 콘텐츠 자주 안 바뀌면 OK.

---

## 3. 추가 영역이 필요할 때 — Phase 8+ 영역

현재 모듈화는 *4 phase × 1 slot 씩* 만 fragment 화 됨. 다음 큰 영역은 host.html 안에 inline:

- `#lobby-tabs-host` (사람/채팅 토글)
- `#profile-carousel` (참가자 카드)
- `#mp-list-wrap` (모바일 참가자 리스트)
- `#vote-bars` (탐구 투표 막대)
- `.closing-grid` (마무리 카드들)

이런 큰 영역을 pack-specific 으로 다르게 만들고 싶으면:
1. 해당 영역 추출 (host.html DOM/CSS/JS 모두 분리)
2. fragment 형식으로 변환
3. `loadRoomInfo` 또는 `switchTab` 에서 load 호출
4. JS direct manipulate 함수 (예: `renderVoteBars`, `updateMVPList`) 의 element 참조 null safety 추가
5. fragment inject 완료 후 해당 함수 재호출 (race 회피)
6. prod 핵심 시나리오 수동 워크스루로 회귀 검증

Phase 3 의 `#no-approved` 추출이 이 패턴의 첫 사례. 회귀 위험 크므로 1 영역 = 1 commit = advisor 양끝 + 사용자 검증 권장.

---

## 4. 참고 파일

- `routes/question-sources.js` — `.md` 파서 + PACK_DEFAULTS derived from JSON.
- `routes/pack-fragments.js` — `/pack/:id/:phase` server route.
- `public/js/pack-fragment-loader.js` — `ntPackFragment.load()` helper.
- `config/pack-ui-overrides.json` — 향후 UI override manifest (현재 POC 단계).
- `CLAUDE.md` "방(Pack) 별 UI 분기 구조" 섹션 — Phase 1-7 진행 상태.
