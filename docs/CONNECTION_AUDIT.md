# 연결 상태 조사 (B-1 · 2026-09-17)

> **이 파일의 자리** — 조사 지시는 결과를 `tmp/connection-audit.md` 에 적으라고 했고
> 그 파일도 그대로 있다. 다만 `tmp/` 는 **git 제외**라(CLAUDE.md §3.2) 커밋되지 않아
> 다음 사람이 볼 수 없다. 그래서 **같은 내용을 `docs/` 에 둔다** — 원장·명세와 같은
> 자리에 있어야 C 단계를 시작하는 사람이 찾는다.


**목적** — 사용자가 제시한 네 방향(웨딩쇼핑 · 입점업체 · 3자 연동 · 스케줄)에 대해
**무엇이 이미 되고 무엇이 안 되는지** 사실만 확인한다. 추측으로 설계하면 있는 것을 또 만든다.

**방법** — 코드·스키마·마이그레이션·`docs/ROUTES.md`(S0-04 실동작 점검 결과)를 읽었다.
**Docker 가 없어 DB 를 띄우지 못했고 화면을 실제로 열지 못했다.** 그래서 이 문서는
**코드로 확인되는 사실**만 담는다. 코드로 답할 수 없는 것은 §6 에 따로 적었다.

**읽는 법** — 각 절을 셋으로 가른다.

| 표기 | 뜻 |
|---|---|
| ✅ **되는 것** | 지금 동작한다 |
| 🟡 **흩어진 것** | 기능·데이터는 있는데 화면이 나뉘어 있거나 이어지는 버튼이 없다. **모으면 된다** |
| ❌ **없는 것** | 스키마나 코드 자체가 없다. 새로 만들어야 한다 |

---

## 0. 한 장 요약

**가장 중요한 사실 하나** — 거래 사슬이 **정확히 한 칸에서 끊긴다.**

```
문의 → 견적 → [견적 수락] → ???  → 계약 → 서명 → 결제 → 정산
 ✅     ✅        ✅         ❌     ✅     ✅     ✅     ✅
                          bookings 행을
                          만드는 코드가 없다
```

`POST /api/contracts` 는 **이미 있는 `bookingId`** 를 요구하는데, 리포 전체에
`bookings` 에 INSERT 하는 코드가 **하나도 없다**(확인: `app/`·`lib/` 전수 grep).
지금 DB 에 있는 예약은 전부 `scripts/seed-accounts.mjs` 가 서비스롤로 넣은 픽스처다.

`lib/inquiry/actions.ts:565` 의 주석이 그 사실을 적어 두었다 —
*"계약 전환은 5단계다(S5-04·S5-06). 여기서는 상태만 바꾼다."*
그런데 **S5-04·S5-06 은 둘 다 `[x]` 완료**다. 즉 하류는 다 만들어졌고 **다리만 없다.**

그 결과 `/inquiries` 화면이 이렇게 말한다(`InquiriesView.tsx:355`):
> "진행하기로 표시했어요. 계약서 작성과 결제는 **준비 중이에요(S5-04·S5-06)**."

**이 안내문은 낡았다** — 가리키는 두 태스크는 끝났다.

---

## 1. 소비자 탐색 경로

### 1-1. `/explore` 필터가 실제로 거르는 것

`lib/explore/query.ts` · `lib/core/schemas/explore.ts` 확인.

| 필터 | 보는 컬럼 | 방식 | 비고 |
|---|---|---|---|
| `region` | `vendors.region_code` | `ilike %값%` **부분 일치** | 자유 입력 문자열. 코드 체계 없음 |
| `category` | `vendors.category` | 정확히 일치 | 6종 고정 |
| `budgetMin/Max` | `products.base_price_total` | `gte`/`lte` | **판매가 기준**(플래너 수수료 제외 · 화면이 고지) |
| `guestCount` | `products.capacity_min/max` | 범위 포함 | **범위를 안 적은 상품은 거르지 않는다** |
| `date` | `inventory_slots`(상품별) | 슬롯 판정 | 업체 단위로 안 묶는다 — 상품별로 본다 |
| `styleTags` | `vendors.style_tags` | `overlaps` 배열 교집합 | ← **컨셉별의 실체** |
| `onlyAvailable` | 위 슬롯 판정 결과 | 메모리 필터 | 날짜 없이는 켤 수 없다 |

**게시 조건**(항상 적용): `products.status='published'` + `vendors.status='active'`
+ `add_ons_declared_at is not null`.

### 1-2. 컨셉별 — **데이터도 입력 자리도 있다**

| 항목 | 상태 |
|---|---|
| 값 집합 | ✅ `STYLE_TAGS` **8종** — 모던·클래식·내추럴·로맨틱·미니멀·럭셔리·야외·스몰웨딩 |
| 저장 | ✅ `vendors.style_tags text[]` (0017 마이그레이션 · CHECK + GIN 인덱스) |
| 업체 입력 | ✅ `/vendor/profile` 에 체크박스 (`VendorProfileForm.tsx:256`) |
| 커플 취향 | ✅ `couples.style_tags` — 온보딩 5번 문항에서 **같은 어휘**로 받는다 |
| 소비자 필터 | ✅ `/explore` · `/search` 둘 다 |
| 업체 상세 노출 | ✅ 배지로 그린다 |

