-- =============================================================================
-- 0033 · 정산 집행 · 상계 · 지급 (S5-07)
-- 근거: docs/07_개발명세서.md §2.2 F-V-09, §2.3 F-A-11, §3.4 settlements·
--       settlement_items·planner_settlements, §3.8 요율 스냅샷, §3.9 RLS,
--       §4.3, §6.3 /vendor/settlements, §7.4, D-16 · D-17 · D-18 · D-23 · D-27 · D-28
-- =============================================================================
-- 0028 이 `settlements.fee_rate_bp`(스냅샷)와 열람 경계(대표 전용)를 세웠고, 0030 이
-- 결제를, 0031 이 해지·환불을, 0032 가 쿠폰을 만들었다. 이 파일은 그것들을 **한 장의
-- 정산서로 모으고 실제로 지급**하는 쪽이다.
--
-- 이 파일이 정한 것 — 판단이 필요했던 지점과 근거
--
--  1. **`fee_basis` 미결(O-15)은 '실패' 가 아니라 '대기' 다.** 값이 없으면 정산을 세울
--     수 없지만, 그것을 `failed` 로 적으면 운영은 **우리 시스템이 고장난 것**으로 읽고
--     원인을 코드에서 찾는다. 실제로는 **결정 하나가 비어 있을 뿐**이다. 그래서 상태를
--     `blocked` 로 두고 **`blocked_reason` 에 무엇이 비었는지**를 적는다. 값이 정해지면
--     같은 행을 **재계산**한다 — 새 행을 만들지 않는다(기간당 하나여야 한다).
--
--  2. **`fee_basis` 를 정산서에 스냅샷으로 박는다.** 나중에 O-15 가 정해지고 또 바뀌면
--     "이 정산서는 무엇을 기준으로 계산했나" 를 재현할 수 없다. 요율 스냅샷(D-16)과
--     같은 이유이며, 박는 시점은 **계산이 성립한 시점**이다.
--
--  3. **상계는 별도 표다**(`settlement_adjustments`). `settlement_items.adjustment`
--     (0003)는 **건별 조정**이라 "지난 기간의 환불을 이번 정산에서 뺀다" 를 표현할 수
--     없다 — 그 조정은 어느 거래의 것도 아니고 **기간을 건너뛴다.** 그리고 상계는
--     발생 시점과 반영 시점이 다르므로(해지는 오늘, 정산은 다음 달) **미반영 상태로
--     떠 있는 기간**이 필요하다. `applied_settlement_id` 가 null 인 동안이 그 상태다.
--
--  4. **쿠폰 차감은 부담 주체가 정한다**(D-27 · §3.4 NOTE). `borne_by='vendor'` 인
--     사용분만 그 업체 정산에서 뺀다. `platform` 은 빼지 않는다 — 업체가 모르는 사이에
--     자기 수입이 깎이면 안 된다.
--
--  5. **지급은 별도 표다**(`settlement_payouts`). 정산서 한 장에 지급 시도가 여럿일 수
--     있다(실패·재시도). `settlements.paid_at` 한 컬럼으로는 "몇 번 시도했고 왜
--     실패했나" 를 담을 수 없다 — 0030 이 결제에서 내린 것과 같은 판단이다.
--     멱등 열쇠는 **정산서 id + 시도 회차**이며 유니크가 그 경계다.
--
--  6. **정산 금액을 업체가 쓸 수 없다.** 0028 이 `bookings` 요율 컬럼을 **컬럼 수준
--     권한**으로 닫았는데, `settlements` 는 애초에 UPDATE 정책이 없어 정책 층에서는
--     막혀 있다. 다만 **정책은 행을 가르고 컬럼을 가르지 않으므로** 나중에 "이의 제기"
--     같은 UPDATE 정책이 붙으면 금액까지 열린다. 그 때를 대비해 **지금 권한을
--     회수**하고 이의 제기는 별도 컬럼으로만 열어 둔다.
--
--  7. **정산서를 지운 자리에 다시 만들지 않는다.** 기간·업체당 하나(0003 UNIQUE)이며
--     재계산은 **같은 행을 고친다.** 지우고 다시 만들면 id 가 바뀌어 증적
--     (`entity_events.entity_id`)이 가리키던 대상이 사라진다(D-23).
-- =============================================================================

