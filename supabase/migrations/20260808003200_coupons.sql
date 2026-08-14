-- =============================================================================
-- 0032 · 쿠폰 (S5-11)
-- 근거: docs/07_개발명세서.md §2.1 F-C-35·36, §2.2 F-V-19, §2.3 F-A-19,
--       §3.4 coupons·coupon_issues·coupon_redemptions + 값 집합 표, §3.9 RLS,
--       §7.4 파라미터, §7.7 리뷰 대가 쿠폰 금지, D-03 · D-16 · D-27
-- =============================================================================
-- S5-01(0028)이 "쿠폰은 명세 §3 에도 커버리지 표에도 없다" 며 만들지 않았고, T-00e 가
-- 그 자리를 채워(07 v2.4) 구현을 S5-11~S5-14 에 배정했다. 이 파일이 그 첫 조각이며
-- **스키마·RLS·불변식까지**다 — 화면·발급 경로는 S5-12~S5-14 다.
--
-- **왜 지금인가.** S5-07(정산)의 선행이 이 태스크다. 쿠폰 할인의 **부담 주체**
-- (`coupon_redemptions.borne_by`)가 정산 차감의 근거이므로, 이 표 없이 정산을 만들면
-- 업체 쿠폰의 비용이 어디로 가는지 표현할 수 없다.
--
-- 이 파일이 정한 것 — 판단이 필요했던 지점과 근거
--
--  1. **리뷰 대가 쿠폰을 스키마가 막는다**(§7.7 · D-03). `issue_condition` 을 자유
--     텍스트로 두면 "후기 작성 시 5천원" 이 언제든 들어온다. 그래서 **허용 값 집합을
--     CHECK 로 제한**하고 리뷰·후기·평점 관련 값을 **집합에 넣지 않는다.** 정책 문서
--     한 줄로 두지 않는 이유는, 금지의 실효성이 "아무도 그렇게 쓰지 않는다" 는 기대에
--     얹히기 때문이다. T-04 가 `detect_rules.basis_ref` 에, 0029 가 조항 번호에 건 것과
--     같은 방식이다.
--
--  2. **소진·만료를 `status` 에 저장하지 않는다.** 수량은 `total_quantity`·
--     `issued_count`, 기간은 `valid_to` 로 **계산되는 값**이다. 저장하면 배치가 늦은
--     만큼 화면이 거짓을 말한다(0027·0028·0030 이 세운 같은 규칙). `status` 가 담는
--     것은 **발행자의 의사**뿐이다: `active` | `paused` | `ended`.
--
--  3. **발급 시점에 만료일을 박는다**(D-16 과 같은 스냅샷 원칙). `coupons.valid_to` 를
--     그때그때 읽으면 정의를 고쳤을 때 **이미 발급한 쿠폰의 기한이 소급 변경**된다.
--     요율 스냅샷이 계약을 지키는 것과 같은 이유로 발급분이 자기 기한을 갖는다.
--
--  4. **정률 쿠폰은 basis point 정수다**(§6 부동소수점 금지). `discount_value` 하나로
--     정액(원)과 정률(bp)을 겸하되 `discount_type` 이 뜻을 정하고, 정률에만 상한
--     (`max_discount_amount`)이 붙는다 — 상한 없는 정률 쿠폰은 고액 계약에서 업체
--     정산을 통째로 지운다.
--
--  5. **`coupon_redemptions` 는 insert-only 다**(§3.4 · §3.9). 사용을 되돌리는 일은
--     행 수정이 아니라 **환불**이다(0031 이 만든 `refunds`·`contract_cancellations`).
--     UPDATE·DELETE 정책을 어떤 역할에도 주지 않으며 권한도 회수한다 — 정책이 없어도
--     테이블 소유자 권한으로 들어오는 경로를 닫기 위해서다.
--
--  6. **부담 주체를 사용 시점에 박는다.** `borne_by` 는 `coupons.issuer_type` 에서
--     복사되지만 **별도 컬럼**이다. 발행자가 나중에 바뀌거나(운영 이관) 정의가 고쳐져도
--     **이미 쓴 쿠폰의 비용 부담은 바뀌면 안 된다** — 그것이 정산 금액을 소급 변경한다.
--
--  7. **업체가 플랫폼 쿠폰을 만들 수 없다.** `issuer_type='platform'` 행은 정책이
--     당사자에게 열려 있지 않다(운영자·서비스롤 전용). 반대로 운영자가 업체 쿠폰을
--     만드는 것도 S5-14 가 화면에서 막는다 — 남의 정산에서 깎는 쿠폰을 운영자가
--     만들면 부담 주체가 흐려진다.
-- =============================================================================