🟡 **흩어진 것** — **커플 취향과 업체 스타일이 같은 어휘인데 이어져 있지 않다.**
온보딩에서 "로맨틱" 을 고른 커플이 `/explore` 를 열면 필터가 **비어 있다.**
`couples.style_tags` → 탐색 기본 필터로 넣는 코드가 없다(확인: `styleTags` 전수 grep).

❌ **없는 것** — **상품 단위 컨셉.** 태그는 **업체에만** 붙는다. 한 스튜디오가
'로맨틱 패키지'와 '미니멀 패키지'를 함께 팔면 둘을 구분할 자리가 없다.

### 1-3. 정렬 — 4개 열림 · 3개 막힘 (이유를 화면이 적는다)

| 코드 | 상태 | 막힌 이유(코드에 적힌 그대로) |
|---|---|---|
| `price_asc` | ✅ 열림 · **기본값** | — |
| `price_desc` | ✅ 열림 | — |
| `price_index_gap` | ✅ 열림 | 참가격 지수 대비 편차. 지수 없는 곳은 맨 뒤 + '비교 기준 없음' |
| `recent` | ✅ 열림 | — |
| `review_score` | ❌ 막힘 | "후기 데이터가 아직 없습니다" (S8-02) |
| `available_date` | ❌ 막힘 | "재고 캘린더를 등록한 업체가 일부라, 지금 정렬하면 **등록 여부가 순서를 정하게** 됩니다" |
| `response_speed` | ❌ 막힘 | "응답 기록이 쌓인 업체가 아직 일부라, **문의를 받아 본 적이 있는지**가 순서를 정하게 됩니다" |

> 막힌 셋은 **데이터 부족**이 이유이고 코드가 없는 것이 아니다. `reviews`·
> `inventory_slots`·`inquiry_targets.responded_at` 세 표는 전부 실재한다.
> **'추천순' 은 의도적으로 없다**(D-03 — 기준을 말할 수 없는 정렬은 기본값으로 쓰지 않는다).

### 1-4. 상품이 보여주는 정보 — **상품 상세 페이지가 없다**

라우트 전수 확인: `/explore/[vendorId]` 는 있고 **`/explore/[vendorId]/[productId]` 는 없다.**
상품은 업체 상세 안의 **카드 한 장**으로만 존재한다(`VendorProducts.tsx`).

`products` 테이블 전체 컬럼(생성 타입 확인):
`id · vendor_id · category · name · base_price_total · price_includes_vat ·
included_items_json · capacity_min · capacity_max · add_ons_declared_at ·
status · published_at · created_at · updated_at`

| 쇼핑몰 상품 페이지에 있어야 하는 것 | 이 리포 |
|---|---|
| 상품 사진 | ❌ **없다.** `vendor_media` 는 `vendor_id` 만 있고 `product_id` 가 없다 |
| 상품 설명 | ❌ **없다.** `products` 에 본문 컬럼이 없다(`vendors.intro` 만 있다) |
| 가격 | ✅ `base_price_total` + VAT 포함 여부 |
| 포함 항목 | ✅ `included_items_json` |
| 추가금 사전표 | ✅ `product_options` (게시 전 필수) |
| 수용 인원 | ✅ `capacity_min/max` |
| 상품별 후기 | ❌ **없다.** `reviews` 는 `vendor_id` + `booking_id` — **업체 단위** |
| 상품별 컨셉 | ❌ 없다(§1-2) |
| 재고·예약 가능일 | 🟡 있는데 **업체 단위 패널**(`AvailabilityPanel`)에 있다 |
| 찜 | ✅ `wishlists.product_id` — **상품 단위** |
| 장바구니 | ✅ `cart_items.product_id` — **상품 단위** |
| 준비 데드라인 | ❌ 없다(§4-5) |
| Q&A | 🟡 `/qna/[vendorId]` — **업체 단위** 별도 화면 |

**정리** — 찜·장바구니는 상품 단위인데 **보여 주는 화면은 업체 단위**다.
사진·설명·상품 후기가 없어 지금 구조로는 상품 상세를 만들어도 **채울 내용이 부족하다.**

---

## 2. 업체 주문 관리

### 2-1. 한 거래를 따라가려면 — **화면 7개를 오간다**

