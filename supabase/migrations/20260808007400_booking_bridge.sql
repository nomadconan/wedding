-- =============================================================================
-- C-1 견적 수락 → 예약 생성 다리 · 세 면 거래 상세
-- =============================================================================
--
-- ── 무엇이 끊겨 있었나 (B-1 조사) ──────────────────────────────────────────
--
--   문의 → 견적 → [수락] → ??? → 계약 → 서명 → 결제 → 정산
--    ✅     ✅       ✅      ❌     ✅     ✅     ✅     ✅
--
-- `POST /api/contracts` 는 **이미 있는 `bookingId`** 를 요구하는데 리포 전체에
-- `bookings` 에 INSERT 하는 코드가 **0건**이었다. 지금 있는 예약은 전부
-- `seed-accounts.mjs` 가 서비스롤로 넣은 픽스처다. 하류는 다 만들어졌고 다리만 없었다.
--
-- ── 권한 감사 — 표를 만지기 전에 세 층을 봤다 ──────────────────────────────
--
-- **층 1 (정책 아래의 권한).** `bookings` 는 0065(FIX-44)가 이미 닫았다 —
-- `revoke all` 뒤 `grant select` 만 돌려줬고 `bookings_insert`·`bookings_update`
-- 정책도 함께 걷었다. **쓰기는 전부 서비스롤 경유**(D-62)다. 이번에 그 상태를 바꾸지
-- 않는다 — 생성 경로를 만들면서 표를 다시 열면 FIX-44 를 그대로 되돌리는 일이다.
--
-- **그런데 층 1 에 구멍이 하나 남아 있었다.** `assert_booking_rate_snapshot` 이
-- **`before update` 전용**이라 `status='confirmed'` 인 행을 **INSERT 로 바로 만들면**
-- 요율 검사를 통째로 건너뛴다. 0065 주석이 그 사실을 적어 두었고(곁가지 넷 중 하나),
-- **오늘은 INSERT 경로가 없어 도달할 수 없었다.** 이 마이그레이션이 그 경로를
-- 만들므로 **여기서 닫는다** — 구멍을 열면서 같이 닫지 않으면 열어 둔 것이 된다.
--
-- **층 2 (부모 표의 정책에 기대는가).** 이번에 더하는 것은 컬럼 하나와 함수 둘이며
-- 새 정책이 없다. 기존 `bookings_select` 는 세 갈래가 **자기 조건을 스스로 말한다**
-- (`is_couple_member` · `is_vendor_member` · `has_planner_scope`) — 층 2 위반 없음.
--
-- **층 3 (자격의 근거 표를 자격을 얻으려는 사람이 직접 쓸 수 있는가).**
-- `bookings` 가 정확히 그 표다 — `reviews_insert` 가 `bookings.status` 를 후기 자격으로
-- 삼는다(D-129). 0065 가 표에서 쓰기를 걷었으므로 **당사자는 여전히 못 쓴다.**
-- 이번 다리는 서비스롤로 쓰고 **자격을 서버가 판정한다**(`lib/bookings/create.ts`).
-- 만드는 것은 `hold` 이며 `accepted_at` 은 **비운다** — 고객의 행위로 업체 동의가
-- 만들어지면 그것이 바로 FIX-44 가 막은 모양이다.
--
-- ── 자리·요율은 이 다리가 건드리지 않는다 ─────────────────────────────────
-- **자리는 `confirmed` 에서 잡힌다**(`apply_booking_slot_movement` · 0031).
-- **요율은 서명 완료 시 박힌다**(`activateContract` → `bookings` UPDATE).
-- `hold` 예약은 자리를 차지하지 않고 요율이 null 이며 **그것이 정상**이다
-- (null = "아직 스냅샷하지 않았다").
-- =============================================================================

-- ══════════════════════════════════════════════════════════════════════════
-- 1. 요율 스냅샷 검사를 INSERT 에도 건다 (층 1 구멍)
-- ══════════════════════════════════════════════════════════════════════════
--
-- `old` 는 INSERT 에서 null 이다. 두 갈래를 나눠 쓰지 않고 **"이전 값" 을 지역 변수로
-- 정규화**한다 — 갈래를 나누면 한쪽만 고치는 날이 오고, 그날 조용히 뚫린다.
create or replace function public.assert_booking_rate_snapshot()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_old_fee         integer;
  v_old_planner_fee integer;
  v_old_status      text;
