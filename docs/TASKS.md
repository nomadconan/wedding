# TASKS.md — 웨딩클리어 개발 태스크

> 진행 표기: `[ ]` 미착수 · `[~]` 진행 중 · `[x]` 완료
> 브랜치명 형식: `feat/T-03-migrations`
> 각 태스크는 `docs/07_개발명세서.md`의 해당 절을 근거로 한다.
> **범위 축소 금지**(CLAUDE.md §2.1) — 공개 제어는 `feature_flags`로만 한다.

---

## 진행 현황

| ID | 태스크 | 상태 | 명세서 근거 | 마일스톤 |
|---|---|---|---|---|
| T-01 | 리포 초기화·셋업 검증 | [~] | §8 M0, 부록 C | M0 |
| T-02a | 브랜치·원격 정리 | [~] | §7.2 | M0 |
| T-02b | CI 파이프라인 | [ ] | §7.2, §7.5 | T-04 이후 |
| T-02c | 이미지·아이콘 자산 규약 | [x] | §6, §7.5 | M0 |
| T-03 | 마이그레이션 1차 | [x] | §3.1~§3.8, §3.9 | M0 |
| T-04 | lib/core 골격 + 테스트 | [x] | §5.1·§5.2·§5.3·§5.4, 부록 A, §7.5 | M0~M1 |
| T-05 | 인증·온보딩 | [ ] | F-C-01, F-C-02 | M1 |
| T-06 | 예산 배분·추적 | [ ] | F-C-05 | M1 |

---

## T-01 — 리포 초기화·셋업 검증

**상태:** [~] (`npm run db:start` 사용자 확인 대기)

### 목적
스캐폴드를 실제로 구동 가능한 개발 환경으로 만든다. 이후 모든 태스크가 로컬에서
빌드·테스트·DB 초기화를 반복할 수 있는 기반을 확보한다.

### 선행조건
- Node.js 20 LTS 설치 (nvm-windows로 버전 고정 권장)
- Docker Desktop 설치 + WSL2 백엔드 활성화 (Supabase 로컬 스택용)
- Supabase CLI 사용 가능 (`scoop` 설치 또는 `npx supabase`)
- 리포 루트에 스캐폴드 전개 완료

### 작업 내용
```bat
:: 최초 셋업 (docs/07 부록 C)
npm install
copy .env.example .env.local
:: → .env.local 에 supabase start 출력값 / ANTHROPIC_API_KEY / 토스 테스트 키 기입
npm run db:start
npm run db:reset
npm run db:types
npm run dev
```
- `vitest` 설정 확인 — `lib/core` 대상 단위 테스트가 실제로 수집·실행되는지.
- `next lint` / ESLint flat config가 동작하는지 확인.
- `scripts\dev-setup.bat`이 위 흐름을 일괄 실행하도록 정비.

### 완료 판정 기준
- [x] `npm run dev` → `http://localhost:3000` 이 HTTP 200 으로 응답한다.
- [ ] `npm run db:start` → 로컬 Supabase(Docker) 스택이 기동된다. *(사용자가 Docker 기동 후 직접 실행)*
- [x] `npm run lint && npm run test` 가 **통과**한다 (ESLint 경고 0, vitest 4건 통과).
- [x] `.env.local` 이 `.gitignore` 로 제외되어 있고, `.env.example` 에 필요한 키 목록이 전부 있다.
- [x] (추가 확인) `npm run build` 가 통과한다 — T-02 CI 의 build 스텝 전제.

### T-01 에서 실제로 변경된 것
| 파일 | 변경 |
|---|---|
| `package.json` | `eslint` `^9` → `^8.57.1` (eslint-config-next@14.2 peer 범위), `supabase` devDependency 추가 |
| `.eslintrc.json` | 신규 — `next/core-web-vitals`. flat config(`eslint.config.mjs`)는 삭제 |
| `next.config.mjs` | `next.config.ts` 대체 (Next 14 는 TS config 미지원) |
| `vitest.config.ts` | 신규 — `include`에 `lib/core` 테스트 경로 명시 |
| `lib/core/smoke.test.ts` | 신규 — 스모크 테스트 4건 |
| `.gitignore` | 전역 `*.pdf`/`*.docx` → `_local_reports/**`·`tmp/**` 경로 한정 |
| `scripts/dev-setup.bat` | 단계별 실패 중단, `.env.local` 덮어쓰기 방지, `dev` 까지 연결 |
| `lib/supabase/server.ts` | `setAll` implicit any 제거 (build 차단 이슈) |

---

## T-02a — 브랜치·원격 정리

