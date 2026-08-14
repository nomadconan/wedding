-- =============================================================================
-- 0035 · 에스크로 예치 · 이행 확인 · 릴리즈 (S5-09)
-- 근거: docs/07_개발명세서.md §2.1 F-C-16, §3.4 escrow_holds, §4.2, §6.2, §3.9,
--       D-21 · D-23 · D-24 · D-28, O-03
-- =============================================================================
-- 0003 이 `escrow_holds` 를 만들면서 "**O-03 법무 결론 대기 — 컬럼 정의만 유지,
-- 집행 로직 미구현**" 이라고 적었다. 커버리지 표도 S5-09 를 "**집행 로직은 O-03 대기,
-- 절차·기록만**" 으로 잡았다. 이 파일은 그 **절차와 기록**을 만든다 — 실제 자금 분리
-- 보관은 어댑터 뒤에 있고 프로덕션에서는 스텁이 거부된다(D-28).
--
-- 이 파일이 정한 것 — 판단이 필요했던 지점과 근거
--
--  1. **예치 대상은 잔금이다**(F-C-16 이 "잔금 예치" 라고 적었다). 계약금(1회차)은
--     계약 성립의 증표이자 위약금의 기준이다(T-04 `refundDeposit` · 검출 룰 R-02).
--     그것까지 묶으면 **계약이 성립해도 업체는 아무것도 받지 못한 채** 예식일까지
--     준비 비용을 먼저 쓴다 — 안전거래가 아니라 자금 압박이다. 판정은
--     `lib/core/escrow` 의 `isEscrowTarget` 이며 회차가 늘어도 규칙은 같다.
--
--  2. **무응답의 기본값이 S4-07 과 반대다.** 그쪽은 "몰취가 기본이면 업체의 방치가
--     이득" 이라 환불을 기본값으로 뒀다. 에스크로에서는 논리가 뒤집힌다 — **환불이
--     기본이면 고객의 방치가 이득**이 되고, 서비스가 이미 이행됐는데 확인만 안 하면
--     업체가 영원히 돈을 못 받는다. 그래서 **기본값은 릴리즈**다.
--     다만 **예식일 경과를 조건으로 넣는다** — 예식 전에는 이행이 없었으므로 기한이
--     지나도 릴리즈하지 않는다. 두 조건이 모두 맞아야 한다.
--
--  3. **릴리즈 조건을 스냅샷으로 박는다.** `release_condition` 에 기한·폴백 방향·판본을
--     담는다. 규칙이 나중에 바뀌어도 **이 건이 무엇에 합의했는지**는 바뀌면 안 된다 —
--     요율 스냅샷(D-16)·계약 해시(D-23)와 같은 이유이며, 에스크로에서는 그것이 곧
--     "언제 이행이 확인됐는가" 의 근거다.
--
--  4. **홀드에 'pending' 이 없다.** 예치가 실패하면 행을 만들지 않는다 — 실패한 보관은
--     보관이 아니다. 0030 이 결제에 `pending` 을 둔 것과 다른 판단이며, 이유는
--     에스크로가 **이미 승인된 결제 위에** 서기 때문이다(트리거가 그것을 강제한다).
--
--  5. **종결은 되돌리지 않는다**(D-23). `released`·`refunded` 에서 나가는 전이가 없고,
--     `disputed` 에서 `held` 로 돌아가지도 않는다 — 이의가 제기된 사실은 남아야 한다.
--
--  6. **정산이 보관 중인 돈을 지급하지 않는다.** 완납과 이행 확인은 **다른 사건**이다.
--     S5-07 의 집계가 열린 홀드를 만나면 그 예약을 이번 기간에서 뺀다(코드 쪽 연결).
--     DB 는 그 판정을 강제하지 않는다 — 집계 로직이 조인해야 하는 일이라 트리거로
--     막을 자리가 없다.
--
--  7. **알림 토픽을 늘리지 않았다.** 고객에게 에스크로는 **결제한 돈의 상태**이므로
--     `payment` 이고, 업체에게 릴리즈는 **정산으로 가는 사건**이므로 `settlement` 다.
--     둘 다 이미 있다. 토픽을 늘리면 수신 설정 화면이 복잡해지는데 사용자가 구분할
--     실익이 없다(0023 이후 토픽을 늘릴 때마다 한 판단이다).
-- =============================================================================

-- =============================================================================
-- 1) escrow_holds — 절차·기록
-- =============================================================================
alter table public.escrow_holds add column if not exists booking_id uuid
  references public.bookings (id) on delete cascade;