begin
  if tg_op = 'INSERT' then
    v_old_fee         := null;
    v_old_planner_fee := null;
    -- INSERT 에는 '이전 상태' 가 없다. `confirmed` 로 바로 들어오는 것도
    -- **전이**로 본다 — 그래야 아래 검사가 걸린다.
    v_old_status      := null;
  else
    v_old_fee         := old.applied_fee_rate_bp;
    v_old_planner_fee := old.applied_planner_fee_rate_bp;
    v_old_status      := old.status::text;
  end if;

  -- 스냅샷은 나중에 고쳐지지 않는다. 고칠 수 있으면 스냅샷이 아니라 그냥 값이다.
  if v_old_fee is not null and new.applied_fee_rate_bp is distinct from v_old_fee then
    raise exception '확정된 수수료율 스냅샷은 바꿀 수 없습니다.' using errcode = 'check_violation';
  end if;

  if v_old_planner_fee is not null
     and new.applied_planner_fee_rate_bp is distinct from v_old_planner_fee then
    raise exception '확정된 플래너 수수료율 스냅샷은 바꿀 수 없습니다.' using errcode = 'check_violation';
  end if;

  -- 요율 없이 확정된 계약은 나중에 정산할 근거가 없다(§3.8).
  -- **INSERT 로 바로 `confirmed` 인 행도 여기서 걸린다** — 그 길이 0065 가 적어 둔
  -- 곁가지였고, 이 마이그레이션이 생성 경로를 만들므로 함께 닫는다.
  if new.status = 'confirmed' and v_old_status is distinct from 'confirmed' then
    if new.applied_fee_rate_bp is null or new.applied_planner_fee_rate_bp is null then
      raise exception '요율 스냅샷 없이 계약을 확정할 수 없습니다. 플래너를 쓰지 않으면 0 을 적습니다.'
        using errcode = 'check_violation', constraint = 'bookings_rate_snapshot_required';
    end if;
  end if;

  return new;
end;
$$;

comment on function public.assert_booking_rate_snapshot() is
  '요율 스냅샷 불변식(D-16·D-17). (가) 한 번 채워진 스냅샷은 못 바꾼다 (나) confirmed 전이에는 두 요율이 모두 있어야 한다. **0074 가 INSERT 에도 걸었다** — before update 전용이던 탓에 confirmed 행을 INSERT 로 바로 만들면 검사를 건너뛸 수 있었고(0065 가 적어 둔 곁가지), C-1 이 생성 경로를 만들면서 그 길이 실제로 열리기 전에 닫았다. 플래너 미선택은 0 이고 null 이 아니다.';

drop trigger if exists trg_bookings_rate_snapshot on public.bookings;
create trigger trg_bookings_rate_snapshot
  before insert or update on public.bookings
  for each row execute function public.assert_booking_rate_snapshot();

-- ══════════════════════════════════════════════════════════════════════════
-- 2. 예약이 어느 견적에서 왔는지 남긴다
-- ══════════════════════════════════════════════════════════════════════════
--
-- **왜 컬럼인가.** `contracts.quote_id` 는 이미 있는데 그것은 계약이 발행된 뒤의
-- 이야기다. 예약은 계약보다 앞서 생기므로 그 사이의 출처를 담을 자리가 없었다.
-- 운영자 조율(§4)과 업체 화면이 "이 예약은 저 견적에서 왔다" 를 말하려면 필요하다.
--
-- **on delete set null.** 견적이 사라져도 예약은 남아야 한다 — 예약은 그 자체로
-- 사실이고, 출처를 잃는 것과 예약이 없어지는 것은 다르다.
alter table public.bookings
  add column if not exists quote_id uuid references public.quotes (id) on delete set null;