**상태:** [~] (로컬 브랜치 정리 완료 / **GitHub 원격 미생성**으로 push·PR·보호규칙 대기)

### 목적
PR 기반 개발 흐름이 올라탈 브랜치·원격 구조를 고정한다. CI는 T-02b에서 분리해 다룬다.

### 선행조건
- T-01 완료
- GitHub 리포지토리 생성 ← **현재 미충족**

### 작업 내용
- `main`(배포) / `dev`(통합) 브랜치 확보. 기능 브랜치는 `dev`에서 분기.
- `dev` 를 `main` 기준으로 동기화 (히스토리 재작성 없이 fast-forward).
- GitHub 원격 연결 → `dev` push + upstream 설정.
- GitHub 기본 브랜치를 `dev` 로 변경 (웹 UI).
- `main` 브랜치 보호: 직접 push 금지, PR 병합만 허용 (웹 UI).

### 완료 판정 기준
- [x] `main` / `dev` 브랜치가 로컬에 존재하고 동일 커밋을 가리킨다.
- [x] 기존 커밋 2개(`62a2252`, `ede2083`)의 히스토리가 재작성되지 않았다.
- [ ] `origin` 원격이 연결되어 있다.
- [ ] `origin/dev` 가 존재하고 로컬 `dev` 에 upstream 이 설정되어 있다.
- [ ] GitHub 기본 브랜치가 `dev` 다.
- [ ] `main` 직접 push 가 차단되고 PR 병합만 허용된다.

> **잔여 사유**: 이 리포에 git 원격이 하나도 설정되어 있지 않고 `gh` CLI 도 미설치라,
> push·PR·브랜치 보호를 수행할 수 없다. GitHub 리포 생성 후 재개한다.

---

## T-02b — CI 파이프라인

**상태:** [ ] (**T-04 이후 착수**)

### 목적
개인정보·보안 사고를 자동으로 차단하는 게이트를 건다.
특히 **서비스롤 키·ANTHROPIC_API_KEY의 클라이언트 번들 유입**을 사람이 아니라 CI가 잡는다.

### 선행조건
- T-02a 완료 (원격·브랜치 보호가 있어야 PR 트리거를 걸 수 있다)
- T-04 완료 — `lib/core` 테스트가 실질 커버리지를 갖춘 뒤에 CI 게이트를 거는 것이 순서다.
  (스모크 테스트만 있는 상태로 게이트를 걸면 통과가 무의미하다)

### 작업 내용
- GitHub Actions 워크플로 작성 — PR 트리거로 다음을 실행:
  1. `npm ci`
  2. `npm run lint`
  3. `npm run test`
  4. `npm run build`
  5. **시크릿 스캔** (커밋된 키 탐지)
  6. **클라이언트 번들 시크릿 유입 검사** — 빌드 산출물에 `SUPABASE_SERVICE_ROLE_KEY` /
     `ANTHROPIC_API_KEY` / `TOSS_SECRET_KEY` 값이나 참조가 포함되지 않았는지 확인
  7. `npm audit` (의존성 취약점)
- Vercel 연결 → PR마다 Preview 배포.

### 완료 판정 기준
- [ ] PR을 열면 **lint + test + build + 시크릿 스캔**이 자동 실행된다.
- [ ] 위 검사 중 하나라도 실패하면 병합이 차단된다.
- [ ] 일부러 서버 전용 키를 클라이언트 컴포넌트에서 참조한 PR이 CI에서 **실패**하는 것을 확인했다.

---

## T-02c — 이미지·아이콘 자산 규약

**상태:** [x] (2026-08-07 완료 · 슬롯 **18개** 정의)

### 목적
실제 이미지를 나중에 제작하더라도 **같은 경로·같은 파일명으로 덮어쓰기만 하면 교체가 끝나도록**
자산 참조를 매니페스트 한 곳으로 모은다. 지금은 정확한 치수의 자리표시 이미지를 커밋해
빌드와 CI(T-02b)가 이미지 부재로 깨지지 않게 한다.

### 작업 내용
- `lib/assets/manifest.ts` — 단일 진실. `AssetSlot` 타입 + `ASSETS` 레코드.
  슬롯 근거는 명세서 §6 화면 명세의 **R1 화면**으로 한정했다.
- `public/images/{brand,marketing,consumer,vendor,admin,icons}/` 폴더 구조 + 자리표시 이미지 커밋.
- `scripts/generate-placeholders.mjs` / `scripts/check-assets.mjs` — **신규 의존성 없음**.
  PNG 는 Node 내장 `zlib` 기반 자체 인코더(`scripts/lib/png-writer.mjs`, 5×7 비트맵 폰트)로 생성.
