-- =============================================================================
-- 0028 · 분할 결제 · 정산 스냅샷 · 플래너 정산 (S5-01 잔여분)
-- 근거: docs/07_개발명세서.md §3.4 payment_schedules·payments·settlements·
--       planner_settlements·bookings, §3.8 요율 스냅샷 NOTE, §3.9 RLS,
--       §7.4 가변 파라미터, D-16·D-17·D-21·D-23·D-27·D-28
-- =============================================================================
-- S5-01 은 요율 두 테이블(0006)까지 끝내고 `[~]` 로 남았다. 남은 것이 이 파일이다 —
-- `payment_schedules`·`planner_settlements` 신규 2테이블, `bookings` 스냅샷 컬럼 2개,
-- `settlements.fee_rate_bp`, `payments.payment_schedule_id`.
--
-- **화면·결제 실행은 이번 범위가 아니다**(S5-06 분할 결제 · S5-07 정산). 여기서는
-- 스키마·RLS·불변식까지이며, 도메인 계산은 `lib/core/payment/payment.ts` 가 갖는다.
--
-- 이 파일이 정한 것 — 판단이 필요했던 지점과 근거
--
--  1. **비율 합 10000bp 는 DEFERRABLE 제약 트리거가 강제한다.**
--     회차는 한 트랜잭션 안에서 **행 단위로** 들어온다. 즉시 판정하는 트리거는 첫 행에서
--     합 2000 을 보고 거절하므로 쓸 수 없다. 그래서 판정 시점을 **커밋**으로 미룬다
--     (`constraint trigger ... deferrable initially deferred`). CHECK 로는 다른 행을 볼 수
--     없고, 합계 컬럼을 따로 두면 그 컬럼이 두 번째 진실이 된다.
--     **애플리케이션에서만 검사하지 않는 이유** — 회차를 만드는 경로가 앞으로 여럿이다
--     (계약 발행 · 재발행 · 운영 보정). 한 경로만 검사를 빠뜨리면 합이 99% 인 계약이
--     조용히 생기고, 그 계약은 잔금을 다 받아도 미납으로 남는다.
--     회차가 **0건인 상태는 통과**시킨다 — 아직 스케줄을 만들지 않은 계약(draft)이
--     정상이며, 0건을 막으면 계약을 먼저 만들 수 없다.
--
--  2. **기한 조건은 '기준 사건 + 며칠'로 분해한다.** 자유 텍스트도 jsonb 도 아니다.
--     자유 텍스트면 배치가 `due_at` 을 계산할 수 없고("예식 30일 전" 을 파싱할 수 없다),
--     jsonb 면 형태를 DB 가 검증하지 못한다. 조건은 실제로 두 값이다 — **무엇을 기준으로**
--     (`due_anchor`) **며칠**(`due_offset_days`).
--       · `on_contract`     계약 체결 시. 오프셋 0 만 허용한다.
--       · `before_event`    예식 D-n. 오프셋 1 이상을 요구한다.
--       · `on_preparation`  사전탐방·리허설 등 **이행 준비 시점**. 날짜를 미리 알 수 없어
--                           오프셋이 없고, 그 사건이 일어날 때 서버가 `due_at` 을 찍는다.
--       · `on_fulfillment`  이행 완료 시. 같은 이유로 오프셋이 없다.
--
--  3. **회차 상태는 셋뿐이다**(`scheduled`·`paid`·`void`). '도래'·'연체' 를 값으로 두지
--     않는다 — 그 둘은 `due_at` 과 시계로 **계산되는 값**이고, 상태로 저장하면 갱신 배치가
--     늦은 만큼 화면이 거짓을 말한다. 계산은 `scheduleState()` 한 곳이다.
--
--  4. **요율 스냅샷은 고쳐지지 않는다.** `bookings.applied_fee_rate_bp` 는 한 번 채워지면
--     트리거가 변경을 막는다(§3.4 NOTE — "요율 변경이 과거 거래를 소급 변경하면 정산
--     분쟁이 된다"). 그리고 `status='confirmed'` 로 넘어가려면 **두 요율이 모두 채워져
--     있어야 한다** — 요율 없이 확정된 계약은 나중에 정산할 근거가 없다(§3.8 "조회 결과가
--     없으면 계약 확정을 막는다").
--     플래너를 쓰지 않는 계약은 **0bp** 다. `null` 은 "아직 스냅샷하지 않았다" 라는 뜻이며
--     둘을 같은 값으로 적으면 "플래너 미선택" 과 "요율을 못 찾음" 이 구별되지 않는다.
--
--  5. **고객·업체는 요율 컬럼을 쓸 수 없다.** `bookings_update` 정책(0005)은 커플 소유자와
--     업체 멤버에게 UPDATE 를 열어 뒀는데, 그 상태로 요율 컬럼을 더하면 **당사자가 자기
--     수수료율을 적을 수 있다.** 정책은 행을 가르고 컬럼을 가르지 않으므로, 컬럼 수준
--     권한으로 좁힌다 — `status` 만 남기고 나머지 UPDATE 권한을 회수한다(S4-14 가
--     `vendor_invites.revoked_at` 에 쓴 방법과 같다). 금액·요율은 서비스롤의 일이다.
--
--  6. **`settlements.fee_rate` 를 `fee_rate_bp` 로 바꾼다.** 기존 컬럼은 `numeric` 이고
--     명세 §3.4 는 `fee_rate_bp`(스냅샷)를 적고 있다. 두 컬럼을 함께 두면 요율의 진실이
--     둘이 되고, 어느 쪽으로 계산했는지에 따라 정산액이 갈린다. 리포 전체가 bp 정수를
--     쓰므로(§6 부동소수점 금지) **기존 컬럼을 떨어뜨린다.** 정산을 만드는 경로가 아직
--     없어(S5-07 미착수) 데이터가 없다 — 지금이 바꿀 수 있는 마지막 시점이다.
--
--  7. **`settlements` 열람을 대표로 좁힌다.** 0005 는 `is_vendor_member` 로 열어 뒀는데,
--     S2-08 은 이미 "정산 금액은 업체 대표 계정만 볼 수 있습니다" 를 화면에서 판정하고
--     있었다(`canSeeFinancials`). 판정이 앱에만 있으면 경계가 RLS 가 아니라 코드다.
--     §3.9 는 staff 의 정산 **UPDATE** 를 막는데(UPDATE 정책은 어느 역할에도 없다),
--     읽기까지 좁히는 것은 그보다 강한 선택이므로 **명세 §3.9 문구 보완을 함께 제안한다**
--     (CLAUDE.md §7.5).
--
--  8. **웹훅 원문을 그대로 보관하지 않는다.** 아래 `payments.raw_webhook_json` CHECK 주석
--     참조. PG 웹훅에는 카드·구매자 식별정보가 섞여 오고 §7.3 은 그것을 남기지 말라고
--     한다. 대신 **정규화 스냅샷 + 원문 해시**를 남긴다 — 원문 없이도 "우리가 받은 것이
--     이것이었다" 를 증명할 수 있고 원문은 PG 사에 남아 있다.
--
--  9. **쿠폰(D-27)은 이번에 만들지 않는다.** `coupons`·`coupon_issues`·
--     `coupon_redemptions` 는 **명세 §3 에도 커버리지 표에도 없다.** 없는 명세를 근거로
--     스키마를 지어내면 그 스키마가 명세를 앞지른다(CLAUDE.md §7.5·§7.6). 태스크 신설을
--     제안하고 여기서는 만들지 않는다.
-- =============================================================================

-- =============================================================================
-- 1) payment_schedules — 결제 N회 분할 (D-21)
-- =============================================================================
create table if not exists public.payment_schedules (
  id              uuid primary key default gen_random_uuid(),
  contract_id     uuid not null references public.contracts (id) on delete cascade,
  seq             integer not null,
  ratio_bp        integer not null,
  due_anchor      text not null,
  due_offset_days integer,
  /** 확정된 기한. 기준 사건이 아직 일어나지 않았으면 null 이다. */
  due_at          timestamptz,
  amount          bigint not null,
  status          text not null default 'scheduled',
  paid_at         timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint payment_schedules_seq_positive check (seq >= 1),
  -- 한 회차가 0bp 이면 회차가 아니고, 10000bp 를 넘으면 다른 회차가 음수가 된다.
  constraint payment_schedules_ratio_range check (ratio_bp > 0 and ratio_bp <= 10000),
  constraint payment_schedules_amount_nonneg check (amount >= 0),
  constraint payment_schedules_anchor_values
    check (due_anchor in ('on_contract', 'before_event', 'on_preparation', 'on_fulfillment')),
  -- 기준 사건별로 오프셋의 뜻이 다르다. 아무 조합이나 통과하면 배치가 기한을 계산할 수 없다.
  constraint payment_schedules_offset_shape
    check (
      (due_anchor = 'on_contract' and due_offset_days = 0)
      or (due_anchor = 'before_event' and due_offset_days >= 1)
      or (due_anchor in ('on_preparation', 'on_fulfillment') and due_offset_days is null)
    ),
  constraint payment_schedules_status_values check (status in ('scheduled', 'paid', 'void')),
  -- 완료의 짝. 상태와 시각이 어긋나면 어느 쪽이 진실인지 알 수 없다.
  constraint payment_schedules_paid_pair check ((status = 'paid') = (paid_at is not null)),

  unique (contract_id, seq)
);

comment on table public.payment_schedules is
  '결제 회차(D-21). 계약 1건에 회차 N개이며 초기 운영은 2회다. 비율 합 10000bp 는 커밋 시점에 제약 트리거가 판정한다 — 회차가 행 단위로 들어오므로 즉시 판정으로는 첫 행에서 걸린다.';
comment on column public.payment_schedules.ratio_bp is
  '회차 비율(bp). **값은 코드가 아니라 app_settings.payment.split_ratios_bp 가 갖는다**(§7.4) — 20/80 을 코드에 박지 않는다. 합은 트리거가 10000 으로 강제한다.';
comment on column public.payment_schedules.due_anchor is
  'on_contract(계약 체결 시) | before_event(예식 D-n) | on_preparation(사전탐방·리허설 등 이행 준비 시점) | on_fulfillment(이행 완료 시). 자유 텍스트로 두지 않는 이유는 배치가 기한을 계산해야 하기 때문이다.';
comment on column public.payment_schedules.due_offset_days is
  '기준 사건으로부터의 일수. before_event 는 며칠 전인지이며 1 이상이다. 날짜를 미리 알 수 없는 기준(on_preparation·on_fulfillment)에서는 null 이고 사건 발생 시 서버가 due_at 을 찍는다.';
comment on column public.payment_schedules.amount is
  '이 회차의 청구 금액. 총액을 비율로 나눌 때 생기는 잔여는 **마지막 회차가 흡수한다**(lib/core/payment/payment.ts splitAmount). 회차 합이 총액과 어긋나지 않게 하는 책임은 그 순수 함수와 테스트가 진다 — 총액이 재발행으로 바뀔 수 있어 DB 제약으로 묶으면 총액 수정 자체가 막힌다.';
comment on column public.payment_schedules.status is
  'scheduled | paid | void. **도래·연체를 값으로 두지 않는다** — due_at 과 시계로 계산되는 값이며 저장하면 배치가 늦은 만큼 화면이 거짓을 말한다(scheduleState()).';

create index if not exists idx_payment_schedules_contract_id
  on public.payment_schedules (contract_id);
-- 기한 도래 배치가 훑는 경로. 완료된 회차는 볼 이유가 없다.
create index if not exists idx_payment_schedules_due
  on public.payment_schedules (due_at)
  where status = 'scheduled';

select public.attach_set_updated_at('payment_schedules');

-- ── 비율 합 = 10000bp (커밋 시점 판정) ──────────────────────────────────────
create or replace function public.assert_payment_schedule_ratio_sum()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_contract uuid;
  v_count integer;
  v_sum integer;
begin
  -- **DELETE 에서 new 를 읽으면 안 된다.** plpgsql 은 그 경우 new 를 배정하지 않아
  -- 필드 접근 자체가 오류다(coalesce 로도 피할 수 없다).
  if tg_op = 'DELETE' then v_contract := old.contract_id;
  else v_contract := new.contract_id;
  end if;

  select count(*), coalesce(sum(ratio_bp), 0)
    into v_count, v_sum
  from public.payment_schedules
  where contract_id = v_contract and status <> 'void';

  -- 아직 회차를 만들지 않은 계약은 정상이다. 0건을 막으면 계약을 먼저 만들 수 없다.
  if v_count = 0 then return null; end if;

  if v_sum <> 10000 then
    raise exception '계약 % 의 결제 회차 비율 합이 %bp 입니다. 10000bp 여야 합니다.', v_contract, v_sum
      using errcode = 'check_violation', constraint = 'payment_schedules_ratio_sum';
  end if;

  return null;
end;
$$;

comment on function public.assert_payment_schedule_ratio_sum() is
  '결제 회차 비율 합 판정. **DEFERRABLE INITIALLY DEFERRED** 라 커밋 시점에 돈다 — 회차가 행 단위로 들어오므로 즉시 판정하면 첫 행에서 거절된다. void 회차는 합에서 뺀다(취소된 회차가 남아 합을 깨지 않도록).';

drop trigger if exists trg_payment_schedules_ratio_sum on public.payment_schedules;
create constraint trigger trg_payment_schedules_ratio_sum
  after insert or update or delete on public.payment_schedules
  deferrable initially deferred
  for each row execute function public.assert_payment_schedule_ratio_sum();

-- =============================================================================
-- 2) bookings — 요율 스냅샷 (D-16 · D-17, §3.4 NOTE)
-- =============================================================================
alter table public.bookings add column if not exists applied_fee_rate_bp integer;
alter table public.bookings add column if not exists applied_planner_fee_rate_bp integer;