| 단계 | 업체 화면 | 소비자 화면 |
|---|---|---|
| 문의 수신 | `/vendor/inquiries` | `/inquiries` |
| 견적 발송 | `/vendor/inquiries` (같은 화면) | `/inquiries` → `/estimates` |
| 상담 예약 | `/vendor/consultations` | `/consultations` |
| 예약 승인 | `/vendor/bookings` | `/bookings` |
| 계약 발행 | `/vendor/bookings` | `/bookings/[id]` |
| 결제 | **없다** (회차 결제를 보는 업체 화면 없음) | `/checkout/[bookingId]` |
| 정산 | `/vendor/settlements` | — |
| 해지·환불 | `/vendor/cancellations` | `/bookings/[id]/cancel` |
| 안전거래 | `/vendor/escrow` | `/bookings/[id]/escrow` |
| 후기 응답 | `/vendor/reviews` | `/reviews/new/[bookingId]` |

### 2-2. 한 거래를 한눈에 보는 화면 — **소비자는 있고 업체는 없다**

| 면 | 거래 상세 화면 | 확인 |
|---|---|---|
| 소비자 | ✅ **있다** — `/bookings/[id]` | S5-10 이 만든 **다섯 기능의 진입점**(D-153): 계약·결제·해지·안전거래·후기. 못 가는 곳은 **왜 못 가는지**를 적는다(`entryPoints`) |
| 업체 | ❌ **없다** — `/vendor/bookings/[id]` 라우트가 없다 | `/vendor/bookings` 는 **목록**이며 네 갈래로 나눈다(승인 대기·계약 발행 대기 등) |
| 운영자 | ❌ **없다** | §3-3 |

🟡 **가장 먼저 모을 자리** — 소비자 쪽 `entryPoints` 패턴이 **이미 검증된 채로 존재한다.**
업체판을 만드는 일은 새 설계가 아니라 **같은 패턴을 한 번 더 쓰는 일**이다.

> ⚠ **죽은 링크 하나** — 소비자 예약 상세와 `/vendor/bookings` 둘 다
> `/contracts/[계약id]` 로 링크하는데 **그 화면이 없다.**
> 이미 **FIX-57**(기록 · 미해소)로 원장에 적혀 있다. `docs/ROUTES.md:807` 이 같은 것을 센다.

### 2-3. 상품 등록 — **3단계 · 입력 6칸 · 복사 기능 없음**

| 단계 | 화면 | 입력 |
|---|---|---|
| 1 | `/vendor/products/new` | **6칸** — 상품명 · 카테고리 · 총액 · 수용인원(최소) · 수용인원(최대) · 포함 항목 |
| 2 | `/vendor/products/[id]` | 추가금(`product_options`) 등록 → **사전등록 확정**(`add_ons_declared_at`) |
| 3 | `/vendor/products/[id]` | 게시 — `publishBlockersOf` 통과해야 한다 |

| 편의 기능 | 상태 |
|---|---|
| 복사·복제 | ❌ 없다 (`ProductForm.tsx` 에 관련 코드 0건) |
| 템플릿 불러오기 | ❌ 없다 |
| `vendor_templates` 표 | 🟡 **있는데 상품용이 아니다** — `kind` 는 `quick_reply`(채팅) · `quote`(견적) 둘뿐 |
| 이미지 업로드 | ❌ 상품용 없음 (`vendor_media` 는 업체 단위) |
| 일괄 등록 | ❌ 없다 (`/api/vendor/inventory/bulk` 는 **재고 슬롯** 일괄이지 상품이 아니다) |

🟡 **흩어진 것** — 템플릿 표(`vendor_templates`)와 설정 화면(`/vendor/settings`)이
**이미 있다.** `kind` 에 `product` 를 더하는 구조가 이미 서 있다.

---

## 3. 3자 연동

### 3-1. 도메인별 세 면 대조

| 도메인 | 소비자 | 업체 | 운영자 |
|---|---|---|---|
| **문의** | `/inquiries` — 보낸 문의, 업체별 상태 | `/vendor/inquiries` — 받은 문의, SLA 기한 | ❌ **화면 없음** (대시보드 **건수**만) |
| **견적** | `/inquiries`(수락·보류) · `/estimates`(비교) | `/vendor/inquiries` 에서 작성·발송 | ❌ **화면 없음** |
| **상담 예약** | `/consultations` | `/vendor/consultations` | 🟡 `/admin/disputes?source=consultation` — **분쟁만** |
| **계약** | `/bookings/[id]` → `/contracts/[id]` **(죽은 링크)** | `/vendor/bookings` → 같은 죽은 링크 | ❌ **화면 없음** |
| **결제** | `/checkout/[bookingId]` | ❌ **화면 없음** | ❌ 없음 (`/admin/settlements` 는 정산) |
| **정산** | — | `/vendor/settlements` | ✅ `/admin/settlements` · `/admin/commission-rates` |
| **일정** | `/checklist` (+ 표현 4종) | `/vendor/availability` · `/vendor/inventory` | ❌ **화면 없음** |
| **분쟁·위약** | `/bookings/[id]/cancel` | `/vendor/cancellations` | ✅ `/admin/disputes` · `/admin/penalties` |

### 3-2. 한쪽이 바꾸면 반대쪽에 반영되는가 — **전부 새로고침**

