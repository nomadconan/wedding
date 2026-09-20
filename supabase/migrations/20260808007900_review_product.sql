-- =============================================================================
-- 0079 · 상품 단위 후기 (C-2e)
--   근거: 07 §2.1 F-C-17 확장 · §2.2 F-V-11 · §3.3 「C 단계가 상품 쪽에 더하는 칸」
--
-- ── 무엇이 없었나 ───────────────────────────────────────────────────────────
-- `reviews` 는 `booking_id` + `vendor_id` 라 **업체 단위**다. 그래서 상품 상세
-- (C-2c)에 보여 줄 후기가 없었고, 화면이 "상품별 후기는 아직 모으는 중" 이라고
-- 적고 있었다(D-212).
--
-- ── 왜 칸을 두는가 — **조인으로는 안 된다** ─────────────────────────────────
-- 상품은 `bookings.product_id` 가 안다. 그러면 읽을 때 조인하면 될 것 같지만,
-- **`bookings` 에는 공개 정책이 없다**(`bookings_select` = 커플·업체·플래너 뿐).
-- 상품 후기는 **비로그인이 보는 것**이라 anon 이 조인하면 0행이 된다.
-- 그래서 값을 **쓸 때 옮겨 둔다** — D-16 이 요율을 계약 시점에 스냅샷한 것과 같은
-- 종류이며, "계산 가능한 값을 저장하지 않는다" 의 예외 사유가 여기 있다:
-- **계산에 필요한 표를 읽을 수 없는 사람에게 보여 줘야 하는 값이다.**
--
-- ── 작성자가 고르게 하지 않는다 ─────────────────────────────────────────────
-- 고르게 하면 **안 산 상품에 후기가 붙는다.** 값은 `bookings.product_id` 하나이며
-- 아래 정책이 **그 값과 같을 때만** INSERT 를 받는다. 즉 "끌어온다" 가 앱의 관행이
-- 아니라 **DB 의 조건**이다.
--
-- ── FIX-39 의 모양을 늘리지 않는다 ──────────────────────────────────────────
-- S8-11 이 찾은 구멍은 *"작성자가 `vendor_id` 를 남의 업체로 고쳐 검증 후기를
-- 만든다"* 였고, 0058 이 **UPDATE 를 칸 목록으로** 좁혀 닫았다. 그 목록에 새 칸을
-- **더하지 않는다** — 목록 방식이라 새 칸은 **자동으로 못 고치는 칸**이 된다
-- (`products` 가 표 단위라 새 칸이 자동으로 쓸 수 있게 되는 것과 정반대다).
-- `with check` 로는 "이 칸은 바뀌면 안 된다" 를 말할 수 없다 — 바뀐 뒤의 행만 보기
-- 때문이다. 그래서 **권한으로** 막는다.
-- =============================================================================

alter table public.reviews
  add column if not exists product_id uuid;

comment on column public.reviews.product_id is
  '이 후기가 가리키는 상품(C-2e). **예약이 가리키는 상품에서 끌어온다** — 작성자가 '
  '고르지 않으며 reviews_insert 정책이 bookings.product_id 와 같을 때만 받는다. '
  'nullable 인 이유는 상품 없는 예약(업체 단위 거래)과 이미 쌓인 후기 때문이며, '
  '그런 후기는 계속 업체 단위로 읽힌다. **작성자는 이 칸을 고칠 수 없다**(0058 의 '
  'UPDATE 칸 목록에 없다 · FIX-39).';

-- **남의 업체 상품을 가리키지 못하게 한다.** 정책이 `vendor_id` 를 예약에 묶고
-- 상품도 예약에 묶지만, 그 둘이 서로 같은 업체인지는 **선언으로** 못박는다 —
-- C-2b 가 `vendor_media` 에서 쓴 방식과 같고 대상 유니크(`products_id_vendor_uk`)도
-- 그때 만들어 뒀다. (MATCH SIMPLE 기본값이라 product_id 가 null 이면 검사하지 않는다.)
alter table public.reviews
  add constraint reviews_product_same_vendor_fk
  foreign key (product_id, vendor_id)
  references public.products (id, vendor_id)
  on delete set null;

create index if not exists idx_reviews_product_id
  on public.reviews (product_id)
  where product_id is not null;