alter table public.bookings drop constraint if exists bookings_applied_fee_rate_range;
alter table public.bookings
  add constraint bookings_applied_fee_rate_range
  check (
    (applied_fee_rate_bp is null or (applied_fee_rate_bp >= 0 and applied_fee_rate_bp <= 10000))
    and (
      applied_planner_fee_rate_bp is null
      or (applied_planner_fee_rate_bp >= 0 and applied_planner_fee_rate_bp <= 10000)
    )
  );

comment on column public.bookings.applied_fee_rate_bp is
  '계약 확정 시점의 업체 수수료율 스냅샷(bp · D-16). **이후 commission_rates 변경에 소급되지 않는다**(§3.4 NOTE). null 은 "아직 스냅샷하지 않았다" 이며, confirmed 로 넘어갈 때 트리거가 채워져 있기를 요구한다. 한 번 채워지면 트리거가 변경을 막는다.';
comment on column public.bookings.applied_planner_fee_rate_bp is
  '계약 확정 시점의 플래너 수수료율 스냅샷(bp · D-17). **플래너를 쓰지 않는 계약은 0** 이다 — null 은 "아직 스냅샷하지 않았다" 라는 뜻이므로 "미선택" 과 같은 값으로 적으면 둘을 구별할 수 없다.';

create or replace function public.assert_booking_rate_snapshot()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- 스냅샷은 나중에 고쳐지지 않는다. 고칠 수 있으면 스냅샷이 아니라 그냥 값이다.
  if old.applied_fee_rate_bp is not null
     and new.applied_fee_rate_bp is distinct from old.applied_fee_rate_bp then
    raise exception '확정된 수수료율 스냅샷은 바꿀 수 없습니다.' using errcode = 'check_violation';
  end if;

  if old.applied_planner_fee_rate_bp is not null
     and new.applied_planner_fee_rate_bp is distinct from old.applied_planner_fee_rate_bp then
    raise exception '확정된 플래너 수수료율 스냅샷은 바꿀 수 없습니다.' using errcode = 'check_violation';
  end if;

  -- 요율 없이 확정된 계약은 나중에 정산할 근거가 없다(§3.8).
  if new.status = 'confirmed' and old.status <> 'confirmed' then
    if new.applied_fee_rate_bp is null or new.applied_planner_fee_rate_bp is null then
      raise exception '요율 스냅샷 없이 계약을 확정할 수 없습니다. 플래너를 쓰지 않으면 0 을 적습니다.'
        using errcode = 'check_violation', constraint = 'bookings_rate_snapshot_required';
    end if;
  end if;

  return new;