- `components/ui/AssetImage.tsx` — `next/image` 래핑, 슬롯 id 로만 참조.
- `docs/ASSETS.md` — 파일명 규칙·교체 절차·슬롯 추가 절차·아이콘 정책.

### 정의한 슬롯 — 총 18개
| 그룹 | 개수 | 슬롯 |
|---|---|---|
| brand | 3 | `brand.logo` · `brand.symbol` · `brand.og-default` |
| marketing | 2 | `landing.hero` · `guide.thumbnail-default` |
| consumer | 9 | `onboarding.step1`~`step6` · `reports.empty` · `budget.empty` · `explore.empty` |
| vendor | 1 | `vendor.dashboard.empty` |
| admin | 1 | `admin.dashboard.empty` |
| icons | 2 | `icon.clear-avatar` · `icon.no-paid-placement` |

> R2/R3 화면 슬롯은 **범위에서 뺀 것이 아니라**, 해당 화면 구현 시점에 §6 근거로 추가한다
> (`docs/ASSETS.md` §4 절차). 범위 축소 금지 원칙(CLAUDE.md §2.1)에 저촉되지 않는다.

### 완료 판정 기준
- [x] `npm run assets:gen` → 18개 슬롯 파일이 전부 생성된다. **기존 파일은 덮어쓰지 않는다**(재실행 시 `kept`).
- [x] `npm run assets:check` → 파일 존재·실제 픽셀 치수·파일명 `@WxH` 일치가 전부 통과한다.
- [x] 매니페스트에 없는 id 를 `AssetImage` 에 넘기면 **타입 에러**가 난다(`AssetId` 로 키 좁힘).
- [x] `npm run lint && npm run test` 통과.
- [x] `npm run build` 통과.

### T-02b 연계
`npm run assets:check` 는 불일치 시 **비영 종료 코드**를 반환한다.
T-02b CI 워크플로의 게이트 스텝으로 그대로 얹는다(`npm run build` 앞).

---

## T-03 — 마이그레이션 1차 (명세서 §3.1~§3.8 전체)

**상태:** [x] (2026-08-08 완료, 브랜치 `feat/T-03-migrations`)

> **범위 확대 이력** 2026-08-08: 당초 §3.1·§3.2·§3.5 로 좁혀 두었던 범위를
> **§3.1~§3.8 전 테이블**로 확대해 1차에 일괄 작성했다. 근거는 CLAUDE.md §2.1
> (범위 축소 금지) — 공개 시점은 `feature_flags` 로만 제어하고 스키마는 미리 만들어 둔다.

### 목적
소비자 코어 기능(온보딩·체크리스트·예산·계약검토)이 올라탈 데이터 기반을 만든다.
동시에 **RLS가 실제로 타 커플의 데이터를 차단하는지**를 코드로 증명한다.

### 선행조건
- T-01 완료 (`npm run db:reset` / `db:types` 가 동작해야 함)
- 명세서 §3.1~§3.8(데이터 모델 전체), §3.9(RLS 원칙) 숙지

### 범위
**포함 (§3.1 · 9)**: `profiles`, `couples`, `couple_members`, `couple_invites`,
`onboarding_answers`, `memberships`, `subscription_payments`, `consents`,
`data_deletion_requests`

**포함 (§3.2 · 5)**: `task_templates`, `tasks`, `budgets`, `budget_items`, `expenses`

**포함 (§3.3 · 9)**: `vendors`, `vendor_documents`, `vendor_members`, `vendor_media`,
`products`, `product_options`, `price_rules`, `price_index`, `price_sources`

**포함 (§3.4 · 14)**: `inventory_slots`, `inquiries`, `inquiry_targets`, `quotes`,
`quote_items`, `bookings`, `contracts`, `contract_signatures`, `payments`,
`escrow_holds`, `refunds`, `settlements`, `settlement_items`, `disputes`

**포함 (§3.5 · 9)**: `documents`, `document_analyses`, `findings`, `detect_rules`,
`penalty_rules`, `penalty_simulations`, `estimate_uploads`, `estimate_items`,
`estimate_comparisons`

**포함 (§3.6 · 5)**: `ai_conversations`, `ai_messages`, `ai_tool_calls`, `ai_call_logs`,
`prompt_versions`

**포함 (§3.7 · 10)**: `reviews`, `review_reports`, `planners`, `planner_engagements`,
`content_posts`, `notifications`, `notification_prefs`, `share_links`, `guests`,
`seating_plans`

**포함 (§3.8 · 5)**: `audit_logs`, `feature_flags`, `app_settings`, `tickets`, `job_runs`
— `feature_flags`·`app_settings`·`audit_logs` 는 2026-08-06 결정(하단 "결정 완료" 참조)