-- =============================================================================
-- 1) coupons — 정의
-- =============================================================================
create table if not exists public.coupons (
  id                  uuid primary key default gen_random_uuid(),
  issuer_type         text not null,
  /** vendor 면 vendors.id, platform 이면 null. */
  issuer_id           uuid references public.vendors (id) on delete cascade,
  name                text not null,
  discount_type       text not null,
  /** 정액이면 원, **정률이면 basis point 정수**다(§6). */
  discount_value      integer not null,
  /** 정률 쿠폰의 할인 상한. 정액이면 null. */
  max_discount_amount bigint,
  min_order_amount    bigint not null default 0,
  issue_condition     text not null,
  valid_from          timestamptz,
  valid_to            timestamptz,
  /** null 이면 수량 무제한. */
  total_quantity      integer,
  issued_count        integer not null default 0,
  status              text not null default 'active',
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint coupons_issuer_values check (issuer_type in ('platform', 'vendor')),
  -- 발행 주체와 id 의 짝. platform 쿠폰에 vendor id 가 붙으면 부담 주체가 흐려진다.
  constraint coupons_issuer_shape
    check (
      (issuer_type = 'vendor' and issuer_id is not null)
      or (issuer_type = 'platform' and issuer_id is null)
    ),
  constraint coupons_discount_type_values check (discount_type in ('amount', 'rate')),
  constraint coupons_name_present check (nullif(btrim(name), '') is not null),

  -- 정액은 1원 이상, 정률은 1bp~10000bp. 0원·0% 쿠폰은 쿠폰이 아니다.
  constraint coupons_discount_value_range
    check (
      (discount_type = 'amount' and discount_value >= 1)
      or (discount_type = 'rate' and discount_value >= 1 and discount_value <= 10000)
    ),
  -- **정률에만 상한이 붙는다**(위 근거 4). 정액에 상한을 두면 두 값이 서로를 부정한다.
  constraint coupons_max_discount_shape
    check (
      (discount_type = 'rate' and max_discount_amount is not null and max_discount_amount >= 1)
      or (discount_type = 'amount' and max_discount_amount is null)
    ),
  constraint coupons_min_order_nonneg check (min_order_amount >= 0),
  constraint coupons_quantity_shape
    check (
      issued_count >= 0
      and (total_quantity is null or (total_quantity >= 1 and issued_count <= total_quantity))
    ),
  constraint coupons_period_order
    check (valid_to is null or valid_from is null or valid_to > valid_from),
  constraint coupons_status_values check (status in ('active', 'paused', 'ended')),

  -- **리뷰 대가 쿠폰을 스키마가 막는다**(위 근거 1 · §7.7 · D-03).
  -- 리뷰·후기·평점과 관련된 값은 이 집합에 **없다.**
  constraint coupons_issue_condition_values
    check (
      issue_condition in (
        'contract_completed',
        'first_purchase',
        'period_event',
        'repeat_purchase',
        'manual_grant'
      )
    )
);

comment on table public.coupons is
  '쿠폰 정의(D-27). **소진·만료를 status 에 저장하지 않는다** — 수량·기간으로 계산한다(저장하면 배치가 늦은 만큼 화면이 거짓을 말한다). status 가 담는 것은 발행자의 의사(active|paused|ended)뿐이다.';
comment on column public.coupons.issue_condition is
  '발행 조건. **허용 값 집합을 CHECK 로 제한한다**(§7.7 · D-03) — 자유 텍스트면 "후기 작성 시 5천원" 이 언제든 들어오고, 그것은 (가) 표시·광고 심사지침상 경제적 이해관계 공개 의무를 낳고 (나) 검증 후기(F-C-17)의 신뢰 근거를 무너뜨리며 (다) "돈이 평가에 개입하지 않는다"(D-03)와 정면 충돌한다. 리뷰 관련 값은 집합에 **없다**.';