end;
$$;

comment on function public.assert_booking_rate_snapshot() is
  '요율 스냅샷 불변식(D-16·D-17). (가) 한 번 채워진 스냅샷은 못 바꾼다 (나) confirmed 전이에는 두 요율이 모두 있어야 한다. 플래너 미선택은 0 이고 null 이 아니다.';

drop trigger if exists trg_bookings_rate_snapshot on public.bookings;
create trigger trg_bookings_rate_snapshot
  before update on public.bookings
  for each row execute function public.assert_booking_rate_snapshot();

-- 당사자가 자기 수수료율을 적을 수 없게 컬럼 수준으로 좁힌다(위 근거 5).
-- 정책은 행을 가르고 컬럼을 가르지 않으므로, 정책만으로는 막을 수 없다.
revoke update on public.bookings from authenticated, anon;
grant update (status) on public.bookings to authenticated;

-- =============================================================================
-- 3) settlements — 요율을 bp 스냅샷으로 (§3.4)
-- =============================================================================
alter table public.settlements add column if not exists fee_rate_bp integer;

-- 기존 numeric 요율에서 옮긴다. 정산을 만드는 경로가 아직 없어 실제로는 0행이지만,
-- 마이그레이션이 데이터 유무를 가정하지 않는다.
update public.settlements
set fee_rate_bp = round(fee_rate * 10000)::int
where fee_rate_bp is null;

