-- =============================================================================
-- 0030 · 분할 결제 실행 · 결제 전 동의 로그 · 결제 알림 토픽 (S5-06)
-- 근거: docs/07_개발명세서.md §2.1 F-C-14, §3.4 payments·payment_schedules·
--       payment_webhook_events, §4.2, §6.2 /checkout, §7.3, §7.4,
--       D-18 · D-21 · D-23 · D-27 · D-28
-- =============================================================================
-- 0028 이 **회차를 만드는 쪽**(스키마·불변식)을 끝냈고, 이 파일은 **그 회차를 실제로
-- 내는 쪽**을 만든다. 결제 실행은 돈이 움직이는 경로라 앱이 아니라 **DB 가 마지막
-- 경계**여야 한다 — S4-08 이 보증금에서, 0029 가 서명에서 세운 것과 같은 원칙이다.
--
-- 이 파일이 정한 것 — 판단이 필요했던 지점과 근거
--
--  1. **회차당 진행 중인 결제는 하나다.** 0028 이 "회차당 성공 결제 하나" 를 부분
--     유니크로 막았는데, 그것만으로는 **승인을 기다리는 pending 이 둘** 생기는 것을
--     막지 못한다. 그 상태가 되면 어느 것이 그 회차의 결제인지 알 수 없고, 둘 다
--     승인되면 성공 유니크에서 하나가 튕겨 **돈은 두 번 나갔는데 장부에는 한 번**이
--     된다. 그래서 `pending` 에도 부분 유니크를 건다.
--
--  2. **상태 전이를 트리거가 판정한다.** `pending → paid|failed|cancelled`,
--     `paid → partially_refunded|refunded` 만 허용하고 **종결 상태에서 되돌리는 것을
--     막는다.** 결제 상태는 분쟁의 1차 증거(D-23)이며, 코드가 실수로 `failed` 를
--     `pending` 으로 되돌리면 "언제 얼마를 냈는가" 의 답이 바뀐다.
--
--  3. **돈 없이 회차를 완료 처리할 수 없다.** `payment_schedules.status='paid'` 로
--     가려면 그 회차에 승인된 `payments` 행이 있어야 한다(트리거). 회차만 paid 로
--     적는 경로가 하나라도 생기면 미수금이 조용히 사라진다.
--
--  4. **계약이 확정되기 전에는 승인할 수 없다.** `contracts.status='active'`(전원
--     서명)가 아닌 계약의 회차는 `paid` 로 갈 수 없다. 서명 전에 받은 돈은 무엇에
--     대한 대가인지 정해지지 않은 돈이다.
--
--  5. **환불액을 컬럼으로 들고 상태와 짝을 맞춘다.** `refunded_amount` 없이
--     `partially_refunded` 만 두면 "얼마가 남았는가" 를 환불 행을 모아야 알 수 있고,
--     그 합계가 결제 금액을 넘는 것을 막을 자리가 없다. CHECK 로 셋을 묶는다 —
--     0원 환불은 상태를 바꾸지 않고, 전액이면 `refunded`, 그 사이면
--     `partially_refunded` 다. **경계는 전액 쪽**이다(1원이 남으면 아직 아니다).
--
--  6. **결제 전 동의는 별도 표에 남긴다.** F-C-14 가 "지급 조건·기한·금액을 결제 전
--     고지하고 **동의 로그를 저장**" 을 요구한다. `consents`(0002)는 가입 약관처럼
--     **사용자 단위** 동의라 회차를 가리킬 수 없다 — 어느 결제 앞에서 무엇에 동의했는지가
--     분쟁의 쟁점이므로 회차에 매달아야 한다. 문구 자체는 저장하지 않고 **종류 + 판본**을
--     저장한다(§7.3): 문구가 바뀌어도 과거 동의가 무엇이었는지 `lib/core/payment/checkout.ts`
--     의 판본으로 재현된다. 계약이 해시로 같은 문제를 푼 것과 같다(D-23).
--
--  7. **동의 없이는 결제가 승인되지 않는다** — 트리거가 판정한다. 앱에서만 검사하면
--     결제 경로가 늘 때(재시도 배치·운영 보정) 한 곳만 빠뜨려도 고지 없는 결제가 생긴다.
--
--  8. **알림 토픽에 `payment` 를 더한다.** 기존 토픽 중 결제를 담을 자리가 없었다 —
--     `contract` 는 계약 단계이고 결제는 그 뒤의 이행이라, 한 토픽으로 합치면 사용자가
--     "계약 알림만 끄고 결제 알림은 받기" 를 할 수 없다. 목록은 이 CHECK 와
--     `lib/core/schemas/notification.ts` 양쪽에 있으므로 함께 고친다(`db:rls` 가 본다).
--
--  9. **쿠폰은 이번에도 만들지 않는다**(D-27). 0028 이 같은 판단을 했고 그 뒤 T-00e 가
--     명세를 채워 **S5-11~S5-14** 에 배정했다. 결제 화면의 쿠폰 자리는 UI 상태로만
--     두며(`couponSlotState`), **'아직 없음' 과 '쿠폰 없음' 을 구별**한다. 스키마는
--     S5-11 이 만든다 — 여기서 지어내면 그 스키마가 명세를 앞지른다(§7.6).
-- =============================================================================

