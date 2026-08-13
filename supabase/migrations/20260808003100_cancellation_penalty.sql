-- =============================================================================
-- 0031 · 계약 해지 · 위약금 정산 · 예약 자리 차감 (S5-08)
-- 근거: docs/07_개발명세서.md §2.3 F-A-17, §2.2 F-V-08, §3.4 bookings·contracts·
--       refunds, §3.5 penalty_rules, §5.3, §7.7, D-21 · D-23 · D-24 · T-04
-- =============================================================================
-- 0030 이 **돈을 받는 쪽**을 끝냈고 이 파일은 **돌려주는 쪽**이다. 그리고 S2-05 가
-- "예약이 확정될 때 줄이고 취소될 때 되돌린다" 며 남겨 둔 `inventory_slots.remaining`
-- 자리를 채운다 — 취소를 만들면서 그 반대편을 비워 둘 수는 없다.
--
-- 이 파일이 정한 것 — 판단이 필요했던 지점과 근거
--
--  1. **해지는 계약 단위의 사건이라 표가 필요하다.** `refunds`(0003)는 **결제 단위**다.
--     한 계약에 결제가 여러 건이므로 "이 계약을 해지한다" 를 refunds 로는 표현할 수
--     없고, 양측 확인·귀책·조율 같은 절차 상태를 담을 자리도 없다. 그래서
--     `contract_cancellations` 를 신설한다. **명세 §3.4 에 없는 표**이므로 반영을
--     제안한다(§7.5) — S5-01 이 `payment_webhook_events` 에서 같은 절차를 밟았고
--     명세 v2.3 이 그것을 받았다.
--
--  2. **귀책의 기본값은 `undecided` 다.** 취소를 요청한 쪽이 스스로 "업체 잘못" 이라고
--     적을 수 있으면 **사유 선택 하나가 곧 정산 결과**가 된다. 그래서 주장(`*_claim`)과
--     확정(양측 일치 또는 운영자 결정)을 컬럼으로 나눈다. 귀책이 미정인 채로는
--     `settled` 로 갈 수 없다(트리거).
--
--  3. **무응답을 동의로 읽지 않는다.** S4-07 은 상담 보증금에서 "양측 무응답의 기본값은
--     환불" 로 정했다 — 금액이 소액·정형이고 방향이 하나였기 때문이다. 계약 해지는
--     금액이 크고 **귀책에 따라 결과가 정반대**라 기본값을 만들 수 없다. 기한이 지나면
--     `disputed` 로 보낸다. 조율 큐는 S4-07 과 **같은 모양**(상태 + 부분 인덱스)이다.
--
--  4. **산정 결과를 스냅샷으로 박는다.** 위약금 구간·요율은 `penalty_rules` 가 바뀌면
--     달라진다. 확정 시점의 밴드·기준·금액을 남기지 않으면 나중에 "왜 이 금액이었나" 를
--     재현할 수 없고, 그것이 분쟁의 쟁점이다(D-23 — 0029 가 계약 해시로 푼 것과 같은 문제).
--
--  5. **`penalty_rules` 를 밴드 구조로 바꾼다.** 기존 컬럼은 `cancel_window text` +
--     `standard_rate numeric` 인데, 엔진(T-04 `calculatePenalty`)이 요구하는 것은
--     **일수 구간 + bp 정수 + 계약금 반환 여부**다. text 구간("예식 30일 전")은 배치도
--     엔진도 해석할 수 없고, numeric 요율은 리포 전체의 bp 정수 원칙(§6)과 어긋난다.
--     정산을 만드는 경로가 아직 없어 **이 표는 0행**이다 — 지금이 바꿀 수 있는 마지막
--     시점이다(0028 이 `settlements.fee_rate` 에서 내린 것과 같은 판단).
--
--  6. **위약금 시드를 넣지 않는다.** T-04 가 만든 수치는 **법무 검수 전 가정치**이고,
--     DB 에 넣는 순간 그것이 운영 기준처럼 굳는다 — 0029 가 조항 문안에서 내린 판단과
--     같다. 대신 로더가 **DB 에 확정 룰이 있으면 그것을 쓰고 없으면 코드의 가정치를
--     쓰되 `isDraft` 를 화면까지 실어 보낸다.** 확정되면 **시드만 넣으면** 코드 변경
--     없이 전환된다. `is_draft` 컬럼이 그 전환을 표시한다.
--
--  7. **예약 확정과 계약 확정은 다른 사건이다.** 계약 확정은 3자 서명이 끝난 것이고,
--     예약 확정은 그 결과로 **자리를 잡는 것**이다. `inventory_slots.remaining` 이
--     줄어드는 지점은 후자이며 트리거가 판정한다. **자리 없는 계약도 가능하다**
--     (`bookings.slot_id` 는 nullable — 스튜디오·드레스처럼 날짜 슬롯을 쓰지 않는
--     카테고리가 있다). 다만 **자리가 붙어 있는데 남은 자리가 없으면 확정을 막는다** —
--     없는 자리를 파는 것이기 때문이다.
--
--  8. **취소·조율 종결에는 사유가 붙는다**(D-24). 0025 가 보증금 종결에,
--     0029 가 계약 취소에 같은 CHECK 를 걸었다. 플랫폼이 재량으로 정한 값이 아님을
--     기록으로 남기기 위해서다.
-- =============================================================================