alter table public.escrow_holds add column if not exists payment_schedule_id uuid
  references public.payment_schedules (id) on delete set null;
alter table public.escrow_holds add column if not exists status text not null default 'held';
alter table public.escrow_holds add column if not exists held_at timestamptz;
alter table public.escrow_holds add column if not exists couple_confirmed boolean;
alter table public.escrow_holds add column if not exists vendor_confirmed boolean;
alter table public.escrow_holds add column if not exists couple_confirmed_at timestamptz;
alter table public.escrow_holds add column if not exists vendor_confirmed_at timestamptz;
alter table public.escrow_holds add column if not exists confirm_due_at timestamptz;
alter table public.escrow_holds add column if not exists disputed_at timestamptz;
alter table public.escrow_holds add column if not exists refunded_at timestamptz;
alter table public.escrow_holds add column if not exists release_reason text;
alter table public.escrow_holds add column if not exists resolution_note text;
alter table public.escrow_holds add column if not exists resolved_by uuid
  references auth.users (id) on delete set null;
/** 어느 어댑터가 보관했는가. 스텁으로 처리된 건을 골라낼 수 있어야 한다(D-28). */
alter table public.escrow_holds add column if not exists provider text;
alter table public.escrow_holds add column if not exists provider_ref text;
alter table public.escrow_holds add column if not exists idempotency_key text;

alter table public.escrow_holds drop constraint if exists escrow_holds_status_values;
alter table public.escrow_holds
  add constraint escrow_holds_status_values
  check (status in ('held', 'disputed', 'released', 'refunded'));

-- 종결의 짝. 상태와 시각이 어긋나면 어느 쪽이 진실인지 알 수 없다.
alter table public.escrow_holds drop constraint if exists escrow_holds_released_pair;
alter table public.escrow_holds
  add constraint escrow_holds_released_pair
  check ((status = 'released') = (released_at is not null));

alter table public.escrow_holds drop constraint if exists escrow_holds_refunded_pair;
alter table public.escrow_holds
  add constraint escrow_holds_refunded_pair
  check ((status = 'refunded') = (refunded_at is not null));

alter table public.escrow_holds drop constraint if exists escrow_holds_disputed_pair;
alter table public.escrow_holds
  add constraint escrow_holds_disputed_pair
  check ((status = 'disputed') = (disputed_at is not null));

-- 확인 여부와 시각의 짝. "언제 이행이 확인됐는가" 가 분쟁의 쟁점이다(D-23).
alter table public.escrow_holds drop constraint if exists escrow_holds_confirm_pair;
alter table public.escrow_holds
  add constraint escrow_holds_confirm_pair
  check (
    (couple_confirmed is null) = (couple_confirmed_at is null)
    and (vendor_confirmed is null) = (vendor_confirmed_at is null)
  );

-- 조율 결과에는 사유가 붙는다(D-24 — 0025·0029·0031 이 건 같은 규칙).
alter table public.escrow_holds drop constraint if exists escrow_holds_resolution_shape;
alter table public.escrow_holds
  add constraint escrow_holds_resolution_shape
  check (resolved_by is null or nullif(btrim(coalesce(resolution_note, '')), '') is not null);

alter table public.escrow_holds drop constraint if exists escrow_holds_amount_positive;
alter table public.escrow_holds add constraint escrow_holds_amount_positive check (held_amount >= 1);

comment on table public.escrow_holds is
  '에스크로 홀드(F-C-16). **플랫폼은 보관자이며 계약 당사자가 아니다**(D-24) — 양측이 합의한 조건을 맡아 두었다가 조건 충족 여부에 따라 집행한다. **집행 로직은 O-03(전자금융업 등록 등) 대기**이며 이 판본은 절차·기록과 어댑터 뒤의 스텁까지다. 자금 보관은 대금을 옮기는 결제보다 법적 요건이 무겁다.';
comment on column public.escrow_holds.release_condition is
  '릴리즈 조건 **스냅샷**(basis·confirmDueDays·timeoutAction·version). 규칙이 나중에 바뀌어도 이 건이 무엇에 합의했는지는 바뀌지 않는다 — 요율 스냅샷(D-16)·계약 해시(D-23)와 같은 이유다.';
comment on column public.escrow_holds.status is
  'held(보관 중) | disputed(조율 중) | released(업체 정산 대상) | refunded(고객 환불). **pending 이 없다** — 예치가 실패하면 행을 만들지 않는다. 실패한 보관은 보관이 아니다.';