alter table public.settlements alter column fee_rate_bp set not null;
alter table public.settlements alter column fee_rate_bp set default 0;

alter table public.settlements drop constraint if exists settlements_fee_rate_bp_range;
alter table public.settlements
  add constraint settlements_fee_rate_bp_range
  check (fee_rate_bp >= 0 and fee_rate_bp <= 10000);

-- 요율의 진실을 둘로 두지 않는다(위 근거 6).
alter table public.settlements drop column if exists fee_rate;

comment on column public.settlements.fee_rate_bp is
  '적용 수수료율 스냅샷(bp). **계약 시점 스냅샷(bookings.applied_fee_rate_bp)을 집계한 값이며 정산 시점 요율로 재계산하지 않는다**(§3.4). 값은 코드에 없다(O-02). 0028 에서 numeric fee_rate 를 이 컬럼으로 대체했다 — 요율의 진실이 둘이면 어느 쪽으로 계산했는지에 따라 정산액이 갈린다.';

-- 정산액 정합. 순액은 총액에서 수수료를 뺀 값이며 그 관계가 깨지면 정산서가 거짓이 된다.
alter table public.settlements drop constraint if exists settlements_net_amount_shape;
alter table public.settlements
  add constraint settlements_net_amount_shape
  check (fee_amount <= gross_amount and net_amount = gross_amount - fee_amount);

-- 열람을 대표로 좁힌다(위 근거 7). S2-08 이 앱에서만 판정하던 것을 DB 로 내린다.
drop policy if exists settlements_select on public.settlements;
create policy settlements_select on public.settlements for select to authenticated
  using (public.is_vendor_owner(vendor_id));

comment on policy settlements_select on public.settlements is
  '정산 금액은 업체 대표만 본다. S2-08 이 화면에서 "정산 금액은 업체 대표 계정만 볼 수 있습니다" 로 판정하고 있었으나 경계가 앱 코드에 있었다 — 인가의 최종 경계는 RLS 다.';