-- =============================================================================
-- 1) payments — 실행 결과를 담을 자리
-- =============================================================================
alter table public.payments add column if not exists paid_at timestamptz;
alter table public.payments add column if not exists failed_at timestamptz;
alter table public.payments add column if not exists cancelled_at timestamptz;
alter table public.payments add column if not exists refunded_amount bigint not null default 0;
alter table public.payments add column if not exists failure_reason text;
alter table public.payments add column if not exists attempt_count integer not null default 1;
/** 어느 어댑터가 처리했는가. 스텁으로 처리된 건을 나중에 골라낼 수 있어야 한다(D-28). */
alter table public.payments add column if not exists provider text;

alter table public.payments drop constraint if exists payments_paid_pair;
alter table public.payments
  add constraint payments_paid_pair
  check (
    (status in ('paid', 'partially_refunded', 'refunded')) = (paid_at is not null)
  );

alter table public.payments drop constraint if exists payments_failed_pair;
alter table public.payments
  add constraint payments_failed_pair
  check ((status = 'failed') = (failed_at is not null));

alter table public.payments drop constraint if exists payments_cancelled_pair;
alter table public.payments
  add constraint payments_cancelled_pair
  check ((status = 'cancelled') = (cancelled_at is not null));

alter table public.payments drop constraint if exists payments_attempt_positive;
alter table public.payments add constraint payments_attempt_positive check (attempt_count >= 1);

-- 환불액·상태의 짝(위 근거 5). 셋이 어긋나면 "얼마가 남았는가" 의 답이 둘이 된다.
alter table public.payments drop constraint if exists payments_refund_shape;
alter table public.payments
  add constraint payments_refund_shape
  check (
    refunded_amount >= 0
    and refunded_amount <= amount
    and (status <> 'refunded' or refunded_amount = amount)
    and (status <> 'partially_refunded' or (refunded_amount > 0 and refunded_amount < amount))
    and (status not in ('pending', 'failed', 'cancelled') or refunded_amount = 0)
  );

comment on column public.payments.refunded_amount is
  '누적 환불액. **부분 환불을 전제한다** — 취소 위약금이 붙으면 돌려줄 돈은 "낸 돈 − 위약금" 이라 회차 금액보다 작고(T-04), 계약 일부만 취소하면 그 비율만큼만 돌아간다. 전액 환불만 지원하면 그런 경우가 장부 밖으로 나가 D-23 이 요구하는 "얼마를 돌려받았는가" 를 재현할 수 없다. 상태와의 짝은 payments_refund_shape 가 강제한다.';
comment on column public.payments.attempt_count is
  '같은 회차에 대한 시도 횟수. 상한은 lib/payments 의 MAX_PAYMENT_ATTEMPTS(3) 이며 S4-08 알림·보증금과 같은 값이다. **자동 재시도는 멱등 열쇠를 바꾸지 않는다** — 열쇠가 바뀌면 재시도가 새 결제가 된다(paymentIdempotencyKey).';
comment on column public.payments.provider is
  '처리한 결제 어댑터 이름(stub | noop | toss). **스텁으로 처리된 건을 골라낼 수 있어야 한다**(D-28) — 실연동 전환 시 "이 결제는 진짜였나" 를 물을 수 있어야 하기 때문이다.';

