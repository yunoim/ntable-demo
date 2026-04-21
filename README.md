# ntable-app

소셜 모임 퍼실리테이션 SaaS (오프라인·온라인·하이브리드). 모임장이 할 일(아이스브레이킹·대화 유도·결과 정리)을 앱이 대신 수행.

- 배포: Railway (GitHub push → 자동)
- 도메인: https://app.ntable.kr
- 랜딩: https://ntable.kr (별도 레포 `ntable-landing`)
- 스택: Node.js · Express · PostgreSQL · WebSocket

## 브랜드 가이드

ntable 의 공식 태그라인·톤앤매너·표기 규칙은 [`docs/brand/ntable-brand-guide.md`](docs/brand/ntable-brand-guide.md) 에서 관리됨. 원본은 Notion.

- 랜딩·앱 화면 카피 작성 시 참조
- 노션 진행 보고·릴리스 노트 작성 시 톤 기준
- 신규 기능 마이크로카피 설계 시 예시 활용

카피 상수는 [`docs/brand/brand.json`](docs/brand/brand.json) 에 구조화 저장 (tagline · cta · error_copy · series · tone). 런타임 로드용이 아니라 하드코딩 시 기준값 참조용.

## 프로젝트 문서

- [`CLAUDE.md`](CLAUDE.md) — Claude Code 에이전트용 규칙·DB 스키마·WS 이벤트
- [`docs/brand/ntable-brand-guide.md`](docs/brand/ntable-brand-guide.md) — 브랜드 자산 (태그라인·톤·시리즈 구조)
