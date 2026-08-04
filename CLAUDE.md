# CLAUDE.md — 웨딩클리어(WeddingClear) 개발 지침

> 이 파일은 Claude Code가 이 리포에서 작업할 때의 최상위 규칙이다.
> 상세 근거: `docs/07_개발명세서.md`(구현 기준), `docs/04_의사결정로그.md`(결정 이력),
> `docs/05_앱개발_로컬환경_가이드.md`(구조·환경), `06_개발환경_컨텍스트.md`(Windows 환경).
> 이 파일과 명세서가 충돌하면 **명세서가 우선**이며, 충돌 사실을 사용자에게 보고한다.

---

## 1. 프로젝트 정체성

**웨딩클리어는 투명 가격 웨딩 직거래 플랫폼이다.**

- 본체는 소비자와 업체가 직접 거래하는 **양면 플랫폼**이다. AI 플래너('클리어')와 계약서 검토
  리포트는 그 플랫폼의 **매력 기능 중 일부**이지, 단독 도구 제품이 아니다.
  (D-01: 과거 'AI 계약검토 단독 도구'로 축소하는 제안이 반려된 이력이 있다.)
- **수익 모델**: 거래 수수료(업체 부담 5~8% 범위, 요율 미확정) + 소비자 멤버십.
  업체 **광고·제휴·리베이트 수익을 받지 않는다.** 이것이 서비스 차별성의 근간이다(D-03).
- **개발 범위**: 소비자 + 업체 어드민 + 운영자 콘솔 **전면 풀개발**(D-09).
  기능·단계 축소 없음.

### 3면(three-sided) 구조

| 면 | 기능 ID | 라우트 그룹 | 기능 수 |
|---|---|---|---|
| 소비자 | F-C-01 ~ F-C-24 | `(consumer)` / `(marketing)` / `(auth)` | 24 |
| 업체 어드민 | F-V-01 ~ F-V-14 | `(vendor)` | 14 |
| 운영자 콘솔 | F-A-01 ~ F-A-14 | `(admin)` | 14 |

---

## 2. 절대 규칙 — 제안도 구현도 금지

### 2.1 범위 축소 금지

- **기능 범위를 줄이는 제안을 하지 않는다.** "MVP니까 이건 빼자", "일단 이것만 만들고
  나중에" 같은 제안 금지.
- 공개 시점 제어는 **오직 `feature_flags` 테이블(§3.8)로만** 한다.
  원칙: **'나중에 만든다'가 아니라 '만들어 두고 켜지 않는다'.**
- R2·R3 기능도 R1과 동시에 개발·테스트한다. 릴리즈 정의는 명세서 §1.3 참조.

### 2.2 광고·유료 노출 관련 산출물 금지

- 업체 광고, 유료 상위 노출, 리베이트, 제휴 수수료를 **전제로 한 스키마·API·UI를 만들지 않는다.**
  (예: `products.ad_boost`, `vendors.sponsored_rank`, `/api/vendors?promoted=true` 등 — 전부 금지)
- 정렬·추천 결과에는 **정렬 기준 코드를 API 응답과 UI에 항상 함께 노출**한다.
  - API: `GET /api/vendors` 응답에 적용된 정렬 기준 코드 포함(명세서 §4.2).
  - UI: 목록 화면에 정렬 기준 배지 노출 — "유료 노출 없음"을 화면으로 증명한다(§6 공통 UI 규칙).
  - AI 플래너의 `search_vendors` 툴도 정렬 기준 코드를 동반 반환한다(§5.5).

### 2.3 AI 산출물 법적 고지

- AI 결과가 포함된 **모든 화면**에 **"참고 정보이며 법률 자문이 아님"** 고지를 상시(고정) 노출한다.
  숨김·접힘·툴팁 처리 금지.
- 근거 조항(표준약관 / 소비자분쟁해결기준)을 함께 제시한다.
- 위약금은 **"기준 대비 비교값"**으로만 표현한다. 확정적 법적 결론·승소 가능성 언급 금지.
- 업체에 대한 부정적 판단은 **사실(등록가·계약 내역)과 기준 대비 편차로만** 표현한다.
  평가적 단정 표현 금지.

---

## 3. 구조

### 3.1 아키텍처 원칙

- **단일 Next.js 앱**(App Router) 구조다(D-08). **모노레포가 아니다.**
  프로젝트 지침 본문·`docs/03`에 남아 있는 "Turborepo + pnpm 모노레포"는 **낡은 정보**이며
  D-08로 대체되었다. 언급하지도 따르지도 않는다.