-- =============================================================================
-- 1) penalty_rules — 밴드 구조로 (위 근거 5·6)
-- =============================================================================
alter table public.penalty_rules add column if not exists band_code text;
alter table public.penalty_rules add column if not exists band_label text;
alter table public.penalty_rules add column if not exists min_days_before_event integer;
alter table public.penalty_rules add column if not exists max_days_before_event integer;
alter table public.penalty_rules add column if not exists rate_bp integer;
alter table public.penalty_rules add column if not exists refund_deposit boolean not null default false;
/** 이 판본이 법무 검수 전 가정치인가. 화면이 그대로 노출한다(§7.7). */
alter table public.penalty_rules add column if not exists is_draft boolean not null default true;

-- 요율의 진실을 둘로 두지 않는다. 이 표는 0행이라 지금이 바꿀 수 있는 마지막 시점이다.
alter table public.penalty_rules drop column if exists standard_rate;

alter table public.penalty_rules drop constraint if exists penalty_rules_rate_range;
alter table public.penalty_rules
  add constraint penalty_rules_rate_range
  check (rate_bp is null or (rate_bp >= 0 and rate_bp <= 10000));

alter table public.penalty_rules drop constraint if exists penalty_rules_day_range;
alter table public.penalty_rules
  add constraint penalty_rules_day_range
  check (
    min_days_before_event is null
    or min_days_before_event >= 0
  );

alter table public.penalty_rules drop constraint if exists penalty_rules_day_order;
alter table public.penalty_rules
  add constraint penalty_rules_day_order
  check (
    max_days_before_event is null
    or min_days_before_event is null
    or max_days_before_event >= min_days_before_event
  );

comment on table public.penalty_rules is
  '위약금 기준 구간(§3.5 · §5.3). **시드를 넣지 않는다** — T-04 의 수치는 법무 검수 전 가정치이고 DB 에 넣으면 그것이 운영 기준처럼 굳는다(0029 가 조항 문안에서 내린 판단과 같다). 확정되면 이 표에 행을 넣기만 하면 로더가 코드의 가정치 대신 DB 값을 쓴다 — 코드는 바뀌지 않는다.';
comment on column public.penalty_rules.rate_bp is
  '위약금 요율(bp 정수). 0003 의 numeric standard_rate 를 대체한다 — 리포 전체가 bp 정수를 쓰고(§6 부동소수점 금지) 엔진(calculatePenalty)도 bp 로 계산한다. 이 표가 0행일 때 바꿨다.';
comment on column public.penalty_rules.refund_deposit is
  '이 구간에서 계약금을 돌려주는가. 소비자분쟁해결기준이 계약금 반환을 따로 다루므로 요율과 별도 컬럼이다 — 요율 0% 와 "계약금 반환" 은 총액이 다르면 다른 결과를 낸다.';