-- =============================================================================
-- 4) planner_settlements — 플래너 수수료 원장 (D-17 · D-21)
-- =============================================================================
create table if not exists public.planner_settlements (
  id           uuid primary key default gen_random_uuid(),
  planner_id   uuid not null references public.planners (id) on delete restrict,
  booking_id   uuid not null references public.bookings (id) on delete restrict,
  gross_amount bigint not null,
  /** 적용 요율 스냅샷. 금액만 남기면 "왜 이 금액인가" 를 재현할 수 없다. */
  fee_rate_bp  integer not null,
  fee_amount   bigint not null,
  /** 계약 성사 시점. 상담만으로는 발생하지 않는다(D-17). */
  earned_at    timestamptz not null,
  /** earned_at + 유예 기간. 유예 값은 app_settings.planner.payout_grace_days 가 갖는다. */
  payable_at   timestamptz not null,
  status       text not null default 'earned',
  paid_at      timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint planner_settlements_amount_nonneg
    check (gross_amount >= 0 and fee_amount >= 0 and fee_amount <= gross_amount),
  constraint planner_settlements_fee_rate_range
    check (fee_rate_bp >= 0 and fee_rate_bp <= 10000),
  constraint planner_settlements_grace_order check (payable_at >= earned_at),
  constraint planner_settlements_status_values
    check (status in ('earned', 'payable', 'paid', 'void')),
  constraint planner_settlements_paid_pair check ((status = 'paid') = (paid_at is not null)),

  -- 한 계약에 한 플래너 정산 1건. 둘이면 같은 계약으로 두 번 지급된다.
  unique (planner_id, booking_id)
);

comment on table public.planner_settlements is
  '플래너 수수료 원장(D-21). **계약 성사 시 earned_at 을 적고 유예 기간이 지나면 payable 로 전환**한다(cron planner-payout-due). 플랫폼이 플래너에게 지급하는 원장이므로 커플·업체는 열람하지 않는다.';
comment on column public.planner_settlements.earned_at is
  '수수료가 발생한 시점 = 계약 성사 시점(D-17). **상담만 받고 계약하지 않으면 이 행이 생기지 않는다.**';
comment on column public.planner_settlements.payable_at is
  '지급 대상이 되는 시점. earned_at + app_settings.planner.payout_grace_days 이며 **유예 일수를 코드에 박지 않는다**(§7.4). 이 시각 전에는 payable 로 넘길 수 없다(트리거).';
comment on column public.planner_settlements.status is
  'earned(발생) | payable(지급 대상) | paid(지급 완료) | void(무효). payable 전환은 배치가 하지만, 화면 판정은 payable_at 과 시계로 계산한다(plannerPayoutState()) — 배치가 늦어도 화면이 거짓을 말하지 않는다.';

create index if not exists idx_planner_settlements_planner_id
  on public.planner_settlements (planner_id);
create index if not exists idx_planner_settlements_booking_id
  on public.planner_settlements (booking_id);
-- 지급 전환 배치가 훑는 경로.
create index if not exists idx_planner_settlements_payable
  on public.planner_settlements (payable_at)
  where status = 'earned';

select public.attach_set_updated_at('planner_settlements');

-- 유예 기간이 지나기 전에는 지급 대상이 될 수 없다. CHECK 로는 쓸 수 없다 —
-- now() 는 IMMUTABLE 이 아니다.
create or replace function public.assert_planner_settlement_payable()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status in ('payable', 'paid') and new.payable_at > now() then
    raise exception '유예 기간이 지나지 않은 플래너 정산은 지급 대상이 될 수 없습니다.'
      using errcode = 'check_violation', constraint = 'planner_settlements_grace_not_elapsed';
  end if;

  return new;
end;
$$;

comment on function public.assert_planner_settlement_payable() is
  '유예 경계 판정. 배치가 실수로 일찍 전환하는 것을 DB 가 막는다 — 유예는 고객 환불·분쟁 창구가 닫히기를 기다리는 기간이라 앞당기면 회수할 수 없는 돈이 나간다.';

drop trigger if exists trg_planner_settlements_payable on public.planner_settlements;
create trigger trg_planner_settlements_payable
  before insert or update on public.planner_settlements
  for each row execute function public.assert_planner_settlement_payable();

-- =============================================================================
-- 5) payments — 회차 연결 · 상태 값 집합 · 웹훅 원문 최소화
-- =============================================================================
alter table public.payments add column if not exists payment_schedule_id uuid
  references public.payment_schedules (id) on delete set null;

alter table public.payments drop constraint if exists payments_schedule_purpose_chk;
alter table public.payments
  add constraint payments_schedule_purpose_chk
  check (payment_schedule_id is null or purpose <> 'membership');

comment on column public.payments.payment_schedule_id is
  '연결된 결제 회차(§3.4). 멤버십 결제에는 회차가 없다(CHECK). 회차당 성공 결제는 하나뿐이며 부분 유니크가 그것을 강제한다 — 같은 회차를 두 번 받으면 환불로만 되돌릴 수 있다.';

-- **회차당 성공 결제는 하나뿐이다.** 실패·취소는 여러 번 있을 수 있다(재시도).
create unique index if not exists uq_payments_schedule_paid
  on public.payments (payment_schedule_id)
  where status = 'paid' and payment_schedule_id is not null;