- **도메인 로직은 반드시 `lib/core/`에 작성한다** — 검출 룰, 위약금 엔진, 가격 계산, zod 스키마.
  `lib/core`에서 **React/Next를 import 하는 순간 잘못된 위치**다. (Expo 전환 시 패키지로 승격 대비)
- **Claude API 호출은 `app/api/**` 서버에서만.** 클라이언트 직접 호출 금지.
  프롬프트·클라이언트·출력 검증은 `lib/ai/`(서버 전용).
- **DB 스키마는 `supabase/migrations/` 단일 진실.** Supabase 대시보드 수동 변경 금지.
- **결정적 계산(위약금·총액·수수료)에 LLM을 쓰지 않는다.** `lib/core/pricing`의 순수 함수 + vitest.

### 3.2 폴더 구조 (docs/05 §2 그대로)

```
weddingclear/                     # 리포지토리 루트 (단일 Next.js 앱)
├─ .claude/                       # Claude Code 설정 (선택)
├─ app/                           # Next.js App Router
│  ├─ (marketing)/                # 랜딩·SEO 콘텐츠 (블로그/가이드)
│  ├─ (auth)/login, onboarding/   # 로그인·온보딩
│  ├─ (consumer)/                 # 소비자: planner(AI)·explore(탐색)·reports(검토)·budget·checkin
│  ├─ (vendor)/                   # 업체 어드민 (P2)
│  ├─ (admin)/                    # 운영자 콘솔
│  ├─ api/                        # Route Handlers: documents/reports/estimates/penalty/prices/payments/ai
│  ├─ layout.tsx / page.tsx / globals.css
├─ lib/
│  ├─ core/                       # ★도메인 로직 — React/Next import 금지 (Expo 재사용 대비)
│  │  ├─ rules/                   # 검출 룰 20종 (DetectRule)
│  │  ├─ pricing/                 # 위약금 룰 엔진(penalty.ts)·총액/다이내믹 계산
│  │  └─ schemas/                 # zod 스키마 (AI 출력 ReportSchema 등)
│  ├─ ai/                         # Claude 클라이언트·프롬프트·출력 검증 (서버 전용)
│  ├─ supabase/                   # client.ts(브라우저)/server.ts(서버) 초기화
│  └─ utils/
├─ types/                         # database.ts (supabase gen types 자동 생성)
├─ supabase/
│  ├─ migrations/                 # SQL 마이그레이션 (db diff로 생성, 단일 진실)
│  ├─ seed.sql                    # detect_rules·penalty_rules·추가금 사전 시드
│  └─ functions/                  # Edge Functions (파기 배치 등)
├─ docs/                          # 프로젝트 컨텍스트 문서 (00~05 사본)
├─ public/
├─ scripts/                       # Windows .bat + node 스크립트 (dev-setup.bat, 참가격 수집 등)
├─ _local_reports/                # 로컬 전용 산출물·샘플 (git 제외)
├─ tmp/                           # 임시 (git 제외)
├─ CLAUDE.md / AGENTS.md / README.md
├─ .env.example / .gitignore
├─ package.json / tsconfig.json / next.config.ts / tailwind.config.ts
├─ postcss.config.mjs / eslint.config.mjs / vercel.json
└─ (앱 착수 시) capacitor.config.ts + android/   # Capacitor는 같은 리포에 추가
```

> 실제 리포의 `docs/`에는 07 개발명세서도 포함된다(00~05 + 07). `06_개발환경_컨텍스트.md`는
> 현재 리포 **루트**에 있다 — 위 트리는 05 문서 원문 그대로이므로 이 차이는 알고 있을 것.

---

## 4. Windows 개발 환경 (06 문서 §2·§3 기준)

### 4.1 셸·명령 규칙

