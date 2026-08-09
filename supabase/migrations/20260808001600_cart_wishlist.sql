-- =============================================================================
-- 0016 · 장바구니 · 찜 (S3-04 — 마이그레이션 2차)
-- 근거: docs/07_개발명세서.md §2.1 F-C-25·F-C-26·F-C-31, §3.4 carts·cart_items·
--       wishlists, §3.9(장바구니·찜 행), D-16·D-17·D-19
-- =============================================================================
-- **화면·API 는 이번 범위가 아니다**(S3-05 장바구니 · S3-06 찜). 여기서는 스키마와
-- RLS 까지만 만든다.
--
-- 이 파일이 정한 것 — 판단이 필요했던 지점과 근거
--
--  1. **장바구니는 커플당 '활성' 하나다.** 행 자체는 여러 개일 수 있다.
--     §3.4 는 "커플당 활성 장바구니 1건" 이라고 쓴다. '1건' 이 아니라 '활성 1건' 이므로
--     `status` 는 장바구니의 **생애**를 구분하는 값이다. 계약으로 넘어간 장바구니를
--     지워 버리면 "무엇을 비교하다 무엇을 골랐는가" 라는 증적이 사라진다.
--
--  2. **장바구니에는 가격을 박지 않는다. 찜에는 박는다.**
--     장바구니 총액은 **고객이 지금 낼 금액**이어야 한다. 스냅샷을 표시값으로 쓰면
--     "장바구니에선 300만원이었는데 결제하려니 320만원" 이 되고, 그것은 투명 가격
--     (D-03)의 정면 위반이다. 그래서 합계는 항상 `products.base_price_total` 현재가로
--     계산한다.
--     반대로 찜은 **가격 변동을 알리는 것 자체가 기능**(F-C-26)이라 담은 시점 가격이
--     반드시 필요하다. 즉 두 테이블의 스냅샷은 목적이 다르다 — 찜의 스냅샷은
--     '비교 기준점', 장바구니의 스냅샷은 '표시 금액' 이 되어 버린다.
--     금액이 고정되는 지점은 계약이다 — `bookings.total_amount` 와 요율 스냅샷(§3.4 NOTE).
--     다만 장바구니에도 `price_at_add` 를 **기준점으로만** 둔다(아래 컬럼 주석 참조).
--
--  3. **요율은 장바구니에 저장하지 않는다.** `cart_items.planner_selected` 는 이 항목에
--     플래너를 쓸지 여부(F-C-31)일 뿐이고, 수수료율은 매번 `commission_rates` ·
--     `planner_fee_rates` 에서 조회해 계산한다. §3.7 의 `planner_scopes` 도 같은 문장을
--     달고 있다 — "요율을 여기 저장하지 않는다". 요율이 박히는 순간은 계약 확정이며
--     그때 `bookings.applied_fee_rate_bp` · `applied_planner_fee_rate_bp` 로 간다(D-16·D-17).
--     장바구니에 요율을 박으면 진실이 둘이 되고, 요율이 바뀌었을 때 결제 직전 금액이 튄다.
--
--  4. **같은 상품이라도 옵션이 다르면 다른 항목이다.** 옵션까지 같으면 같은 항목이므로
--     중복을 막는다. 겹침이 아니라 **한 점**의 중복이므로 EXCLUDE 가 아니라 UNIQUE 다
--     (S2-05 에서 세운 기준과 같다).
--
-- 수량 컬럼은 두지 않는다. 홀·드레스·스튜디오는 같은 것을 두 개 사는 물건이 아니다.
-- 필요해지면 그때 컬럼을 더한다 — 지금 두면 화면마다 '1'을 곱하는 코드만 남는다.
-- =============================================================================

-- =============================================================================
-- carts — 커플의 장바구니
-- =============================================================================
create table public.carts (
  id         uuid primary key default gen_random_uuid(),
  couple_id  uuid not null references public.couples (id) on delete cascade,
  status     text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint carts_status_chk check (status in ('active', 'converted', 'abandoned'))
);