| 항목 | 확인 결과 |
|---|---|
| Realtime | ❌ **어디에도 없다.** `.channel(` · `postgres_changes` 전수 grep **0건** |
| DB publication | ❌ `supabase_realtime` 에 표를 넣는 마이그레이션이 없다. **O-11 미결**로 주석에 남아 있다(0021:848) |
| 실제 방식 | `router.refresh()` 또는 다음 방문 시 재조회 |
| 채팅 | 🟡 **유일한 예외** — `useRoomSignal` 이 있고 화면이 `"polling"` 상태를 **사용자에게 적는다** |
| 장바구니 | 🟡 `COUPLE_SYNC_NOTICE` 로 **"배우자 변경이 즉시 반영되지 않는다"** 를 화면이 고지 |
| 알림 | ✅ `notifications` 표 + 이메일. 단 §4-6 참조 |

> **거짓말은 하지 않는다** — 안 되는 동기화를 화면이 스스로 적고 있다. 좋은 상태다.
> 다만 3자 연동을 "실시간" 으로 만들려면 **O-11 결론이 선행**이다.

### 3-3. 운영자가 거래 하나를 통으로 보는 화면 — **없다**

운영자 화면 19개 전수 확인. 거래 관련은 **사후 처리 화면**뿐이다:
`/admin/settlements` · `/admin/penalties` · `/admin/disputes` · `/admin/commission-rates`.

운영자가 문의·견적·상담·계약을 보는 유일한 경로는 **`/admin` 대시보드의 집계 숫자**다
(`lib/admin/metrics.ts` — `inquiries` · `consultations` · `bookings` · `contracts` · `gmvAmount`).
**행 단위로 여는 화면이 없다.**

❌ **없는 것** — 운영자용 거래 상세(`/admin/bookings/[id]` 같은 것).
사용자가 말한 *"운영자는 비공개 내부관리용"* 이 성립하려면 이 화면이 필요하다.

### 3-4. 세 면이 같은 사건을 다른 이름으로 부르는가

| 사건 | 어휘 | 판정 |
|---|---|---|
| 예약 상태 | `bookings.status` — `hold` · `confirmed` · `cancelled` · `fulfilled` | ✅ 한 벌 |
| 업체 승인 | **상태가 아니라 짝 컬럼** — `accepted_at`/`declined_at` (D-151) | ✅ 의도적 분리. `confirmed` 는 **계약 확정**이라 승인을 같은 칸에 적으면 서명 없는 계약이 확정으로 읽힌다 |
| 문의 대상 상태 | `inquiry_targets.status` — `pending`·`declined`… | ✅ `pending`(아직 답 없음)과 `declined`(받지 않음)를 **뭉치지 않는다** |
| 견적 상태 | `quotes.status` — `sent`·`accepted`·`declined`·`expired` | ✅ 한 벌 |
| 상담 결과 | `consultation_outcome` — `fulfilled`·`no_show_couple`·`no_show_vendor`·`undetermined` | ⚠ **'계약으로 이어짐' 이 없다.** 상담이 거래로 전환됐는지 기록할 자리가 없다 |
| 분쟁 상태 | 도메인마다 **다르게 유지** | ✅ 의도적(D-121 — 수렴시키면 한쪽 기본값이 뒤집힌다) |

**어휘 충돌은 찾지 못했다.** 오히려 구분이 필요한 곳을 일부러 나눠 두었다.

### 3-5. 한 면에만 있고 다른 면에 없는 정보

| 정보 | 있는 면 | 없는 면 |
|---|---|---|
| 회차별 결제 내역 | 소비자(`/checkout`) · 운영자(집계) | ❌ **업체** — 정산 합계로만 본다 |
| 견적 만료 시각(`valid_until`) | 소비자·업체 | ❌ 운영자 |
| SLA 응답 기한 | 업체(`/vendor/inquiries`) | ❌ 소비자 — "언제까지 답이 오는지" 를 못 본다 |
| 상담 확정 양측 시각 | `consultations.couple_confirmed_at`/`vendor_confirmed_at` **둘 다 있다** | ✅ 대칭 |
| 계약 정본·서명 | 소비자·업체 **둘 다 링크가 죽어 있다**(FIX-57) | ❌ 운영자 |

---

## 4. 스케줄과 정보 연결

### 4-1. 템플릿 19종 전수 (`lib/core/schedule/templates.ts`)

판본 `2026-08-16-a` · 카테고리 6종(`hall`·`sdm`·`yedan`·`honsu`·`document`·`honeymoon`).
오프셋은 **예식일 기준 음수 일수**다.