-- **회차당 진행 중 결제는 하나**(위 근거 1). 0028 의 성공 유니크와 짝을 이룬다.
create unique index if not exists uq_payments_schedule_pending
  on public.payments (payment_schedule_id)
  where status = 'pending' and payment_schedule_id is not null;

create index if not exists idx_payments_paid_at on public.payments (paid_at);

-- =============================================================================
-- 2) payment_consents — 결제 전 고지·동의 로그 (F-C-14 · §7.3)
-- =============================================================================
create table if not exists public.payment_consents (
  id                  uuid primary key default gen_random_uuid(),
  payment_schedule_id uuid not null references public.payment_schedules (id) on delete cascade,
  user_id             uuid not null references auth.users (id) on delete restrict,
  /** 무엇에 동의했는가. 문구가 아니라 **종류**다. */
  kind                text not null,
  /** 그때의 문구 판본. 문구가 바뀌어도 과거 동의를 재현할 수 있다. */
  consent_version     text not null,
  agreed_at           timestamptz not null default now(),
  /** 요청 출처 해시. **원본 IP 를 저장하지 않는다**(§7.3). */
  ip_hash             text,
  created_at          timestamptz not null default now(),

  constraint payment_consents_kind_values
    check (kind in ('installment_terms', 'refund_policy')),
  constraint payment_consents_version_shape
    check (nullif(btrim(consent_version), '') is not null),

  -- 회차·종류당 하나. 재시도할 때마다 동의를 다시 받게 하면 실패 뒤 재결제가
  -- 번거로워지고, 여러 행이 쌓이면 "언제 동의했는가" 의 답이 여러 개가 된다.
  unique (payment_schedule_id, kind)
);

comment on table public.payment_consents is
  '결제 전 고지·동의 로그(F-C-14). **문구를 저장하지 않고 종류 + 판본을 저장한다**(§7.3) — 문구는 lib/core/payment/checkout.ts 의 CHECKOUT_CONSENT_ITEMS 가 판본과 함께 갖는다. consents(0002)를 쓰지 않는 이유는 그쪽이 사용자 단위라 회차를 가리킬 수 없기 때문이다 — 어느 결제 앞에서 무엇에 동의했는지가 분쟁의 쟁점이다(D-23).';
comment on column public.payment_consents.ip_hash is
  '요청 출처 해시. 원본 IP 를 저장하지 않는다(§7.3) — 남길 사실은 "같은 곳에서 왔는가" 이고 주소 자체가 아니다. 0029 가 서명 증적에서 쓴 것과 같다.';

create index if not exists idx_payment_consents_schedule
  on public.payment_consents (payment_schedule_id);

-- =============================================================================
-- 3) 불변식 트리거
-- =============================================================================

-- ── (가) 결제 상태 전이 (위 근거 2·4·7) ────────────────────────────────────
create or replace function public.assert_payment_transition()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_contract_status text;
  v_consents integer;
  v_required integer;
