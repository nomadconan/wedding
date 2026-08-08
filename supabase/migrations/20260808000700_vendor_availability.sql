-- =============================================================================
-- 0007 · 업체 가능 시간대 (S4-02 부분 — vendor_availability)
-- 근거: docs/07_개발명세서.md §3.3(vendor_availability), §3.9(RLS), §3.11(이행 확인),
--       F-V-17(업체 가능 시간대 등록)
-- =============================================================================
-- 이 파일이 다루는 범위
--  * `vendor_availability` **한 테이블만** 만든다. 같은 S4-02 에 묶인
--    `consultations`·`consultation_deposits` 는 4단계 예약 흐름과 함께 별도로 추가한다.
--  * `vendor_availability` 를 먼저 만드는 이유: 이것은 **업체 도메인(§3.3) 테이블**이고
--    업체 어드민의 시간대 등록 화면이 예약 기능보다 먼저 필요하다.
--
-- 설계 원칙
--  * **요일 단위 반복 규칙**이다. 특정 날짜의 예외(휴무·마감)는 이 테이블이 아니라
--    `inventory_slots` 의 블록 처리로 다룬다(§3.3 비고). 두 곳에 날짜 예외를 두지 않는다.
--  * 같은 업체·같은 요일에 **시간대가 겹치면** 어느 규칙으로 슬롯을 쪼갤지 비결정적이 된다.
--    0006(요율)과 같은 이유로 DB 가 입력 자체를 거부한다.
--  * 기존 마이그레이션은 수정하지 않는다. RLS 정책은 CLAUDE.md §5.5 에 따라
--    **같은 파일의 별도 섹션**에 둔다(0006 과 동일한 형식).
-- =============================================================================

-- time 에는 기본 range 타입이 없다. 겹침 판정을 DB 로 내리려면 range 가 필요하다.
create type public.timerange as range (subtype = time);

comment on type public.timerange is
  '시각 구간. vendor_availability 의 겹침 판정 전용이며 날짜는 담지 않는다.';

create table public.vendor_availability (
  id           uuid primary key default gen_random_uuid(),
  vendor_id    uuid not null references public.vendors (id) on delete cascade,
  -- 0=일요일 … 6=토요일. Postgres `extract(dow from date)` 와 같은 규약이라
  -- 슬롯 생성 시 변환 없이 바로 대조할 수 있다.
  weekday      smallint not null,
  start_time   time not null,
  end_time     time not null,
  -- 이 구간을 몇 분 단위로 쪼개 예약을 받는지.
  slot_minutes integer not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint vendor_availability_weekday_range
    check (weekday >= 0 and weekday <= 6),

  -- 자정을 넘는 구간은 허용하지 않는다. 상담·탐방 시간대에 필요한 형태가 아니며,
  -- 허용하면 겹침 판정과 슬롯 생성이 양쪽 다 복잡해진다.
  -- 심야 운영이 실제로 필요해지면 요일을 나눠 두 행으로 등록한다.
  constraint vendor_availability_time_order
    check (end_time > start_time),

  constraint vendor_availability_slot_minutes_range
    check (slot_minutes > 0 and slot_minutes <= 1440),

  -- 구간보다 긴 슬롯은 예약 가능한 칸이 하나도 안 나온다. 등록 시점에 막는다.
  constraint vendor_availability_slot_fits
    check (extract(epoch from (end_time - start_time)) >= slot_minutes * 60)
);

-- 같은 업체·같은 요일에서 시간대가 겹치면 슬롯 생성 결과가 비결정적이 된다.
-- 오전·오후로 나눈 두 행처럼 **맞닿기만 하는** 구간은 허용된다(반개구간 '[)').
alter table public.vendor_availability
  add constraint vendor_availability_no_overlap
  exclude using gist (
    vendor_id with =,
    weekday with =,
    public.timerange(start_time, end_time, '[)') with &&
  );

comment on table public.vendor_availability is
  '상담·탐방 가능 시간대(F-V-17). 요일 단위 반복 규칙이며 날짜 예외는 inventory_slots 로 다룬다.';
comment on column public.vendor_availability.weekday is
  '0=일요일 … 6=토요일. extract(dow from date) 와 같은 규약.';
comment on column public.vendor_availability.slot_minutes is
  '예약 슬롯 길이(분). 구간 길이보다 클 수 없다.';

-- 조회 경로: 업체 상세 화면이 "이 업체의 요일별 가능 시간"을 통째로 읽는다.
create index if not exists idx_vendor_availability_vendor_weekday
  on public.vendor_availability (vendor_id, weekday, start_time);

select public.attach_set_updated_at('vendor_availability');

-- =============================================================================
-- RLS (§3.9)
--
-- 형제 테이블인 `inventory_slots`(0005 [26])와 같은 성격이라 같은 정책 형태를 쓴다.
--  * active 업체의 가능 시간대는 **공개 열람**이다. 예약 화면이 로그인 전에도
--    "언제 상담이 가능한지" 를 보여줘야 한다.
--  * 등록·수정·삭제는 업체 멤버. **staff 도 가능하다** —
--    §3.9 가 staff 에게 막는 것은 **가격·정산** 테이블이고 일정은 거기 해당하지 않는다.
--  * 운영자는 정책을 두지 않는다. 서비스롤 경유 Route Handler 로만 접근한다.
-- =============================================================================

alter table public.vendor_availability enable row level security;

-- [01] 공개 열람 — active 업체만
create policy vendor_availability_select_public on public.vendor_availability
  for select to anon, authenticated
  using (exists (
    select 1 from public.vendors v
    where v.id = vendor_availability.vendor_id and v.status = 'active'
  ));

-- [02] 멤버 열람 — 심사 중(pending)이어도 자기 업체는 본다
create policy vendor_availability_select_member on public.vendor_availability
  for select to authenticated
  using (public.is_vendor_member(vendor_id));

create policy vendor_availability_insert on public.vendor_availability
  for insert to authenticated
  with check (public.is_vendor_member(vendor_id));

create policy vendor_availability_update on public.vendor_availability
  for update to authenticated
  using (public.is_vendor_member(vendor_id))
  with check (public.is_vendor_member(vendor_id));

create policy vendor_availability_delete on public.vendor_availability
  for delete to authenticated
  using (public.is_vendor_member(vendor_id));

-- =============================================================================
-- 이 파일이 생성한 것
--   테이블 1 — vendor_availability
--   타입 1 — timerange (time 구간 겹침 판정용)
--   제약 — CHECK 4(요일 범위·시각 순서·슬롯 길이 범위·슬롯이 구간에 들어감),
--          EXCLUDE 1(같은 업체·요일 시간대 겹침), FK 1
--   인덱스 1, RLS 정책 5
-- =============================================================================