create index if not exists idx_payments_schedule_id
  on public.payments (payment_schedule_id);

-- 상태 값 집합. 0003 은 text + 기본값만 두고 열거하지 않았다 — 값이 자유로우면
-- 'paid' 와 'PAID' 가 섞이고 위 부분 유니크가 조용히 새어 나간다.
-- 목록은 `lib/core/payment/payment.ts` 의 PAYMENT_STATUSES 와 같아야 하며
-- `db:rls` 가 정합을 본다(0023 이 알림 토픽에서 겪은 일을 되풀이하지 않기 위해서다).
alter table public.payments drop constraint if exists payments_status_values;
alter table public.payments
  add constraint payments_status_values
  check (status in ('pending', 'paid', 'failed', 'cancelled', 'partially_refunded', 'refunded'));

-- ── 웹훅 원문 (위 근거 8) ───────────────────────────────────────────────────
-- PG 웹훅에는 카드 정보·구매자 이름·연락처가 섞여 온다. §7.3 은 그것을 남기지 말라고
-- 하고, 동시에 D-23 은 분쟁에 쓸 증적을 요구한다. 둘을 다 지키는 방법은 **원문을
-- 보관하지 않고 원문의 해시를 보관하는 것**이다 — 무엇을 받았는지 증명할 수 있고
-- 원문 자체는 PG 사에 남아 있다.
--
-- 이 CHECK 는 **최상위 키만** 본다(jsonb ?| 의 한계). 중첩된 식별정보까지 잡지는
-- 못하므로 최종 책임은 적재 코드에 있고, 이 제약은 가장 흔한 사고를 막는 층이다.
alter table public.payments drop constraint if exists payments_webhook_no_pii;
alter table public.payments
  add constraint payments_webhook_no_pii
  check (
    raw_webhook_json is null
    or not (raw_webhook_json ?| array[
      'card', 'virtualAccount', 'giftCertificate', 'mobilePhone', 'receipt', 'cashReceipt',
      'customerName', 'customerEmail', 'customerMobilePhone', 'buyer', 'orderName'
    ])
  );

comment on column public.payments.raw_webhook_json is
  '웹훅의 **정규화·최소화 스냅샷**이다. 원문을 그대로 넣지 않는다(§7.3) — 카드·구매자 식별정보가 섞여 오기 때문이다. 담는 것은 provider·eventId·status·amount·currency·approvedAt·methodType 수준이며, 원문 무결성은 payment_webhook_events.payload_digest 가 증명한다. 금지 키 CHECK 는 최상위만 본다.';

-- =============================================================================
-- 6) payment_webhook_events — 수신 → 멱등 확인 → 상태 전이
-- =============================================================================
-- 멱등의 두 방향을 구분한다.
--   **나가는 요청**: `payments.idempotency_key`(0003, unique). 같은 결제 시도를 두 번
--     보내지 않게 PG 에 넘기는 열쇠이며, 구성 규칙은 `paymentIdempotencyKey()` 가 갖는다.
--   **들어오는 웹훅**: 이 표. PG 는 같은 이벤트를 **여러 번 보낸다**(재시도가 정상 동작).
--     그래서 수신 측이 이벤트 식별자로 중복을 접어야 한다. `payments` 에 그 상태를 담으면
--     "결제 한 건 : 이벤트 여러 건" 을 표현할 수 없다.
create table if not exists public.payment_webhook_events (
  id             uuid primary key default gen_random_uuid(),
  provider       text not null,
  /** PG 가 준 이벤트 식별자. 중복 판정의 열쇠다. */
  event_id       text not null,
  event_type     text,
  /** 아직 우리 결제를 못 찾았을 수 있다(웹훅이 먼저 도착). 그때도 기록은 남긴다. */
  payment_id     uuid references public.payments (id) on delete set null,
  payment_key    text,
  status         text not null default 'received',
  /** 원문의 sha256. **원문을 보관하지 않고** 무엇을 받았는지 증명한다(§7.3). */
  payload_digest text not null,
  signature_ok   boolean,
  attempt_count  integer not null default 1,
  last_error     text,
  received_at    timestamptz not null default now(),
  processed_at   timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint payment_webhook_events_status_values
    check (status in ('received', 'processed', 'duplicate', 'ignored', 'failed')),
  constraint payment_webhook_events_processed_pair
    check ((status = 'processed') = (processed_at is not null)),
  constraint payment_webhook_events_attempt_positive check (attempt_count >= 1),
  constraint payment_webhook_events_digest_shape check (payload_digest ~ '^[0-9a-f]{64}$'),

  -- **멱등의 지점.** 같은 이벤트를 두 번 처리하지 않는다. 행을 먼저 만들고 유니크
  -- 충돌을 '중복' 으로 읽는 방식은 S4-08 이 보증금에서 쓴 것과 같다.
  unique (provider, event_id)
);