begin
  if tg_op = 'UPDATE' and new.status is distinct from old.status then
    -- 허용된 전이만. 종결 상태에서 되돌릴 수 없다.
    if not (
      (old.status = 'pending' and new.status in ('paid', 'failed', 'cancelled'))
      or (old.status = 'paid' and new.status in ('partially_refunded', 'refunded'))
      or (old.status = 'partially_refunded' and new.status in ('partially_refunded', 'refunded'))
      -- 재시도는 실패한 결제를 되살리지 않고 **새 행**을 만든다. 그래야 몇 번
      -- 시도했는지가 행으로 남는다(D-23).
    ) then
      raise exception '허용되지 않은 결제 상태 전이입니다: % -> %', old.status, new.status
        using errcode = 'check_violation', constraint = 'payments_transition';
    end if;
  end if;

  -- 승인 시점에만 본다. 실패·취소는 계약 상태와 무관하게 기록될 수 있어야 한다.
  if new.status = 'paid' and (tg_op = 'INSERT' or old.status is distinct from 'paid') then
    if new.payment_schedule_id is not null then
      select c.status into v_contract_status
      from public.payment_schedules s
      join public.contracts c on c.id = s.contract_id
      where s.id = new.payment_schedule_id;

      -- 계약이 확정되기 전에 받은 돈은 무엇에 대한 대가인지 정해지지 않았다.
      if v_contract_status is distinct from 'active' then
        raise exception '확정된 계약의 회차만 결제할 수 있습니다. 계약 상태: %',
          coalesce(v_contract_status, '(없음)')
          using errcode = 'check_violation', constraint = 'payments_contract_not_active';
      end if;

      -- 고지·동의 없이 승인될 수 없다(위 근거 7). 종류를 세는 것이 아니라
      -- **필요한 종류가 다 있는지**를 본다 — 같은 종류 두 건으로 통과할 수 없다.
      v_required := 2;

      select count(distinct kind) into v_consents
      from public.payment_consents
      where payment_schedule_id = new.payment_schedule_id
        and kind in ('installment_terms', 'refund_policy');

      if v_consents < v_required then
        raise exception '결제 전 고지·동의 기록이 없습니다. 필요 %종 중 %종.', v_required, v_consents
          using errcode = 'check_violation', constraint = 'payments_consent_missing';
      end if;
    end if;
  end if;

  return new;
end;
$$;

comment on function public.assert_payment_transition() is
  '결제 불변식. (가) 허용된 상태 전이만 — 종결 상태를 되돌릴 수 없다(D-23). (나) 확정된 계약(active)의 회차만 승인된다. (다) 결제 전 고지·동의 기록이 없으면 승인되지 않는다(F-C-14). 앱에서만 검사하면 경로가 늘 때 한 곳만 빠뜨려도 새어 나간다.';

drop trigger if exists trg_payments_transition on public.payments;
create trigger trg_payments_transition
  before insert or update on public.payments
  for each row execute function public.assert_payment_transition();

-- ── (나) 돈 없이 회차를 완료 처리할 수 없다 (위 근거 3) ────────────────────
create or replace function public.assert_schedule_paid_has_payment()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_paid integer;
begin
  if new.status <> 'paid' then return new; end if;
  if tg_op = 'UPDATE' and old.status = 'paid' then return new; end if;

  select count(*) into v_paid
  from public.payments
  where payment_schedule_id = new.id and status in ('paid', 'partially_refunded', 'refunded');

  if v_paid = 0 then
    raise exception '승인된 결제 없이 회차를 완료 처리할 수 없습니다.'
      using errcode = 'check_violation', constraint = 'payment_schedules_paid_without_payment';
  end if;

  return new;
end;
$$;

comment on function public.assert_schedule_paid_has_payment() is
  '회차 완료의 근거를 요구한다. 회차만 paid 로 적는 경로가 하나라도 생기면 미수금이 조용히 사라진다 — 회차는 "받았다" 를 주장하고 payments 는 "받은 사실" 을 갖는다.';

drop trigger if exists trg_payment_schedules_paid_guard on public.payment_schedules;
create trigger trg_payment_schedules_paid_guard
  before insert or update on public.payment_schedules
  for each row execute function public.assert_schedule_paid_has_payment();

-- =============================================================================
-- 4) RLS (§3.9)
-- -----------------------------------------------------------------------------
-- **쓰기 정책을 주지 않는다.** 결제 실행·동의 기록·환불은 전부 서버(서비스롤)의 일이다.
-- 클라이언트가 payments 를 만들 수 있으면 **스스로 금액을 적을 수 있고**, 동의 행을
-- 만들 수 있으면 **고지받지 않고 고지받았다고 적을 수 있다**(0029 가 서명에서 내린
-- 결론과 같다 — 서명·결제는 없는 사실을 만들어 낼 수 있는 자리다).
-- =============================================================================
alter table public.payment_consents enable row level security;

-- 동의 기록은 커플 소유자와 업체가 읽는다. 업체에도 여는 이유 — 분쟁에서 "고지했다"
-- 를 증명해야 하는 쪽이 업체이기도 하다(D-23). 담기는 것은 종류·판본·시각뿐이라
-- 열어도 개인정보가 나가지 않는다.
create policy payment_consents_select on public.payment_consents for select to authenticated
  using (exists (
    select 1 from public.payment_schedules s
    where s.id = payment_consents.payment_schedule_id
      and (
        public.is_couple_owner(public.booking_couple_id(public.contract_booking_id(s.contract_id)))
        or public.is_vendor_member(public.booking_vendor_id(public.contract_booking_id(s.contract_id)))
      )
  ));