**포함 (기반)**: 전 테이블 공통 컬럼(`id` uuid / `created_at` / `updated_at` 트리거),
enum 13종, RLS 활성화 + 정책, 역할별 GRANT

> **제외**: §3.10 Storage 버킷, `seed.sql`(검출 룰 20종·`task_templates` 시드) — 별도 태스크.

### 산출물

| 파일 | 내용 | 테이블 |
|---|---|---|
| `supabase/migrations/20260808000100_extensions_and_helpers.sql` | pgcrypto, `set_updated_at()`, `attach_set_updated_at()`, enum 13종 | — |
| `supabase/migrations/20260808000200_core.sql` | §3.1 + §3.2 + 커플 스코프(`guests`·`seating_plans`) | 16 |
| `supabase/migrations/20260808000300_vendor_commerce.sql` | §3.3 + §3.4 | 23 |
| `supabase/migrations/20260808000400_ai_ops.sql` | §3.5 + §3.6 + §3.7(잔여) + §3.8 | 27 |
| `supabase/migrations/20260808000500_rls.sql` | RLS 보조 함수 7종, 전 테이블 RLS + 정책 블록 66, 역할별 GRANT | — |

기존 `00000000000000_init.sql`(TODO 주석 3줄)은 삭제했다.

### 결과 수치

- **테이블 66** (§3.1~§3.8 전체) · **정책 블록 66** (테이블 1:1 대응) · **개별 정책 156건**
- **RLS 미활성 테이블 0** · **공통 컬럼/트리거 누락 테이블 0**
- 정책을 두지 않은 **전면 거부(서비스롤 전용) 10종**:
  `price_sources`, `detect_rules`, `penalty_rules`, `ai_call_logs`, `prompt_versions`,
  `share_links`, `audit_logs`, `feature_flags`, `app_settings`, `job_runs`
- 이 중 **`feature_flags` 만 테이블 GRANT 까지 회수**했다(`anon`·`authenticated` 권한 없음).
  미공개 R2·R3 기능의 **존재 자체를 감추기 위해서**다 — 플래그 목록이 클라이언트에 보이면
  D-09 의 '만들어 두고 켜지 않는다' 전략이 무력해진다. 플래그 평가는 Route Handler
  (서비스롤)에서만 수행하고 클라이언트에는 **평가 결과만** 내려보낸다.
- enum 13종 / `types/database.ts` 3,003줄 재생성

검산 쿼리는 `20260808000500_rls.sql` 말미 주석에 그대로 실어 두었다.

### 작업 내용
- 마이그레이션 SQL 5개 파일 작성(위 산출물 표).
- **모든 테이블에 RLS 활성화 + 정책 작성** (§3.9):
  - 커플 데이터: `couple_members` 에 소속된 `user_id` 만 SELECT/INSERT/UPDATE
  - 결제·계약 서명 관련은 `member_role = 'owner'` 추가 조건
  - `documents`: 소유 커플만. `purged_at IS NOT NULL` 이면 `storage_path` 를 API 응답에서 제외
  - 기본은 **거부**, 필요한 것만 허용
- `documents.purge_scheduled_at` **NOT NULL** 로 파기 예약 누락을 구조적으로 방지.
- `products.base_price_total` **NOT NULL** — '별도 문의' 가격 등록 차단의 스키마 근거(F-V-03).
- `npm run db:types` 로 `types/database.ts` 재생성.

> **작업 중 발견 · 조치** Supabase 기본 권한(`pg_default_acl`)은 `postgres` 역할이 만든
> 테이블에 대해 `anon`·`authenticated` 에게 `Dxtm` 만 부여하고 SELECT/INSERT/UPDATE/DELETE 는
> 부여하지 않는다. GRANT 가 없으면 **RLS 정책 평가 이전에 `permission denied` 로 막혀 정책이
> 전부 무력해진다.** `20260808000500_rls.sql` 말미에 역할별 GRANT 와 `alter default privileges`
> (이후 마이그레이션 자동 적용)를 명시했다. 행 단위 경계는 어디까지나 RLS 이며 `anon` 에는
> SELECT 만 부여한다.