comment on column public.escrow_holds.couple_confirmed is
  '고객의 이행 확인. **무응답(null)과 부정(false)은 다르다** — 부정은 즉시 조율이고 무응답은 기한과 예식일 경과를 함께 본다(S4-07 과 폴백 방향이 반대인 이유는 lib/core/escrow 주석 참조).';
comment on column public.escrow_holds.provider is
  '보관을 처리한 어댑터(stub | noop | 위탁 PG). **PG 사 에스크로 위탁도 이 자리에 들어온다** — 우리가 직접 보관하지 않고 위탁하는 형태가 O-03 결론에 따라 더 현실적일 수 있고, 어댑터는 그 형태를 그대로 수용한다.';

-- 회차당 홀드는 하나다. 둘이면 같은 돈이 두 번 보관된 것처럼 보인다.
create unique index if not exists uq_escrow_holds_schedule
  on public.escrow_holds (payment_schedule_id)
  where payment_schedule_id is not null;

create unique index if not exists uq_escrow_holds_idempotency
  on public.escrow_holds (idempotency_key)
  where idempotency_key is not null;

create index if not exists idx_escrow_holds_booking on public.escrow_holds (booking_id);
create index if not exists idx_escrow_holds_status on public.escrow_holds (status);
-- 운영자 조율 큐(F-A-12·F-A-17). S4-07·S5-08 이 쓴 것과 같은 모양이다.
create index if not exists idx_escrow_holds_disputed on public.escrow_holds (disputed_at)
  where status = 'disputed';
-- 자동 릴리즈 배치가 훑는 경로.
create index if not exists idx_escrow_holds_due on public.escrow_holds (confirm_due_at)
  where status = 'held';

-- =============================================================================
-- 2) 불변식 트리거
-- =============================================================================
create or replace function public.assert_escrow_hold()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_payment_status text;
begin
  -- **승인된 결제 위에만 선다**(위 근거 4). 받지 않은 돈을 보관할 수는 없다.
  if tg_op = 'INSERT' then
    select status into v_payment_status from public.payments where id = new.payment_id;

    if v_payment_status is null then
      raise exception '결제를 찾을 수 없습니다.' using errcode = 'foreign_key_violation';
    end if;

    if v_payment_status not in ('paid', 'partially_refunded') then
      raise exception '승인된 결제만 안전거래로 맡을 수 있습니다. 결제 상태: %', v_payment_status
        using errcode = 'check_violation', constraint = 'escrow_holds_payment_not_paid';
    end if;
  end if;

  -- **종결은 되돌리지 않는다**(위 근거 5 · D-23).
  if tg_op = 'UPDATE' and new.status is distinct from old.status then
    if not (
      (old.status = 'held' and new.status in ('disputed', 'released', 'refunded'))
      -- 조율에서 held 로 돌아가지 않는다 — 이의가 있었다는 사실이 남아야 한다.
      or (old.status = 'disputed' and new.status in ('released', 'refunded'))
    ) then
      raise exception '허용되지 않은 안전거래 상태 전이입니다: % -> %', old.status, new.status
        using errcode = 'check_violation', constraint = 'escrow_holds_transition';
    end if;
  end if;

  return new;
end;
$$;

comment on function public.assert_escrow_hold() is
  '에스크로 불변식. (가) 승인된 결제 위에만 홀드가 선다 — 받지 않은 돈을 보관할 수 없다. (나) 종결(released·refunded)은 되돌릴 수 없고 조율에서 보관으로도 돌아가지 않는다(D-23 — 이의가 있었다는 사실이 남아야 한다).';

drop trigger if exists trg_escrow_holds_guard on public.escrow_holds;
create trigger trg_escrow_holds_guard
  before insert or update on public.escrow_holds
  for each row execute function public.assert_escrow_hold();

-- =============================================================================
-- 3) RLS (§3.9)
-- -----------------------------------------------------------------------------
-- 0005 는 `escrow_holds` 에 정책을 만들지 않았다(집행 미구현이라 열 이유가 없었다).
-- 이제 화면이 생기므로 **열람만** 연다 — 쓰기는 서비스롤이다.
-- 클라이언트가 홀드를 쓸 수 있으면 **스스로 이행을 확인하고 릴리즈**할 수 있다.
--
-- 커플은 **owner 만**(§3.9 — 결제·계약 서명과 같은 조건이며 에스크로는 그 돈이다),
-- 업체는 멤버 전원(이행 확인은 담당자가 한다), 운영자는 조율 큐를 본다.
-- =============================================================================
alter table public.escrow_holds enable row level security;