comment on policy payment_consents_select on public.payment_consents is
  '결제 전 고지·동의 기록 열람. 커플은 owner 만(§3.9 결제는 owner 조건), 업체는 멤버 전원 — 분쟁에서 "고지했다" 를 증명해야 하는 쪽이 업체이기도 하다.';

-- =============================================================================
-- 5) 증적 열람 (D-23 · 0019·0028 의 방식)
-- =============================================================================
create policy entity_events_select_payment_consent on public.entity_events
  for select to authenticated
  using (
    entity_type = 'payment_consent'
    and exists (
      select 1 from public.payment_consents pc
      join public.payment_schedules s on s.id = pc.payment_schedule_id
      where pc.id = entity_events.entity_id
        and (
          public.is_couple_owner(public.booking_couple_id(public.contract_booking_id(s.contract_id)))
          or public.is_vendor_member(public.booking_vendor_id(public.contract_booking_id(s.contract_id)))
        )
    )
  );

-- =============================================================================
-- 6) 알림 토픽에 payment 추가 (위 근거 8)
-- -----------------------------------------------------------------------------
-- 0023·0024·0026 이 남긴 규칙 그대로 — 목록은 이 CHECK 와
-- `lib/core/schemas/notification.ts` **양쪽**에 있으므로 함께 고친다.
-- =============================================================================
alter table public.notifications drop constraint if exists notifications_topic_chk;

alter table public.notifications
  add constraint notifications_topic_chk
  check (
    topic in (
      'dday', 'schedule', 'contract', 'care', 'price_change', 'couple_invite',
      'chat', 'inquiry', 'vendor_invite',
      -- S5-06. 계약 단계(contract)와 나누는 이유 — 결제는 계약 뒤의 **이행**이라
      -- "계약 알림만 끄고 결제 알림은 받기" 가 성립해야 한다.
      'payment'
    )
  );

alter table public.notification_prefs drop constraint if exists notification_prefs_topic_chk;

alter table public.notification_prefs
  add constraint notification_prefs_topic_chk
  check (
    topic in (
      'dday', 'schedule', 'contract', 'care', 'price_change', 'couple_invite',
      'chat', 'inquiry', 'vendor_invite', 'payment'
    )
  );

-- =============================================================================
-- 7) 운영 파라미터 (§7.4 — 값을 코드에 박지 않는다)
-- =============================================================================
insert into public.app_settings (key, value_json, description)
values
  (
    'payment.max_attempts',
    '{"count": 3, "unit": "attempts"}'::jsonb,
    '한 회차에 대한 결제 시도 상한. 상한을 두는 이유는 영구 오류(한도 초과·정지 카드)가 큐를 영원히 막지 않게 하는 것이며, S4-08 보증금·S4-13 알림과 같은 값이다. 상한에 닿으면 화면이 다른 결제 수단이나 고객센터를 안내한다.'
  )
on conflict (key) do update
  set value_json = excluded.value_json, description = excluded.description
  where public.app_settings.value_json ->> 'status' = 'undecided';

-- =============================================================================
-- 이 파일이 한 것
--   테이블 1 — payment_consents (결제 전 고지·동의 로그)
--   컬럼 — payments +7 (paid_at · failed_at · cancelled_at · refunded_amount ·
--          failure_reason · attempt_count · provider)
--   CHECK 7 · UNIQUE 2(회차·종류당 동의 1 · **회차당 pending 결제 1**)
--   함수 2 — 결제 상태 전이 · 회차 완료 근거
--   트리거 2
--   정책 — payment_consents SELECT · entity_events(payment_consent) SELECT
--   알림 토픽 — notifications·notification_prefs CHECK 에 'payment' 추가
--   app_settings 1 — payment.max_attempts
--   기존 마이그레이션 수정 없음
--   **만들지 않은 것** — 쿠폰 3표(D-27 · S5-11). 결제 화면의 쿠폰 자리는 UI 상태로만 둔다.
-- =============================================================================