### 완료 판정 기준
- [x] `npm run db:reset` 이 에러 없이 완주한다.
- [x] `npm run db:types` 가 통과하고 `types/database.ts` 가 갱신된다(public 테이블 66 / enum 13).
- [x] 범위 내 **모든 테이블에 RLS가 활성화**되어 있다 (`pg_class.relrowsecurity` 조회 → 미활성 0건).
- [x] **타 커플 데이터 차단을 확인**했다 (로컬 psql 세션 검증, `set local role authenticated` +
      `request.jwt.claims` 전환):
  - 커플 A 세션에서 `couples`/`tasks`/`budgets`/`documents` 는 자기 행 1건씩만 조회된다.
  - 커플 B의 `couples`/`tasks`/`documents` 를 id 지정 조회 → 전부 0건.
  - 커플 B의 `tasks` UPDATE → 0행. 커플 B에 `tasks` INSERT → RLS 위반으로 거부.
- [x] `member_role='partner'` 사용자가 owner 전용 동작을 하지 못한다:
      `couples` UPDATE → 0행, `couple_invites` INSERT → RLS 위반으로 거부.
- [x] `anon` 은 공개 데이터(`vendors`(active)·`products`(active 업체)·`price_index`·
      `content_posts`(발행분))만 읽고, `app_settings`·`audit_logs` 는 0건,
      쓰기는 `permission denied` 로 거부된다.
- [x] `feature_flags` 는 `anon`·`authenticated` 모두 조회 시 `permission denied` 이며
      `service_role` 만 SELECT/INSERT/UPDATE 가 가능하다.
- [ ] **위 RLS 검증을 자동화 테스트로 커밋**한다 — 이번 태스크는 마이그레이션 파일 범위로
      한정되어 로컬 psql 수동 검증까지만 수행했다. 테스트 하네스는 T-05(E2E 도입)에서
      함께 넣는다.

---

## T-04 — lib/core 골격 + 테스트

**상태:** [x] (2026-08-08 완료, 브랜치 `feat/T-04-core-domain`)

> **범위 확대 이력** 2026-08-08: 당초 "인터페이스·골격만" 이던 범위를 **실제 구현**으로 넓혔다.
> 검출 룰 20종은 부록 A 를 데이터로 옮겨 전부 구현했고(근거 조항 번호만 법무 검수 대기),
> 마스킹(§5.2 3단계)과 견적 정규화 스키마(§5.4)를 함께 넣었다.

### 목적
프레임워크 무관 도메인 로직의 뼈대를 세운다. 특히 **위약금 계산이 LLM 없이 결정적으로**
동작하고, 경계값에서 틀리지 않음을 테스트로 고정한다.

### 선행조건
- T-01 완료 (vitest 실행 가능)
- 명세서 §5.2(ReportSchema), §5.3(위약금 시뮬레이터), §3.5(`detect_rules`·`penalty_rules`) 숙지
- T-03과 병행 가능 (DB 스키마와 zod 스키마의 필드명을 맞출 것)

### 작업 내용
1. **`lib/core/schemas/report.ts` — `ReportSchema` (zod)**
   ```
   risk_score: number(0~100)
   summary: string
   findings: [{ rule_code, severity: 'high'|'mid'|'low', clause_excerpt,
                issue, basis_ref, negotiation_script }]
   missing_clauses: string[]
   disclaimer: string   // 상시 고정 문구
   ```
   - `rule_code` 는 `detect_rules.code` 와 일치해야 한다(검증 포함).
2. **`lib/core/pricing/penalty.ts` — 위약금 엔진 (LLM 미사용, 순수 함수)**
   - 입력: 카테고리, 총액, 계약금, 예식일, 취소 시점, 계약서 규정 위약률
   - 출력: 기준 위약금, 계약서 기준 위약금, **초과분**, 근거 조항, 이의 제기 문구
3. **`lib/core/rules/` — 검출 룰 20종 (부록 A)**
   - `types.ts` — `DetectRule` 인터페이스(`code`, `title`, `category`, `severity_default`,
     `detect.presence` / `detect.absence`, `prompt_fragment`, `basis_ref`, `version`, `is_active`)
   - `detect-rules.ts` — R-01~R-20 데이터 정의
   - `scan.ts` — 마스킹 텍스트를 받아 결정적으로 매칭, 인용 대조(`verifyCitation`)
   - **근거 조항 번호는 지어내지 않는다.** 출처 수준(표준약관 / 소비자분쟁해결기준 업종)까지만
     적고 조항 단위 매핑은 파일 상단 TODO 로 남긴다.
4. **`lib/core/masking/` — 개인정보 마스킹 (§5.2 3단계)**
   - 이름·연락처·주민번호·주소·계좌·사업자번호 정규식 치환
   - 마스킹 맵은 반환값으로만 전달. 파일·로그에 쓰지 않는다.
   - 마스킹 실패 판정(`detectResidualPii` / `assertMaskingComplete`)
5. **`lib/core/schemas/estimate.ts` — 견적 정규화 입출력 스키마 (§5.4)**
6. **React/Next import 금지 확인** — 테스트(`no-framework-imports.test.ts`)로 강제한다.