comment on table public.payment_webhook_events is
  '결제 웹훅 수신 원장. **원문을 담지 않고 해시만** 담는다(§7.3). (provider, event_id) 유니크가 멱등의 지점이며, 상태 전이는 이 표를 지난 뒤에만 일어난다. 클라이언트 정책을 두지 않는다 — 서버(서비스롤) 전용이다.';
comment on column public.payment_webhook_events.payload_digest is
  '원문 본문의 sha256 16진 소문자. 원문을 보관하지 않고도 "우리가 받은 것이 이것이었다" 를 증명한다. 원문은 PG 사에 남아 있으므로 분쟁 시 대조할 수 있다.';
comment on column public.payment_webhook_events.attempt_count is
  '같은 이벤트가 다시 온 횟수. PG 재시도는 정상 동작이라 오류가 아니며, 세어 두면 우리 처리 실패를 알아볼 수 있다.';

create index if not exists idx_payment_webhook_events_payment_id
  on public.payment_webhook_events (payment_id);
create index if not exists idx_payment_webhook_events_status
  on public.payment_webhook_events (status);

select public.attach_set_updated_at('payment_webhook_events');

-- =============================================================================
-- 7) RLS (§3.9)
-- -----------------------------------------------------------------------------
-- **쓰기 정책을 어느 표에도 주지 않는다.** 회차 생성·정산·웹훅 처리는 전부 서버의 일이며
-- 정책이 없으면 기본 거부다(0019 가 entity_events 에 쓴 방식과 같다).
--
-- 읽기 판정 기준
--   payment_schedules  — 결제 조건이므로 `payments` 와 같은 기준으로 판정한다:
--                        커플은 **owner 만**(§3.9 "결제·계약 서명은 owner 추가 조건"),
--                        업체는 멤버 전원(회차 일정은 응대에 필요한 운영 정보다).
--   planner_settlements — **플래너 본인만.** 커플·업체에 주지 않는다 — 고객이 낸 금액은
--                        bookings·payments 가 말하고, 이 표는 플랫폼이 플래너에게
--                        지급하는 원장이다. 업체가 남의 수입을 볼 이유가 없다.
--   payment_webhook_events — 아무 정책도 주지 않는다. 결제사 이벤트는 당사자에게 보여줄
--                        정보가 아니고, 보여줄 것은 payments 의 상태다.
-- =============================================================================
alter table public.payment_schedules enable row level security;