comment on column public.penalty_rules.is_draft is
  '법무 검수 전 가정치인가. **true 면 화면이 "가정치" 경고를 노출해야 한다**(§7.7). 확정 판본을 넣을 때 false 로 적는다.';

-- =============================================================================
-- 2) contract_cancellations — 해지 절차 (위 근거 1~4)
-- =============================================================================
create table if not exists public.contract_cancellations (
  id                 uuid primary key default gen_random_uuid(),
  contract_id        uuid not null references public.contracts (id) on delete cascade,
  booking_id         uuid not null references public.bookings (id) on delete cascade,

  requested_by       uuid references auth.users (id) on delete set null,
  requester_side     text not null,
  reason_code        text not null,
  /** 짧은 보충 설명. 개인식별정보를 적을 자리가 아니다(§7.3) — 길이를 좁혀 둔다. */
  reason_note        text,

  -- 귀책 — 주장과 확정을 나눈다(위 근거 2)
  couple_claim       text,
  vendor_claim       text,
  admin_decision     text,
  fault              text not null default 'undecided',

  -- 양측 확인(위 근거 3)
  couple_agreed      boolean,
  vendor_agreed      boolean,
  confirm_due_at     timestamptz,

  -- 산정 스냅샷(위 근거 4)
  rule_version       text,
  band_code          text,
  band_label         text,
  basis_ref          text,
  is_draft_rules     boolean not null default true,
  paid_amount        bigint,
  penalty_standard   bigint,
  penalty_contract   bigint,
  penalty_applied    bigint,
  refund_amount      bigint,
  balance_due        bigint,

  status             text not null default 'requested',
  disputed_at        timestamptz,
  settled_at         timestamptz,
  resolved_by        uuid references auth.users (id) on delete set null,
  resolution_note    text,

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  constraint contract_cancellations_side_values
    check (requester_side in ('couple', 'vendor')),
  constraint contract_cancellations_reason_values
    check (reason_code in (
      'schedule_changed', 'budget', 'vendor_unavailable', 'vendor_terms',
      'service_quality', 'personal', 'other'
    )),
  constraint contract_cancellations_note_length
    check (reason_note is null or char_length(reason_note) <= 500),
  constraint contract_cancellations_fault_values
    check (
      fault in ('couple', 'vendor', 'mutual', 'undecided')
      and (couple_claim is null or couple_claim in ('couple', 'vendor', 'mutual', 'undecided'))
      and (vendor_claim is null or vendor_claim in ('couple', 'vendor', 'mutual', 'undecided'))
      and (admin_decision is null or admin_decision in ('couple', 'vendor', 'mutual', 'undecided'))
    ),
  constraint contract_cancellations_status_values
    check (status in ('requested', 'agreed', 'disputed', 'settled', 'withdrawn')),
  constraint contract_cancellations_amounts_nonneg
    check (
      (paid_amount is null or paid_amount >= 0)
      and (penalty_standard is null or penalty_standard >= 0)
      and (penalty_contract is null or penalty_contract >= 0)
      and (penalty_applied is null or penalty_applied >= 0)
      and (refund_amount is null or refund_amount >= 0)
      and (balance_due is null or balance_due >= 0)
    ),
  -- 환불과 잔여 청구가 동시에 생길 수 없다. 낸 돈이 위약금보다 많으면 환불이고,
  -- 적으면 청구다 — 둘 다 0 이 아니면 계산이 어딘가에서 어긋난 것이다.
  constraint contract_cancellations_settlement_shape
    check (
      refund_amount is null or balance_due is null
      or refund_amount = 0 or balance_due = 0
    ),
  constraint contract_cancellations_disputed_pair
    check ((status = 'disputed') = (disputed_at is not null)),
  -- 종결에는 사유가 붙는다(위 근거 8 · D-24).
  constraint contract_cancellations_settled_shape
    check (
      status <> 'settled'
      or (
        settled_at is not null
        and penalty_applied is not null
        and refund_amount is not null
        and fault <> 'undecided'
      )
    ),
  constraint contract_cancellations_resolution_shape
    check (resolved_by is null or nullif(btrim(coalesce(resolution_note, '')), '') is not null)
);