### 산출물

| 파일 | 내용 |
|---|---|
| `lib/core/legal.ts` | 고정 고지 문구·검증 (§7.7) |
| `lib/core/schemas/report.ts` | `ReportSchema`·`FindingSchema` (§5.2) |
| `lib/core/schemas/penalty.ts` | 위약금 입출력·룰 세트 스키마 (§5.3) |
| `lib/core/schemas/estimate.ts` | 견적 정규화 스키마 (§5.4) |
| `lib/core/schemas/index.ts` | 스키마 배럴 |
| `lib/core/pricing/penalty.ts` | 위약금 엔진 (LLM 미사용 순수 함수) |
| `lib/core/pricing/penalty-rules.ts` | 기준 룰 세트 (가정치, 주입 대체 가능) |
| `lib/core/rules/types.ts` · `detect-rules.ts` · `scan.ts` · `index.ts` | 검출 룰 20종·스캐너 |
| `lib/core/masking/patterns.ts` · `index.ts` | 마스킹 패턴·엔진 |

### 결과 수치

- **소스 13파일 / 테스트 7파일 · 테스트 197건 전부 통과**
- 내보낸 함수·클래스·상수 **53개 중 51개(96%)가 테스트에서 직접 참조**된다.
  나머지 2개(`PenaltyCategorySchema`·`PenaltyResultSchema`)는 상위 스키마·엔진을 통해 간접 실행된다.
- 검출 룰 **20종 × (양성 1 + 음성 1) = 40건** + 목록 무결성 9건
- 위약금 경계값 **10구간** + 계약금 분기 5건 + 비정상 입력 7건 + 정수 연산·출력 규약 7건
- 마스킹 패턴별 치환 8건 + 실패 판정 8건 + 목록 무결성 6건
- 스키마 검증 50건

### 완료 판정 기준
- [x] `npm run test` 가 통과하고, **위약금 경계값 테스트가 실제로 실행된다**(skip 아님):
  - [x] 취소 시점 **구간 경계** — 경계일 당일이 어느 구간에 속하는지
        (D-90 은 상위 구간, D-89 는 하위 구간. D-60/59, D-30/29 도 동일하게 검증)
  - [x] 구간 경계 ±1일 (D-91/90/89, D-60/59, D-30/29, D-1/0/-1)
  - [x] **계약금 반환 여부** 분기 (반환 / 계약금 = 위약금 / 부분 반환 / 부족분 추가 부담)
  - [x] 계약서 위약률이 기준보다 **낮은 경우** → 초과분 0 (음수 없음)
  - [x] 총액 0 / 총액 음수 / 비정수 / 계약금 > 총액 / 잘못된 날짜 형식
  - [x] 예식일 경과 후 취소 (`AFTER_EVENT` 구간)
- [x] `ReportSchema` 가 유효/무효 샘플 JSON을 각각 통과/거부한다
      (필수 4필드 누락, 점수 범위·정수, 미정의 `rule_code`, 미정의 `severity`, 고지 누락)
- [x] `lib/core` 에서 `react`·`next`·DB·AI SDK import 를 금지한다 —
      `lib/core/no-framework-imports.test.ts` 가 소스 전체를 스캔해 위반 시 실패한다.
      같은 테스트가 `console` 호출 금지(원문·마스킹 맵 유출 방지)도 함께 강제한다.
- [ ] **ESLint `no-restricted-imports` 규칙 추가** — 이번 태스크의 수정 허용 범위가
      `lib/core`·테스트·`docs/TASKS.md` 로 한정돼 `.eslintrc.json` 을 건드리지 않았다.
      현재는 위 테스트가 같은 역할을 하고 있으며, 규칙 추가는 T-02b(CI)에서 함께 넣는다.
- [ ] **커버리지 80% 수치 측정** — `@vitest/coverage-v8` 미설치이며 새 의존성 추가는
      이번 태스크에서 보고 대상이라 실행하지 않았다. 위 심볼 참조율 96% 로 대체 보고한다.

---

## T-05 — 인증·온보딩 (F-C-01, F-C-02)

**상태:** [ ]

### 목적
사용자가 처음 진입해서 서비스의 기준 스코프(`couples`)를 갖게 되는 경로를 완성한다.
이 경로가 없으면 이후 모든 소비자 기능이 실행될 수 없다.

### 선행조건
- T-03 완료 (`couples`, `couple_members`, `couple_invites`, `onboarding_answers`,
  `tasks`, `task_templates`, `budgets`, `budget_items` 존재)