-- =============================================================================
-- 1) settlements — 상태·스냅샷·지급 예정
-- =============================================================================
alter table public.settlements add column if not exists fee_basis text;
alter table public.settlements add column if not exists blocked_reason text;
alter table public.settlements add column if not exists adjustment_amount bigint not null default 0;
alter table public.settlements add column if not exists coupon_deduction bigint not null default 0;
alter table public.settlements add column if not exists payout_amount bigint;
alter table public.settlements add column if not exists payable_at date;
alter table public.settlements add column if not exists confirmed_at timestamptz;
alter table public.settlements add column if not exists paid_at timestamptz;
alter table public.settlements add column if not exists calculated_at timestamptz;
alter table public.settlements add column if not exists vendor_note text;

alter table public.settlements drop constraint if exists settlements_status_values;
alter table public.settlements
  add constraint settlements_status_values
  check (status in ('blocked', 'draft', 'confirmed', 'paid', 'void'));

-- **'대기' 에는 이유가 붙는다**(위 근거 1). 이유 없는 blocked 는 운영이 무엇을
-- 고쳐야 할지 알 수 없어 그냥 고장으로 읽힌다.
alter table public.settlements drop constraint if exists settlements_blocked_shape;
alter table public.settlements
  add constraint settlements_blocked_shape
  check (
    (status = 'blocked') = (blocked_reason is not null)
    and (blocked_reason is null or blocked_reason in ('fee_basis_missing', 'rate_snapshot_missing'))
  );

-- 계산이 성립한 정산서에는 기준 스냅샷이 있다(위 근거 2).
alter table public.settlements drop constraint if exists settlements_fee_basis_shape;
alter table public.settlements
  add constraint settlements_fee_basis_shape
  check (
    status = 'blocked'
    or status = 'void'
    or (fee_basis is not null and fee_basis in ('pre_discount', 'post_discount'))
  );

alter table public.settlements drop constraint if exists settlements_confirmed_pair;
alter table public.settlements
  add constraint settlements_confirmed_pair
  check ((status in ('confirmed', 'paid')) = (confirmed_at is not null));

alter table public.settlements drop constraint if exists settlements_paid_pair;
alter table public.settlements
  add constraint settlements_paid_pair
  check ((status = 'paid') = (paid_at is not null));

alter table public.settlements drop constraint if exists settlements_amounts_shape;
alter table public.settlements
  add constraint settlements_amounts_shape
  check (
    adjustment_amount >= 0
    and coupon_deduction >= 0
    and (payout_amount is null or payout_amount >= 0)
  );

comment on column public.settlements.fee_basis is
  '이 정산서가 무엇을 기준으로 수수료를 뗐는가(pre_discount | post_discount · O-15). **스냅샷이다** — 나중에 기준이 정해지고 또 바뀌어도 이 정산서의 계산 근거는 바뀌지 않는다(요율 스냅샷 D-16 과 같은 이유). 값이 없어 계산을 세우지 못한 상태는 status=blocked 다.';
comment on column public.settlements.blocked_reason is
  '정산을 세우지 못한 이유. **실패가 아니라 대기다** — fee_basis_missing 은 O-15 결정이 비어 있다는 뜻이고 rate_snapshot_missing 은 계약 확정 시 요율이 안 박힌 예약이 있다는 뜻이다. 이유 없이 blocked 로 두면 운영은 고장으로 읽고 원인을 코드에서 찾는다.';