comment on table public.contract_cancellations is
  '계약 해지 절차(F-A-17). **refunds(결제 단위)로는 표현할 수 없어 신설했다** — 한 계약에 결제가 여럿이고, 양측 확인·귀책·조율이라는 절차 상태를 담을 자리가 필요하다. 플랫폼은 판정자가 아니라 조율자이므로(D-24) 이 표는 **제시값과 확인 기록**을 담고 일방 집행을 담지 않는다. 명세 §3.4 반영 제안 대상(§7.5).';
comment on column public.contract_cancellations.fault is
  '확정된 귀책. **주장(couple_claim·vendor_claim)과 다른 컬럼이다** — 요청자가 스스로 "업체 잘못" 이라고 적을 수 있으면 사유 선택 하나가 곧 정산 결과가 된다. 양측 일치 또는 운영자 결정으로만 undecided 를 벗어나며, undecided 인 채로는 settled 로 갈 수 없다.';
comment on column public.contract_cancellations.penalty_applied is
  '실제로 적용한 위약금. **기준과 계약서 조건 중 낮은 쪽**이다 — 기준을 넘는 위약 조항은 다툼의 대상이고(검출 룰 R-02), 플랫폼이 초과분을 먼저 집행하면 §7.7 의 "기준 대비 비교값" 원칙이 무의미해진다.';
comment on column public.contract_cancellations.is_draft_rules is
  '산정에 쓴 룰이 법무 검수 전 가정치인가. **스냅샷이다** — 나중에 확정 룰이 들어와도 이 건이 무엇으로 계산됐는지는 바뀌지 않는다(D-23).';
comment on column public.contract_cancellations.confirm_due_at is
  '양측 확인 기한. 값은 app_settings.cancellation.confirm_due_days 가 갖는다(§7.4). **기한이 지나면 조율로 간다 — 자동 정산하지 않는다.** S4-07 이 보증금에서 무응답 기본값을 둔 것과 다른 판단이며, 이유는 금액이 크고 귀책에 따라 결과가 정반대이기 때문이다.';

-- 계약당 살아 있는 해지 절차는 하나다. 철회된 건은 제외해 재요청을 막지 않는다.
create unique index if not exists uq_contract_cancellations_open
  on public.contract_cancellations (contract_id)
  where status <> 'withdrawn';

create index if not exists idx_contract_cancellations_booking
  on public.contract_cancellations (booking_id);
create index if not exists idx_contract_cancellations_status
  on public.contract_cancellations (status);
-- 운영자 조율 큐(F-A-16·F-A-17). S4-07 이 상담에서 쓴 것과 같은 모양이다.
create index if not exists idx_contract_cancellations_disputed
  on public.contract_cancellations (disputed_at)
  where status = 'disputed';

select public.attach_set_updated_at('contract_cancellations');

-- =============================================================================
-- 3) refunds — 해지와 연결 (§3.4 "위약금 산정 결과 연결")
-- =============================================================================
alter table public.refunds add column if not exists cancellation_id uuid
  references public.contract_cancellations (id) on delete set null;
alter table public.refunds add column if not exists completed_at timestamptz;

-- 0003 은 status 를 text + 기본값만 두고 열거하지 않았다. 값이 자유로우면
-- 'completed' 와 'COMPLETED' 가 섞이고 집계가 조용히 갈라진다.
alter table public.refunds drop constraint if exists refunds_status_values;
alter table public.refunds
  add constraint refunds_status_values
  check (status in ('pending', 'completed', 'failed', 'cancelled'));

alter table public.refunds drop constraint if exists refunds_completed_pair;
alter table public.refunds
  add constraint refunds_completed_pair
  check ((status = 'completed') = (completed_at is not null));