-- 조인 결과가 RLS 에 다시 걸리지 않도록 definer 헬퍼로 감싼다(0016 cart_couple_id 와 같은 방식).
create or replace function public.contract_booking_id(p_contract_id uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select c.booking_id from public.contracts c where c.id = p_contract_id;
$$;

comment on function public.contract_booking_id(uuid) is
  '계약이 가리키는 예약. payment_schedules 정책이 계약 → 예약 → 당사자로 내려가기 위한 것이다.';

create or replace function public.booking_couple_id(p_booking_id uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select b.couple_id from public.bookings b where b.id = p_booking_id;
$$;

create or replace function public.booking_vendor_id(p_booking_id uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select b.vendor_id from public.bookings b where b.id = p_booking_id;
$$;

create policy payment_schedules_select on public.payment_schedules for select to authenticated
  using (
    public.is_couple_owner(public.booking_couple_id(public.contract_booking_id(contract_id)))
    or public.is_vendor_member(public.booking_vendor_id(public.contract_booking_id(contract_id)))
  );

alter table public.planner_settlements enable row level security;

create policy planner_settlements_select on public.planner_settlements for select to authenticated
  using (exists (
    select 1 from public.planners p
    where p.id = planner_settlements.planner_id and p.user_id = auth.uid()
  ));

alter table public.payment_webhook_events enable row level security;

-- =============================================================================
-- 8) 운영 파라미터 (§7.4 — 값을 코드에 박지 않는다)
-- -----------------------------------------------------------------------------
-- `seed.sql` 이 `payment.split_ratios_bp`·`planner.payout_grace_days` 를 **미확정
-- (value: null)** 자리로 만들어 뒀다. 0025 가 보증금 파라미터에서 한 것처럼 **초기 운영값**을
-- 채운다 — 값이 없으면 계산이 아예 서지 않아 다음 태스크가 아무것도 확인할 수 없다.
--
-- `on conflict do update` 를 쓰되 **미확정 자리만** 채운다. 운영이 이미 정한 값을
-- 마이그레이션이 덮으면 배포가 운영 결정을 되돌리는 셈이 된다.
-- =============================================================================
insert into public.app_settings (key, value_json, description)
values
  (
    'payment.split_ratios_bp',
    '{"installments": [{"ratioBp": 2000, "anchor": "on_contract", "offsetDays": 0}, {"ratioBp": 8000, "anchor": "before_event", "offsetDays": 30}], "unit": "bp"}'::jsonb,
    '분할 결제 기본 회차(D-21). 초기 운영은 2회(계약 시 20% · 예식 30일 전 80%)이며 **운영이 배포 없이 바꾼다**. 비율과 기한 조건을 한 행에 두는 이유 — 둘은 회차 단위로 짝이라 두 행으로 쪼개면 길이가 어긋난 상태가 생긴다. 합은 10000bp 여야 하고 DB 트리거가 회차 행에서 다시 판정한다.'
  ),
  (
    'planner.payout_grace_days',
    '{"days": 14, "unit": "days"}'::jsonb,
    '플래너 수수료 지급 유예(일 · D-21). earned_at + 이 일수 = payable_at. 유예를 두는 이유는 고객 환불·분쟁 창구가 닫히기를 기다리는 것이며, 앞당기면 회수할 수 없는 돈이 나간다. 초기 운영값 14일.'
  ),
  (
    'settlement.fee_basis',
    '{"basis": null, "openIssue": "O-15", "status": "undecided"}'::jsonb,
    '수수료를 **할인 전 판매가**(pre_discount)에서 뗄지 **할인 후 실수금**(post_discount)에서 뗄지. **O-15 미결이므로 값을 비워 둔다** — 코드가 기본값을 지어내면 미결정이 조용히 확정된다. 값이 없으면 정산 계산은 명시적으로 실패한다(feeBasisOf()). price_rules 할인(S2-04)이 이미 있으므로 쿠폰(D-27)과 무관하게 답이 필요한 물음이다.'
  )
on conflict (key) do update
  set value_json = excluded.value_json,
      description = excluded.description
  where public.app_settings.value_json ->> 'status' = 'undecided';

-- =============================================================================
-- 9) 증적 열람 (D-23 · 0019 의 방식 그대로)
-- -----------------------------------------------------------------------------
-- 결제·정산은 **상태 전이가 곧 분쟁의 근거**다. 다음 태스크(S5-06·S5-07)가 첫 줄부터
-- `recordEvent()` 로 남길 수 있도록 **열람 정책을 지금 만든다** — 정책 없이 쌓기 시작하면
-- 기록은 남지만 당사자가 자기 기록을 읽지 못하는 상태로 한동안 지나간다(0019 가 삭제요청
-- 이벤트에서 실제로 겪은 일이다).
--
-- `entity_type` 은 테이블 이름이다. `payment` 와 `payment_schedule` 을 같은 이름으로
-- 적으면 `entity_id` 가 어느 표의 행인지 알 수 없어 정책을 쓸 수 없다.
-- =============================================================================
create policy entity_events_select_payment on public.entity_events
  for select to authenticated
  using (
    entity_type = 'payment'
    and exists (
      select 1 from public.payments p
      where p.id = entity_events.entity_id
        and p.booking_id is not null
        and (
          public.is_couple_owner(public.booking_couple_id(p.booking_id))
          or public.is_vendor_member(public.booking_vendor_id(p.booking_id))
        )
    )
  );

create policy entity_events_select_payment_schedule on public.entity_events
  for select to authenticated
  using (
    entity_type = 'payment_schedule'
    and exists (
      select 1 from public.payment_schedules s
      where s.id = entity_events.entity_id
        and (
          public.is_couple_owner(
            public.booking_couple_id(public.contract_booking_id(s.contract_id))
          )
          or public.is_vendor_member(
            public.booking_vendor_id(public.contract_booking_id(s.contract_id))
          )
        )
    )
  );

-- 정산 이벤트는 정산서와 같은 경계다 — 대표만 본다(위 근거 7).
create policy entity_events_select_settlement on public.entity_events
  for select to authenticated
  using (
    entity_type = 'settlement'
    and exists (
      select 1 from public.settlements s
      where s.id = entity_events.entity_id and public.is_vendor_owner(s.vendor_id)
    )
  );

create policy entity_events_select_planner_settlement on public.entity_events
  for select to authenticated
  using (
    entity_type = 'planner_settlement'
    and exists (
      select 1 from public.planner_settlements ps
      join public.planners pl on pl.id = ps.planner_id
      where ps.id = entity_events.entity_id and pl.user_id = auth.uid()
    )
  );

-- =============================================================================
-- 이 파일이 한 것
--   테이블 3 — payment_schedules · planner_settlements · payment_webhook_events
--   컬럼 — bookings +2(요율 스냅샷) · settlements +1(fee_rate_bp, numeric fee_rate 대체) ·
--          payments +1(payment_schedule_id)
--   CHECK 20 · UNIQUE 4(회차 순번 · 플래너×예약 · 웹훅 이벤트 · 회차당 성공 결제)
--   함수 6 — 비율 합 · 요율 스냅샷 · 유예 경계 + 정책 헬퍼 3
--   트리거 3(비율 합은 **DEFERRABLE** 제약 트리거)
--   권한 — bookings UPDATE 를 status 컬럼으로 좁힘
--   정책 — payment_schedules SELECT · planner_settlements SELECT ·
--          settlements SELECT 를 대표로 재작성 · payment_webhook_events 정책 없음
--   app_settings 3 — payment.split_ratios_bp · planner.payout_grace_days ·
--                    settlement.fee_basis(미결 자리)
--   기존 마이그레이션 수정 없음
--   **만들지 않은 것** — 쿠폰 3표(D-27). 명세 §3·커버리지 표에 근거 행이 없다.
-- =============================================================================
