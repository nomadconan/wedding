-- =============================================================================
-- 0011 · 추가금 사전 등록 (S2-04)
-- 근거: docs/07_개발명세서.md §2.2 F-V-04, §3.3 product_options, §6 공통 UI 규칙, D-16
-- =============================================================================
-- F-V-04: "발생 가능한 **모든** 추가금을 사전 항목화. **사전 미등록 항목은 사후 청구 불가**"
--
-- 이 규칙이 성립하려면 **"추가금이 없다"와 "아직 안 적었다"를 구분**해야 한다.
-- 둘을 같은 상태(추가금 0건)로 두면, 안 적은 업체가 나중에 "없다고 한 적 없다"고
-- 주장할 수 있고 고객은 미등록 상태의 상품을 정상 상품으로 오인한다.
-- (같은 이유로 화면의 `PriceDisplay` 도 `none` 과 `unknown` 을 다르게 그린다.)
--
-- 그래서 **선언 시각**을 둔다.
--   `products.add_ons_declared_at`
--     null      = 아직 정리하지 않았다(미등록)
--     not null  = 이 시점 기준으로 **발생 가능한 추가금을 전부 적었다**고 업체가 확정했다
--                 (0건으로 확정하면 '추가금 없음'이라는 확정 진술이 된다)
--
-- 컬럼을 `products` 에 더한 근거는 S2-02·S2-03 과 같다 — §3.3 의 목록은 '주요 컬럼'이고,
-- 선언 여부는 상품 자체의 상태이며 `products` 는 이미 공개 카탈로그 테이블이다.
-- =============================================================================

alter table public.products
  add column if not exists add_ons_declared_at timestamptz;

comment on column public.products.add_ons_declared_at is
  '추가금 사전 등록 확정 시각(F-V-04). null 이면 미등록 — 0건 확정과 구분한다. 확정 이후에 바뀐 항목이 있으면(updated_at > 이 값) 재확정 대상이며, 게시 시점에 API 가 막는다.';

-- 게시 조건에 추가금 확정을 더한다.
-- 사전 미등록 항목을 사후 청구할 수 없는 정책이므로, **미확정 상품이 고객에게 보이면 안 된다.**
-- 고객이 본 총액이 나중에 늘어날 수 있다는 뜻이 되기 때문이다.
alter table public.products
  drop constraint if exists products_publish_requirements_chk;

alter table public.products
  add constraint products_publish_requirements_chk
  check (
    status <> 'published'
    or (
      base_price_total > 0
      and jsonb_array_length(included_items_json) >= 1
      and add_ons_declared_at is not null
    )
  );

-- -----------------------------------------------------------------------------
-- product_options 제약 (§3.3)
-- -----------------------------------------------------------------------------
-- 이름 없는 추가금은 사전 등록의 의미가 없다. 고객이 무엇에 대한 돈인지 알 수 없다.
alter table public.product_options
  add constraint product_options_name_not_blank_chk
  check (length(btrim(name)) > 0);

alter table public.product_options
  add constraint product_options_trigger_is_object_chk
  check (jsonb_typeof(trigger_condition) = 'object');

-- **조건부 추가금은 발생 조건을 적어야 한다.**
-- '필수(is_mandatory)'는 항상 발생하므로 조건이 필요 없지만, 조건부인데 조건이 없으면
-- 고객은 언제 그 돈을 내는지 알 수 없고 그 상태로는 '사전 등록됐다'고 할 수 없다.
alter table public.product_options
  add constraint product_options_condition_required_chk
  check (
    is_mandatory
    or (
      trigger_condition ? 'description'
      and length(btrim(trigger_condition ->> 'description')) > 0
    )
  );

-- 조회 경로: 상품 상세가 항목을 금액순으로 읽는다. (product_id 단독 인덱스는 T-03 에 있다)
create index if not exists idx_product_options_product_price
  on public.product_options (product_id, price desc);

-- =============================================================================
-- RLS 는 손대지 않는다 (§3.9)
--   T-03 의 정책 그대로다 — 조회는 상품이 보이면 함께 보이고(상품 RLS 가 published+active
--   업체로 이미 좁혀 준다), 쓰기는 owner 전용이다. 추가금은 가격 정보이므로 staff 불가.
-- =============================================================================

-- =============================================================================
-- 이 파일이 한 것
--   ALTER  products + 1컬럼(add_ons_declared_at), 게시 조건 CHECK 교체
--   CHECK  product_options 3 — 이름 공백 / trigger_condition 객체 / 조건부는 조건 필수
--   인덱스 1, 신규 테이블·정책 없음
-- =============================================================================