comment on column public.refunds.cancellation_id is
  '이 환불이 어느 해지에서 나왔는가. null 이면 해지와 무관한 환불이다(결제사 취소 통지 등 — S5-06 의 웹훅 경로). 위약금 산정 결과와의 연결이 §3.4 가 적어 둔 이 컬럼의 뜻이다.';

-- =============================================================================
-- 3-1) contracts — 확정된 계약을 **취소할 수 있게** 한다
-- -----------------------------------------------------------------------------
-- 0029 의 `contracts_active_pair` 는 `(status = 'active') = (activated_at is not null)`
-- 였다. 확정을 거친 계약을 취소하면 `status='cancelled'` 인데 `activated_at` 은 남아
-- 있으므로 **이 등식이 깨져 취소 자체가 막힌다.** S5-08 이 처음으로 그 경로를 밟으면서
-- 드러났다.
--
-- 고칠 방향은 둘이었다. (가) 취소할 때 `activated_at` 을 비운다 — **언제 확정됐는지가
-- 사라진다**(D-23 이 지키려는 것이 그 사실이다). (나) 불변식을 "active 면 activated_at 이
-- 있다" 라는 **한 방향**으로 고친다. (나)를 택했다 — 확정 시각은 지워지면 안 되는 사실이고,
-- 원래 의도도 "확정 시각 없이 active 일 수 없다" 였다.
-- =============================================================================
alter table public.contracts drop constraint if exists contracts_active_pair;
alter table public.contracts
  add constraint contracts_active_pair
  check (status <> 'active' or activated_at is not null);

comment on column public.contracts.activated_at is
  '전원 서명으로 계약이 확정된 시각. **취소돼도 지우지 않는다** — "언제 확정됐는가" 는 해지 정산의 기준 사실이다(D-23). 그래서 0031 이 짝 제약을 한 방향(active 면 값이 있다)으로 고쳤다.';

-- =============================================================================
-- 4) 예약 자리 — 확정에서 줄이고 해지에서 되돌린다 (위 근거 7)
-- =============================================================================
create or replace function public.apply_booking_slot_movement()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_slot uuid;
  v_from text;
  v_to text;
  v_remaining integer;
  v_capacity integer;
begin
  v_slot := new.slot_id;
  v_to := new.status::text;
  v_from := case when tg_op = 'INSERT' then 'hold' else old.status::text end;

  -- **자리를 차지한 예약은 자리를 옮길 수 없다.** 옮기려면 옛 자리를 놓고 새 자리를
  -- 잡아야 하는데, 그 사이 새 자리가 없으면 예약이 자리 없는 상태로 남는다. 취소 후
  -- 다시 예약하면 두 단계가 각각 판정된다.
  -- **가예약(hold) 단계에서는 자유롭게 바꾼다** — 아직 아무 자리도 차지하지 않았다.
  if tg_op = 'UPDATE'
     and new.slot_id is distinct from old.slot_id
     and v_from in ('confirmed', 'fulfilled') then
    raise exception '확정된 예약의 자리를 바꿀 수 없습니다. 취소 후 다시 예약해야 합니다.'
      using errcode = 'check_violation', constraint = 'bookings_slot_immutable';
  end if;

  -- 자리를 쓰지 않는 예약이거나 자리 수가 달라지지 않으면 할 일이 없다.
  if v_slot is null then return new; end if;

  if (v_from in ('confirmed', 'fulfilled')) = (v_to in ('confirmed', 'fulfilled')) then
    return new;
  end if;

  -- 자리를 잡는다.
  if v_to in ('confirmed', 'fulfilled') then
    -- **행을 잠그고 읽는다.** 동시에 두 예약이 확정되면 둘 다 remaining 1 을 보고
    -- 통과할 수 있다. 마지막 한 자리를 두 커플에게 파는 것이 이 잠금이 막는 사고다.
    select remaining into v_remaining from public.inventory_slots where id = v_slot for update;

    if v_remaining is null then
      raise exception '예약이 가리키는 자리를 찾을 수 없습니다.'
        using errcode = 'foreign_key_violation';
    end if;

    if v_remaining <= 0 then
      raise exception '남은 자리가 없어 예약을 확정할 수 없습니다.'
        using errcode = 'check_violation', constraint = 'inventory_slots_no_remaining';
    end if;

    update public.inventory_slots set remaining = remaining - 1 where id = v_slot;

    return new;
  end if;

  -- 자리를 되돌린다. capacity 를 넘지 않게 자른다 — 넘으면 CHECK 가 막고,
  -- 막히면 취소 자체가 실패해 고객이 계약에 묶인다.
  select remaining, capacity into v_remaining, v_capacity
  from public.inventory_slots where id = v_slot for update;

  if v_remaining is not null and v_remaining < v_capacity then
    update public.inventory_slots set remaining = remaining + 1 where id = v_slot;
  end if;

  return new;