comment on column public.settlements.coupon_deduction is
  '쿠폰 차감액. **borne_by=vendor 인 사용분만** 센다(D-27 · §3.4 NOTE) — 플랫폼 쿠폰은 차감하지 않는다. 업체가 모르는 사이에 자기 수입이 깎이면 안 된다.';
comment on column public.settlements.adjustment_amount is
  '이번 정산에 반영된 상계 합계. 지난 기간의 환불·회수처럼 **기간을 건너뛰는 조정**이며 건별 조정(settlement_items.adjustment)과 다르다. 근거 행은 settlement_adjustments 가 갖는다.';
comment on column public.settlements.payout_amount is
  '실제 지급액 = 순액 − 상계 − 쿠폰 차감. **음수가 되지 않는다** — 모자란 만큼은 상계가 다음 기간으로 넘어간다(carry).';
comment on column public.settlements.vendor_note is
  '업체 이의 제기 메모(F-V-09). **업체가 쓸 수 있는 유일한 컬럼**이며 금액 컬럼은 권한으로 닫혀 있다 — 정책은 행을 가르고 컬럼을 가르지 않기 때문이다(0028 이 bookings 에서 쓴 방법과 같다).';

create index if not exists idx_settlements_status on public.settlements (status);
create index if not exists idx_settlements_payable on public.settlements (payable_at)
  where status = 'confirmed';

-- **금액을 업체가 쓸 수 없다**(위 근거 6). 지금은 UPDATE 정책이 없어 어차피 막히지만,
-- 이의 제기 정책이 붙는 순간 금액까지 열린다. 컬럼 수준에서 미리 좁혀 둔다.
revoke update on public.settlements from authenticated, anon;
grant update (vendor_note) on public.settlements to authenticated;

-- =============================================================================
-- 2) settlement_items — 건별 근거 (§3.8 스냅샷 표시)
-- =============================================================================
alter table public.settlement_items add column if not exists fee_rate_bp integer;
alter table public.settlement_items add column if not exists fee_amount bigint not null default 0;
alter table public.settlement_items add column if not exists net_amount bigint not null default 0;
alter table public.settlement_items add column if not exists coupon_deduction bigint not null default 0;

alter table public.settlement_items drop constraint if exists settlement_items_shape;
alter table public.settlement_items
  add constraint settlement_items_shape
  check (
    (fee_rate_bp is null or (fee_rate_bp >= 0 and fee_rate_bp <= 10000))
    and fee_amount >= 0
    and coupon_deduction >= 0
    and net_amount = amount - fee_amount - coupon_deduction
  );

comment on column public.settlement_items.fee_rate_bp is
  '이 거래에 적용된 요율(bp). **계약 확정 시점 스냅샷**(bookings.applied_fee_rate_bp)이며 정산 시점 요율이 아니다(§3.4 NOTE · D-16). 화면이 "지금 요율과 다를 수 있다" 를 말할 수 있는 근거가 이 컬럼이다.';

