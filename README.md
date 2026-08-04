# 웨딩클리어 (WeddingClear)

AI 플래너 기반 투명 가격 웨딩 직거래 플랫폼.

## 시작하기 (Windows)

필수: Node 20+ (nvm-windows), Docker Desktop(WSL2), Supabase CLI, Git

```bat
:: 1) 의존성
npm install

:: 2) 환경변수
copy .env.example .env.local
:: supabase start 출력의 URL/anon key와 API 키 기입

:: 3) 로컬 Supabase
npm run db:start
npm run db:reset      :: migrations + seed 적용
npm run db:types      :: types/database.ts 생성

:: 4) 개발 서버
npm run dev           :: http://localhost:3000
```

## 폴더 구조
```
app/            라우트 (marketing/auth/consumer/vendor/admin/api)
lib/core/       도메인 로직 (룰·가격·스키마) — 프레임워크 무관, 테스트 필수
lib/ai/         Claude 클라이언트·프롬프트·출력 검증
lib/supabase/   클라이언트(브라우저/서버) 초기화
types/          database.ts (자동 생성) 등
supabase/       migrations / seed.sql / functions
docs/           프로젝트 컨텍스트 문서 (00~05)
scripts/        배치·수집 스크립트 (참가격 등)
_local_reports/ 로컬 전용 산출물·샘플 (git 제외)
tmp/            임시 파일 (git 제외)
```

## 규칙 요약
- DB 변경: `npm run db:diff` 로 마이그레이션 생성 후 커밋 (대시보드 수동 변경 금지)
- AI 키는 서버 전용, lib/core에는 React/Next import 금지
- 자세한 개발 지침: CLAUDE.md, docs/03, docs/05