| # | 코드 | 이름 | 기준 시점 | 카테고리 | 선행 |
|---|---|---|---|---|---|
| 1 | `T-hall-tour` | 웨딩홀 투어·상담 | D-330 | 웨딩홀 | — |
| 2 | `T-hall-contract` | 웨딩홀 계약 | D-300 | 웨딩홀 | `T-hall-tour` |
| 3 | `T-sdm-contract` | 스드메 계약 | D-270 | 스드메 | `T-hall-contract` |
| 4 | `T-honsu-home` | 신혼집 계약 | D-210 | 혼수 | — |
| 5 | `T-yedan-talk` | 양가 예단 범위 상의 | D-180 | 예단·예물 | — |
| 6 | `T-sdm-studio` | 스튜디오 촬영 | D-150 | 스드메 | `T-sdm-contract` |
| 7 | `T-honeymoon-plan` | 허니문 일정·예산 정하기 | D-150 | 허니문 | `T-hall-contract` |
| 8 | `T-hall-guest-count` | 예상 하객 수 정리 | D-120 | 웨딩홀 | `T-hall-contract` |
| 9 | `T-sdm-dress-fitting` | 드레스 가봉 | D-120 | 스드메 | `T-sdm-contract` |
| 10 | `T-honeymoon-booking` | 항공·숙소 예약 | D-120 | 허니문 | `T-honeymoon-plan` |
| 11 | `T-sdm-album` | 앨범 사진 고르기 | D-90 | 스드메 | `T-sdm-studio` |
| 12 | `T-yedan-prepare` | 예단·예물 준비 | D-90 | 예단·예물 | `T-yedan-talk` |
| 13 | `T-hall-meal` | 식사·연회 메뉴 확정 | D-60 | 웨딩홀 | `T-hall-guest-count` |
| 14 | `T-honsu-furniture` | 가전·가구 준비 | D-60 | 혼수 | `T-honsu-home` |
| 15 | `T-doc-invitation` | 청첩장 주문 | D-60 | 서류 | `T-hall-contract` |
| 16 | `T-honeymoon-doc` | 여권·비자 확인 | D-60 | 허니문 | `T-honeymoon-plan` |
| 17 | `T-doc-invitation-send` | 청첩장 전달 | D-30 | 서류 | `T-doc-invitation`, `T-hall-guest-count` |
| 18 | `T-hall-rehearsal` | 예식 진행 순서 확정 | D-21 | 웨딩홀 | `T-hall-contract` |
| 19 | `T-doc-marriage` | 혼인신고 서류 확인 | D-14 | 서류 | — |

카테고리별: 웨딩홀 5 · 스드메 4 · 허니문 3 · 서류 3 · 예단 2 · 혼수 2 = **19** ✅

### 4-2. 요청한 준비 항목이 들어 있는가

| 항목 | 상태 | 어디에 |
|---|---|---|
| 청첩장 제작 | ✅ | `T-doc-invitation` (D-60) |
| 청첩장 발송 | ✅ | `T-doc-invitation-send` (D-30) |
| 신혼여행 | ✅ | `T-honeymoon-plan`·`booking`·`doc` 3종 |
| 혼수 | ✅ | `T-honsu-home`·`T-honsu-furniture` |
| 예단 | ✅ | `T-yedan-talk`·`T-yedan-prepare` |
| 신혼집 | ✅ | `T-honsu-home` (D-210) |
| 혼인신고 | 🟡 **서류 확인만** | `T-doc-marriage`(D-14). **예식 후 실제 신고 제출 태스크가 없다** — 모든 오프셋이 음수(예식 전)다 |
| **답례품** | ❌ **없다** | — |
| **상견례** | ❌ **없다** | — |
| **예복·한복** | ❌ **없다** | 스드메에 드레스 가봉만 있다 |
| **축의금 정산** | ❌ **없다** | 예식 후 항목 자체가 없다 |

> **구조적 제약 둘.**
> ① `TASK_CATEGORIES` 6종에 답례·상견례·축의금이 들어갈 칸이 없다.
> ② **오프셋이 전부 음수**다 — 예식 **후** 항목(축의금 정산·혼인신고 제출·답례)을
> 표현하려면 양수 오프셋을 허용해야 한다. `templateDefects` 의 `offset_inversion`
> 검사는 양수도 받으므로 **코드 변경 없이 가능**하다.

### 4-3. 체크리스트에서 상품·가이드·커뮤니티로 가는 링크 — **없다**

`app/(consumer)/checklist/` 전체에서 `href` 는 **2개**뿐이다:
`/onboarding` 하나, 그리고 `ScheduleViews.tsx:233` 의 **`href={null}`**(의도적 — 이미 그 화면).

태스크 카드에서 나가는 링크가 **0개**다.

### 4-4. `tasks` 에 정보를 연결할 컬럼이 있는가 — **없다**

`tasks`: `id · couple_id · title · category · status · due_date · assignee_id ·
source · template_code · completed_out_of_order · created_at · updated_at`

`task_templates`: `code · category · title · description · offset_days · default_owner`

❌ `product_id` · `vendor_id` · `content_slug` · `community_tag` 같은 연결 컬럼이 **하나도 없다.**

### 4-5. 상품·가이드에 "언제 준비하는 것" 정보가 있는가