-- =============================================================================
-- 3) settlement_adjustments — 상계 (위 근거 3)
-- =============================================================================
create table if not exists public.settlement_adjustments (
  id                    uuid primary key default gen_random_uuid(),
  vendor_id             uuid not null references public.vendors (id) on delete cascade,
  /** 무엇에서 나온 조정인가. */
  source_type           text not null,
  /** 그 근거 행의 id(해지 절차·환불 등). 표가 여럿이라 FK 를 걸지 않는다. */
  source_id             uuid,
  booking_id            uuid references public.bookings (id) on delete set null,
  /** **양수로만 적는다.** 방향은 source_type 이 정한다 — 부호로 표현하면 합계에서 실수한다. */
  amount                bigint not null,
  reason                text not null,
  /** 반영된 정산서. **null 인 동안이 '다음 정산에서 뺄 것' 상태다.** */
  applied_settlement_id uuid references public.settlements (id) on delete set null,
  applied_at            timestamptz,
  created_by            uuid references auth.users (id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint settlement_adjustments_source_values
    check (source_type in ('cancellation_refund', 'coupon', 'planner_recovery', 'manual')),
  constraint settlement_adjustments_amount_positive check (amount >= 1),
  constraint settlement_adjustments_reason_present
    check (nullif(btrim(reason), '') is not null),
  constraint settlement_adjustments_applied_pair
    check ((applied_settlement_id is null) = (applied_at is null))
);

comment on table public.settlement_adjustments is
  '정산 상계(F-V-09 · F-A-11). **settlement_items.adjustment 와 다르다** — 그쪽은 건별 조정이고 이쪽은 **기간을 건너뛰는 조정**이다(지난 달 해지 환불을 이번 달 정산에서 뺀다). 발생 시점과 반영 시점이 다르므로 applied_settlement_id 가 null 인 **미반영 상태**가 필요하며, 그 상태가 화면에 "다음 정산에서 차감 예정" 으로 드러난다.';
comment on column public.settlement_adjustments.amount is
  '**양수로만 적는다.** 방향은 source_type 이 정한다 — 부호로 표현하면 합계에서 부호를 빠뜨리는 실수가 생기고, 그 실수는 지급액을 늘리는 쪽으로 조용히 작동한다.';
comment on column public.settlement_adjustments.applied_settlement_id is
  '반영된 정산서. **null 이면 아직 반영되지 않은 상계**이며 다음 정산이 가져간다. 반영은 한 번뿐이고 부분 유니크가 그것을 강제한다.';

create index if not exists idx_settlement_adjustments_vendor
  on public.settlement_adjustments (vendor_id);
-- 다음 정산이 훑는 경로. 이미 반영된 것은 볼 이유가 없다.
create index if not exists idx_settlement_adjustments_pending
  on public.settlement_adjustments (vendor_id)
  where applied_settlement_id is null;

select public.attach_set_updated_at('settlement_adjustments');

-- 같은 근거로 두 번 상계하지 않는다. 해지 1건이 두 정산에서 빠지면 업체가 두 번 잃는다.
create unique index if not exists uq_settlement_adjustments_source
  on public.settlement_adjustments (source_type, source_id)
  where source_id is not null;

-- =============================================================================
-- 4) settlement_payouts — 지급 실행 (위 근거 5 · D-28)
-- =============================================================================
create table if not exists public.settlement_payouts (
  id              uuid primary key default gen_random_uuid(),
  settlement_id   uuid not null references public.settlements (id) on delete cascade,
  amount          bigint not null,
  status          text not null default 'pending',
  provider        text,
  provider_ref    text,
  /** 나가는 요청의 멱등 열쇠. `settlement:<id>:payout:<attempt>` 형태다. */
  idempotency_key text not null unique,
  attempt_count   integer not null default 1,
  failure_reason  text,
  paid_at         timestamptz,
  failed_at       timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint settlement_payouts_status_values
    check (status in ('pending', 'paid', 'failed', 'cancelled')),
  constraint settlement_payouts_amount_positive check (amount >= 1),
  constraint settlement_payouts_attempt_positive check (attempt_count >= 1),
  constraint settlement_payouts_paid_pair check ((status = 'paid') = (paid_at is not null)),
  constraint settlement_payouts_failed_pair check ((status = 'failed') = (failed_at is not null))
);

comment on table public.settlement_payouts is
  '정산 지급 실행(D-28). **정산서 한 장에 지급 시도가 여럿일 수 있다**(실패·재시도) — settlements.paid_at 한 컬럼으로는 "몇 번 시도했고 왜 실패했나" 를 담을 수 없다(0030 이 결제에서 내린 것과 같은 판단). 실연동 전에는 스텁이 돌며 **프로덕션에서는 어댑터가 거부한다** — 없는 돈이 나갔다고 기록되면 업체가 받지 못한 돈을 받았다고 판정된다.';