comment on column public.bookings.quote_id is
  'C-1. 이 예약을 만든 견적. **한 견적은 예약을 하나만 만든다**(아래 부분 유니크) — 고객이 수락 버튼을 두 번 눌러도 예약이 둘 생기면 업체는 같은 건을 두 번 승인해야 하고 자리도 두 번 잡힌다. null 은 견적을 거치지 않은 예약이다(시드 픽스처·이관분).';

-- **한 견적당 예약 하나.** 부분 유니크라 `null` 은 여러 개일 수 있다.
create unique index if not exists uq_bookings_quote
  on public.bookings (quote_id)
  where quote_id is not null;

create index if not exists idx_bookings_created_at on public.bookings (created_at desc);

-- ══════════════════════════════════════════════════════════════════════════
-- 3. 운영자 거래 조회 — **정책이 아니라 definer 함수** (D-120)
-- ══════════════════════════════════════════════════════════════════════════
--
-- D-115 는 "행이 목적이면 정책" 이라고 정했고 그 말은 여전히 맞다. 그런데 D-120 이
-- 조건을 하나 더 달았다 — **행을 보여 줘도 되는가.**
--
-- 거래 하나를 통으로 보려면 `bookings`·`contracts`·`payments`·`quotes`·`inquiries`·
-- `consultations` 를 함께 읽어야 하는데 그 사슬에는 운영자가 볼 이유가 없는 칸이 섞여 있다:
--
--   `contracts.clauses_json` · `contracts.pdf_path`  계약 정본과 **Storage 경로**(§5.3 금지)
--   `inquiries.note`                                  고객이 쓴 자유 텍스트
--   `quotes.vendor_memo`                              업체가 쓴 메모
--   `consultations.location`                          장소(주소가 들어온다)
--
-- 정책으로 열면 **표 전체가 열린다** — 정책은 행을 가르지 칸을 가르지 않는다.
-- 그래서 `transparent_contract_since`·`planner_contract_count` 와 같은 방식으로
-- **definer 함수가 투영해서 내보낸다.** 위 네 칸은 **애초에 함수 밖으로 나가지 않는다.**
--
-- **집계가 아니라 행이다.** 운영자 대시보드는 이미 건수를 센다(`admin_metrics`).
-- 여기서 필요한 것은 "이 거래가 지금 어디까지 왔나" 이고 그것은 행이어야 답이 된다.

create or replace function public.admin_transaction_rows(p_limit integer default 100)
returns table (
  booking_id      uuid,
  booking_status  text,
  vendor_id       uuid,
  vendor_name     text,
  couple_id       uuid,
  total_amount    bigint,
  created_at      timestamptz,
  accepted_at     timestamptz,
  declined_at     timestamptz,
  quote_id        uuid,
  contract_id     uuid,
  contract_status text,
  paid_count      integer,
  schedule_count  integer,
  settled         boolean
)
language sql security definer stable set search_path = public as $$
  select
    b.id,
    b.status::text,
    b.vendor_id,
    v.name,
    b.couple_id,
    b.total_amount,
    b.created_at,
    b.accepted_at,
    b.declined_at,
    b.quote_id,
    c.id,
    c.status,
    (select count(*)::integer from public.payments p
      where p.booking_id = b.id and p.status = 'paid'),
    (select count(*)::integer from public.payment_schedules s
      where s.contract_id = c.id),
    exists (select 1 from public.settlement_items si where si.booking_id = b.id)
  from public.bookings b
  join public.vendors v on v.id = b.vendor_id
  -- **살아 있는 계약 하나만 붙인다.** 취소된 계약이 여럿일 수 있고, 그중 무엇을
  -- 보여 줄지 정하지 않으면 화면이 회차마다 다른 계약을 그린다.
  left join lateral (
    select ct.id, ct.status
    from public.contracts ct
    where ct.booking_id = b.id
    order by (ct.status <> 'cancelled') desc, ct.created_at desc
    limit 1
  ) c on true
  where public.is_operator()
  order by b.created_at desc
  limit greatest(1, least(coalesce(p_limit, 100), 500));
$$;