-- 0005 의 정책은 `payments → bookings` 조인으로 당사자를 찾았다. 이제 홀드가
-- **`booking_id` 를 직접** 갖는다 — `payments.booking_id` 는 `on delete set null` 이라
-- 결제 행이 정리되면 조인이 끊기고 **당사자가 자기 보관 기록을 못 보게 된다.**
-- 조건을 넓히는 것이 아니라 **같은 판정을 끊기지 않는 경로로** 다시 쓴 것이다.
drop policy if exists escrow_holds_select on public.escrow_holds;

create policy escrow_holds_select on public.escrow_holds for select to authenticated
  using (
    booking_id is not null
    and (
      public.is_couple_owner(public.booking_couple_id(booking_id))
      or public.is_vendor_member(public.booking_vendor_id(booking_id))
    )
  );

comment on policy escrow_holds_select on public.escrow_holds is
  '안전거래 열람. 커플은 owner 만(§3.9 — 결제·계약 서명과 같은 조건이며 이것은 그 돈이다), 업체는 멤버 전원(이행 확인은 담당자가 한다). **쓰기 정책은 없다** — 당사자가 쓸 수 있으면 스스로 이행을 확인하고 릴리즈할 수 있다.';

create policy escrow_holds_select_operator on public.escrow_holds for select to authenticated
  using (public.is_operator());

-- =============================================================================
-- 4) 증적 열람 (D-23 · 0019 의 방식)
-- -----------------------------------------------------------------------------
-- **"언제 이행이 확인됐는가" 가 분쟁의 쟁점이다.** 당사자가 자기 기록을 읽을 수 있어야 한다.
-- =============================================================================
create policy entity_events_select_escrow on public.entity_events
  for select to authenticated
  using (
    entity_type = 'escrow_hold'
    and exists (
      select 1 from public.escrow_holds h
      where h.id = entity_events.entity_id
        and h.booking_id is not null
        and (
          public.is_couple_owner(public.booking_couple_id(h.booking_id))
          or public.is_vendor_member(public.booking_vendor_id(h.booking_id))
        )
    )
  );

-- =============================================================================
-- 5) 운영 파라미터 (§7.4 — 값을 코드에 박지 않는다)
-- =============================================================================
insert into public.app_settings (key, value_json, description)
values
  (
    'escrow.confirm_due_days',
    '{"days": 7, "unit": "days"}'::jsonb,
    '이행 확인 기한(일). **기한이 지나고 예식일도 지났으면 릴리즈**한다 — S4-07 보증금이 무응답을 환불로 읽은 것과 반대 방향이며, 이유는 여기서는 고객의 방치가 이득이 되기 때문이다(서비스는 이미 이행됐는데 확인만 안 하면 업체가 돈을 못 받는다). 예식일 전에는 기한이 지나도 릴리즈하지 않는다. 초기 운영값 7일.'
  ),
  (
    'escrow.enabled',
    '{"enabled": false, "openIssue": "O-03", "status": "undecided"}'::jsonb,
    '안전거래 실예치 활성 여부. **O-03(전자금융업 등록 등 법적 요건) 대기이므로 false 다** — 자금 보관은 대금을 옮기는 결제보다 요건이 무겁다. false 인 동안에도 절차·기록은 동작하며 화면이 그 사실을 고지한다. 결론이 나면 이 값을 켠다.'
  )
on conflict (key) do update
  set value_json = excluded.value_json, description = excluded.description
  where public.app_settings.value_json ->> 'status' = 'undecided';

-- =============================================================================
-- 이 파일이 한 것
--   컬럼 — escrow_holds +17 (절차·확인·조율·어댑터 참조)
--   CHECK 7 · UNIQUE 2(회차당 홀드 1 · 멱등 열쇠)
--   함수/트리거 1 — 승인된 결제 위에만 · 종결 되돌리기 금지
--   정책 3 — escrow_holds SELECT **재작성**(0005 의 조인 경로 → booking_id 직접) ·
--          운영자 SELECT · entity_events 열람
--   인덱스 4(조율 큐 · 자동 릴리즈 배치 경로 포함)
--   app_settings 2 — escrow.confirm_due_days · **escrow.enabled(O-03 대기 · false)**
--   기존 마이그레이션 수정 없음
--   **알림 토픽을 늘리지 않았다** — 고객에겐 payment, 업체에겐 settlement 다.
-- =============================================================================