comment on column public.coupons.discount_value is
  '정액이면 원, **정률이면 basis point 정수**(1% = 100bp). 부동소수점을 쓰지 않는다(§6). 정률에는 max_discount_amount 가 반드시 붙는다 — 상한 없는 정률 쿠폰은 고액 계약에서 업체 정산을 통째로 지운다.';
comment on column public.coupons.issued_count is
  '발급된 수. 발급 트리거가 올린다. 소진 여부는 total_quantity 와 비교해 **계산**하며 status 로 저장하지 않는다.';

create index if not exists idx_coupons_issuer on public.coupons (issuer_type, issuer_id);
create index if not exists idx_coupons_status on public.coupons (status);

select public.attach_set_updated_at('coupons');

-- =============================================================================
-- 2) coupon_issues — 발급분
-- =============================================================================
create table if not exists public.coupon_issues (
  id         uuid primary key default gen_random_uuid(),
  coupon_id  uuid not null references public.coupons (id) on delete cascade,
  /** 개인 쿠폰. 커플 공유 쿠폰이면 null 이다. */
  user_id    uuid references auth.users (id) on delete cascade,
  /** 커플 단위 공유 쿠폰. 개인 쿠폰이면 null 이다. */
  couple_id  uuid references public.couples (id) on delete cascade,
  issued_at  timestamptz not null default now(),
  /** **발급 시점에 확정한다**(위 근거 3). coupons.valid_to 를 그때그때 읽지 않는다. */
  expires_at timestamptz,
  status     text not null default 'issued',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint coupon_issues_status_values
    check (status in ('issued', 'used', 'expired', 'revoked')),
  -- 대상은 둘 중 하나다. 둘 다이거나 둘 다 아니면 누구 쿠폰인지 알 수 없다.
  constraint coupon_issues_target_shape
    check ((user_id is null) <> (couple_id is null))
);

comment on table public.coupon_issues is
  '쿠폰 발급분(D-27). 정의 1건에 발급 N건이다. **만료일을 발급 시점에 박는다** — 정의를 고쳤을 때 이미 발급한 쿠폰의 기한이 소급 변경되면 안 된다(요율 스냅샷과 같은 이유 · D-16).';
comment on column public.coupon_issues.expires_at is
  '이 발급분의 만료 시각. **coupons.valid_to 의 스냅샷**이며 이후 정의 변경에 소급되지 않는다. null 이면 기한 없는 발급이다.';

-- **같은 쿠폰을 같은 대상에게 중복 발급하지 않는다.** user·couple 이 배타라 부분
-- 유니크 둘로 나눈다(한 인덱스에 넣으면 null 끼리 중복이 통과한다 — Postgres 에서
-- NULL <> NULL 이다. 0013 이 재고 슬롯에서 겪은 것과 같은 함정이다).
create unique index if not exists uq_coupon_issues_user
  on public.coupon_issues (coupon_id, user_id)
  where user_id is not null;
create unique index if not exists uq_coupon_issues_couple
  on public.coupon_issues (coupon_id, couple_id)
  where couple_id is not null;

create index if not exists idx_coupon_issues_coupon on public.coupon_issues (coupon_id);
create index if not exists idx_coupon_issues_user on public.coupon_issues (user_id);
create index if not exists idx_coupon_issues_couple on public.coupon_issues (couple_id);

select public.attach_set_updated_at('coupon_issues');

-- 발급 수를 세는 것은 DB 다. 앱에서 올리면 동시 발급에서 수량 상한이 새어 나간다.
create or replace function public.bump_coupon_issued_count()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_total integer;
  v_count integer;
begin
  select total_quantity into v_total from public.coupons where id = new.coupon_id for update;

  update public.coupons
     set issued_count = issued_count + 1
   where id = new.coupon_id
  returning issued_count into v_count;

  -- 수량 상한은 CHECK 도 보지만, 여기서 먼저 사람이 읽을 수 있는 오류로 끊는다.
  if v_total is not null and v_count > v_total then
    raise exception '쿠폰 수량이 소진됐습니다(%/%).', v_count, v_total
      using errcode = 'check_violation', constraint = 'coupons_quantity_exhausted';
  end if;

  return new;