-- -----------------------------------------------------------------------------
-- 기존 후기 이행 — **nullable 로 두고 채울 수 있는 것만 채운다**
-- -----------------------------------------------------------------------------
-- `not null` 로 걸면 **기존 행이 그 자리에서 깨진다**(C-2b 가 게시 조건에서 겪은
-- 것과 같은 모양 — 제약은 기존 행을 즉시 검사한다). 게다가 `bookings.product_id`
-- 자체가 nullable 이라 **채울 수 없는 후기가 앞으로도 생긴다**(상품 없는 예약).
--
-- 그래서 nullable 이고, **예약이 상품을 아는 후기만** 지금 채운다. 못 채운 후기는
-- 업체 단위로 계속 읽힌다 — 그 사실을 화면이 적는다("이 업체의 후기" vs "이 상품의 후기").
--
-- **로컬에서 이 문장은 빈 표를 훑는다.** `db:reset` 은 마이그레이션을 먼저,
-- `seed.sql` 을 나중에 적용하기 때문이다(C-2a 가 같은 자리에서 물렸다).
-- 로컬 시드 후기는 아래 **트리거**가 채우고, 이 문장은 **운영 DB 의 기존 행**을 위한
-- 것이다. 둘을 한 문장으로 합칠 수 없어서 둘 다 둔다.
update public.reviews r
   set product_id = b.product_id
  from public.bookings b
 where b.id = r.booking_id
   and b.product_id is not null
   and r.product_id is null;

-- -----------------------------------------------------------------------------
-- 끌어오는 장치 — **트리거가 값을 정한다**
-- -----------------------------------------------------------------------------
-- 작성자가 고르게 하면 안 산 상품에 후기가 붙는다. 그래서 **입력을 받지 않고
-- 예약에서 읽어 덮어쓴다** — 앱이 무엇을 보내든 결과는 같다.
--
-- 정책(`reviews_insert`)에도 같은 조건이 있다. 층을 둘로 두는 이유: 트리거가
-- 사라지면 값이 **비는** 것으로 끝나지만(구멍이 아니다), 정책이 사라지면 **값을
-- 지어낼 수 있게** 된다. 막는 쪽이 정책이고 채우는 쪽이 트리거다.
--
-- `booking_id` 는 작성자가 못 고치므로(0058 칸 목록) INSERT 만 본다.
create or replace function public.set_review_product()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  select b.product_id into new.product_id
    from public.bookings b
   where b.id = new.booking_id;

  return new;
end;
$$;

comment on function public.set_review_product() is
  '후기의 상품을 예약에서 끌어온다(C-2e). 작성자 입력을 무시하고 덮어쓴다 — '
  '고르게 하면 안 산 상품에 후기가 붙는다.';

drop trigger if exists trg_reviews_set_product on public.reviews;
create trigger trg_reviews_set_product
  before insert on public.reviews
  for each row execute function public.set_review_product();

-- -----------------------------------------------------------------------------
-- 작성 정책 — 상품은 **예약이 정한다**
-- -----------------------------------------------------------------------------
-- 기존 조건(커플 구성원 · 확정/이행된 예약 · 커플·업체가 예약과 일치)은 그대로 두고
-- **상품 조건 한 줄만 더한다.** 정책을 새로 쓰지 않고 조건을 더하는 이유는, 기존
-- 조건이 **검증 후기의 근거 전부**이기 때문이다(FIX-44 가 세운 경계 — 자격의 근거
-- 표인 `bookings` 를 자격 대상이 직접 못 쓴다는 사실 위에 서 있다).
drop policy if exists reviews_insert on public.reviews;
create policy reviews_insert on public.reviews for insert to authenticated
  with check (
    public.is_couple_member(couple_id)
    and exists (
      select 1
        from public.bookings b
       where b.id = reviews.booking_id
         and b.couple_id = reviews.couple_id
         and b.vendor_id = reviews.vendor_id
         and b.status = any (array['confirmed'::booking_status, 'fulfilled'::booking_status])
         -- **상품은 고르는 것이 아니라 예약이 정한다.**
         -- null 을 허용하는 것은 상품 없는 예약 때문이며, 값이 있으면 **반드시**
         -- 그 예약의 상품이어야 한다.
         and (reviews.product_id is null or reviews.product_id = b.product_id)
    )
  );

-- =============================================================================
-- 이 파일이 한 것
--   ALTER  reviews + 1컬럼(product_id, nullable)
--   FK     복합 1(product_id, vendor_id → products) — 남의 업체 상품 차단
--   인덱스 1(부분 인덱스)
--   데이터 이행 1 — 예약이 상품을 아는 기존 후기만 채운다(운영 DB 용)
--   트리거 1 + 함수 1 — 새 후기의 상품을 예약에서 끌어온다(작성자 입력 무시)
--   RLS    reviews_insert 재작성(상품 조건 한 줄 추가 · 나머지 조건 그대로)
--   **UPDATE 칸 목록은 건드리지 않았다** — 그래서 작성자는 이 칸을 못 고친다
--   새 표·새 정책 없음
-- =============================================================================