- T-02 완료 권장 (E2E를 CI에 얹기 위해)
- Playwright 설치·설정 (미설치 상태이므로 이 태스크에서 도입)
- 소셜 로그인 provider 설정 (카카오 우선, 네이버/구글/애플)

### 범위
- **F-C-01 회원가입·온보딩**: 소셜(카카오/네이버/구글/애플) + 이메일.
  온보딩 6문항 — 예식 예정일 / 지역 / 예산 총액 / 하객 규모 / 스타일 선호 / 진행 단계.
  결과로 `couples` 레코드 + 초기 체크리스트 자동 생성.
- **F-C-02 커플 연동**: 초대 코드·딥링크로 배우자 연동. 동일 `couple_id` 데이터 공유,
  활동 로그에 작성자 표기.

### 관련 API·화면
- `POST /api/onboarding` — 6문항 저장 → `couples` 생성 + 체크리스트·예산 초안 생성
- `POST /api/couples/invite` — 초대 코드 발급 / `GET` 으로 코드 검증·수락
- `/login` (소셜 4종 + 이메일), `/onboarding` (6단계 스텝퍼, 진행률, 결과 요약)

### 작업 내용
- Supabase Auth 세션 쿠키 설정 (HttpOnly, Secure, SameSite=Lax).
- 온보딩 입력을 zod로 검증(`lib/core/schemas`), 실패 시 422.
- `task_templates` 를 예식일 기준 **D-360~D-0 역산**으로 전개해 `tasks` 자동 생성
  (카테고리: 홀·스드메·예단·혼수·서류·허니문, `source='auto'`).
- 예산 초안 생성 — 총예산을 카테고리별로 배분해 `budgets` + `budget_items` 생성.
  (참가격 지수 기반 배분은 T-06 및 `price_index` 확보 후 고도화 — 하단 미결 항목 참조)
- 초대 코드 만료 처리(`couple_invites.expires_at`), 재사용 방지.
- 약관·개인정보 동의를 `consents` 에 기록.

### 완료 판정 기준
- [ ] **Playwright E2E가 다음 시나리오를 통과한다**:
      가입 → 온보딩 6문항 입력 → `couples` 레코드 생성 → 체크리스트 자동 생성 →
      예산 초안 자동 생성 → `/home` 대시보드에 D-day·할 일·예산 게이지가 표시된다.
- [ ] 두 번째 사용자가 초대 코드로 연동하면 동일 `couple_id` 데이터를 볼 수 있고,
      RLS로 다른 커플 데이터는 여전히 차단된다(E2E 또는 통합 테스트).
- [ ] 만료된 초대 코드는 거부된다.
- [ ] `npm run lint && npm run test` 통과.

---

## T-06 — 예산 배분·추적 (F-C-05)

**상태:** [ ]

### 목적
"총예산을 넣으면 어디에 얼마를 써야 하고 지금 얼마나 썼는지"를 보여준다.
투명 가격 플랫폼의 소비자 측 핵심 가치가 처음 눈에 보이는 지점이다.

### 선행조건
- T-03 완료 (`budgets`, `budget_items`, `expenses`)
- T-05 완료 (온보딩에서 예산 초안이 생성되어 있어야 함)
- 카테고리 코드 체계 확정 (홀·스드메·예단·혼수·서류·허니문 등 — 체크리스트와 동일 체계 사용)

### 범위
- 총예산 입력·수정
- 카테고리별 권장 배분 (초기에는 고정 비율 기반, `price_index` 확보 후 지수 기반으로 교체)
- 실지출 등록(`expenses`) 및 `budget_items.spent_amount` 반영
- 계획 대비 실지출 시각화, **초과 경고**
- 견적·계약 확정 시 `contracted_amount` 자동 반영 (해당 기능 공개 전까지는 훅만 확보)

### 관련 API·화면
- `GET/PUT /api/budget` — 예산 배분 조회·갱신, 실지출 등록
- `/budget` — 카테고리 배분 도넛, 계획 대비 실지출, 초과 경고

### 작업 내용
- 배분 계산은 **`lib/core/pricing` 순수 함수**로 작성(LLM 미사용) + vitest.
  - 배분 합계가 총예산과 일치하는지(반올림 오차 처리)
  - 카테고리 추가/삭제 시 재배분 규칙
- 초과 경고 임계값은 **`app_settings` 파라미터**로 분리한다(하드코딩 금지).
- `budgets.index_version` 에 어떤 지수 버전 기준으로 배분했는지 기록.
- 로딩·빈 상태·에러 상태 3종을 화면에 정의(§6 공통 UI 규칙).