end;
$$;

comment on function public.apply_booking_slot_movement() is
  'S2-05 가 남긴 자리를 채운다 — 예약이 확정될 때 remaining 을 줄이고 풀릴 때 되돌린다. **계약 확정과 예약 확정은 다른 사건이다**: 계약은 서명으로 서고, 자리는 예약이 confirmed 로 갈 때 잡힌다. 자리 없는 예약(slot_id is null)도 정상이며 스튜디오·드레스처럼 날짜 슬롯을 쓰지 않는 카테고리가 있다. 동시 확정은 for update 잠금이 막는다.';

drop trigger if exists trg_bookings_slot_movement on public.bookings;
-- `slot_id` 도 감시 대상이다. `of status` 만 두면 **자리만 바꾸는 UPDATE 가 트리거를
-- 건너뛴다** — 확정된 예약의 자리를 조용히 옮길 수 있게 된다.
create trigger trg_bookings_slot_movement
  after insert or update of status, slot_id on public.bookings
  for each row execute function public.apply_booking_slot_movement();

-- =============================================================================
-- 5) 해지 불변식 트리거
-- =============================================================================
create or replace function public.assert_cancellation_state()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_contract_status text;
begin
  -- 확정된 계약만 해지 대상이다. 발행 전 계약은 해지가 아니라 **폐기**이며
  -- 위약금이 붙지 않는다(계약 전 취소 — 이 표를 쓰지 않는다).
  if tg_op = 'INSERT' then
    select status into v_contract_status from public.contracts where id = new.contract_id;

    if v_contract_status is distinct from 'active' then
      raise exception '확정된 계약만 해지할 수 있습니다. 계약 상태: %',
        coalesce(v_contract_status, '(없음)')
        using errcode = 'check_violation', constraint = 'contract_cancellations_not_active';
    end if;
  end if;

  -- 귀책이 미정인 채로 정산을 끝낼 수 없다(위 근거 2).
  if new.status = 'settled' and new.fault = 'undecided' then
    raise exception '귀책이 확인되지 않은 해지는 정산할 수 없습니다.'
      using errcode = 'check_violation', constraint = 'contract_cancellations_fault_undecided';
  end if;

  -- 종결 상태는 되돌리지 않는다(D-23 — 0030 이 결제에 건 것과 같은 규칙).
  if tg_op = 'UPDATE' and old.status in ('settled', 'withdrawn')
     and new.status is distinct from old.status then
    raise exception '종결된 해지 절차는 되돌릴 수 없습니다: % -> %', old.status, new.status
      using errcode = 'check_violation', constraint = 'contract_cancellations_transition';
  end if;

  return new;
end;
$$;

comment on function public.assert_cancellation_state() is
  '해지 불변식. (가) 확정된 계약만 해지 대상 — 발행 전 폐기는 위약금이 붙지 않아 이 표를 쓰지 않는다. (나) 귀책 미정 상태로 정산 불가. (다) 종결은 되돌릴 수 없다(D-23).';

drop trigger if exists trg_contract_cancellations_state on public.contract_cancellations;
create trigger trg_contract_cancellations_state
  before insert or update on public.contract_cancellations
  for each row execute function public.assert_cancellation_state();

