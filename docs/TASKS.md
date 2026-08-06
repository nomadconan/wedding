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
| T-02c | 이미지·아이콘 자산 규약 | [ ] | (미정) | M0 |
| T-03 | 마이그레이션 1차 | [ ] | §3.1·§3.2·§3.5, §3.9 | M0 |
| T-04 | lib/core 골격 + 테스트 | [ ] | §5.2·§5.3, §7.5 | M0~M1 |
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

**상태:** [ ]

**다음 세션에서 정의.**

---

## T-03 — 마이그레이션 1차 (명세서 §3.1·§3.2·§3.5 범위만)

**상태:** [ ]

### 목적
소비자 코어 기능(온보딩·체크리스트·예산·계약검토)이 올라탈 데이터 기반을 만든다.
동시에 **RLS가 실제로 타 커플의 데이터를 차단하는지**를 코드로 증명한다.

### 선행조건
- T-01 완료 (`npm run db:reset` / `db:types` 가 동작해야 함)
- 명세서 §3.1(사용자·커플), §3.2(일정·예산), §3.5(계약검토·견적 정규화), §3.9(RLS 원칙) 숙지

### 범위
**포함 (§3.1)**: `profiles`, `couples`, `couple_members`, `couple_invites`,
`onboarding_answers`, `memberships`, `subscription_payments`, `consents`,
`data_deletion_requests`

**포함 (§3.2)**: `task_templates`, `tasks`, `budgets`, `budget_items`, `expenses`

**포함 (§3.5)**: `documents`, `document_analyses`, `findings`, `detect_rules`,
`penalty_rules`, `penalty_simulations`, `estimate_uploads`, `estimate_items`,
`estimate_comparisons`

**포함 (§3.8)**: `feature_flags`, `app_settings`, `audit_logs`
— 2026-08-06 결정(하단 "결정 완료" 참조)

**포함 (기반)**: 전 테이블 공통 컬럼(`id` uuid / `created_at` / `updated_at` 트리거),
§3.10 Storage 버킷 중 `contracts-raw`·`reports`

> **제외**: §3.3(업체·상품·가격), §3.4(재고·거래·결제), §3.6~3.7 — 아래 "선행조건 대기" 표 참조.
> §3.8 중 위 3종을 제외한 나머지 테이블도 이번 범위가 아니다.

### 작업 내용
- 마이그레이션 SQL 작성 → `npm run db:diff -- -f init_consumer_core`
- **모든 테이블에 RLS 활성화 + 정책 작성** (§3.9):
  - 커플 데이터: `couple_members` 에 소속된 `user_id` 만 SELECT/INSERT/UPDATE
  - 결제·계약 서명 관련은 `member_role = 'owner'` 추가 조건
  - `documents`: 소유 커플만. `purged_at IS NOT NULL` 이면 `storage_path` 를 API 응답에서 제외
  - 기본은 **거부**, 필요한 것만 허용
- `documents.purge_scheduled_at` NOT NULL 제약 또는 기본값으로 파기 예약 누락을 구조적으로 방지.
- `seed.sql`에 `task_templates`(D-360~D-0 역산 원본) 시드 작성.
  `detect_rules`·`penalty_rules`는 **테이블·인터페이스만** 만들고 시드는 보류(하단 표 참조).
- `npm run db:types` 로 `types/database.ts` 재생성.

### 완료 판정 기준
- [ ] `npm run db:reset` 이 에러 없이 완주한다.
- [ ] `npm run db:types` 가 통과하고 `types/database.ts` 가 갱신된다.
- [ ] 범위 내 **모든 테이블에 RLS가 활성화**되어 있다 (`pg_tables` 조회로 확인).
- [ ] **통합 테스트로 타 커플 데이터 차단을 확인**한다:
      커플 A 사용자 세션으로 커플 B의 `couples` / `tasks` / `budgets` / `documents` /
      `findings` 를 조회·수정 시도 → 전부 0건 반환 또는 거부.
- [ ] 같은 테스트에서 `member_role='partner'` 사용자가 결제·서명 권한 대상 행을 변경하지 못한다.

---

## T-04 — lib/core 골격 + 테스트

**상태:** [ ]

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
3. **`lib/core/rules/index.ts` — `DetectRule` 인터페이스**
   - 필드: `code`, `title`, `category`, `severity_default`, `pattern`,
     `prompt_fragment`, `basis_ref`, `version`
   - 룰 20종 **구현체는 아직 작성하지 않는다**(근거 조항 확정 대기 — 하단 표 참조).
     인터페이스와 레지스트리 골격, 그리고 인터페이스 계약 테스트만 작성한다.
4. **React/Next import 금지 확인** — `lib/core` 하위에서 `react`·`next` import를 금지하는
   ESLint 규칙(`no-restricted-imports`)을 추가한다.

### 완료 판정 기준
- [ ] `npm run test` 가 통과하고, **위약금 경계값 테스트가 실제로 실행된다**(skip 아님):
  - [ ] 취소 시점 **구간 경계** — 경계일 당일이 어느 구간에 속하는지 (예: D-30 정확히 당일)
  - [ ] 구간 경계 ±1일
  - [ ] **계약금 반환 여부** 분기 (반환 / 몰취 / 부분)
  - [ ] 계약서 위약률이 기준보다 **낮은 경우** → 초과분 0 (음수가 나오지 않을 것)
  - [ ] 총액 0 / 계약금 > 총액 등 비정상 입력 처리
  - [ ] 예식일 경과 후 취소
- [ ] `ReportSchema` 가 유효/무효 샘플 JSON을 각각 통과/거부한다.
- [ ] `lib/core` 에서 `react`·`next` import 시 lint 에러가 발생한다.

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
| `detect_rules` 시드 20종 | 근거 조항 확정 후. 테이블·인터페이스만 선행 |
| §3.3~3.4 업체·거래 테이블 | M5 구간. T-03 범위에 넣지 않는다 |
| 에스크로 스키마 | O-03 법무 결론 대기. 컬럼 정의만 유지 |
| 수수료 요율 하드코딩 | O-02 미확정. `app_settings` 파라미터로만 접근 |

### 부가 메모

- **검출 룰 20종 초안**은 명세서 부록 A에 R-01~R-20으로 이미 존재한다.
  등급·문안은 **법무 검수 후 확정**이며, `basis_ref`(소비자분쟁해결기준·표준약관 조항)
  매핑이 끝나야 시드를 작성한다. T-04에서는 `DetectRule` 인터페이스와 레지스트리 골격까지만.
- **`penalty_rules` 시드**도 같은 근거 조항 확정에 묶여 있다. T-04의 위약금 엔진은
  룰 데이터를 **주입받는 순수 함수**로 설계해, 시드가 나중에 들어와도 코드 변경이 없게 한다.
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
   F-C-05는 "참가격 지수 기반 권장 배분"이나 `price_index` 는 §3.3(T-03 범위 밖, M5)에 있다.
   → T-05·T-06은 **고정 비율 배분으로 시작**하고 `budgets.index_version` 에
   `'fixed-v1'` 같은 값을 기록해두는 것으로 진행한다(변경 시 확인).