end;
$$;

comment on function public.bump_coupon_issued_count() is
  '발급 수를 DB 가 센다. 앱에서 올리면 동시 발급에서 수량 상한이 새어 나간다 — for update 잠금이 그 지점이다. 소진 여부는 여전히 **계산**이며 status 에 저장하지 않는다.';

drop trigger if exists trg_coupon_issues_count on public.coupon_issues;
create trigger trg_coupon_issues_count
  after insert on public.coupon_issues
  for each row execute function public.bump_coupon_issued_count();

-- =============================================================================
-- 3) coupon_redemptions — 사용 이력 (insert-only)
-- =============================================================================
create table if not exists public.coupon_redemptions (
  id               uuid primary key default gen_random_uuid(),
  coupon_issue_id  uuid not null references public.coupon_issues (id) on delete restrict,
  booking_id       uuid references public.bookings (id) on delete set null,
  payment_id       uuid references public.payments (id) on delete set null,
  discount_amount  bigint not null,
  /** **비용 부담 주체.** 정산 차감의 근거다(§3.4 NOTE). */
  borne_by         text not null,
  redeemed_at      timestamptz not null default now(),
  created_at       timestamptz not null default now(),

  constraint coupon_redemptions_borne_values check (borne_by in ('platform', 'vendor')),
  constraint coupon_redemptions_amount_positive check (discount_amount >= 1),

  -- 발급 1건은 한 번만 쓴다.
  unique (coupon_issue_id)
);

comment on table public.coupon_redemptions is
  '쿠폰 사용 이력(D-27). **insert-only** — 사용을 되돌리는 일은 행 수정이 아니라 환불이다(refunds·contract_cancellations · 0031). UPDATE·DELETE 정책을 어떤 역할에도 주지 않고 권한도 회수한다.';
comment on column public.coupon_redemptions.borne_by is
  '비용 부담 주체이며 **정산 계산의 근거**다: vendor 면 그 업체 정산에서 차감하고 platform 이면 차감하지 않는다(§3.4 NOTE). coupons.issuer_type 에서 복사하되 **별도 컬럼**인 이유는, 발행자가 바뀌거나 정의가 고쳐져도 **이미 쓴 쿠폰의 부담 주체는 바뀌면 안 되기** 때문이다 — 바뀌면 과거 정산 금액이 소급 변경된다.';

create index if not exists idx_coupon_redemptions_booking on public.coupon_redemptions (booking_id);
create index if not exists idx_coupon_redemptions_payment on public.coupon_redemptions (payment_id);

-- 사용 시 발급분을 used 로 옮긴다. 두 표가 어긋나면 같은 쿠폰이 두 번 쓰인 것처럼 보인다.
create or replace function public.mark_coupon_issue_used()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_status text;
begin
  select status into v_status from public.coupon_issues where id = new.coupon_issue_id for update;

  if v_status is null then
    raise exception '쿠폰 발급분을 찾을 수 없습니다.' using errcode = 'foreign_key_violation';
  end if;

  if v_status <> 'issued' then
    raise exception '사용할 수 없는 쿠폰입니다. 발급분 상태: %', v_status
      using errcode = 'check_violation', constraint = 'coupon_issues_not_usable';
  end if;

  update public.coupon_issues set status = 'used' where id = new.coupon_issue_id;

  return new;
end;
$$;

comment on function public.mark_coupon_issue_used() is
  '사용 시 발급분을 used 로 옮기고, 이미 쓰였거나 취소된 발급분의 사용을 막는다. 유니크(coupon_issue_id)와 함께 "발급 1건은 한 번만" 을 두 층으로 지킨다.';

drop trigger if exists trg_coupon_redemptions_use on public.coupon_redemptions;
create trigger trg_coupon_redemptions_use
  before insert on public.coupon_redemptions
  for each row execute function public.mark_coupon_issue_used();