-- =============================================================================
-- 6) RLS (§3.9)
-- -----------------------------------------------------------------------------
-- **쓰기 정책을 주지 않는다.** 해지 요청·확인·조율·집행은 전부 서버(서비스롤)의 일이다.
-- 클라이언트가 이 표를 쓸 수 있으면 **자기 귀책을 스스로 적고 위약금을 0 으로 적을 수
-- 있다.** 0029(서명)·0030(결제)이 같은 결론에 이르렀다 — 금액과 귀책은 없는 사실을
-- 만들어 낼 수 있는 자리다.
--
-- 열람은 **양측 모두**에게 연다. 커플은 **owner 만**(§3.9 결제·계약 서명은 owner 조건),
-- 업체는 멤버 전원 — 해지 응대는 담당자가 한다.
-- =============================================================================
alter table public.contract_cancellations enable row level security;

create policy contract_cancellations_select on public.contract_cancellations
  for select to authenticated
  using (
    public.is_couple_owner(public.booking_couple_id(booking_id))
    or public.is_vendor_member(public.booking_vendor_id(booking_id))
  );

comment on policy contract_cancellations_select on public.contract_cancellations is
  '해지 절차 열람. 커플은 owner 만(§3.9), 업체는 멤버 전원. 배우자에게 열지 않는 이유는 결제·계약 서명과 같다 — 돈의 결론이 걸린 절차다.';

-- **운영자는 조율 큐를 봐야 한다**(F-A-16·F-A-17). 정책 없이 서비스롤로 우회해 읽으면
-- 경계가 RLS 가 아니라 앱 코드가 된다(§5.5) — 0019 가 `is_operator()` 를 만든 이유다.
create policy contract_cancellations_select_operator on public.contract_cancellations
  for select to authenticated
  using (public.is_operator());

-- =============================================================================
-- 7) 증적 열람 (D-23 · 0019·0028·0030 의 방식)
-- =============================================================================
create policy entity_events_select_cancellation on public.entity_events
  for select to authenticated
  using (
    entity_type = 'contract_cancellation'
    and exists (
      select 1 from public.contract_cancellations c
      where c.id = entity_events.entity_id
        and (
          public.is_couple_owner(public.booking_couple_id(c.booking_id))
          or public.is_vendor_member(public.booking_vendor_id(c.booking_id))
        )
    )
  );

-- =============================================================================
-- 8) 운영 파라미터 (§7.4 — 값을 코드에 박지 않는다)
-- =============================================================================
insert into public.app_settings (key, value_json, description)
values
  (
    'cancellation.confirm_due_days',
    '{"days": 7, "unit": "days"}'::jsonb,
    '해지 요청 후 양측 확인 기한(일). **기한이 지나면 자동 정산이 아니라 운영자 조율로 간다** — 계약 해지는 금액이 크고 귀책에 따라 결과가 정반대라 무응답의 기본값을 만들 수 없다(S4-07 이 보증금에서 내린 판단과 다른 이유). 초기 운영값 7일.'
  )
on conflict (key) do update
  set value_json = excluded.value_json, description = excluded.description
  where public.app_settings.value_json ->> 'status' = 'undecided';

-- =============================================================================
-- 이 파일이 한 것
--   테이블 1 — contract_cancellations
--   컬럼 — penalty_rules +7(밴드 구조, numeric standard_rate 대체) · refunds +2
--   CHECK 12 · UNIQUE 1(계약당 살아 있는 해지 1건)
--   함수 2 — 예약 자리 이동 · 해지 불변식
--   트리거 2
--   정책 — contract_cancellations SELECT · entity_events(contract_cancellation) SELECT
--   app_settings 1 — cancellation.confirm_due_days
--   기존 마이그레이션 수정 없음
--   **넣지 않은 것** — penalty_rules 시드. 법무 검수 전 가정치를 DB 에 넣으면 그것이
--   운영 기준처럼 굳는다(위 근거 6). 로더가 DB 우선·코드 폴백으로 동작한다.
-- =============================================================================