| 대상 | 상태 |
|---|---|
| `products` | ❌ **없다.** 컬럼 14개 중 시점 관련은 `created_at`·`published_at`(등록 시각)뿐 |
| `products` 데드라인 | ❌ **없다** — 사용자가 말한 "최종 데드라인" 컬럼이 없다 |
| `content_posts` | ❌ 준비 단계 컬럼 없음. `type` 은 `guide`·`price_report`·`glossary` **3종** |
| 가이드 → 도구 | ✅ **있다** — `seo_json.tools` + `TOOL_CTAS` 7종(penalty·explore·search·reports·estimates·budget·checklist) |
| 가이드 → 상품 | 🟡 `/explore` **전체**로만 간다. 특정 상품·카테고리로 가지 않는다 |
| 체크리스트 → 가이드 | ❌ 없다(§4-3) |

### 4-6. `dday-notifications` 배치가 실제로 하는 일

`lib/notify/dday.ts` 전문 확인.

| 질문 | 답 |
|---|---|
| 무엇을 판정하나 | `couples.wedding_date` 하나. **`tasks` 를 아예 읽지 않는다** |
| 언제 보내나 | `DDAY_MILESTONES = [100, 60, 30, 14, 7, 3, 1, 0]` — **8회** |
| 누구에게 | `couple_members` 중 `owner`·`partner` |
| 채널 | 앱 알림함 + 이메일 **둘 다** |
| 본문 | `"예식일까지 {days}일 남았어요."` — **그게 전부** |
| payload | `{ days, coupleId }` — 참조와 숫자만(§7.3 — 개인 식별값 금지) |
| 이동 링크 | ❌ **없다.** `notifications` 표에 링크 컬럼이 없고, `/notifications` 화면의 `router` 는 `refresh()` 에만 쓴다 |
| **태스크 기한 알림** | ❌ **나가지 않는다.** 배치가 `tasks.due_date` 를 보지 않는다 |
| **상품 데드라인 알림** | ❌ 없다 |

알림 템플릿은 **29종**이 있고 그중 상품 관련은 `price_change.drop`(찜한 상품 가격 인하) 하나다.

### 4-7. `/guides` 현황

| 질문 | 답 |
|---|---|
| 글 수 | **시드 2건**(발행 1 + 초안 1). 발행된 것은 `hall-contract-checklist` 하나 |
| 준비 단계 컬럼 | ❌ 없다 |
| 카테고리 어휘 | `content_post_type` = `guide`·`price_report`·`glossary` |
| 체크리스트와 같은가 | ❌ **완전히 다르다.** 체크리스트는 `hall`·`sdm`·`yedan`·`honsu`·`document`·`honeymoon` |

### 4-8. ⚠ 카테고리 어휘가 **세 벌**이다

| 어휘 | 값 | 쓰는 곳 |
|---|---|---|
| `VENDOR_CATEGORIES` (6) | hall · studio · dress · makeup · video · agency | 업체·상품·탐색 필터 |
| `TASK_CATEGORIES` (6) | hall · sdm · yedan · honsu · document · honeymoon | 체크리스트 |
| `content_post_type` (3) | guide · price_report · glossary | 가이드 |

**겹치는 것은 `hall` 하나뿐이다.** 체크리스트가 "예단·혼수·서류·허니문" 을 말하는데
**마켓플레이스는 그 어느 것도 팔 수 없다** — 업체 카테고리에 없기 때문이다.
사용자가 말한 *"스드메 외 준비항목 전부가 관련 상품으로 이어져야 한다"* 는
**어휘를 잇는 일부터** 시작해야 한다.

---

## 5. 화면 간 이동

### 5-1. 작업을 끝낸 뒤 다음으로 이어지는가

각 화면에서 나가는 `href` 를 전수로 뽑았다.

| 끝낸 작업 | 다음으로 가는 버튼 | 판정 |
|---|---|---|
| 업체를 찾았다 → 문의 | ✅ 업체 상세에 문의·상담·대화 진입점 | 됨 |
| 문의 보냄 → 견적 확인 | ✅ `/inquiries` → `/estimates` | 됨 |
| **견적 비교 끝 → 계약** | ❌ **`/estimates` 의 나가는 링크는 `/onboarding` 하나** | **끊김** |
| **견적 수락 → 예약** | ❌ 상태만 바뀐다. 안내문은 "준비 중"(낡음) | **끊김** |
| **장바구니 → 문의·예약** | ❌ 나가는 링크는 `/explore`·`/wishlist`·`/planners/scopes` | **끊김** |
| **상담 완료 → 계약** | ❌ `/consultations` 의 나가는 링크는 `/explore` 하나. `consultation_outcome` 에 '계약 전환' 값도 없다 | **끊김** |
| 예약 있음 → 계약·결제·해지·후기 | ✅ `/bookings/[id]` 가 다섯을 잇고 **못 가는 이유까지 적는다** | **됨(모범)** |
| 계약 → 계약서 보기 | ❌ `/contracts/[id]` 화면 없음(FIX-57) | **끊김** |
| 가이드 읽음 → 도구 | ✅ `TOOL_CTAS` | 됨 |
| **체크리스트 → 상품·가이드** | ❌ 링크 0개 | **끊김** |
| **알림 → 해당 화면** | ❌ 링크 컬럼 없음 | **끊김** |