-- =============================================================================
-- 4) RLS (§3.9)
-- =============================================================================
alter table public.coupons enable row level security;
alter table public.coupon_issues enable row level security;
alter table public.coupon_redemptions enable row level security;

-- ── 정책 헬퍼 (definer) ───────────────────────────────────────────────────
-- **정책끼리 서로를 조회하면 무한 재귀다.** `coupons` 정책이 `coupon_issues` 를 보고
-- `coupon_issues` 정책이 `coupons` 를 보면 Postgres 가 그 자리에서 멈춘다
-- (`infinite recursion detected in policy`). 0016(`cart_couple_id`)·0028
-- (`booking_couple_id`)이 쓴 방법을 그대로 쓴다 — **조인을 definer 함수로 감싸** 그
-- 안에서는 RLS 를 다시 타지 않게 한다.
create or replace function public.coupon_issuer_vendor_id(p_coupon_id uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select c.issuer_id from public.coupons c
   where c.id = p_coupon_id and c.issuer_type = 'vendor';
$$;

comment on function public.coupon_issuer_vendor_id(uuid) is
  '쿠폰을 발행한 업체. coupon_issues 정책이 coupons 를 직접 조회하면 두 정책이 서로를 불러 무한 재귀가 된다 — definer 로 감싸 그 고리를 끊는다.';

create or replace function public.has_coupon_issue(p_coupon_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.coupon_issues i
    where i.coupon_id = p_coupon_id
      and (i.user_id = auth.uid() or public.is_couple_member(i.couple_id))
  );
$$;

comment on function public.has_coupon_issue(uuid) is
  '이 사용자가 그 쿠폰을 발급받았는가. coupons 정책이 coupon_issues 를 직접 조회하면 무한 재귀가 되므로 definer 로 감싼다. **발급받은 쿠폰의 정의만** 열리며, 발급받지 않은 쿠폰까지 열면 미공개 프로모션이 노출된다.';

-- ── coupons ───────────────────────────────────────────────────────────────
-- 업체는 **자사 쿠폰만** 쓰고 읽는다. 플랫폼 쿠폰은 운영자·서비스롤 전용이다(근거 7).
create policy coupons_select_vendor on public.coupons for select to authenticated
  using (issuer_type = 'vendor' and public.is_vendor_member(issuer_id));

create policy coupons_write_vendor on public.coupons for insert to authenticated
  with check (issuer_type = 'vendor' and public.is_vendor_owner(issuer_id));

create policy coupons_update_vendor on public.coupons for update to authenticated
  using (issuer_type = 'vendor' and public.is_vendor_owner(issuer_id))
  with check (issuer_type = 'vendor' and public.is_vendor_owner(issuer_id));

comment on policy coupons_write_vendor on public.coupons is
  '쿠폰 발행은 업체 **대표**만 한다 — 할인은 그 업체의 정산에서 차감되므로 금액을 움직이는 행위다(§3.9 가 가격·정산을 대표로 좁힌 것과 같은 경계).';

create policy coupons_select_operator on public.coupons for select to authenticated
  using (public.is_operator());

-- **고객은 발급받은 쿠폰의 정의만** 읽는다. 쿠폰함이 조건(최소 주문 금액·상한·기한)을
-- 보여줘야 하기 때문이며, 발급받지 않은 쿠폰까지 열면 미공개 프로모션이 노출된다.
create policy coupons_select_issued on public.coupons for select to authenticated
  using (public.has_coupon_issue(id));

-- ── coupon_issues ─────────────────────────────────────────────────────────
create policy coupon_issues_select_own on public.coupon_issues for select to authenticated
  using (user_id = auth.uid() or public.is_couple_member(couple_id));

create policy coupon_issues_select_issuer on public.coupon_issues for select to authenticated
  using (public.is_vendor_member(public.coupon_issuer_vendor_id(coupon_id)));

create policy coupon_issues_select_operator on public.coupon_issues for select to authenticated
  using (public.is_operator());

comment on policy coupon_issues_select_issuer on public.coupon_issues is
  '업체는 자사 쿠폰의 발급·사용 현황을 본다. 다만 **정산 차감액은 대표 전용**이며 그 경계는 settlements 쪽에 있다(§3.9 — 정산과 같은 경계).';

-- **발급은 서비스롤이 한다.** 고객이 스스로 발급하면 수량·조건을 우회할 수 있고,
-- 업체가 남의 계정에 발급하는 것도 막아야 한다. 정책 없음 = 기본 거부다.

-- ── coupon_redemptions ────────────────────────────────────────────────────
-- **insert-only 이며 쓰기 정책이 없다**(근거 5). 사용 기록은 결제 경로(서비스롤)가
-- 만들고, 되돌리는 일은 환불이다.
create or replace function public.owns_coupon_issue(p_issue_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.coupon_issues i
    where i.id = p_issue_id
      and (i.user_id = auth.uid() or public.is_couple_member(i.couple_id))
  );
$$;

create policy coupon_redemptions_select_own on public.coupon_redemptions
  for select to authenticated
  using (public.owns_coupon_issue(coupon_issue_id));

create policy coupon_redemptions_select_vendor on public.coupon_redemptions
  for select to authenticated
  using (
    booking_id is not null
    and public.is_vendor_member(public.booking_vendor_id(booking_id))
  );

create policy coupon_redemptions_select_operator on public.coupon_redemptions
  for select to authenticated
  using (public.is_operator());

-- 정책이 없어도 권한으로 들어오는 경로를 닫는다(0019 가 entity_events 에 쓴 방식).
revoke update, delete on public.coupon_redemptions from authenticated, anon;

-- =============================================================================
-- 5) 증적 열람 (D-23)
-- =============================================================================
create policy entity_events_select_coupon on public.entity_events
  for select to authenticated
  using (
    entity_type = 'coupon_issue'
    and public.owns_coupon_issue(entity_events.entity_id)
  );