comment on table public.carts is
  '커플 장바구니(F-C-25). 커플당 active 는 하나뿐이며, 지나간 장바구니는 지우지 않고 상태로 남긴다.';
comment on column public.carts.status is
  'active(담는 중 · 커플당 1건) | converted(항목이 계약으로 넘어갔다) | abandoned(커플이 비우고 새로 시작했다). 값 집합은 명세서 미확정이므로 text + CHECK 다(0001 원칙).';

-- 활성 장바구니는 커플당 하나. 둘이면 "내 장바구니" 가 어느 쪽인지 정할 수 없다.
-- 부분 유니크라 converted·abandoned 는 몇 개든 쌓일 수 있다.
create unique index if not exists uq_carts_active_per_couple
  on public.carts (couple_id)
  where status = 'active';

comment on index public.uq_carts_active_per_couple is
  '커플당 활성 장바구니 1건(§3.4). 지나간 장바구니는 상태가 다르므로 제한을 받지 않는다.';

create index if not exists idx_carts_couple_id on public.carts (couple_id);
select public.attach_set_updated_at('carts');

-- =============================================================================
-- cart_items — 담긴 항목
-- =============================================================================
create table public.cart_items (
  id               uuid primary key default gen_random_uuid(),
  cart_id          uuid not null references public.carts (id) on delete cascade,
  vendor_id        uuid not null references public.vendors (id) on delete cascade,
  product_id       uuid not null references public.products (id) on delete cascade,
  options_json     jsonb not null default '{}'::jsonb,
  planner_selected boolean not null default false,
  added_by         uuid not null references auth.users (id) on delete restrict,
  price_at_add     bigint not null check (price_at_add >= 0),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

comment on table public.cart_items is
  '장바구니 항목(F-C-25). 같은 상품이라도 옵션이 다르면 별개 항목이다.';
comment on column public.cart_items.options_json is
  '선택한 옵션(product_options 기준). NOT NULL 이며 미선택은 빈 객체다 — null 이면 중복 판정에서 NULL <> NULL 때문에 같은 항목이 여러 번 담긴다.';
comment on column public.cart_items.planner_selected is
  '이 항목에 플래너를 쓸지 여부(F-C-31). **요율은 저장하지 않는다** — 매번 planner_fee_rates 에서 조회해 계산하고, 계약 확정 시 bookings.applied_planner_fee_rate_bp 로 스냅샷된다(D-17).';
comment on column public.cart_items.added_by is
  '커플 중 누가 담았는지(§2.1 활동 로그 작성자 표기). RLS 가 auth.uid() 와 일치하도록 강제한다.';
comment on column public.cart_items.price_at_add is
  '담은 시점의 products.base_price_total. **표시·합산에 쓰지 않는다** — 장바구니 금액은 항상 현재가로 계산한다(위 2번 근거). 이 값은 "담을 때보다 얼마 올랐다/내렸다" 를 말해 주기 위한 기준점일 뿐이다. 원 단위 정수이므로 부동소수점이 끼어들 여지가 없다.';

-- 같은 장바구니에 같은 상품 + 같은 옵션 조합은 하나뿐이다.
-- jsonb 는 저장할 때 키 순서가 정규화되므로 `{"a":1,"b":2}` 와 `{"b":2,"a":1}` 이
-- 같은 값으로 비교된다. 그래서 별도 지문(해시) 컬럼 없이 컬럼 자체로 유니크를 건다.
create unique index if not exists uq_cart_items_product_options
  on public.cart_items (cart_id, product_id, options_json);

comment on index public.uq_cart_items_product_options is
  '같은 상품·같은 옵션의 중복 담기를 막는다. 옵션이 다르면 별개 항목이므로 통과한다.';

create index if not exists idx_cart_items_cart_id on public.cart_items (cart_id);
create index if not exists idx_cart_items_vendor_id on public.cart_items (vendor_id);
create index if not exists idx_cart_items_product_id on public.cart_items (product_id);
select public.attach_set_updated_at('cart_items');

-- =============================================================================
-- wishlists — 찜
-- =============================================================================
create table public.wishlists (
  id           uuid primary key default gen_random_uuid(),
  couple_id    uuid not null references public.couples (id) on delete cascade,
  vendor_id    uuid not null references public.vendors (id) on delete cascade,
  product_id   uuid references public.products (id) on delete cascade,
  added_by     uuid not null references auth.users (id) on delete restrict,
  price_at_add bigint check (price_at_add is null or price_at_add >= 0),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  -- 업체 찜에는 가격이 없다. 상품 찜에는 반드시 있다 — 없으면 변동을 계산할 수 없다.
  constraint wishlists_price_pair_chk
    check ((product_id is null) = (price_at_add is null))
);

comment on table public.wishlists is
  '찜(F-C-26). product_id 가 null 이면 **업체 찜**이다 — "관심 업체·상품 저장"(§2.1).';
comment on column public.wishlists.price_at_add is
  '담은 시점의 products.base_price_total. 현재가와 비교해 가격 변동을 알린다(F-C-26). 업체 찜에는 가격이 없으므로 null 이며, 그 짝은 wishlists_price_pair_chk 가 강제한다.';
comment on column public.wishlists.added_by is
  '커플 중 누가 찜했는지(§2.1). RLS 가 auth.uid() 와 일치하도록 강제한다.';

-- 같은 대상을 두 번 찜할 수 없다. product_id 가 null 일 수 있어 그대로 UNIQUE 를 걸면
-- NULL <> NULL 때문에 업체 찜이 여러 번 통과한다(0013 에서 쓴 방법과 같다).
create unique index if not exists uq_wishlists_target
  on public.wishlists (
    couple_id,
    vendor_id,
    (coalesce(product_id, '00000000-0000-0000-0000-000000000000'::uuid))
  );

comment on index public.uq_wishlists_target is
  '같은 커플이 같은 업체·상품을 중복 찜하는 것을 막는다. 업체 찜(product_id null)도 하나뿐이다.';

create index if not exists idx_wishlists_couple_id on public.wishlists (couple_id);
create index if not exists idx_wishlists_product_id on public.wishlists (product_id);
-- 가격 변동 배치(wishlist-price-watch, S3-06)는 상품 찜만 훑는다.
create index if not exists idx_wishlists_price_watch
  on public.wishlists (product_id)
  where product_id is not null;

select public.attach_set_updated_at('wishlists');

-- =============================================================================
-- RLS (§3.9 — "커플 데이터 규칙을 그대로 따른다. 업체는 자기 상품이 담겼다는 사실을
--        조회할 수 없다")
-- -----------------------------------------------------------------------------
-- **읽기**: 커플 구성원 + 위임받은 플래너. 0005 의 guests·seating_plans 와 같은 모양이다.
--   플래너를 읽게 하는 이유 — 무엇을 후보로 두고 있는지 모르는 플래너는 상담을 할 수
--   없다. 다만 위임(`planner_engagements`)에 `carts`·`wishlists` 범위가 들어 있을
--   때만이며, 커플이 범위를 빼면 즉시 닫힌다(F-C-18).
--   `cart_items` 의 위임 범위 키도 **`carts`** 다. 항목을 못 보는 장바구니 열람은
--   의미가 없어서, 범위를 둘로 쪼개면 "장바구니는 되는데 내용은 안 되는" 상태만 만든다.
--
-- **쓰기**: 당사자(owner·partner)만. `is_couple_member` 가 아니라 `is_couple_principal`
--   (0015)을 쓴다. 두 가지 이유다.
--     · `is_couple_member` 는 **couple_members 의 planner 행도 참**으로 본다. 플래너
--       접근은 위임으로 판정해야지 멤버십으로 뭉뚱그리면 범위·기간 제한이 무력해진다.
--     · `planner_selected` 는 **플래너 자신의 수수료가 붙느냐를 정하는 스위치**다(F-C-31).
--       플래너가 그것을 켤 수 있으면 이해충돌이다. 무엇을 살지 정하는 것은 당사자다.
--
-- **업체·anon**: 어떤 정책도 주지 않는다. RLS 가 켜져 있고 해당 역할의 정책이 없으면
--   기본 거부다. 업체가 "내 상품이 몇 번 담겼나" 를 보는 것은 §3.9 가 금지한다.
--   (S2-08 대시보드의 '찜' 지표도 그래서 집계 대상 없음으로 남겨 뒀다.)
-- =============================================================================
alter table public.carts enable row level security;
create policy carts_select on public.carts for select to authenticated
  using (public.is_couple_member(couple_id) or public.has_planner_scope(couple_id, 'carts'));
create policy carts_insert on public.carts for insert to authenticated
  with check (public.is_couple_principal(couple_id));
create policy carts_update on public.carts for update to authenticated
  using (public.is_couple_principal(couple_id))
  with check (public.is_couple_principal(couple_id));
create policy carts_delete on public.carts for delete to authenticated
  using (public.is_couple_principal(couple_id));

-- cart_items 는 couple_id 를 직접 갖지 않는다. 부모 장바구니로 판정한다.
-- 조인 결과가 RLS 에 다시 걸리지 않도록 security definer 헬퍼로 감싼다(0005 와 같은 방식).
create or replace function public.cart_couple_id(p_cart_id uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select c.couple_id from public.carts c where c.id = p_cart_id;
$$;

comment on function public.cart_couple_id(uuid) is
  '장바구니가 속한 커플. cart_items 정책이 부모를 통해 커플을 찾기 위한 것이다.';

alter table public.cart_items enable row level security;
create policy cart_items_select on public.cart_items for select to authenticated
  using (
    public.is_couple_member(public.cart_couple_id(cart_id))
    or public.has_planner_scope(public.cart_couple_id(cart_id), 'carts')
  );
-- 담은 사람을 남이라고 적을 수 없다. 활동 기록의 작성자 표기가 거짓이 되면 안 된다.
create policy cart_items_insert on public.cart_items for insert to authenticated
  with check (
    public.is_couple_principal(public.cart_couple_id(cart_id))
    and added_by = auth.uid()
  );
create policy cart_items_update on public.cart_items for update to authenticated
  using (public.is_couple_principal(public.cart_couple_id(cart_id)))
  with check (public.is_couple_principal(public.cart_couple_id(cart_id)));
create policy cart_items_delete on public.cart_items for delete to authenticated
  using (public.is_couple_principal(public.cart_couple_id(cart_id)));

alter table public.wishlists enable row level security;
create policy wishlists_select on public.wishlists for select to authenticated
  using (public.is_couple_member(couple_id) or public.has_planner_scope(couple_id, 'wishlists'));
create policy wishlists_insert on public.wishlists for insert to authenticated
  with check (public.is_couple_principal(couple_id) and added_by = auth.uid());
create policy wishlists_update on public.wishlists for update to authenticated
  using (public.is_couple_principal(couple_id))
  with check (public.is_couple_principal(couple_id));
create policy wishlists_delete on public.wishlists for delete to authenticated
  using (public.is_couple_principal(couple_id));

-- =============================================================================
-- 이 파일이 한 것
--   테이블 3 — carts · cart_items · wishlists (전부 id·created_at·updated_at +
--              set_updated_at 트리거)
--   UNIQUE 인덱스 3 — 활성 장바구니 1건 / 상품+옵션 중복 / 찜 대상 중복
--   CHECK 3 — carts.status 값 집합 / cart_items.price_at_add >= 0 /
--             wishlists 가격·상품 짝
--   조회 인덱스 7, 함수 1(cart_couple_id), 정책 12
--   기존 마이그레이션 수정 없음
-- =============================================================================
