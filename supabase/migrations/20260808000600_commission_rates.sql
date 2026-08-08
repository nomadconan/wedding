-- =============================================================================
-- 0006 · 요율 구조 (S5-01)
-- 근거: docs/07_개발명세서.md §3.8(commission_rates·planner_fee_rates·요율 해석 규칙),
--       §3.9(RLS — 요율), §7.4(가변 파라미터), D-16 · D-17
-- =============================================================================
-- 원칙
--  * **요율 값을 코드·마이그레이션·시드 어디에도 고정하지 않는다.** O-02 가 미확정인 채로
--    개발이 진행돼야 하므로 여기서 만드는 것은 **구조뿐**이다. 값은 운영이 넣는다.
--  * 값은 basis point 정수(1% = 100bp)로 저장한다. 부동소수점을 쓰지 않는다.
--  * 요율 변경은 **새 행 추가**다. 기존 행을 수정하지 않는다 —
--    과거 시점 조회가 가능해야 정산 이의 제기에 답할 수 있다(§3.8).
--  * 계약 시점 요율은 bookings 에 스냅샷으로 박히며, 이 테이블을 소급 참조하지 않는다.
-- =============================================================================

-- 동일 스코프의 기간 겹침을 EXCLUDE 제약으로 막으려면 스칼라 = 연산자에도
-- GiST 연산자 클래스가 필요하다.
create extension if not exists btree_gist;

-- -----------------------------------------------------------------------------
-- 열거 타입 (§3.8 이 값 집합을 명시한 컬럼)
-- -----------------------------------------------------------------------------
create type public.commission_scope_type as enum ('global', 'category', 'vendor');
create type public.planner_rate_scope_type as enum ('global', 'category', 'planner');