comment on function public.admin_transaction_rows(integer) is
  'C-1. 운영자 거래 목록. **definer 로 투영한다**(D-120) — 계약 정본·Storage 경로·고객 메모·업체 메모·상담 장소는 함수 밖으로 나가지 않는다. `is_operator()` 가 아니면 **행이 0건**이며 오류가 아니다(권한을 오류로 알리면 그 자체가 정보다). 집계가 아니라 행인 이유는 운영자가 답해야 하는 질문이 "몇 건인가" 가 아니라 "이 거래가 어디까지 왔나" 라서다.';

revoke all on function public.admin_transaction_rows(integer) from public, anon;
grant execute on function public.admin_transaction_rows(integer) to authenticated;

-- ── 거래 하나의 사슬 ────────────────────────────────────────────────────────
--
-- **시각만 돌려준다.** 각 단계가 언제 일어났는가가 조율의 근거이고, 무엇을 적었는지는
-- 아니다. 그래서 본문·메모·경로가 하나도 없다.
create or replace function public.admin_transaction_chain(p_booking_id uuid)
returns table (
  stage       text,
  occurred_at timestamptz,
  detail      text
)
language sql security definer stable set search_path = public as $$
  -- **권한은 where 로 건다.** 처음에 `cross join allowed` 로 썼다가 CI 가 잡았다 —
  -- `select *` 가 그 조인 컬럼까지 끌어와 **선언한 3칸에 4칸을 돌려주려** 했다
  -- (`return type mismatch in function declared to return record`).
  select c.stage, c.occurred_at, c.detail
  from (
    select 'inquiry_sent'::text as stage, i.created_at as occurred_at, null::text as detail
      from public.bookings b
      join public.quotes q on q.id = b.quote_id
      join public.inquiry_targets it on it.id = q.inquiry_target_id
      join public.inquiries i on i.id = it.inquiry_id
     where b.id = p_booking_id
    union all
    select 'quote_sent', q.sent_at, null::text
      from public.bookings b join public.quotes q on q.id = b.quote_id
     where b.id = p_booking_id and q.sent_at is not null
    union all
    select 'quote_decided', q.decided_at, q.status
      from public.bookings b join public.quotes q on q.id = b.quote_id
     where b.id = p_booking_id and q.decided_at is not null
    union all
    select 'booking_created', b.created_at, null::text
      from public.bookings b where b.id = p_booking_id
    union all
    select 'booking_accepted', b.accepted_at, null::text
      from public.bookings b where b.id = p_booking_id and b.accepted_at is not null
    union all
    -- **거절 사유는 싣는다.** 사유 없는 거절은 조율의 근거가 되지 못한다(D-24).
    select 'booking_declined', b.declined_at, b.decline_reason
      from public.bookings b where b.id = p_booking_id and b.declined_at is not null
    union all
    select 'contract_issued', ct.issued_at, null::text
      from public.contracts ct where ct.booking_id = p_booking_id and ct.issued_at is not null
    union all
    select 'contract_activated', ct.activated_at, null::text
      from public.contracts ct where ct.booking_id = p_booking_id and ct.activated_at is not null
    union all
    select 'contract_cancelled', ct.cancelled_at, null::text
      from public.contracts ct where ct.booking_id = p_booking_id and ct.cancelled_at is not null
    union all
    select 'payment_paid', p.paid_at, null::text
      from public.payments p
     where p.booking_id = p_booking_id and p.status = 'paid' and p.paid_at is not null
    union all
    select 'settled', si.created_at, null::text
      from public.settlement_items si where si.booking_id = p_booking_id
  ) c
  where public.is_operator()
  order by 2;
$$;

comment on function public.admin_transaction_chain(uuid) is
  'C-1. 거래 하나의 사슬을 시간순으로. **시각만 돌려준다** — 계약 본문·고객 메모·업체 메모는 나가지 않는다. 거절 사유만 예외로 싣는다(D-24 — 사유 없는 거절은 조율의 근거가 못 된다). `is_operator()` 가 아니면 0건이다. **표를 새로 만들지 않았다**(D-124) — 전부 이미 어딘가에 시각으로 적혀 있는 사실이고 이 함수는 늘어놓기만 한다.';

revoke all on function public.admin_transaction_chain(uuid) from public, anon;
grant execute on function public.admin_transaction_chain(uuid) to authenticated;