comment on column public.settlement_payouts.idempotency_key is
  '나가는 요청의 멱등 열쇠. **자동 재시도에서 바꾸지 않는다** — 바꾸면 재시도가 새 이체가 되고 돈이 두 번 나간다. 명시적 재지급만 attempt 를 올려 다른 열쇠를 만든다(paymentIdempotencyKey 와 같은 규칙).';

-- **정산서당 진행 중인 지급은 하나다.** 둘이 승인되면 같은 정산이 두 번 나간다.
create unique index if not exists uq_settlement_payouts_pending
  on public.settlement_payouts (settlement_id)
  where status = 'pending';
-- 성공한 지급도 하나뿐이다.
create unique index if not exists uq_settlement_payouts_paid
  on public.settlement_payouts (settlement_id)
  where status = 'paid';

create index if not exists idx_settlement_payouts_settlement
  on public.settlement_payouts (settlement_id);

select public.attach_set_updated_at('settlement_payouts');

-- =============================================================================
-- 5) 불변식 트리거
-- =============================================================================
create or replace function public.assert_settlement_transition()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_paid integer;
begin
  if tg_op = 'UPDATE' and new.status is distinct from old.status then
    -- 재계산은 blocked ↔ draft 를 오간다(값이 정해지면 풀리고, 지워지면 다시 막힌다).
    if not (
      (old.status = 'blocked' and new.status in ('draft', 'void'))
      or (old.status = 'draft' and new.status in ('blocked', 'confirmed', 'void'))
      or (old.status = 'confirmed' and new.status in ('paid', 'draft', 'void'))
    ) then
      raise exception '허용되지 않은 정산 상태 전이입니다: % -> %', old.status, new.status
        using errcode = 'check_violation', constraint = 'settlements_transition';
    end if;
  end if;

  -- **지급 완료는 근거를 요구한다.** 성공한 지급 행 없이 paid 로 적으면 나가지 않은
  -- 돈이 나갔다고 기록된다(0030 이 회차 완료에 건 것과 같은 규칙).
  if new.status = 'paid' and (tg_op = 'INSERT' or old.status is distinct from 'paid') then
    select count(*) into v_paid
    from public.settlement_payouts
    where settlement_id = new.id and status = 'paid';

    if v_paid = 0 then
      raise exception '성공한 지급 기록 없이 정산을 지급 완료로 적을 수 없습니다.'
        using errcode = 'check_violation', constraint = 'settlements_paid_without_payout';
    end if;
  end if;

  return new;
end;
$$;

comment on function public.assert_settlement_transition() is
  '정산 불변식. (가) 허용된 상태 전이만 — 재계산은 blocked ↔ draft 를 오간다. (나) 성공한 지급 기록 없이 paid 로 적을 수 없다. 회차 완료에 결제를 요구한 것(0030)과 같은 규칙이며, 없으면 나가지 않은 돈이 나갔다고 기록된다.';

drop trigger if exists trg_settlements_transition on public.settlements;
create trigger trg_settlements_transition
  before insert or update on public.settlements
  for each row execute function public.assert_settlement_transition();

-- 확정된 정산서의 금액은 바뀌지 않는다. 바뀌면 업체가 본 숫자와 받은 돈이 달라진다.
create or replace function public.assert_settlement_frozen()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.status in ('confirmed', 'paid') and new.status in ('confirmed', 'paid') then
    if new.gross_amount is distinct from old.gross_amount
       or new.fee_amount is distinct from old.fee_amount
       or new.net_amount is distinct from old.net_amount
       or new.adjustment_amount is distinct from old.adjustment_amount
       or new.coupon_deduction is distinct from old.coupon_deduction
       or new.payout_amount is distinct from old.payout_amount
       or new.fee_basis is distinct from old.fee_basis then
      raise exception '확정된 정산서의 금액은 바꿀 수 없습니다. 조정이 필요하면 상계로 다음 정산에 반영합니다.'
        using errcode = 'check_violation', constraint = 'settlements_frozen';
    end if;
  end if;

  return new;