-- -----------------------------------------------------------------------------
-- 업체 수수료 요율 (F-A-15, D-16)
-- -----------------------------------------------------------------------------
create table public.commission_rates (
  id             uuid primary key default gen_random_uuid(),
  scope_type     public.commission_scope_type not null,
  -- global 이면 null, category 면 카테고리 코드, vendor 면 vendors.id 의 uuid 문자열.
  scope_key      text,
  fee_rate_bp    integer not null,
  effective_from timestamptz not null,
  -- null = 무기한. 구간은 [effective_from, effective_to) 반개구간으로 해석한다.
  effective_to   timestamptz,
  memo           text,
  updated_by     uuid references auth.users (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  -- 스키마 수준 sanity bound 다. 0bp ~ 10000bp(=100%) 를 벗어나면 입력 사고다.
  -- **운영 상한은 이 값이 아니다** — 실제 허용 범위는 app_settings·운영 정책의 몫이며
  -- 여기에 업무 요율을 못박지 않는다(O-02).
  constraint commission_rates_fee_rate_bp_range
    check (fee_rate_bp >= 0 and fee_rate_bp <= 10000),

  -- global 은 키가 없고, 나머지는 반드시 있어야 한다.
  constraint commission_rates_scope_key_shape
    check (
      (scope_type = 'global' and scope_key is null)
      or (scope_type <> 'global' and scope_key is not null and length(scope_key) > 0)
    ),

  -- vendor 스코프의 키는 uuid 형식이어야 한다. FK 를 걸지 않는 이유는 scope_key 가
  -- 카테고리 코드도 담는 다형 컬럼이기 때문이며, 형식만이라도 여기서 막는다.
  constraint commission_rates_vendor_key_is_uuid
    check (
      scope_type <> 'vendor'
      or scope_key ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    ),

  constraint commission_rates_effective_range
    check (effective_to is null or effective_to > effective_from)
);

-- 같은 스코프에서 기간이 겹치면 **어느 요율이 적용될지 비결정적**이 된다.
-- 그대로 두면 정산 분쟁의 원인이므로 DB 가 입력 자체를 거부한다.
alter table public.commission_rates
  add constraint commission_rates_no_overlap
  exclude using gist (
    -- enum 을 text 로 캐스팅하지 않는다 — enum_out 은 STABLE 이라 인덱스 식에 못 쓴다.
    -- btree_gist 가 enum 타입의 = 연산자 클래스를 제공하므로 그대로 넣는다.
    scope_type with =,
    (coalesce(scope_key, '')) with =,
    tstzrange(effective_from, effective_to, '[)') with &&
  );

comment on table public.commission_rates is
  '업체 수수료 요율(§3.8, F-A-15). 요율 값을 코드·명세에 고정하지 않는다(O-02). 변경은 새 행 추가.';
comment on column public.commission_rates.fee_rate_bp is
  'basis point 정수. 1% = 100bp. 부동소수점을 쓰지 않는다.';
comment on column public.commission_rates.scope_key is
  'global=null / category=카테고리 코드 / vendor=vendors.id. 좁은 범위가 넓은 범위를 이긴다.';
comment on column public.commission_rates.effective_to is
  'null 이면 무기한. 적용 구간은 [effective_from, effective_to) 반개구간이다.';

-- 해석 규칙(§3.8)이 타는 조회 경로 그대로 인덱스를 만든다.
create index if not exists idx_commission_rates_scope
  on public.commission_rates (scope_type, scope_key, effective_from desc);

select public.attach_set_updated_at('commission_rates');

-- -----------------------------------------------------------------------------
-- 플래너 수수료 요율 (F-A-15, D-17)
-- -----------------------------------------------------------------------------
create table public.planner_fee_rates (
  id             uuid primary key default gen_random_uuid(),
  scope_type     public.planner_rate_scope_type not null,
  -- global 이면 null, category 면 카테고리 코드, planner 면 planners.id 의 uuid 문자열.
  scope_key      text,
  -- 서비스 등급별 차등. null 이면 '등급 무관' 이며, 같은 스코프에 등급 지정 행이 있으면
  -- 그쪽이 먼저 채택된다(해석은 lib/core/pricing/rates.ts).
  service_level  text,
  fee_rate_bp    integer not null,
  effective_from timestamptz not null,
  effective_to   timestamptz,
  memo           text,
  updated_by     uuid references auth.users (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint planner_fee_rates_fee_rate_bp_range
    check (fee_rate_bp >= 0 and fee_rate_bp <= 10000),

  constraint planner_fee_rates_scope_key_shape
    check (
      (scope_type = 'global' and scope_key is null)
      or (scope_type <> 'global' and scope_key is not null and length(scope_key) > 0)
    ),

  constraint planner_fee_rates_planner_key_is_uuid
    check (
      scope_type <> 'planner'
      or scope_key ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    ),

  constraint planner_fee_rates_effective_range
    check (effective_to is null or effective_to > effective_from)
);

-- 등급이 다르면 같은 기간에 공존할 수 있으므로 service_level 도 겹침 판정 키에 넣는다.
alter table public.planner_fee_rates
  add constraint planner_fee_rates_no_overlap
  exclude using gist (
    scope_type with =,
    (coalesce(scope_key, '')) with =,
    (coalesce(service_level, '')) with =,
    tstzrange(effective_from, effective_to, '[)') with &&
  );

comment on table public.planner_fee_rates is
  '플래너 수수료 요율(§3.8, F-A-15, D-17). 선택한 카테고리에만 부과된다. 요율 값은 운영이 넣는다.';
comment on column public.planner_fee_rates.service_level is
  '서비스 등급별 차등. null 이면 등급 무관이며 등급 지정 행이 우선한다.';

create index if not exists idx_planner_fee_rates_scope
  on public.planner_fee_rates (scope_type, scope_key, effective_from desc);

select public.attach_set_updated_at('planner_fee_rates');

-- =============================================================================
-- RLS (§3.9 — 요율)
--
--  * 쓰기는 **어떤 역할에도 부여하지 않는다.** 운영자는 서비스롤 경유 Route Handler 로만
--    변경하며, service_role 은 RLS 를 우회한다.
--  * 업체는 **자기에게 적용되는 요율만** 본다 — 자기 vendor 스코프 · 자기 카테고리 · 전역.
--    다른 업체의 요율은 볼 수 없다.
--  * 플래너도 동일하게 자기 요율만 본다.
--  * anon 정책은 만들지 않는다 = 전면 거부.
--
--  USING 절에 CASE 를 쓰는 이유: OR 로 늘어놓으면 평가 순서가 보장되지 않아
--  category 행의 scope_key('hall')를 uuid 로 캐스팅하다 에러가 날 수 있다.
--  CASE 는 일치한 분기만 평가한다.
-- =============================================================================

create or replace function public.is_any_vendor_member()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.vendor_members vm where vm.user_id = auth.uid()
  );
$$;

comment on function public.is_any_vendor_member() is
  '어느 업체든 소속이면 true. 전역 요율 열람 판정에 쓴다(§3.9).';

create or replace function public.is_vendor_member_of_category(p_category text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from public.vendor_members vm
    join public.vendors v on v.id = vm.vendor_id
    where vm.user_id = auth.uid() and v.category = p_category
  );
$$;

comment on function public.is_vendor_member_of_category(text) is
  '자기 업체의 카테고리인지 판정한다. 다른 카테고리 요율은 보이지 않는다(§3.9).';

create or replace function public.is_planner_record(p_planner_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.planners p
    where p.id = p_planner_id and p.user_id = auth.uid()
  );
$$;

create or replace function public.is_any_planner()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.planners p where p.user_id = auth.uid()
  );
$$;

comment on function public.is_any_planner() is
  '플래너 등록자인지 판정한다. 플래너는 카테고리를 가리지 않으므로 카테고리·전역 요율을 본다.';

alter table public.commission_rates enable row level security;

create policy commission_rates_select on public.commission_rates
  for select to authenticated
  using (
    case scope_type
      when 'global'   then public.is_any_vendor_member()
      when 'category' then public.is_vendor_member_of_category(scope_key)
      when 'vendor'   then public.is_vendor_member(scope_key::uuid)
    end
  );

alter table public.planner_fee_rates enable row level security;

create policy planner_fee_rates_select on public.planner_fee_rates
  for select to authenticated
  using (
    case scope_type
      when 'global'   then public.is_any_planner()
      when 'category' then public.is_any_planner()
      when 'planner'  then public.is_planner_record(scope_key::uuid)
    end
  );

-- =============================================================================
-- 이 파일이 생성한 것
--   테이블 2 — commission_rates, planner_fee_rates
--   열거 타입 2 — commission_scope_type, planner_rate_scope_type
--   제약 — 요율 범위 CHECK 2, 스코프 키 형태 CHECK 4, 기간 CHECK 2, 겹침 EXCLUDE 2
--   인덱스 2, RLS 정책 2(SELECT 전용), 보조 함수 4
-- =============================================================================