-- =============================================================================
-- 6) 운영 파라미터 (§7.4 — 값을 코드에 박지 않는다)
-- =============================================================================
insert into public.app_settings (key, value_json, description)
values
  (
    'coupon.max_discount_rate_bp',
    '{"rateBp": 3000, "unit": "bp"}'::jsonb,
    '정률 쿠폰의 할인율 상한(bp). 업체가 자사 정산을 통째로 지우는 쿠폰을 만들지 못하게 하는 방어선이며, **값은 운영이 배포 없이 바꾼다**. 초기 운영값 30%.'
  ),
  (
    'coupon.stacking',
    '{"mode": "single", "unit": "policy"}'::jsonb,
    '쿠폰 중복 사용 규칙. single = 결제 1건에 쿠폰 1장. **중복을 기본으로 열지 않는다** — 두 장이 겹치면 할인액이 결제액을 넘을 수 있고, 그 경우 누가 부담하는지(borne_by 가 둘이 된다) 정산이 답할 수 없다. 여는 것은 그 물음에 답한 뒤의 일이다.'
  ),
  (
    'coupon.default_valid_days',
    '{"days": 30, "unit": "days"}'::jsonb,
    '발급 시 만료일을 정하지 않았을 때 쓰는 기본 유효기간(일). 발급 시점에 coupon_issues.expires_at 으로 **박히며**(D-16) 이후 이 값이 바뀌어도 소급되지 않는다.'
  )
on conflict (key) do update
  set value_json = excluded.value_json, description = excluded.description
  where public.app_settings.value_json ->> 'status' = 'undecided';

-- =============================================================================
-- 이 파일이 한 것
--   테이블 3 — coupons · coupon_issues · coupon_redemptions
--   CHECK 13(**리뷰 대가 금지 CHECK 포함**) · UNIQUE 3
--   함수 5 — 발급 수 카운트 · 사용 시 발급분 전이 + 정책 헬퍼 3(무한 재귀 차단)
--   트리거 2
--   정책 11 — coupons 5 · coupon_issues 3 · coupon_redemptions 3
--             (**발급·사용 쓰기 정책 없음** = 서비스롤 전용)
--   GRANT  coupon_redemptions UPDATE·DELETE 회수(insert-only)
--   app_settings 3 — 할인율 상한 · 중복 규칙 · 기본 유효기간
--   기존 마이그레이션 수정 없음
-- =============================================================================
