# AGENTS.md

이 저장소에서 작업하는 AI 에이전트 공통 지침. 상세는 CLAUDE.md와 docs/00~05를 따른다.

- 도메인 로직은 lib/core (프레임워크 무관), 화면은 app/.
- DB는 supabase/migrations 단일 진실. 타입은 npm run db:types 재생성.
- 개인정보·AI 검증·법적 고지 불변 규칙(CLAUDE.md)을 우선한다.
- Windows/CMD 환경. 스크립트는 scripts/에 .bat 또는 node로 작성.