### 완료 판정 기준
- [ ] 총예산 입력 → 카테고리별 배분이 생성되고, 배분 합계 = 총예산 (오차 0).
- [ ] 배분 비율을 수동 조정하면 저장되고 다시 불러온다.
- [ ] 실지출을 등록하면 해당 카테고리 `spent_amount` 와 전체 집계에 즉시 반영된다.
- [ ] 실지출이 계획을 초과하면 **초과 경고가 동작한다** (카테고리 단위 + 총액 단위).
- [ ] 배분·집계 경계값 vitest 통과 (총예산 0, 카테고리 1개, 반올림 잔여 배분).
- [ ] `npm run lint && npm run test` 통과.

---

## 선행조건 대기 — 아직 착수하지 않는 것

> 아래는 **범위에서 뺀 것이 아니라, 선행조건이 풀리면 착수하는 것**이다.
> 범위 축소 금지 원칙(CLAUDE.md §2.1)에 따라 삭제·축소하지 않는다.

| 항목 | 대기 사유 |
|---|---|
| `detect_rules` 시드 20종 | 근거 **조항 번호** 확정 후. 룰 20종 자체는 T-04에서 `lib/core/rules/detect-rules.ts` 로 구현 완료 |
| §3.3~3.4 업체·거래 **기능** | 스키마는 T-03에서 생성 완료. 화면·API 착수는 M5 구간이며 공개는 `feature_flags` 로만 연다 |
| Storage 버킷(§3.10) | T-03 범위 밖. 별도 태스크 |
| `seed.sql`(`task_templates` 등) | T-03 범위 밖. 별도 태스크 |
| 에스크로 스키마 | O-03 법무 결론 대기. 컬럼 정의만 유지 |
| 수수료 요율 하드코딩 | O-02 미확정. `app_settings` 파라미터로만 접근 |

### 부가 메모

- **검출 룰 20종**은 T-04에서 `lib/core/rules/detect-rules.ts` 에 R-01~R-20 전부 구현했다.
  다만 등급·문안은 **법무 검수 후 확정**이고, `basis_ref` 는 출처 수준
  (공정거래위원회 표준약관 / 소비자분쟁해결기준 업종)까지만 적혀 있다.
  **조항 번호 매핑이 끝나야 `seed.sql` 을 작성한다.** 테스트가 조항 번호 표기(`제N조`·`N항`)를
  금지하고 있어, 확정 전에 임의 번호가 들어가면 테스트가 깨진다.
- **`penalty_rules` 시드**도 같은 근거 조항 확정에 묶여 있다. T-04의 위약금 엔진은
  룰 데이터를 **주입받는 순수 함수**로 구현했고, 기본값
  (`lib/core/pricing/penalty-rules.ts` 의 `DRAFT_PENALTY_RULE_SETS`)은 `isDraft: true` 로
  표시돼 결과 `notes` 에 "가정치" 경고가 자동으로 붙는다. 시드가 들어오면 그 값을 주입하면 되고
  엔진 코드는 바뀌지 않는다.
- **에스크로**는 `escrow_holds` 컬럼 정의만 유지하고 릴리즈·집행 로직은 O-03 결론 후.
  M5까지 법무 자문 착수가 하드 선행조건이다(§8.2).
- **수수료 요율**은 `settlements.fee_rate` 를 `app_settings` 에서 읽는다.
  코드 어디에도 숫자를 박지 않는다.

---

## 결정 완료

- **`feature_flags` / `app_settings` / `audit_logs` 의 T-03 포함 여부** — **결정됨(2026-08-06):
  셋 다 T-03 1차 마이그레이션에 포함한다.**
  근거: `feature_flags` 는 범위 축소 금지 원칙(CLAUDE.md §2.1)의 유일한 공개 제어 수단이고,
  `app_settings` 는 수수료 요율(O-02)·초과 경고 임계값(T-06)의 하드코딩 금지 전제이며,
  `audit_logs` 는 감사 필수 항목이다. 셋 다 다른 테이블보다 먼저 있어야 한다.
  → T-03 "범위" 절의 §3.8 항목은 이 결정에 따라 확정으로 읽는다.

---

## 미결 항목 — 착수 전 확인 필요

1. **온보딩 예산 초안의 `price_index` 의존**
   F-C-05는 "참가격 지수 기반 권장 배분"이다. `price_index` **테이블 자체는 T-03에서
   생성**됐지만 데이터 수집(참가격 인덱스 구축)이 M5 구간이라 초기에는 비어 있다.
   → T-05·T-06은 **고정 비율 배분으로 시작**하고 `budgets.index_version` 에
   `'fixed-v1'` 같은 값을 기록해두는 것으로 진행한다(변경 시 확인).