end;
$$;

comment on function public.assert_settlement_frozen() is
  '확정된 정산서를 소급 수정할 수 없게 한다(D-23). 고칠 일이 생기면 금액을 덮어쓰는 것이 아니라 **상계로 다음 정산에 반영**한다 — 그래야 "언제 얼마를 정산했는가" 가 재현된다. 0031 이 해지에서 확정 정산서를 조율로 보낸 것과 같은 판단이다.';

drop trigger if exists trg_settlements_frozen on public.settlements;
create trigger trg_settlements_frozen
  before update on public.settlements
  for each row execute function public.assert_settlement_frozen();

-- =============================================================================
-- 6) RLS (§3.9)
-- -----------------------------------------------------------------------------
-- `settlements` SELECT 는 0028 이 이미 **대표 전용**으로 좁혔다(staff 차단).
-- 여기서 더하는 표들도 같은 경계를 따른다 — 상계·지급은 정산 금액 그 자체다.
-- **쓰기 정책은 주지 않는다.** 정산 집행은 운영자·서비스롤의 일이다.
-- =============================================================================
alter table public.settlement_adjustments enable row level security;
alter table public.settlement_payouts enable row level security;

create policy settlement_adjustments_select on public.settlement_adjustments
  for select to authenticated
  using (public.is_vendor_owner(vendor_id) or public.is_operator());

comment on policy settlement_adjustments_select on public.settlement_adjustments is
  '상계 열람은 정산과 같은 경계다 — **업체 대표 전용**(staff 차단). 상계는 지급액을 줄이는 금액이므로 정산 금액과 같은 성격이다.';

create policy settlement_payouts_select on public.settlement_payouts
  for select to authenticated
  using (
    public.is_operator()
    or exists (
      select 1 from public.settlements s
      where s.id = settlement_payouts.settlement_id and public.is_vendor_owner(s.vendor_id)
    )
  );

-- **이의 제기**(F-V-09). 업체 대표가 쓸 수 있는 유일한 경로이며, **금액은 컬럼 권한이
-- 막는다** — 정책은 행을 가르고 컬럼을 가르지 않으므로 이 정책만으로는 금액까지 열린다.
-- 위의 `grant update (vendor_note)` 가 그 짝이며, 둘이 함께 있어야 경계가 선다.
create policy settlements_update_note on public.settlements for update to authenticated
  using (public.is_vendor_owner(vendor_id))
  with check (public.is_vendor_owner(vendor_id));

comment on policy settlements_update_note on public.settlements is
  '업체 대표의 이의 제기(F-V-09). 이 정책은 **행**만 가르고 어느 컬럼을 쓸 수 있는지는 GRANT 가 정한다 — vendor_note 외 컬럼은 권한이 없어 42501 로 끊긴다. 정책만 두고 권한을 안 좁히면 대표가 자기 정산 금액을 적을 수 있다.';

-- 운영자도 정산서를 봐야 집행할 수 있다(F-A-11). 0028 은 대표만 열어 뒀다.
create policy settlements_select_operator on public.settlements for select to authenticated
  using (public.is_operator());

create policy settlement_items_select_operator on public.settlement_items
  for select to authenticated
  using (public.is_operator());

-- =============================================================================
-- 7) 증적 열람 (D-23 · 0019·0028 의 방식)
-- =============================================================================
create policy entity_events_select_settlement_payout on public.entity_events
  for select to authenticated
  using (
    entity_type = 'settlement_payout'
    and exists (
      select 1 from public.settlement_payouts p
      join public.settlements s on s.id = p.settlement_id
      where p.id = entity_events.entity_id and public.is_vendor_owner(s.vendor_id)
    )
  );