- **기본 셸은 CMD다.** 명령은 **CMD 문법으로만** 제시한다.
  - 파일 복사: `copy` (`cp` 아님)
  - 경로 구분: `\` (`C:\Users\...\weddingclear\lib\core`)
  - 환경변수: `%VAR%`
  - 주석: `::`
  - `&&` 체이닝은 CMD에서도 동작하므로 사용 가능
- **금지**: `export`, `$VAR`, heredoc(`<<EOF`), bash 전용 문법.
- 반복 작업은 `scripts\*.bat`으로 스크립트화한다. 패턴: `@echo off` + `call npm ...`.
- 파일 인코딩은 UTF-8. 문서·산출물 파일명은 한글 허용, **코드 파일명은 영문**.

### 4.2 패키지 매니저

- **npm 단일.** pnpm·yarn 혼용 금지. `pnpm-lock.yaml`·`yarn.lock` 생성 금지.

### 4.3 Python 보조 스크립트

- **소스 ASCII-only 원칙.** 주석·문자열에 한글을 직접 삽입하지 않는다.
  필요하면 유니코드 이스케이프 또는 외부 데이터 파일(UTF-8)로 분리한다.
  (Windows CMD 인코딩 사고 방지를 위한 사용자 표준)

### 4.4 표준 명령표 (06 문서 §4 그대로)

| 명령 | 동작 |
|---|---|
| `npm run dev` | Next.js 개발 서버 (localhost:3000) |
| `npm run build` / `start` | 프로덕션 빌드/실행 |
| `npm run lint` / `test` | ESLint / vitest (lib/core 단위 테스트) |
| `npm run db:start` | 로컬 Supabase 기동 (Docker 필요) |
| `npm run db:reset` | migrations + seed.sql 재적용 (로컬 DB 초기화) |
| `npm run db:diff -- -f <이름>` | 스키마 변경 → 마이그레이션 파일 생성 |
| `npm run db:types` | `types/database.ts` 타입 재생성 |
| `scripts\dev-setup.bat` | 최초 셋업 일괄 실행 |

---

## 5. 개인정보·보안 — 위반 시 작업 중단

> 아래 규칙 중 하나라도 위반하는 코드를 작성하게 될 상황이면, **작성하지 말고 즉시 중단하고
> 사용자에게 보고한다.** 우회 구현을 시도하지 않는다.

### 5.1 계약서 원문 파기

- 업로드 원문은 **분석 완료 후 24시간 내 파기**한다.
- `documents` 레코드 생성 시 **`purge_scheduled_at` 설정은 필수**다. 누락 불가.
- 파기 배치(`purge-documents` Edge Function, 매시간)가 원문·Storage 객체를 삭제한다.
- 파기 실패 시 **F-A-08(개인정보 감사) 경보**를 발생시킨다. 조용히 실패하게 두지 않는다.
- DB에는 **구조화 결과(findings)만** 저장한다.

### 5.2 마스킹

- AI 전달 **전에** 마스킹한다: **이름·연락처·주민번호·주소·계좌·사업자번호**.
- 구현 위치: `lib/core/masking` (프레임워크 무관, 단위 테스트 필수).
- 마스킹 맵은 **메모리에서만** 유지한다. DB·로그·파일에 쓰지 않는다.
- **마스킹 실패 시 AI 호출 자체를 중단하고 경보를 남긴다.** "일단 호출하고 나중에 처리" 금지.

### 5.3 로그 금지 항목

- **원문 내용·Storage 경로·마스킹 맵은 어떤 로그에도 남기지 않는다.**
- `console.log(document)`, `console.log(analysis)` 처럼 **문서 객체를 통째로 찍는 코드를
  작성하지 않는다.** 필요한 식별자(예: `analysis_id`)만 개별 필드로 로깅한다.
- 에러 로깅 시에도 원문·경로가 스택/컨텍스트에 실려 나가지 않는지 확인한다.

### 5.4 키 관리

- `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`, `TOSS_SECRET_KEY`는 **서버 전용**이다.
  Route Handler·Edge Function에서만 사용한다.
- **클라이언트 번들 유입 금지.** `NEXT_PUBLIC_` 접두어를 붙이지 않는다.
  클라이언트 컴포넌트나 `lib/supabase/client.ts` 경로에서 참조하지 않는다.
- 클라이언트에는 `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` /
  `NEXT_PUBLIC_APP_URL` / `TOSS_CLIENT_KEY`만 노출한다.
- CI에서 시크릿 스캔으로 번들 유입 여부를 검사한다(명세서 §7.2).

### 5.5 RLS

- **전 테이블 RLS 활성화.** 새 테이블을 추가하면 같은 마이그레이션에 RLS 정책을 포함한다.
- **앱 레벨 권한 체크는 UX 보조 수단이며 보안 경계가 아니다.** 최종 경계는 RLS다.
- 정책 원칙은 명세서 §3.9 참조 (커플 데이터 / 업체 데이터 / 플래너 위임 / 공개 데이터 /
  운영자 / 문서).
- Storage 접근은 **서명 URL(유효 5분)**로만. 공개 버킷은 `vendor-media` 외 금지.

### 5.6 테스트 데이터

- 로컬 계약서 샘플은 `_local_reports\samples\`에 둔다 (**git 제외**).
- **마스킹본만 커밋을 허용**한다. 원본 커밋 금지.

---

## 6. 코드 스타일

- TypeScript strict.
- API 입출력·AI 출력은 **zod 스키마로 양방향 검증**한다 (`lib/core/schemas`). 검증 실패는 **422**.
- 응답 포맷: `{ ok: boolean, data?: T, error?: { code, message, details? } }`.
  에러 코드는 도메인 접두어(`AUTH_`, `DOC_`, `PAY_`, `AI_`).
- 쓰기 요청은 `Idempotency-Key` 헤더 지원 (결제·예약·AI 생성은 필수).
- 장시간 작업(문서 분석)은 **202 + job id** 반환 후 폴링 또는 SSE.

---

## 7. 작업 방식

### 7.1 브랜치·커밋

- `dev`에서 기능 브랜치를 만들어 작업하고 PR로 병합한다. `main`은 배포 브랜치.
- 브랜치명 형식: **`feat/T-03-migrations`** (`feat|fix|chore/<태스크ID>-<요약>`).
- **커밋 전: `npm run lint && npm run test`.**

### 7.2 DB 변경 절차

```bat
:: 1) 로컬에서 스키마 수정 후 마이그레이션 생성
npm run db:diff -- -f <변경명>
:: 2) 생성된 supabase\migrations\*.sql 커밋
:: 3) 타입 재생성
npm run db:types
```

- 대시보드 수동 변경 금지. 마이그레이션 파일이 단일 진실이다.
- 새 테이블에는 RLS 정책을 **같은 마이그레이션에** 포함한다.

### 7.3 lib/core 변경 시

- **`lib/core`에 로직을 추가하면 같은 커밋에 vitest 테스트를 포함한다.**
- 특히 다음 경계값을 반드시 테스트한다:
  - 취소 시점 **구간 경계** (경계일 당일이 어느 구간에 속하는가)
  - **계약금 반환 여부** 분기
  - 할인 **하한·상한**(`floor_price` / `cap_price`) 클램프 동작
- 커버리지 목표 80% 이상(명세서 §7.5, 가정치).

### 7.4 구현 착수 전 절차

1. 기능 ID(**F-C-xx / F-V-xx / F-A-xx**)를 `docs/07_개발명세서.md` **§2**에서 찾는다.
2. 대응하는 **§3 데이터 모델**, **§4 API**, **§6 화면**을 함께 읽는다.
3. AI가 관여하면 **§5 파이프라인**도 읽는다.
4. 그 다음 코드를 쓴다.

### 7.5 명세서와 다르게 구현해야 할 때

- **임의로 진행하지 않는다.** 먼저 이유를 말하고 사용자 확인을 받는다.
- 확인 후 진행한 변경은 `docs/07_개발명세서.md`에도 반영을 제안한다.

### 7.6 새 의사결정

- 새로운 의사결정이 나오면 **`docs/04_의사결정로그.md`에 추가 항목(D-번호)을 제안**한다.
- 미결정 사항(O-01~O-09)을 임의로 확정하지 않는다. 특히:
  - **O-02 수수료 요율** → `app_settings` 파라미터로만 접근. 코드에 하드코딩 금지.
  - **O-03 에스크로 법무** → 컬럼 정의만 유지, 집행 로직은 결론 대기.

---

## 8. AI 파이프라인 요약 (명세서 §5)

- 출력은 **zod 스키마 검증** → 실패 시 1회 재시도(스키마 오류 피드백 포함) → 재실패 시
  '분석 실패' 반환. **부분 결과를 노출하지 않는다.**
- **인용 대조**: 각 finding의 `clause_excerpt`가 마스킹 원문에 실재하는지 문자열 대조.
  불일치 finding은 **개별 폐기**. 근거 없는 high 판정 금지.
- 프롬프트·룰은 `lib/core`에 코드로 관리하고 **버전 태깅**한다.
  DB `detect_rules`와 `seed.sql`로 동기화한다.
- 플래너 가드레일: 법률·세무·의료 확정 결론 금지 / 미조회 상태의 수치 생성 금지 /
  결제·서명 등 되돌릴 수 없는 행위는 툴로 실행하지 않고 화면 이동만 제안 /
  특정 업체 편향 추천 금지.

---

## 9. 앱 전략 (D-07)

- **1단계**: 이 웹앱을 **Capacitor로 래핑**해 iOS/Android 출시.
  `capacitor.config.ts`는 앱 착수 시 루트에 추가하고 `android/` 폴더를 생성한다.
- **2단계**: 전환 트리거 충족 시 **Expo 병행** — `lib/core`를 패키지로 승격해 재사용.
  트리거 목록은 `docs/05` §1 참조.
- 그래서 `lib/core`의 프레임워크 무관 원칙이 **전환 비용을 결정한다.** 타협하지 않는다.
