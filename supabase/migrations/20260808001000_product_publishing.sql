-- =============================================================================
-- 0010 · 상품 게시 상태·총액 강제 (S2-03)
-- 근거: docs/07_개발명세서.md §2.2 F-V-03, §3.3 products, §3.9, §6.3, D-16
-- =============================================================================
-- 이 파일이 지키려는 것: **총액 표기 강제**(F-V-03, D-16)
--   "총액 표기 강제 — '별도 문의' 가격 등록 불가"
--   T-03 은 `base_price_total NOT NULL` 까지 걸어 뒀다. 여기서 두 겹을 더한다.
--     1) 판매가는 **0 보다 커야 한다**. NOT NULL 만으로는 0원 등록으로 빠져나갈 수 있다.
--     2) **게시 상태에서는 포함 항목이 최소 1개** 있어야 한다. 총액만 있고 무엇이 포함되는지
--        없으면 고객이 비교할 수 없다 — F-V-03 의 "포함 항목 명시 필수" 다.
--
-- **`products` 에 컬럼을 더한 이유** (S2-02 와 같은 기준)
--   §3.3 의 컬럼 목록은 '주요 컬럼' 이라 부가 컬럼 추가가 명세와 충돌하지 않는다.
--   게시 여부는 상품 자체의 상태이고 `products` 는 이미 공개 카탈로그 테이블이므로
--   같은 행에 두는 것이 맞다. 분리하면 탐색 목록(S3-03)이 매번 조인해야 한다.
--   (S2-01 의 `vendor_applications` 는 status 값 집합이 **명세와 어긋나** 분리가
--    불가피했던 경우로 성격이 다르다.)
--
-- 상태 값은 **text + CHECK** 로 둔다. 명세가 `products.status` 의 값 집합을 못박지 않았고,
-- 0001 의 원칙이 "명세가 값을 못박지 않은 status 계열은 text 로 두고 확정 시 제약을 추가"다.
-- =============================================================================

alter table public.products
  add column if not exists status             text not null default 'draft',
  add column if not exists published_at       timestamptz,
  -- §6 공통 UI 규칙: "가격 표시는 항상 총액(**부가세 포함 여부 명시**) 기준" 이다.
  -- 화면 컴포넌트(`PriceDisplay`)가 `taxIncluded` 를 필수 prop 으로 받으므로
  -- 그 값의 출처가 DB 에 있어야 한다. 없으면 화면이 추측하게 되고, 추측한 부가세 표기는
  -- 가격 정찰제에서 가장 하면 안 되는 종류의 오차다.
  add column if not exists price_includes_vat boolean not null default true;

comment on column public.products.price_includes_vat is
  '판매가에 부가세가 포함됐는지. 화면은 이 값을 그대로 표기하며 추측하지 않는다(§6).';

comment on column public.products.status is
  'draft(작성 중) | published(고객 노출) | archived(내림). 게시 조건은 products_publish_requirements_chk 가 강제한다.';
comment on column public.products.published_at is
  '최초 게시 시각. 게시 이력 자체는 entity_events 가 남긴다(D-23).';

alter table public.products
  add constraint products_status_chk
  check (status in ('draft', 'published', 'archived'));

-- 총액 강제 1 — 0원 등록을 막는다. '별도 문의' 를 0원으로 우회할 수 없게 하는 층이다.
alter table public.products
  add constraint products_base_price_positive_chk
  check (base_price_total > 0);

-- included_items_json 은 배열이어야 한다. 아래 게시 조건이 배열 길이를 보기 때문이다.
alter table public.products
  add constraint products_included_items_is_array_chk
  check (jsonb_typeof(included_items_json) = 'array');

-- 총액 강제 2 — 게시하려면 총액과 포함 항목이 모두 있어야 한다.
-- 작성 중(draft)에는 포함 항목이 비어도 저장할 수 있다. 한 번에 다 채우도록 강제하면
-- 업체가 임시 저장을 못 해 오히려 엉터리 값을 넣는다.
alter table public.products
  add constraint products_publish_requirements_chk
  check (
    status <> 'published'
    or (base_price_total > 0 and jsonb_array_length(included_items_json) >= 1)
  );

create index if not exists idx_products_vendor_status
  on public.products (vendor_id, status);

-- -----------------------------------------------------------------------------
-- RLS — 공개 노출 조건에 게시 상태를 더한다 (§3.9)
-- -----------------------------------------------------------------------------
-- 기존 정책은 "active 업체의 상품" 이면 전부 공개였다. 게시 상태가 생겼으므로
-- **published 인 것만** 공개한다. 작성 중인 상품이 고객 화면에 새어 나가면 안 된다.
-- 멤버 열람(products_select_member)은 그대로다 — 자기 업체의 draft 는 봐야 한다.
-- 쓰기 정책(owner 전용, staff 불가)도 그대로 둔다. 가격 테이블이기 때문이다.
drop policy if exists products_select_public on public.products;
create policy products_select_public on public.products
  for select to anon, authenticated
  using (
    status = 'published'
    and exists (
      select 1 from public.vendors v
      where v.id = products.vendor_id and v.status = 'active'
    )
  );

-- =============================================================================
-- 이 파일이 한 것
--   ALTER  products + 3컬럼(status, published_at, price_includes_vat)
--   CHECK  4 — 상태 값 / 총액 > 0 / 포함 항목 배열 / 게시 조건
--   인덱스 1, 정책 교체 1(products_select_public 에 게시 조건 추가)
--   신규 테이블 없음
-- =============================================================================