### 5-2. "지금 뭘 해야 하는지" 알 수 있는가 — **부분적으로 된다**

| 장치 | 상태 |
|---|---|
| 홈 D-day | ✅ `dDayState` — 남은 일수 |
| 홈 '다음 할 일' | ✅ `home-next-tasks` 섹션 + `NextTaskList` |
| 체크리스트 '다음 할 일' 뷰 | ✅ **홈과 같은 컴포넌트·같은 규칙** — 두 화면이 같은 3건을 말한다 |
| 선행 관계 | ✅ `task_dependencies` + 순환 방지 트리거. "이걸 먼저 해야 저게 됩니다" |
| 준비 순서 표현 4종 | ✅ 역산 타임라인 · 진행 게이지 · 다음 할 일 · 의존 관계 |
| 태스크 자동 생성 | ✅ `/checklist` 의 버튼 → `POST /api/tasks {action:"generate"}` |
| **거기서 행동으로** | ❌ **못 간다.** 태스크 카드에 링크가 없다(§4-3) |

> **"무엇을 할지" 는 말해 주는데 "어디서 할지" 를 안 알려 준다.**
> 예: "청첩장 주문(D-60)" 이 떠도 **청첩장 업체가 카테고리에 없어** 갈 곳이 없다(§4-8).

---

## 6. 확인하지 못한 것 (Docker 없음)

**이 머신에 Docker/Podman 이 없어** 로컬 Supabase 스택이 서지 않는다.
따라서 아래는 **코드로만 추론했고 화면으로 확인하지 못했다.**

| 못 한 것 | 왜 | 영향 |
|---|---|---|
| seed 계정으로 실제 화면 열기 | DB 없음 | 화면의 **실제 렌더 결과**(빈 상태·오류 상태)를 못 봤다 |
| `npm run audit:screens` (970건) | 서버+DB+로그인 필요 | 화면별 실제 판정 |
| `npm run audit:api` (1,310건) | 같음 | API 실제 응답 |
| DB 실제 행 수 | DB 없음 | `/guides` 글 수는 **시드 기준**이며 운영 DB 는 다를 수 있다 |
| 알림 실제 발송 본문 | 배치 실행 불가 | 템플릿 코드로만 확인 |
| 필터 조합의 실제 결과 건수 | DB 없음 | 필터가 **무엇을 보는지**는 코드로 확정, **몇 건 나오는지**는 미확인 |

**코드로 확정한 것**(위 제약과 무관): 스키마 컬럼 · 라우트 존재 여부 · `href` 목록 ·
필터가 읽는 컬럼 · 템플릿 19종 · 배치 로직 · 어휘 집합.

---

## 7. 종합 — 세 바구니

### 🟡 되긴 하는데 흩어진 것 (가장 먼저 손댈 자리)

| # | 무엇 | 지금 상태 | 모으는 일 |
|---|---|---|---|
| 1 | **견적 수락 → 예약 생성** | 양끝이 다 있다. `quotes.status='accepted'` 와 `contracts.quote_id` 가 서로를 기다린다 | `bookings` INSERT 경로 하나 |
| 2 | **업체 거래 상세** | 소비자판(`entryPoints`)이 검증된 채로 있다 | 같은 패턴 재사용 |
| 3 | **커플 취향 → 탐색 기본 필터** | `couples.style_tags` 와 `vendors.style_tags` 가 **같은 어휘** | 온보딩 값을 필터 기본값으로 |
| 4 | **알림 → 화면 이동** | `payload_json` 에 참조 ID 가 이미 들어 있다 | 템플릿별 링크 규칙 |
| 5 | **상품 등록 템플릿** | `vendor_templates` 표와 설정 화면이 있다 | `kind` 에 `product` 추가 |
| 6 | **계약서 화면**(FIX-57) | `contracts` 데이터·서명·API 다 있다 | `/contracts/[id]` 화면 하나 |
| 7 | **상품 상세 페이지** | 찜·장바구니·추가금이 이미 상품 단위 | 라우트 + 사진·설명 컬럼 |
| 8 | **가이드 → 상품** | `TOOL_CTAS` 구조가 있다 | 카테고리·상품 지정 CTA |

### ❌ 아예 없는 것 (새로 만들어야 함)

| # | 무엇 | 필요한 것 |
|---|---|---|
| 1 | **운영자 거래 상세** | 화면 + 조회 계층 |
| 2 | **상품 사진·설명** | `products` 컬럼 + `vendor_media.product_id` |
| 3 | **상품 단위 컨셉 태그** | `products.style_tags` |
| 4 | **상품 단위 후기** | `reviews.product_id` |
| 5 | **상품 최종 데드라인** | §8 |
| 6 | **태스크 ↔ 상품·가이드 연결** | `tasks`/`task_templates` 연결 컬럼 |
| 7 | **태스크 기한 알림** | 배치 로직(현재 `tasks` 를 읽지 않는다) |
| 8 | **준비 항목 4종** | 답례품 · 상견례 · 예복/한복 · 축의금 정산 |
| 9 | **예식 후 태스크** | 양수 오프셋 |
| 10 | **비스드메 업체 카테고리** | 청첩장·답례품·여행·한복·가구… |
| 11 | **업체 결제 내역 화면** | 회차 단위 |
| 12 | **가이드 콘텐츠** | 발행 1건뿐 |
| 13 | **실시간 동기화** | O-11 결론 선행 |

