# TASKS.md — 웨딩클리어 개발 태스크

> 진행 표기: `[ ]` 미착수 · `[~]` 진행 중 · `[x]` 완료
> 브랜치명 형식: `feat|fix|chore|docs/<태스크ID>-<요약>` (예: `feat/S2-01-vendor-onboarding`)
> 각 태스크는 `docs/07_개발명세서.md` **v2.0** 의 해당 절을 근거로 한다.
> **범위 축소 금지**(CLAUDE.md §2.1) — 기능을 빼지 않고, 만들어 두고 켜지 않는다.

---

## 운영 규칙 (T-00c)

명세 ↔ 태스크 대응을 사람 기억에 맡기지 않는다. 문서 말미의 **[커버리지 검증표](#커버리지-검증표-t-00c)** 가 단일 진실이다.

1. **새 태스크를 시작하기 전에 커버리지 검증표에서 번호와 범위를 확인한다.**
   브리프에 적힌 태스크 번호와 표가 다르면 **표를 기준**으로 하고, 차이를 사용자에게 보고한다.
2. **모든 태스크는 완료 시 커버리지 표의 해당 행을 갱신한다.** 상태(`미착수`/`진행중`/`완료`)와
   담당 태스크를 함께 고친다. 부분 완료는 `[~]` 로 적고 **잔여분을 같은 칸에 명시**한다.
3. **미배정 행이 하나라도 남아 있으면 그 단계를 완료로 판정하지 않는다.**
   기존 태스크에 넣을 수 없으면 태스크를 신설한다 — 항목을 지우거나 합치지 않는다(CLAUDE.md §2.1).

---

## 태스크 번호 체계 (v2.0 재편)

명세서 §1.3의 **개발 순서 8단계**를 그대로 따른다. `S{단계}-{연번}` 형식이다.

| 접두어 | 단계 | 내용 |
|---|---|---|
| `T-xx` | — | v1.0 시절 셋업 태스크. **이력으로 보존**하며 새로 부여하지 않는다 |
| `S1-xx` | 1 기반 | 디자인 시스템, 공통 컴포넌트, 레이아웃 셸 |
| `S2-xx` | 2 공급 | 업체 입점·심사·상품 등록·추가금 사전표·업체 어드민 전반 |
| `S3-xx` | 3 수요 | 회원가입·온보딩·커플 연동·탐색·필터·비교·장바구니·찜 |
| `S4-xx` | 4 연결 | 채팅·문의게시판·전화 연결·상담/탐방 예약·일정 3자 공유 |
| `S5-xx` | 5 거래 | 표준계약·3자 서명·분할 결제·정산·환불·위약금 |
| `S6-xx` | 6 플래너 | 플래너 등록·부분 선택 과금·랭킹·권한 위임 |
| `S7-xx` | 7 AI·부가 | 조건 검색·AI 추천, 계약 검토, 위약금 시뮬레이터, 예산, 체크리스트 |
| `S8-xx` | 8 운영 | 운영자 콘솔·분쟁 조율·CI·품질·모니터링 |

**단계별 공개는 없다.** 8단계 전부를 완성한 뒤 일괄 오픈한다(D-20). 번호는 착수 순서일 뿐이며, 선행 조건만 충족하면 병행 착수할 수 있다.

---

## 진행 현황

### 완료 (v1.0 시절 · 이력)

| ID | 태스크 | 상태 | 근거 | 산출 |
|---|---|---|---|---|
| T-01 | 리포 초기화·셋업 검증 | [~] | §8 M0, 부록 C | `npm run db:start` 사용자 확인만 대기 |
| T-02a | 브랜치·원격 정리 | [x] | §7.2 | `main`/`dev` + GitHub 원격 연결 완료 |
| T-02b | CI 파이프라인 | [ ] | §7.2, §7.5 | **S8-05로 이관** |
| T-02c | 이미지·아이콘 자산 규약 | [x] | §6, §7.5 | 슬롯 18개, `AssetImage`, `docs/ASSETS.md` |
| T-03 | 마이그레이션 1차 | [x] | §3.1~§3.8, §3.9 | 테이블 66 · 정책 156 · RLS 전면 |
| T-04 | lib/core 골격 + 테스트 | [x] | §5.1~§5.4, 부록 A | 소스 13 · 테스트 197건 |
| T-04b | 디자인 시스템 기반 | [x] | §6 공통 UI 규칙, §7.5 | **S1-01로 승계.** PR #4로 `dev` 병합 완료. 산출물: 디자인 토큰, shadcn/ui 14종 + `size="touch"`, 도메인 3종, 레이아웃 2종, 상태 3종, `/design-system` 카탈로그, `docs/DESIGN.md`. 상세는 커밋 `d7a902c`·PR #4 참조 |
| T-00 | 명세서 v2.0 현행화 | [x] | D-16~D-24 | 본 재편 |

### 1단계 — 기반

| ID | 태스크 | 상태 | 선행 | 근거 |
|---|---|---|---|---|
| S1-01 | 디자인 시스템·공통 컴포넌트 | [x] | — | §6 공통 UI 규칙 (구 T-04b) |
| S1-02 | 가격 표시 컴포넌트 v2 | [x] | S1-01 | §6 — 플래너 수수료 포함 총액 표시 |
| S1-03 | 중개자 지위 고지 컴포넌트 | [x] | S1-01 | §6, D-24 |

> **S1-02·S1-03 산출** `PriceDisplay` v2(총액 → 판매가·추가금·플래너 수수료 내역 → 부가세,
> `item`/`sum` 변형, 0원·미정 구분), `BrokerNotice`(`inline`/`compact`), `lib/core/legal.ts`의
> `BROKER_NOTICE`, 컴포넌트 테스트 32건, `/design-system` 카탈로그 반영, `docs/DESIGN.md` §2.
> 규칙과 강제 방식은 `docs/DESIGN.md` §2에 있다.

### 2단계 — 공급

| ID | 태스크 | 상태 | 선행 | 근거 |
|---|---|---|---|---|
| S2-01 | 업체 인증·입점 신청 | [x] | S1-01, T-03 | F-V-01, F-A-01. 이메일 로그인·미들웨어 세션 포함 |
| S2-02 | 업체 프로필·미디어 | [x] | S2-01 | F-V-02. 변경 이력은 `audit_logs` 기반 |
| S2-03 | 상품·판매가 등록 | [x] | S2-01, **S5-01** | F-V-03 — 총액 강제 3층 + 예상 정산액 |
| S2-04 | 추가금 사전 등록 | [x] | S2-03 | F-V-04 — '없음'과 '미등록' 구분, 게시 조건 |
| S2-05 | 재고 캘린더 | [x] | S2-03 | F-V-05 — 반복·CSV·블록, 슬롯 중복 금지 |
| S2-06 | 다이내믹 프라이싱 룰 | [x] | S2-03 | F-V-06 — 전순서 결정성, floor/cap 가드 |
| S2-07 | 업체 멤버·권한 | [x] | S2-01 | F-V-13 — 마지막 대표 보호, staff 제한 |
| S2-08 | 업체 대시보드·통계 | [x] | S2-03 | F-V-12 — 측정 가능한 지표만, 나머지는 '집계 대상 없음' |
| S2-09 | **미가입자 초대** | [ ] | S2-07, **S4-13** | F-V-13 잔여 — 초대 대기·메일 발송·수락 플로우. **T-S2-07 신설** |

> **S2-01 산출** 마이그레이션 `20260808000800_vendor_apply.sql`(`entity_events`·`vendor_applications`
> ·`vendor-documents` 버킷), 화면 `/login`·`/vendor/apply`·`/admin/vendors`,
> API `POST /api/vendor/apply`·`PATCH /api/admin/vendors/[id]/review`,
> 인증 기반(`middleware.ts` 세션 갱신·라우트 가드, `lib/supabase/auth.ts`·`admin.ts`),
> `lib/core/vendor` + `lib/core/schemas/vendor.ts`, 테스트 20건.
> **소셜 로그인은 S3-01** 에서 붙인다 — 여기서는 이메일·비밀번호 경로만 만들었다.

> **S2-02 산출** 마이그레이션 `20260808000900_vendor_profile.sql`(`vendors` 프로필 컬럼 6개 +
> `vendor-media` 버킷), 화면 `/vendor/profile`(+`loading.tsx`), API `GET/PUT /api/vendor/profile`,
> `lib/core/schemas/vendor-profile.ts`, 테스트 22건.
> **변경 이력은 `audit_logs.before_json/after_json`** 에 바뀐 필드만 남기고 화면이 그대로 읽는다 —
> 별도 이력 테이블을 만들지 않았다.
> **프로필 수정은 owner 전용**(기존 `vendors_update_owner` 정책), **미디어는 staff 도 가능**
> (기존 `vendor_media` 정책). 정책을 새로 만들거나 완화하지 않았다.

> **S2-03 산출** 마이그레이션 `20260808001000_product_publishing.sql`(`products` + `status`·
> `published_at`·`price_includes_vat`, CHECK 4, 공개 정책에 게시 조건 추가), 화면
> `/vendor/products`·`/new`·`/[id]`(+`loading.tsx`), API `GET/POST /api/vendor/products` ·
> `PATCH/DELETE /api/vendor/products/[id]`, `lib/core/schemas/product.ts`,
> `lib/pricing/vendor-rate.ts`, 테스트 24건.
> **총액 표기 강제는 3층이다** — DB CHECK(> 0, 게시 시 포함 항목 ≥ 1) / zod(`positive()` +
> 가격 회피 문구 차단) / UI(숫자 전용 입력·실시간 체크리스트).
> **요율이 없으면 금액을 만들지 않는다** — `resolveRate` 실패를 그대로 살려 "요율 미설정"으로 적는다.

> **S2-04 산출** 마이그레이션 `20260808001100_product_options.sql`(`products.add_ons_declared_at`,
> 게시 조건 CHECK 교체, `product_options` CHECK 3), API `GET/POST /api/vendor/products/[id]/options` ·
> `PATCH/DELETE .../options/[optionId]` + 확정 플래그(`declareAddOns`)는 상품 PATCH 에 실었다,
> 화면 `/vendor/products/[id]` 추가금 섹션, `lib/core/schemas/product-option.ts`, 테스트 20건.
> **'추가금 없음'과 '아직 안 적음'을 구분한다** — 0건 확정은 진술이고 미확정은 공백이다.
> 미확정 상품은 게시할 수 없고, 확정 후 항목이 바뀌면 재확정해야 다시 게시된다.

> **S2-07 산출** 마이그레이션 `20260808001200_vendor_members.sql`(마지막 owner 보호 트리거,
> 자기 삭제 금지 정책), 화면 `/vendor/members`(+`loading.tsx`), API `GET/POST /api/vendor/members` ·
> `PATCH/DELETE /api/vendor/members/[userId]`, `lib/core/schemas/vendor-member.ts`, 테스트 18건.
> **S2-01~S2-04 의 staff 권한 분기를 화면에서 검증할 수 있게 됐다** — 그전에는 psql 로만 확인 가능했다.
> `scripts/seed-accounts.mjs` 에 `staff@local.test` 를 추가해 재현 가능하다.
> **미가입자 초대는 S2-09 로 분리**했다(아래 신설 태스크 참조).

> **S2-05 산출** 마이그레이션 `20260808001300_inventory_slots.sql`(같은 자리 슬롯 UNIQUE,
> 상태·정원 CHECK), 화면 `/vendor/inventory`(달력 + 반복·CSV·블록 탭), API
> `POST /api/vendor/inventory/bulk`, `lib/core/schemas/inventory.ts`·`inventory/csv.ts`,
> `docs/INVENTORY_CSV.md`, 테스트 30건.
> **CSV 는 부분 반영하지 않는다** — 한 행이라도 틀리면 전체 거부 + 행 번호별 오류.
> **`remaining` 을 줄이는 것은 4단계(bookings)** 다. 갱신 지점을 컬럼 주석에 남겼다.

> **S2-06 산출** 마이그레이션 `20260808001400_price_rules.sql`(`priority`·`is_active` 컬럼,
> CHECK 4), 화면 `/vendor/pricing`, API `GET/POST /api/vendor/price-rules` ·
> `PATCH/DELETE .../[id]` · `POST .../simulate`, 순수 함수 `lib/core/pricing/dynamic.ts`,
> `lib/core/schemas/price-rule.ts`, 테스트 31건.
> **적용 순서는 전순서로 못박았다** — priority → rule_type → created_at → id.
> 요율(0006)은 하나만 적용돼야 해서 겹침을 거부했지만, 프라이싱 룰은 **여러 개가 함께
> 적용되는 것이 정상**이라 거부가 아니라 순서로 결정성을 얻는다.

> **S2-08 산출** 화면 `/vendor`(대시보드)·`/vendor/stats`(+`loading.tsx` 각 1),
> API `GET /api/vendor/stats`, 컴포넌트 `components/domain/MetricTile.tsx`,
> 순수 함수 `lib/core/stats/metric.ts`, 집계 `lib/vendor/stats.ts`, 테스트 20건.
> **새 테이블도 캐시도 만들지 않았다.** 기존 데이터를 그때그때 센다.
> **아직 셀 수 없는 지표를 0으로 적지 않는다** — `not_yet` 상태로 두고 어느 태스크에서
> 채워지는지 화면에 함께 적는다(S2-04 의 '없음' vs '미등록' 과 같은 원칙).
> 연결 대상 태스크: S3-03(노출)·S4-12(문의)·S4-07(상담)·S5-06(예약)·S5-04(계약)·
> S5-07(정산)·S8-11(평점) — 각 태스크 행에 완료 조건으로 적어 뒀다.

> **2단계에는 마이그레이션 태스크가 없다.** §3.3·§3.4의 업체 도메인 테이블(`vendors`,
> `vendor_documents`, `vendor_members`, `vendor_media`, `products`, `product_options`,
> `price_rules`, `price_index`, `price_sources`, `inventory_slots`)은 **T-03에서 이미 만들었고**
> v2.0에서 추가·변경된 컬럼도 없다. 2단계는 화면·API 작업만 남았다.
> §3.3의 유일한 잔여 테이블이던 `vendor_availability`는 **S4-02에서 앞당겨 처리**했다(아래 참조).

### 3단계 — 수요

| ID | 태스크 | 상태 | 선행 | 근거 |
|---|---|---|---|---|
| S3-01 | 인증·온보딩 | [x] | S1-01, T-03 | F-C-01 (구 T-05). 온보딩 6문항·문항 단위 저장·미정 허용. 소셜은 **콜백 라우트까지만** → S3-01b |
| S3-01b | **소셜 로그인 공급자 키 등록** | [ ] | S3-01 | 카카오·네이버·구글·애플 앱 등록과 `supabase/config.toml` 공급자 설정. 코드(`/auth/callback`·로그인 버튼)는 S3-01에서 끝났고, **남은 것은 외부 계정 발급**이다. 키가 없으면 버튼은 비활성으로 남는다(`NEXT_PUBLIC_SOCIAL_AUTH_ENABLED`) |
| S3-02 | 커플 연동 | [x] | S3-01 | F-C-02. **S3-01에서 함께 구현**했다 — 온보딩 완료 화면이 곧 초대 지점이라 나누면 화면이 두 번 갈린다. 초대 **메일 발송만 S4-13 대기**(코드는 화면에 노출) |
| S3-03 | 업체 탐색·필터 | [x] | S2-03, S3-01 | F-C-10, F-C-11, F-C-12. 기본 정렬은 **가격 낮은 순**. 스타일 필터의 데이터 출처로 `vendors.style_tags` 를 만들고 업체 프로필에 입력 자리를 붙였다. **S2-08 대시보드의 '노출' 지표는 아직 연결하지 않았다** — 조회 이벤트 적재(entity_events)는 S4-03 이다 |
| S3-04 | **마이그레이션 2차 — 장바구니·찜** | [x] | T-03 | §3.4 `carts`·`cart_items`·`wishlists`. 스키마·RLS 까지 — 화면·API 는 S3-05·S3-06 |
| S3-05 | 장바구니 (커플 실시간 공유) | [x] | S3-04, S3-03 | F-C-25. **실시간 반영은 넣지 않았다** — Realtime 도입이 O-11 미결이라 새로고침 기준이며 연결 지점에 TODO 를 남겼다. 항목별 플래너 토글은 붙였고 **카테고리 스코프 모델(`planner_scopes`)은 S6-03** 이다 |
| S3-06 | 찜·가격 변동 알림 | [x] | S3-04, S3-03 | F-C-26. **화면·API 는 S3-05 에서 함께 구현**했다 — 담기와 찜이 같은 버튼 묶음이라 나누면 같은 자리를 두 번 건드린다. **가격 변동 '알림'(`wishlist-price-watch` 배치)만 남았고 S4-13 알림 인프라 대기**다 |
| S3-07 | 장바구니 기반 비교표 | [x] | S3-05 | F-C-10. 비교 단위는 **항목(상품)**, 묶음은 **카테고리별**, 정렬은 **실총액 낮은 순**(§6.2). 플래너 선택이 갈리면 알리고 '같은 조건으로 보기' 를 준다 — **표시 기준만 바꾸고 장바구니는 건드리지 않는다** |
| S3-08 | 참가격 인덱스 화면 | [ ] | S3-01 | F-C-09 |
| S3-09 | 마이페이지·개인정보 | [ ] | S3-01 | F-C-23 |
| S3-10 | **랜딩·마케팅 진입** | [ ] | S1-01 | §6.1 `/` — 총액 공개 강조·조건 검색 진입. **T-00c 신설** |
| S3-11 | **소비자 홈 대시보드** | [ ] | S3-05, S3-01 | §6.2 `/home` — D-day·다음 할 일·예산 게이지·장바구니 요약. **T-00c 신설** |

### 4단계 — 연결

| ID | 태스크 | 상태 | 선행 | 근거 |
|---|---|---|---|---|
| S4-01 | **마이그레이션 3차 — 채팅·문의게시판** | [ ] | T-03 | §3.7 `chat_rooms`·`chat_messages`·`qna_posts`·`qna_answers` |
| S4-02 | **마이그레이션 4차 — 상담·보증금·가용시간** | [~] | T-03 | §3.3 `vendor_availability`, §3.4 `consultations`·`consultation_deposits` |
| S4-03 | **마이그레이션 5차 — 증거 보존** | [ ] | T-03 | §3.8 `entity_events`, `notifications`·`audit_logs` 확장 |
| S4-04 | 실시간 채팅 (소비자·업체) | [ ] | S4-01, S2-01, S3-01 | F-C-27, F-V-15 |
| S4-05 | 문의게시판 | [ ] | S4-01 | F-C-28, F-V-16 |
| S4-06 | 업체 가능 시간대 등록 | [ ] | S4-02, S2-01 | F-V-17 |
| S4-07 | 상담·탐방 예약 신청·승인 | [ ] | S4-06, S3-01 | F-C-29. **완료 시 S2-08 대시보드의 '상담·탐방' 지표 연결** |
| S4-08 | 노쇼 보증금 결제·환불 | [ ] | S4-07, **S5-02** | D-22, §3.11 |
| S4-09 | 이행 확인·자동 판정 | [ ] | S4-08, S4-03 | §3.11 |
| S4-10 | 노쇼 분쟁 조율 큐 | [ ] | S4-09 | F-A-16 |
| S4-11 | 3자 일정 공유·캘린더 동기화 | [ ] | S4-07 | F-C-29 |
| S4-12 | 표준 문의·견적 | [ ] | S2-03, S3-01 | F-C-13, F-V-07. **완료 시 S2-08 대시보드의 '문의' 지표 연결** |
| S4-13 | 알림센터·발송 증적 | [ ] | S4-03 | F-C-21, D-23. `dday-notifications`·`sla-escalation` 배치 포함 |
| S4-14 | **업체 알림·연동 설정** | [ ] | S2-01, S4-13 | F-V-14 — 수신 채널·담당자 배정·영업시간. **T-00c 신설** |

> **S4-02 진행 상황 — `vendor_availability` 만 끝났다(`[~]`)**
> 마이그레이션 `20260808000700_vendor_availability.sql`. 요일 단위 반복 규칙이며 날짜 예외는
> `inventory_slots` 블록 처리로 다룬다(§3.3). 같은 업체·요일의 시간대 겹침은 EXCLUDE로 거부한다.
> RLS는 형제 테이블 `inventory_slots`와 같은 형태다 — active 업체는 공개 열람, 쓰기는 업체 멤버
> (일정은 가격·정산이 아니므로 **staff도 가능**).
>
> **앞당긴 이유** `vendor_availability`는 §3.3 **업체 도메인** 테이블이고, 업체 어드민의 시간대
> 등록 화면(F-V-17)이 예약 흐름보다 먼저 만들어진다. 예약 테이블과 묶어 둘 이유가 없다.
>
> **남은 것** `consultations`·`consultation_deposits` 2테이블. 4단계 예약 흐름(S4-07·S4-08)과
> 함께 별도 마이그레이션으로 추가한다. 범위에서 뺀 것이 아니다.

### 5단계 — 거래

| ID | 태스크 | 상태 | 선행 | 근거 |
|---|---|---|---|---|
| S5-01 | **마이그레이션 6차 — 요율·결제 스케줄** | [~] | T-03 | §3.8 `commission_rates`·`planner_fee_rates`, §3.4 `payment_schedules`·`planner_settlements`, `bookings` 스냅샷 컬럼 |
| S5-02 | 요율 해석 엔진 (`lib/core/pricing`) | [x] | S5-01 | §3.8 해석 규칙 — 업체→카테고리→전역, bp 정수 |
| S5-03 | 요율 관리 콘솔 | [ ] | S5-02 | F-A-15 |
| S5-04 | 표준계약 템플릿·발행 | [ ] | S4-12 | F-C-15, §7.7 — **조항은 플레이스홀더**. **완료 시 S2-08 '계약' 지표 연결** |
| S5-05 | 3자 전자서명 | [ ] | S5-04 | F-C-15 |
| S5-06 | 분할 결제 | [ ] | S5-04, S5-02 | F-C-14, D-21. **완료 시 S2-08 '예약' 지표 연결** |
| S5-07 | 정산 (스냅샷 요율 기준) | [ ] | S5-06 | F-V-09, F-A-11. **완료 시 S2-08 '정산 예정액' 지표 연결** |
| S5-08 | 환불·위약금 처리 | [ ] | S5-06, T-04 | F-A-17, §7.7 |
| S5-09 | **에스크로 예치·릴리즈** | [ ] | S5-06 | F-C-16 — `escrow_holds`·`POST /api/escrow/release`. **집행 로직은 O-03 대기**, 절차·기록만. **T-00c 신설** |
| S5-10 | **업체 예약·계약 관리** | [ ] | S5-04, S4-07 | F-V-08 — `/vendor/bookings`·`PATCH /api/vendor/bookings/[id]`. **T-00c 신설** |

> **S5-01 진행 상황 — 요율 구조만 끝났다(`[~]`)**
> 마이그레이션 `20260808000600_commission_rates.sql` 로 **`commission_rates`·`planner_fee_rates`**
> 두 테이블(열거 2, 겹침 EXCLUDE 2, RLS SELECT 2)과 `app_settings` 가변 파라미터 키 7개를
> 만들었다. **남은 것은 결제 스케줄 쪽**이다 — `payment_schedules`·`planner_settlements`
> 신규 2테이블, `bookings` 스냅샷 컬럼 2개, `settlements.fee_rate_bp`,
> `payments.payment_schedule_id`. 범위에서 뺀 것이 아니라 **아직 만들지 않은 것**이며
> S5-06(분할 결제) 착수 전까지 별도 마이그레이션으로 추가한다.
>
> **S5-02 산출** `lib/core/pricing/rates.ts`(`resolveRate`·`calculateSettlement`·
> `calculatePlannerFee`), `order.ts`(`calculateOrderTotal`), `amount.ts`(미정 sentinel),
> `lib/core/schemas/rates.ts`·`order.ts`, 테스트 58건. 요율 값은 코드 어디에도 없다.

### 6단계 — 플래너

| ID | 태스크 | 상태 | 선행 | 근거 |
|---|---|---|---|---|
| S6-01 | **마이그레이션 7차 — 플래너 범위** | [ ] | S5-01 | §3.7 `planner_scopes` |
| S6-02 | 플래너 등록·프로필·마켓 | [ ] | S3-01 | F-C-18 |
| S6-03 | 카테고리별 부분 선택 과금 | [ ] | S6-01, S5-02, S3-05 | F-C-31, D-17 |
| S6-04 | 플래너 권한 위임 | [ ] | S6-02 | F-C-18, §3.9 |
| S6-05 | 플래너 정산·지급 유예 | [ ] | S6-03, S5-07 | D-21 |
| S6-06 | 플래너 랭킹 | [ ] | S6-02 | F-C-18 |

### 7단계 — AI·부가

| ID | 태스크 | 상태 | 선행 | 근거 |
|---|---|---|---|---|
| S7-01 | 검출 룰 20종 시드 | [ ] | T-03, T-04 | 부록 A — **근거 조항 확정 대기** |
| S7-02 | 조건 검색·랭킹 | [ ] | S3-03 | F-C-30, §5.5 |
| S7-03 | 계약서 검토 파이프라인 | [ ] | S7-01, T-04 | F-C-07, §5.2 |
| S7-04 | 위약금 시뮬레이터 화면 | [ ] | T-04 | F-C-08, §5.3 |
| S7-05 | 견적 정규화·비교 | [ ] | T-04 | F-C-06, §5.4 |
| S7-06 | AI 플래너 대화·툴 | [ ] | S7-02 | F-C-03, §5.6 |
| S7-07 | 예산 배분·추적 | [ ] | S3-01 | F-C-05 (구 T-06) |
| S7-08 | 일정·체크리스트 | [ ] | S3-01 | F-C-04 |
| S7-09 | 하객·좌석 유틸리티 | [ ] | S3-01 | F-C-22 |
| S7-10 | SEO 콘텐츠 허브 | [ ] | S1-01 | F-C-24 |
| S7-11 | 멤버십 구독 | [ ] | S5-06 | F-C-19 |
| S7-12 | 공유 링크 | [ ] | S7-03 | F-C-20 |
| S7-13 | 컴플라이언스 진단 | [ ] | S7-01, S2-01 | F-V-10 |

### 8단계 — 운영

| ID | 태스크 | 상태 | 선행 | 근거 |
|---|---|---|---|---|
| S8-01 | 운영자 대시보드·지표 | [ ] | S2~S7 | F-A-07 |
| S8-02 | 감사 로그·증적 타임라인 | [ ] | S4-03 | F-A-09, F-A-12 |
| S8-03 | 분쟁 조율 콘솔 | [ ] | S8-02 | F-A-12, F-A-17 |
| S8-04 | 개인정보 감사·파기 배치 | [ ] | S7-03 | F-A-08 |
| S8-05 | **CI 파이프라인** (구 T-02b) | [ ] | S1-01 | §7.2, §7.5 — **미완 2건 포함**, 아래 참조 |
| S8-06 | 룰·프롬프트 관리 | [ ] | S7-01 | F-A-03 |
| S8-07 | AI 품질·비용 관리 | [ ] | S7-03 | F-A-04, §5.8 |
| S8-08 | 콘텐츠 CMS | [ ] | S7-10 | F-A-05 |
| S8-09 | CS·신고 처리 | [ ] | S3-01 | F-A-06 |
| S8-10 | 가격 큐레이션·이상 탐지 | [ ] | S2-03 | F-A-02, F-A-14, §5.7 |
| S8-11 | 검증 후기 | [ ] | S5-07 | F-C-17, F-V-11, F-A-13. **완료 시 S2-08 '평균 평점' 지표 연결** |
| S8-12 | 피처 플래그 콘솔 | [ ] | S1-01 | F-A-10 |
| S8-13 | 모니터링·장애 대응 | [ ] | S8-05 | §7.4 |

---

## 다음 착수 태스크

1단계 기반(S1-01 · S1-02 · S1-03)과 **요율 구조**(S5-01 요율 테이블 · S5-02 해석 엔진)가 끝났다. **S2-03 상품·판매가 등록의 선행 조건이 풀렸다** — 판매가 등록 화면의 예상 정산액을 `calculateSettlement` 로 계산할 수 있다.

**2단계는 S2-09(미가입자 초대)만 남았고 그것은 알림 인프라(S4-13)를 기다린다.** S5-01의 잔여분(결제 스케줄 테이블)은 S5-06 착수 전까지 채우면 되며 2단계를 막지 않는다.

**S3-01·S3-02**(온보딩 + 커플 연동), **S3-03**(탐색·필터), **S3-04**(장바구니·찜 스키마·RLS), **S3-05·S3-06**(장바구니·찜 화면·API)이 끝났다.

**3단계에서 남은 것은 S3-08~S3-11 이다.** 장바구니 계열(S3-03~S3-07)은 전부 끝났다.

- **S3-08**(참가격 인덱스 화면) — 끝나면 `/explore` 의 `price_index_gap` 정렬을 열 수 있다(`EXPLORE_SORT_PENDING` 에서 뺀다).
- **S3-09**(마이페이지) · **S3-10**(랜딩) · **S3-11**(소비자 홈) — 서로 선행이 없어 순서를 자유롭게 잡을 수 있다. S3-11 은 S3-05 가 풀렸으므로 장바구니 요약을 바로 붙일 수 있다.

> **S3-05 가 남긴 것 두 가지.**
> **실시간 반영(O-11)** — `CartView`·`WishlistView` 의 TODO(O-11) 자리에서 `cart_items`·`wishlists` 를 구독하면 된다. 지금은 새로 고칠 때 보인다는 사실을 화면에 적어 뒀다.
> **가격 변동 알림(S4-13)** — 찜 화면은 볼 때 계산해 보여준다. 배치 발송(`wishlist-price-watch`)만 알림 인프라를 기다린다.

> **S3-03이 남긴 것 — 담기 동작은 붙어 있지 않다.** `/explore` 와 업체 상세의 담기 버튼은 **담긴 상태만 표시**하고 비활성이다. `POST /api/cart` 가 커버리지 표에서 S3-05 소관이라 여기서 만들지 않았다. S3-05는 버튼 두 곳(`VendorCard`, `VendorProducts`)에 동작을 붙이면 된다.
>
> **정렬 5종이 아직 닫혀 있다.** `EXPLORE_SORT_PENDING`(`lib/core/schemas/explore.ts`)에 코드·이유·담당 태스크가 적혀 있고 화면에도 그대로 노출된다. 후기(S8-02)·응답 속도(S4-12)·참가격(S3-08)·예약 가능일(S2-05 보급) 이 채워지면 그 배열에서 빼고 `EXPLORE_SORTS` 에 넣는다.

> **S3-04가 남긴 것** — `cart_items` 는 가격을 표시값으로 갖지 않는다. 장바구니 총액은 `products.base_price_total` 현재가와 `planner_selected` 로 **매번 계산**한다. S3-05는 `lib/core/pricing` 의 `resolveRate`·`calculatePlannerFee` 를 그대로 쓰면 되고, 요율을 어디에도 저장하지 않는다(D-16·D-17). `price_at_add` 는 "담을 때보다 올랐다/내렸다" 를 말하기 위한 기준점이며 **합산에 넣지 않는다.**

---

## S8-05 CI 파이프라인 — 포함 항목

기본 게이트(`npm ci` → `lint` → `test` → `build` → 시크릿 스캔 → 번들 유입 검사 → `npm audit` → `assets:check`)에 더해 **T-04·T-04b에서 미룬 2건을 반드시 포함**한다.

| 미완 항목 | 사유 | 처리 |
|---|---|---|
| **ESLint `no-restricted-imports` 규칙** | T-04 당시 수정 허용 범위가 `lib/core`·테스트로 한정돼 `.eslintrc.json` 을 건드리지 않았다 | `lib/core` 하위에서 `react`·`next`·`@supabase/*`·`@anthropic-ai/sdk` import 를 금지하는 override 추가. 현재는 `lib/core/no-framework-imports.test.ts` 가 같은 역할을 하고 있으나 **린트 단계에서도 잡아야** 에디터에서 즉시 드러난다 |
| **커버리지 80% 측정** | `@vitest/coverage-v8` 미설치. 새 의존성 추가가 당시 보고 대상이었다 | `npm i -D @vitest/coverage-v8` 후 `vitest run --coverage` 를 CI 게이트에 추가. 기준은 §7.5의 **80%**. 현재 대체 지표는 내보낸 심볼 참조율 96% |

추가로 **`(dev)` 라우트 그룹 차단**(design-system 카탈로그)을 배포 파이프라인에서 처리한다.

---

## 기술 부채

착수 시점에 의도적으로 감수한 선택이다. 조건이 충족되면 갚는다.

| 항목 | 내용 | 갚는 조건 |
|---|---|---|
| **자산 매니페스트 텍스트 파싱** | `scripts/lib/asset-manifest.mjs` 가 `lib/assets/manifest.ts` 를 **TypeScript 파서 없이 텍스트로 파싱**한다. 새 의존성을 넣지 않으려는 T-02c의 선택이었다.<br>**제약: `manifest.ts` 의 `ASSETS` 는 순수 데이터 리터럴 형태를 유지해야 한다.** 계산식·전개 연산자·헬퍼 함수 호출을 넣으면 `assets:gen`·`assets:check` 가 조용히 깨진다 | 슬롯이 크게 늘거나 매니페스트에 동적 구성이 필요해지면, **빌드 스텝에서 JSON을 생성**해 스크립트가 JSON을 읽는 방식으로 전환한다 |
| **shadcn CLI 버전 고정** | `shadcn@latest`(4.x)는 Tailwind 4 + React 19 세대라 이 프로젝트(React 18 / Next 14 / Tailwind 3)와 호환되지 않는다. **`shadcn@2` 로 고정**해 쓰고 있다 | Next·React·Tailwind 메이저 업그레이드 시 함께 전환 |
| **다크모드 미구현** | 토큰·컴포넌트가 라이트 전용이다. `.dark` 블록과 `darkMode` 설정을 두지 않았다 | 도입 시 `globals.css` 에 `.dark` 토큰만 추가하면 컴포넌트는 그대로 동작 |
| **E2E 미도입** | Playwright 미설치. §7.5는 E2E를 요구한다.<br>**S3-01에서도 도입하지 않았다** — 새 npm 의존성을 넣지 않는 태스크 제약 때문이다. 대신 화면·API 플로우는 REST 스크립트로 확인했고, 그 스크립트는 `tmp/`(git 제외)에 남아 커밋되지 않는다 | 의존성 추가가 허용되는 시점(S8-05 CI 정비)에 도입한다 |
| ~~**RLS 통합 테스트 미커밋**~~ **(S3-01 상환)** | `scripts/rls-check.mjs` + `npm run db:rls` 로 커밋했다. psql 세션을 전환해 커플 격리·당사자 수정 권한·부분 유니크를 12항목 확인한다 | CI 연결은 S8-05. 다른 도메인(업체·문서)의 격리 점검은 해당 태스크에서 같은 스크립트에 덧붙인다 |

---

## 마이그레이션 태스크 요약

T-03에서 66개 테이블을 만들었고, v2.0 신규 테이블은 아래와 같이 **6개 마이그레이션 태스크**로 나눠 등록했다. 기존 마이그레이션은 수정하지 않고 새 파일로 추가한다(CLAUDE.md §7.2).

| 태스크 | 신규 테이블 | 변경 |
|---|---|---|
| ~~S3-04~~ (완료) | ~~`carts`, `cart_items`, `wishlists`~~ | `cart_couple_id()` 헬퍼 추가 |
| S4-01 | `chat_rooms`, `chat_messages`, `qna_posts`, `qna_answers` | — |
| S4-02 | ~~`vendor_availability`~~ (완료), `consultations`, `consultation_deposits` | — |
| S4-03 | `entity_events` | `notifications` 컬럼 확장, `audit_logs.resolution_basis` |
| S5-01 | ~~`commission_rates`~~, ~~`planner_fee_rates`~~ (완료), `payment_schedules`, `planner_settlements` | `bookings` 스냅샷 컬럼 2개, `settlements.fee_rate_bp`, `payments.payment_schedule_id` |
| S6-01 | `planner_scopes` | — |

**신규 테이블 16개.** 각 마이그레이션에는 RLS 정책을 같은 파일에 포함한다(§3.9, CLAUDE.md §5.5). `entity_events`는 **insert-only** — UPDATE·DELETE 정책을 부여하지 않는다.

---

## 선행조건 대기 — 아직 착수하지 않는 것

> 아래는 **범위에서 뺀 것이 아니라, 선행조건이 풀리면 착수하는 것**이다.
> 범위 축소 금지 원칙(CLAUDE.md §2.1)에 따라 삭제·축소하지 않는다.

| 항목 | 대기 사유 | 관련 태스크 |
|---|---|---|
| `detect_rules` 시드 20종 | 근거 **조항 번호** 확정 후. 룰 구현체는 T-04에서 완료 | S7-01 |
| 표준계약서 조항 문안 | O-03 법무 검수. **템플릿 구조·서명 플로우는 먼저 구현**(§7.7) | S5-04 |
| 수수료 요율 **값** | O-02. **구조는 S5-01·S5-02에서 완성**되므로 값은 오픈 전까지만 정하면 된다 | S5-03 |
| 결제 분할 비율·유예 기간·보증금액 | 운영 정책 결정. 전부 DB 파라미터라 미확정 상태로 개발 가능(§7.4) | S5-06, S6-05, S4-08 |
| 에스크로 집행 로직 | O-03 법무 결론. 컬럼·훅만 유지 | S5-06 |
| Storage 버킷 생성 | §3.10. `chat-attachments` 포함 | S4-01 |
| `(dev)` 라우트 그룹 차단 | 배포 전 미들웨어·플래그 처리 | S8-05 |
| ESLint `no-restricted-imports` · 커버리지 80% | 위 "S8-05 CI 파이프라인 — 포함 항목" 참조 | S8-05 |

---

## 결정 완료

- **`feature_flags` / `app_settings` / `audit_logs` 의 1차 마이그레이션 포함** — 결정됨(2026-08-06). T-03에서 반영 완료.
- **D-16~D-24 (2026-08-08)** — 수수료 구조, 플래너 부분 선택, 개발 순서 8단계, 계약·결제 구조, 상담 예약·노쇼 보증금, 증거 보존, 플랫폼 지위. 명세서 v2.0에 전면 반영.
  - **단계별 공개 폐기** — `feature_flags`는 릴리즈 스위치가 아니라 부분 공개·긴급 롤백 수단으로 역할이 좁혀졌다.
  - **O-02 개발 블로커 해제** — 요율 값은 미확정이나 가변 구조 설계로 개발이 값에 묶이지 않는다.

---

## 부가 메모

- **검출 룰 20종**은 `lib/core/rules/detect-rules.ts`에 R-01~R-20 전부 구현돼 있다. `basis_ref`는 출처 수준(표준약관 / 소비자분쟁해결기준 업종)까지만 적혀 있고, **테스트가 조항 번호 표기(`제N조`·`N항`)를 금지**하므로 확정 전에 임의 번호가 들어가면 테스트가 깨진다.
- **위약금 엔진**은 룰 데이터를 주입받는 순수 함수다. 기본값(`DRAFT_PENALTY_RULE_SETS`)은 `isDraft: true`라 결과 `notes`에 "가정치" 경고가 자동으로 붙는다.
- **요율 스냅샷 원칙**(§3.4)은 회귀 테스트로 고정한다 — 요율 변경 후 기존 계약의 정산액이 불변임을 S5-02에서 테스트에 포함한다.
- **노쇼 무응답 기본값은 환불**이다(§3.11). 몰취가 기본이면 업체의 방치가 이득이 되는 구조가 되기 때문이며, 이 설계 의도를 바꾸지 않는다.

---

## 커버리지 검증표 (T-00c)

`docs/07_개발명세서.md` v2.1의 **§2 기능 · §3 테이블 · §4 API · §6 화면**을 전수 추출해 태스크에 대응시킨 표다.
운영 규칙은 문서 상단 [운영 규칙](#운영-규칙-t-00c)에 있다.

| 축 | 총계 | 배정 | 미배정 | 완료 |
|---|---|---|---|---|
| §2 기능 | 65 | 65 | 0 | 8 |
| §3 테이블 | 83 | 83 | 0 | 71 |
| §4 API·배치 | 75 | 75 | 0 | 9 |
| §6 화면 | 67 | 67 | 0 | 9 |

> **추출 시점 미배정 8건은 전부 태스크를 신설해 해소했다** — S3-10, S3-11, S4-14, S5-09, S5-10.
> 상세는 [신설 태스크](#신설-태스크-t-00c)에 있다.

### A. §2 기능 (65)

| ID | 기능 | 단계 | 담당 태스크 | 상태 |
|---|---|---|---|---|
| F-C-01 | 회원가입·온보딩 | 3 | S3-01 / 이메일 로그인은 S2-01 | 완료 (소셜 공급자 키만 S3-01b) |
| F-C-02 | 커플 연동 | 3 | S3-02 (S3-01에서 함께 구현) | 완료 (초대 메일 발송만 S4-13) |
| F-C-03 | AI 플래너 대화 | 7 | S7-06 | 미착수 |
| F-C-04 | 일정·체크리스트 | 7 | S7-08 | 미착수 |
| F-C-05 | 예산 배분·추적 | 7 | S7-07 | 미착수 |
| F-C-06 | 견적 비교·정규화 | 7 | S7-05 | 미착수 |
| F-C-07 | 계약서 검토 리포트 | 7 | S7-03 | 미착수 |
| F-C-08 | 위약금 시뮬레이터 | 7 | S7-04 | 미착수 |
| F-C-09 | 참가격 인덱스 탐색 | 3 | S3-08 | 미착수 |
| F-C-10 | 업체 탐색·필터·비교 | 3 | S3-03, S3-07 | 완료 |
| F-C-11 | 실시간 예약 가능일 | 3 | S3-03 | 완료 |
| F-C-12 | 다이내믹 가격 노출 | 3 | S3-03 | 완료 (업체 상세에서 날짜 선택 시) |
| F-C-13 | 직거래 문의·견적 요청 | 4 | S4-12 | 미착수 |
| F-C-14 | 분할 결제 | 5 | S5-06 | 미착수 |
| F-C-15 | 전자계약·3자 서명 | 5 | S5-04, S5-05 | 미착수 |
| F-C-16 | 에스크로 안전거래 | 5 | **S5-09**(신설) | 미착수 |
| F-C-17 | 검증 후기 | 8 | S8-11 | 미착수 |
| F-C-18 | 플래너 매칭 마켓 | 6 | S6-02, S6-04 | 미착수 |
| F-C-19 | 멤버십 구독 | 7 | S7-11 | 미착수 |
| F-C-20 | 공유 리포트·초대 | 7 | S7-12 | 미착수 |
| F-C-21 | 알림센터 | 4 | S4-13 | 미착수 |
| F-C-22 | 하객·좌석 유틸리티 | 7 | S7-09 | 미착수 |
| F-C-23 | 마이페이지·개인정보 | 3 | S3-09 | 미착수 |
| F-C-24 | SEO 콘텐츠 허브 | 7 | S7-10, **S3-10**(랜딩) | 미착수 |
| F-C-25 | 장바구니 | 3 | S3-05 | 완료 (실시간 반영은 O-11 대기) |
| F-C-26 | 찜 | 3 | S3-06 (S3-05에서 함께 구현) | 완료 (변동 알림 발송만 S4-13) |
| F-C-27 | 실시간 채팅 | 4 | S4-04 | 미착수 |
| F-C-28 | 문의게시판 | 4 | S4-05 | 미착수 |
| F-C-29 | 상담·탐방 예약 | 4 | S4-07, S4-08, S4-09, S4-11 | 미착수 |
| F-C-30 | 조건 검색 | 7 | S7-02 | 미착수 |
| F-C-31 | 플래너 범위 선택 | 6 | S6-03 | 미착수 |
| F-V-01 | 입점 신청·검증 | 2 | S2-01 | 완료 |
| F-V-02 | 업체 프로필 관리 | 2 | S2-02 | 완료 |
| F-V-03 | 상품·패키지 등록 | 2 | S2-03 | 완료 |
| F-V-04 | 추가금 사전 등록 | 2 | S2-04 | 완료 |
| F-V-05 | 실재고 캘린더 | 2 | S2-05 | 완료 |
| F-V-06 | 다이내믹 프라이싱 룰 | 2 | S2-06 | 완료 |
| F-V-07 | 문의·견적 응답 | 4 | S4-12 | 미착수 |
| F-V-08 | 예약·계약 관리 | 5 | **S5-10**(신설) | 미착수 |
| F-V-09 | 정산 관리 | 5 | S5-07 | 미착수 |
| F-V-10 | 컴플라이언스 진단 | 7 | S7-13 | 미착수 |
| F-V-11 | 후기·평판 관리 | 8 | S8-11 | 미착수 |
| F-V-12 | 성과 통계 | 2 | S2-08 | 완료 |
| F-V-13 | 멤버·권한 관리 | 2 | S2-07 / 미가입자 초대는 **S2-09** | 진행중 |
| F-V-14 | 알림·연동 설정 | 4 | **S4-14**(신설) | 미착수 |
| F-V-15 | 채팅 응대 | 4 | S4-04 | 미착수 |
| F-V-16 | 문의게시판 관리 | 4 | S4-05 | 미착수 |
| F-V-17 | 상담 일정 관리 | 4 | S4-06, S4-07, S4-09 | 미착수 |
| F-A-01 | 입점 심사 | 2 | S2-01 | 완료 |
| F-A-02 | 참가격 데이터 큐레이션 | 8 | S8-10 | 미착수 |
| F-A-03 | 검출 룰·프롬프트 관리 | 8 | S8-06 | 미착수 |
| F-A-04 | AI 품질 관리 | 8 | S8-07 | 미착수 |
| F-A-05 | 콘텐츠 CMS | 8 | S8-08 | 미착수 |
| F-A-06 | CS·신고 처리 | 8 | S8-09 | 미착수 |
| F-A-07 | 지표 대시보드 | 8 | S8-01 | 미착수 |
| F-A-08 | 개인정보 감사 | 8 | S8-04 | 미착수 |
| F-A-09 | 감사 로그 | 8 | S8-02 | 미착수 |
| F-A-10 | 피처 플래그 | 8 | S8-12 | 미착수 |
| F-A-11 | 정산 집행 | 5 | S5-07 | 미착수 |
| F-A-12 | 분쟁 조율 | 8 | S8-03 | 미착수 |
| F-A-13 | 후기 관리 | 8 | S8-11 | 미착수 |
| F-A-14 | 가격 이상 탐지 | 8 | S8-10 | 미착수 |
| F-A-15 | 요율 관리 | 5 | S5-03 | 미착수 |
| F-A-16 | 노쇼 분쟁 조율 | 4 | S4-10 | 미착수 |
| F-A-17 | 위약금 처리 | 5 | S5-08 | 미착수 |

### B. §3 테이블 (83)

`상태=완료` 는 마이그레이션이 적용돼 `types/database.ts` 에 반영된 것을 뜻한다. 화면·API 완성 여부와 무관하다.

| 테이블 | 절 | 담당 태스크 | 상태 |
|---|---|---|---|
| profiles | 3.1 | T-03 | 완료 |
| couples | 3.1 | T-03 | 완료 |
| couple_members | 3.1 | T-03 | 완료 |
| couple_invites | 3.1 | T-03 | 완료 |
| onboarding_answers | 3.1 | T-03 | 완료 |
| memberships | 3.1 | T-03 | 완료 |
| subscription_payments | 3.1 | T-03 | 완료 |
| consents | 3.1 | T-03 | 완료 |
| data_deletion_requests | 3.1 | T-03 | 완료 |
| task_templates | 3.2 | T-03 | 완료 |
| tasks | 3.2 | T-03 | 완료 |
| budgets | 3.2 | T-03 | 완료 |
| budget_items | 3.2 | T-03 | 완료 |
| expenses | 3.2 | T-03 | 완료 |
| vendors | 3.3 | T-03 / 프로필 컬럼 6개는 S2-02 | 완료 |
| vendor_documents | 3.3 | T-03 / 업로드·서명 URL 은 S2-01 | 완료 |
| vendor_members | 3.3 | T-03 / 마지막 대표 트리거·자기 삭제 정책은 S2-07 | 완료 |
| vendor_media | 3.3 | T-03 / 업로드·정렬은 S2-02 | 완료 |
| products | 3.3 | T-03 / 게시 상태·총액 강제는 S2-03 | 완료 |
| product_options | 3.3 | T-03 / 제약·확정 상태는 S2-04 | 완료 |
| price_rules | 3.3 | T-03 / 우선순위·정수 CHECK 는 S2-06 | 완료 |
| price_index | 3.3 | T-03 | 완료 |
| price_sources | 3.3 | T-03 | 완료 |
| **vendor_availability** | 3.3 | S4-02 | 완료 |
| inventory_slots | 3.4 | T-03 / 중복 금지·상태 CHECK 는 S2-05 | 완료 |
| **carts** | 3.4 | S3-04 | 완료 |
| **cart_items** | 3.4 | S3-04 | 완료 |
| **wishlists** | 3.4 | S3-04 | 완료 |
| inquiries | 3.4 | T-03 | 완료 |
| inquiry_targets | 3.4 | T-03 | 완료 |
| quotes | 3.4 | T-03 | 완료 |
| quote_items | 3.4 | T-03 | 완료 |
| **consultations** | 3.4 | S4-02 (잔여) | 미착수 |
| **consultation_deposits** | 3.4 | S4-02 (잔여) | 미착수 |
| bookings | 3.4 | T-03 / 스냅샷 컬럼 2개는 S5-01 (잔여) | 진행중 |
| contracts | 3.4 | T-03 | 완료 |
| contract_signatures | 3.4 | T-03 | 완료 |
| **payment_schedules** | 3.4 | S5-01 (잔여) | 미착수 |
| payments | 3.4 | T-03 / `payment_schedule_id` 는 S5-01 (잔여) | 진행중 |
| escrow_holds | 3.4 | T-03 | 완료 |
| refunds | 3.4 | T-03 | 완료 |
| settlements | 3.4 | T-03 / `fee_rate_bp` 는 S5-01 (잔여) | 진행중 |
| settlement_items | 3.4 | T-03 | 완료 |
| **planner_settlements** | 3.4 | S5-01 (잔여) | 미착수 |
| disputes | 3.4 | T-03 | 완료 |
| documents | 3.5 | T-03 | 완료 |
| document_analyses | 3.5 | T-03 | 완료 |
| findings | 3.5 | T-03 | 완료 |
| detect_rules | 3.5 | T-03 / 시드는 S7-01 | 진행중 |
| penalty_rules | 3.5 | T-03 / 시드는 S7-01 | 진행중 |
| penalty_simulations | 3.5 | T-03 | 완료 |
| estimate_uploads | 3.5 | T-03 | 완료 |
| estimate_items | 3.5 | T-03 | 완료 |
| estimate_comparisons | 3.5 | T-03 | 완료 |
| ai_conversations | 3.6 | T-03 | 완료 |
| ai_messages | 3.6 | T-03 | 완료 |
| ai_tool_calls | 3.6 | T-03 | 완료 |
| ai_call_logs | 3.6 | T-03 | 완료 |
| prompt_versions | 3.6 | T-03 | 완료 |
| reviews | 3.7 | T-03 | 완료 |
| review_reports | 3.7 | T-03 | 완료 |
| planners | 3.7 | T-03 | 완료 |
| planner_engagements | 3.7 | T-03 | 완료 |
| **planner_scopes** | 3.7 | S6-01 | 미착수 |
| **chat_rooms** | 3.7 | S4-01 | 미착수 |
| **chat_messages** | 3.7 | S4-01 | 미착수 |
| **qna_posts** | 3.7 | S4-01 | 미착수 |
| **qna_answers** | 3.7 | S4-01 | 미착수 |
| content_posts | 3.7 | T-03 | 완료 |
| notifications | 3.7 | T-03 / 발송·수신·열람 컬럼 확장은 S4-03 (잔여) | 진행중 |
| notification_prefs | 3.7 | T-03 | 완료 |
| share_links | 3.7 | T-03 | 완료 |
| guests | 3.7 | T-03 | 완료 |
| seating_plans | 3.7 | T-03 | 완료 |
| audit_logs | 3.8 | T-03 / 심사 액션 기록은 S2-01 / `resolution_basis` 는 S4-03 (잔여) | 진행중 |
| **entity_events** | 3.8 | S2-01(생성) / S4-03(확장·타임라인) | 진행중 |
| feature_flags | 3.8 | T-03 | 완료 |
| app_settings | 3.8 | T-03 / 파라미터 키 시드는 S5-01 | 완료 |
| **commission_rates** | 3.8 | S5-01 | 완료 |
| **planner_fee_rates** | 3.8 | S5-01 | 완료 |
| tickets | 3.8 | T-03 | 완료 |
| job_runs | 3.8 | T-03 | 완료 |
| **vendor_applications** | 3.3 | S2-01 | 완료 |

> **명세 반영 완료 (S0-01 · 명세서 v2.1)**
> S2-01 구현 중 드러난 갭 2건을 명세서에 반영했다. 더 이상 '명세 외' 항목이 아니다.
> - **`vendor_applications`** → **§3.3** 에 신설. `vendors.status`(3값)로는 F-V-01 의 심사
>   4단계를 담을 수 없고, `vendors` 는 anon SELECT 가 열린 공개 카탈로그 테이블이라 심사 전용
>   정보(반려 사유·대표자 연락처)를 얹지 않는다. 근거는 §3.3 NOTE 에 있다.
> - **`vendor-documents` 버킷** → **§3.10** 에 추가. 비공개 + 서명 URL 전용이라
>   "공개 버킷은 `vendor-media` 외 금지" 원칙에 부합한다.

### C. §4 API · 배치 (75)

| 메서드 · 경로 | 면 | 담당 태스크 | 상태 |
|---|---|---|---|
| POST /api/onboarding | 소비자 | S3-01 | 완료 (GET 포함) |
| POST /api/couples/invite | 소비자 | S3-01 | 완료 (발급·수락 + GET 코드 검증) |
| POST /api/ai/planner (SSE) | 소비자 | S7-06 | 미착수 |
| GET/POST/PATCH /api/tasks | 소비자 | S7-08 | 미착수 |
| GET/PUT /api/budget | 소비자 | S7-07 | 미착수 |
| POST /api/documents | 소비자 | S7-03 | 미착수 |
| POST /api/reports · GET /api/reports/[id] | 소비자 | S7-03 | 미착수 |
| POST /api/estimates/normalize · GET /api/estimates/compare | 소비자 | S7-05 | 미착수 |
| POST /api/penalty/simulate | 소비자 | S7-04 | 미착수 |
| GET /api/prices | 소비자 | S3-08 | 미착수 |
| GET /api/vendors | 소비자 | S3-03 | 완료 (정렬 기준 코드 응답 포함) |
| GET /api/vendors/[id]/availability | 소비자 | S3-03 | 완료 |
| GET/POST/DELETE /api/cart | 소비자 | S3-05 | 완료 (POST 에 담기·플래너 토글·옵션 변경·찜에서 옮기기) |
| GET/POST/DELETE /api/wishlist | 소비자 | S3-06 (S3-05) | 완료 |
| GET/POST /api/search | 소비자 | S7-02 | 미착수 |
| GET/POST /api/chat/rooms | 소비자 | S4-04 | 미착수 |
| GET/POST /api/chat/messages | 소비자 | S4-04 | 미착수 |
| GET/POST /api/qna | 소비자 | S4-05 | 미착수 |
| POST /api/inquiries | 소비자 | S4-12 | 미착수 |
| GET/POST /api/consultations | 소비자 | S4-07 | 미착수 |
| POST /api/consultations/[id]/confirm | 소비자 | S4-09 | 미착수 |
| GET/POST /api/payments/schedules | 소비자 | S5-06 | 미착수 |
| POST /api/payments/checkout | 소비자 | S5-06 | 미착수 |
| POST /api/contracts/[id]/sign | 소비자 | S5-05 | 미착수 |
| POST /api/escrow/release | 소비자 | **S5-09**(신설) | 미착수 |
| POST /api/reviews | 소비자 | S8-11 | 미착수 |
| GET/PUT /api/planner-scopes | 소비자 | S6-03 | 미착수 |
| POST /api/share-links · GET /api/share/[token] | 소비자 | S7-12 | 미착수 |
| GET/PUT /api/notifications | 소비자 | S4-13 | 미착수 |
| POST /api/me/delete-request | 소비자 | S3-09 | 미착수 |
| POST /api/vendor/apply | 업체 | S2-01 | 완료 |
| GET/PUT /api/vendor/profile | 업체 | S2-02 | 완료 |
| CRUD /api/vendor/products | 업체 | S2-03 | 완료 |
| CRUD /api/vendor/products/[id]/options | 업체 | S2-04 | 완료 |
| POST /api/vendor/inventory/bulk | 업체 | S2-05 | 완료 |
| CRUD /api/vendor/price-rules · POST .../simulate | 업체 | S2-06 | 완료 |
| CRUD /api/vendor/availability | 업체 | S4-06 | 미착수 |
| GET/POST /api/vendor/chat | 업체 | S4-04 | 미착수 |
| GET/POST /api/vendor/qna | 업체 | S4-05 | 미착수 |
| GET/PATCH /api/vendor/consultations | 업체 | S4-07, S4-09 | 미착수 |
| POST /api/vendor/quotes | 업체 | S4-12 | 미착수 |
| PATCH /api/vendor/bookings/[id] | 업체 | **S5-10**(신설) | 미착수 |
| GET /api/vendor/settlements | 업체 | S5-07 | 미착수 |
| POST /api/vendor/compliance/scan | 업체 | S7-13 | 미착수 |
| GET /api/vendor/stats | 업체 | S2-08 | 완료 |
| POST /api/vendor/members | 업체 | S2-07 | 완료 |
| PATCH /api/admin/vendors/[id]/review | 운영자 | S2-01 | 완료 |
| POST /api/admin/prices/recalculate | 운영자 | S8-10 | 미착수 |
| CRUD /api/admin/rules | 운영자 | S8-06 | 미착수 |
| POST /api/admin/prompts/deploy | 운영자 | S8-06 | 미착수 |
| GET /api/admin/ai-quality | 운영자 | S8-07 | 미착수 |
| CRUD /api/admin/content | 운영자 | S8-08 | 미착수 |
| CRUD /api/admin/tickets | 운영자 | S8-09 | 미착수 |
| GET /api/admin/metrics | 운영자 | S8-01 | 미착수 |
| GET /api/admin/privacy-audit | 운영자 | S8-04 | 미착수 |
| GET /api/admin/audit-logs | 운영자 | S8-02 | 미착수 |
| CRUD /api/admin/commission-rates · GET .../resolve | 운영자 | S5-03 | 미착수 |
| GET/PATCH /api/admin/consultation-disputes | 운영자 | S4-10 | 미착수 |
| GET /api/admin/entity-events | 운영자 | S8-02 | 미착수 |
| PUT /api/admin/flags/[key] | 운영자 | S8-12 | 미착수 |
| POST /api/admin/settlements/run | 운영자 | S5-07 | 미착수 |
| PATCH /api/admin/disputes/[id] | 운영자 | S8-03 | 미착수 |
| POST /api/admin/penalties | 운영자 | S5-08 | 미착수 |
| GET /api/admin/price-anomalies | 운영자 | S8-10 | 미착수 |
| POST /api/webhooks/toss (웹훅) | 배치 | S5-06 | 미착수 |
| purge-documents (Edge, 매시간) | 배치 | S8-04 | 미착수 |
| dday-notifications (Cron, 매일) | 배치 | S4-13 | 미착수 |
| price-index-refresh (Cron, 주 1회) | 배치 | S8-10 | 미착수 |
| settlement-aggregate (Cron, 월 2회) | 배치 | S5-07 | 미착수 |
| price-anomaly-scan (Cron, 매일) | 배치 | S8-10 | 미착수 |
| sla-escalation (Cron, 1시간) | 배치 | S4-13 | 미착수 |
| consultation-confirm-request (Cron, 1시간) | 배치 | S4-09 | 미착수 |
| consultation-resolve (Cron, 1시간) | 배치 | S4-09 | 미착수 |
| planner-payout-due (Cron, 매일) | 배치 | S6-05 | 미착수 |
| wishlist-price-watch (Cron, 매일) | 배치 | S3-06 | 미착수 — **S4-13 알림 인프라 대기**. 화면은 볼 때 계산해 보여주고 있다 |

> **배치 실행 인프라**(Cron 등록·`job_runs` 기록·실패 경보)는 **S8-13**(모니터링·장애 대응)이 소유한다.
> 위 표의 담당 태스크는 각 배치의 **로직**을 만드는 곳이다.

### D. §6 화면 (67)

| 경로 | 면 | 담당 태스크 | 상태 |
|---|---|---|---|
| / | 마케팅 | **S3-10**(신설) | 미착수 |
| /guides/[slug] | 마케팅 | S7-10 | 미착수 |
| /prices/[region]/[category] | 마케팅 | S3-08 | 미착수 |
| /login | 인증 | S3-01 / 이메일 경로는 S2-01 | 완료 (소셜 버튼은 키 등록 전까지 비활성) |
| /onboarding | 인증 | S3-01 | 완료 |
| /home | 소비자 | **S3-11**(신설) | 미착수 |
| /planner | 소비자 | S7-06 | 미착수 |
| /checklist | 소비자 | S7-08 | 미착수 |
| /budget | 소비자 | S7-07 | 미착수 |
| /reports | 소비자 | S7-03 | 미착수 |
| /reports/upload | 소비자 | S7-03 | 미착수 |
| /reports/[id] | 소비자 | S7-03 | 미착수 |
| /estimates | 소비자 | S7-05 | 미착수 |
| /tools/penalty | 소비자 | S7-04 | 미착수 |
| /explore | 소비자 | S3-03 | 완료 |
| /explore/[vendorId] | 소비자 | S3-03 | 완료 |
| /search | 소비자 | S7-02 | 미착수 |
| /cart | 소비자 | S3-05, S6-03(플래너 토글) | 완료 (항목별 토글까지 / 카테고리 스코프는 S6-03) |
| /explore/compare | 소비자 | S3-07 | 완료 |
| /wishlist | 소비자 | S3-06 (S3-05) | 완료 |
| /chat | 소비자 | S4-04 | 미착수 |
| /chat/[roomId] | 소비자 | S4-04 | 미착수 |
| /qna/[vendorId] | 소비자 | S4-05 | 미착수 |
| /consultations | 소비자 | S4-07, S4-08, S4-09 | 미착수 |
| /inquiries | 소비자 | S4-12 | 미착수 |
| /bookings/[id] | 소비자 | S5-06 | 미착수 |
| /checkout/[bookingId] | 소비자 | S5-06 | 미착수 |
| /contracts/[id] | 소비자 | S5-05 | 미착수 |
| /reviews/new/[bookingId] | 소비자 | S8-11 | 미착수 |
| /planners | 소비자 | S6-02, S6-04 | 미착수 |
| /membership | 소비자 | S7-11 | 미착수 |
| /guests | 소비자 | S7-09 | 미착수 |
| /notifications | 소비자 | S4-13 | 미착수 |
| /me | 소비자 | S3-09 | 미착수 |
| /share/[token] | 소비자 | S7-12 | 미착수 |
| /vendor/apply | 업체 | S2-01 | 완료 |
| /vendor | 업체 | S2-08 | 완료 |
| /vendor/profile | 업체 | S2-02 | 완료 |
| /vendor/products | 업체 | S2-03, S2-04 | 완료 |
| /vendor/inventory | 업체 | S2-05 | 완료 |
| /vendor/pricing | 업체 | S2-06 | 완료 |
| /vendor/inquiries | 업체 | S4-12 | 미착수 |
| /vendor/chat | 업체 | S4-04 | 미착수 |
| /vendor/qna | 업체 | S4-05 | 미착수 |
| /vendor/availability | 업체 | S4-06 | 미착수 |
| /vendor/consultations | 업체 | S4-07, S4-09 | 미착수 |
| /vendor/bookings | 업체 | **S5-10**(신설) | 미착수 |
| /vendor/settlements | 업체 | S5-07 | 미착수 |
| /vendor/compliance | 업체 | S7-13 | 미착수 |
| /vendor/reviews | 업체 | S8-11 | 미착수 |
| /vendor/stats | 업체 | S2-08 | 완료 |
| /vendor/members | 업체 | S2-07 | 완료 |
| /admin | 운영자 | S8-01 | 미착수 |
| /admin/vendors | 운영자 | S2-01 | 완료 |
| /admin/prices | 운영자 | S8-10 | 미착수 |
| /admin/rules | 운영자 | S8-06 | 미착수 |
| /admin/ai-quality | 운영자 | S8-07 | 미착수 |
| /admin/cms | 운영자 | S8-08 | 미착수 |
| /admin/tickets | 운영자 | S8-09 | 미착수 |
| /admin/privacy | 운영자 | S8-04 | 미착수 |
| /admin/flags | 운영자 | S8-12 | 미착수 |
| /admin/audit | 운영자 | S8-02 | 미착수 |
| /admin/commission-rates | 운영자 | S5-03 | 미착수 |
| /admin/consultation-disputes | 운영자 | S4-10 | 미착수 |
| /admin/settlements | 운영자 | S5-07 | 미착수 |
| /admin/disputes | 운영자 | S8-03, S5-08(위약금) | 미착수 |
| /admin/reviews | 운영자 | S8-11 | 미착수 |

> **F-V-14(업체 알림·연동 설정)는 §6에 전용 라우트가 없다.** 명세의 빈칸이며 기능을 뺀 것이 아니다.
> S4-14에서 `/vendor/profile` 내 섹션으로 둘지 `/vendor/settings` 를 신설할지 결정하고,
> 결정 후 §6.3과 이 표에 라우트를 추가한다.

### 신설 태스크 (T-00c)

미배정 8건을 해소하기 위해 만든 태스크다. 기존 태스크에 끼워 넣지 않은 이유를 함께 적는다.

| ID | 단계 | 태스크 | 해소한 미배정 항목 | 신설 이유 |
|---|---|---|---|---|
| S3-10 | 3 | 랜딩·마케팅 진입 | 화면 `/` | F-C-24를 담당하는 S7-10은 **7단계**인데 랜딩은 명세 **3단계**다. 탐색·검색 진입점이라 콘텐츠 허브를 기다릴 수 없다 |
| S3-11 | 3 | 소비자 홈 대시보드 | 화면 `/home` | 여러 기능(F-C-04·05·25)의 요약 화면이라 어느 기능 태스크에도 온전히 속하지 않는다. 소유자가 없으면 끝까지 안 만들어진다 |
| S4-14 | 4 | 업체 알림·연동 설정 | 기능 F-V-14 | S4-13은 **소비자 알림센터**(F-C-21)다. 업체 수신 채널·담당자 배정·영업시간은 별개 화면·별개 권한이다 |
| S5-09 | 5 | 에스크로 예치·릴리즈 | 기능 F-C-16, API `POST /api/escrow/release` | 자체 테이블(`escrow_holds`)과 API가 있는데 담당 태스크가 없었다. **집행 로직은 O-03 대기**이나 절차·기록은 지금 만든다 |
| S5-10 | 5 | 업체 예약·계약 관리 | 기능 F-V-08, API `PATCH /api/vendor/bookings/[id]`, 화면 `/vendor/bookings` | 소비자 측 계약(S5-04·S5-05)과 업체 측 상태 보드는 별개 화면이다. 업체가 승인·거절할 수 없으면 거래가 성립하지 않는다 |

### 표에 없는 것 (의도적)

- **§5 AI 파이프라인**은 기능(F-C-03·06·07·08·30, F-A-03·04·14)에 종속되므로 별도 축을 두지 않았다.
  파이프라인 자체의 진행은 S7-01~S7-06·S8-06·S8-07이 담당한다.
- **§3.10 Storage 버킷 5종**은 테이블이 아니라 인프라다. 생성은 S4-01(`chat-attachments` 포함)이 소유한다.
- **§7 비기능 요구사항**(성능·보안·접근성·CI)은 S8-05·S8-13과 각 태스크의 완료 조건에 녹아 있다.