-- =============================================================================
-- 8) 알림 토픽에 settlement 추가
-- -----------------------------------------------------------------------------
-- 0023~0030 이 남긴 규칙 그대로 — 목록은 이 CHECK 두 곳과
-- `lib/core/schemas/notification.ts` 양쪽에 있으므로 함께 고친다.
-- **`payment` 와 나누는 이유** — 결제는 고객이 내는 돈이고 정산은 업체가 받는 돈이다.
-- 받는 쪽 알림만 따로 켜고 끄는 것이 성립한다.
-- =============================================================================
alter table public.notifications drop constraint if exists notifications_topic_chk;
alter table public.notifications
  add constraint notifications_topic_chk
  check (
    topic in (
      'dday', 'schedule', 'contract', 'care', 'price_change', 'couple_invite',
      'chat', 'inquiry', 'vendor_invite', 'payment', 'settlement'
    )
  );

alter table public.notification_prefs drop constraint if exists notification_prefs_topic_chk;
alter table public.notification_prefs
  add constraint notification_prefs_topic_chk
  check (
    topic in (
      'dday', 'schedule', 'contract', 'care', 'price_change', 'couple_invite',
      'chat', 'inquiry', 'vendor_invite', 'payment', 'settlement'
    )
  );

-- =============================================================================
-- 9) 운영 파라미터 (§7.4 — 값을 코드에 박지 않는다)
-- =============================================================================
insert into public.app_settings (key, value_json, description)
values
  (
    'settlement.period',
    '{"unit": "month", "closingDay": 1}'::jsonb,
    '정산 주기. month = 월 단위이며 closingDay 는 마감 다음 달의 기준일이다. **주기를 코드에 박지 않는다** — 운영이 격주·주간으로 바꿀 수 있어야 한다.'
  ),
  (
    'settlement.payout_lead_days',
    '{"days": 7, "unit": "days"}'::jsonb,
    '정산 확정 후 지급까지의 리드타임(일). payable_at = 확정일 + 이 일수. 환불·분쟁 창구가 닫히기를 기다리는 기간이며 플래너 유예(planner.payout_grace_days)와 같은 취지다. 초기 운영값 7일.'
  ),
  (
    'settlement.tax_rate_bp',
    '{"rateBp": 1000, "unit": "bp"}'::jsonb,
    '세금계산서 자료의 부가세율(bp). **세율을 코드에 박지 않는다** — 바뀌는 날 배포가 필요해진다. 값이 없으면 세금 자료를 만들지 않는다(지어낸 세율로 만든 자료는 신고에 그대로 쓰인다). 과세 대상은 **정산액이 아니라 중개 수수료**다 — 거래 대금은 고객과 업체 사이의 것이고 플랫폼이 제공한 용역의 대가는 수수료뿐이다(D-24). 초기 운영값 10%.'
  )
on conflict (key) do update
  set value_json = excluded.value_json, description = excluded.description
  where public.app_settings.value_json ->> 'status' = 'undecided';

-- =============================================================================
-- 이 파일이 한 것
--   테이블 2 — settlement_adjustments(상계) · settlement_payouts(지급)
--   컬럼 — settlements +10 · settlement_items +4
--   CHECK 15 · UNIQUE 3(상계 근거 1회 · 지급 진행 중 1건 · 성공 1건)
--   함수 2 — 정산 상태 전이 · 확정 정산서 동결
--   트리거 2
--   정책 — settlement_adjustments·settlement_payouts SELECT ·
--          settlements·settlement_items 운영자 SELECT · settlements UPDATE(이의 제기) ·
--          entity_events 1
--   GRANT  settlements UPDATE 를 (vendor_note) 로 좁힘 — 금액은 못 쓴다
--   알림 토픽 — notifications·notification_prefs CHECK 에 'settlement' 추가
--   app_settings 2 — settlement.period · settlement.payout_lead_days
--   기존 마이그레이션 수정 없음
--   **`settlement.fee_basis` 값을 정하지 않았다**(O-15) — 미결인 채로 집행을 만든다.
-- =============================================================================