---

## 8. 상품 데드라인 알림 — 필요한 스키마 변경

사용자 요구: *업체가 상품 등록 시 최종 데드라인 입력 → 그날로부터 40일/35일 전부터
일정 간격으로 발송.*

**지금 있는 것** — `products` 에 시점 컬럼 없음. 배치는 예식일만 본다. 알림에 링크 없음.

**필요한 것**(제안 · 이번 조사에서 만들지 않았다):

| 대상 | 변경 | 왜 |
|---|---|---|
| `products` | `lead_time_days int` — "예식 **며칠 전**까지 주문해야 하는가" | **절대 날짜가 아니라 상대 일수**여야 한다. 상품은 여러 커플이 사고 커플마다 예식일이 다르다 |
| `products` | `lead_time_note text` | "제작 3주 + 배송 1주" 같은 근거. 숫자만 있으면 업체가 왜 그 값인지 못 적는다 |
| `task_templates` | `vendor_category text` | 태스크 ↔ 상품 카테고리 다리 |
| `tasks` | (선택) `related_product_id` | 이미 고른 상품이 있으면 그것을 가리킨다 |
| 배치 | `tasks.due_date` 를 읽는 분기 | **지금은 `tasks` 를 아예 안 읽는다** |
| `notifications` | 링크는 **컬럼 대신 템플릿 규칙**을 권한다 | `payload_json` 에 참조 ID 가 이미 있다. 컬럼을 더하면 같은 사실이 두 곳에 산다 |

> **40일/35일 전이라는 숫자를 코드에 박지 않기를 권한다.** 상품마다 리드타임이 다르고
> (청첩장 4주 · 한복 8주), 간격은 운영 파라미터다. `app_settings` 에 두면
> **값이 없을 때 발송하지 않는다**는 이 리포의 기존 규칙과 맞는다.

> **`lead_time_days` 를 쓰면 기존 장치가 바로 붙는다** — `SCHEDULE_TEMPLATES` 의
> `offsetDays` 와 **같은 단위**이고, `task_dependencies` 가 이미 선행을 계산한다.

---

## 9. C 단계 규모 추정

코드로 확인한 범위에 기반한 **추정치**다. 화면을 못 열었으므로 오차가 있다.

| 단계 | 내용 | 새 화면 | 마이그레이션 | 규모 | 선행 |
|---|---|---|---|---|---|
| **C-1** | **거래 사슬 잇기** — 견적 수락 → 예약 생성 · `/contracts/[id]`(FIX-57) · 업체 거래 상세 · 낡은 안내문 정리 | 2 | 0~1 (`bookings` 쓰기 정책) | **중** — 새 도메인이 없다. 있는 조각을 잇는다 | 없음. **가장 먼저** |
| **C-2** | **웨딩쇼핑 고도화** — 상품 상세 · 사진·설명 · 상품 컨셉 태그 · 상품 후기 · 취향→필터 | 1~2 | 2~3 | **대** — 사진 업로드·스토리지 정책이 붙는다 | C-1(후기는 예약 필요) |
| **C-3** | **업체 편의** — 상품 템플릿·복제 · 결제 내역 화면 · 등록 단계 축소 | 1 | 1 (`vendor_templates.kind`) | **소~중** — 표가 이미 있다 | C-1 |
| **C-4** | **스케줄 ↔ 정보 연결** — 준비 항목 4종 추가 · 예식 후 태스크 · 태스크↔상품·가이드 · 태스크 기한 알림 · `lead_time_days` · 카테고리 어휘 정리 | 0~1 | 3~4 | **대** — **어휘 통합이 가장 크다**(§4-8) | C-2(상품 쪽 연결 대상) |

**권하는 순서: C-1 → C-3 → C-2 → C-4.**
근거 — C-1 은 **다른 전부의 전제**다(예약 없이는 후기도 정산도 성립하지 않는다).
C-3 은 표가 이미 있어 싸다. C-4 는 어휘 통합이 들어가 **가장 넓게 번진다.**

### 운영자 면은 어디에

사용자가 말한 *"운영자는 비공개 내부관리용"* 은 **C-1 에 함께 두기를 권한다** —
거래 상세를 소비자·업체용으로 만들 때 **같은 조회 계층을 쓰면 세 번째가 싸다.**
따로 하면 조회가 세 벌이 되고, 그 셋이 갈리는 날 어느 쪽이 맞는지 답할 수 없다.
