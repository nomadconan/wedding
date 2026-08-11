-- =============================================================================
-- 0025 · 상담·탐방 예약 + 노쇼 보증금 (S4-02 잔여 · S4-07 · S4-08 골격 · S4-09)
-- 근거: docs/07_개발명세서.md §2.1 F-C-29, §2.2 F-V-17, §3.4 consultations·
--       consultation_deposits, §3.9 RLS(상담·보증금), §3.11 이행 확인·노쇼 처리,
--       §7.4(가변 파라미터), D-22·D-23·D-24·D-28
-- =============================================================================
-- 0007 이 `vendor_availability` 만 만들고 "consultations·consultation_deposits 는
-- 4단계 예약 흐름과 함께 별도 마이그레이션으로 추가한다" 고 남겼다. 그 자리가 여기다.
--
-- ── 이 파일이 정한 것 — 판단이 필요했던 지점 ────────────────────────────────
--
--  1. **슬롯 중복은 UNIQUE 가 아니라 EXCLUDE 로 막는다.**
--     S2-05·S3-04 가 세운 기준은 "한 점의 중복이면 UNIQUE, 겹침이면 EXCLUDE" 다.
--     상담은 **시각 하나가 아니라 구간**을 차지한다 — 14:00 60분 예약과 14:30 60분
--     예약은 시작 시각이 달라서 UNIQUE 로는 둘 다 통과하지만, 실제로는 겹친다.
--     그래서 `tstzrange(scheduled_at, scheduled_at + duration)` 겹침을 거부한다.
--     (0007 이 `vendor_availability` 의 요일별 시간대 겹침을 막은 것과 같은 방식이며,
--      그쪽은 시각만 다루므로 `timerange`, 이쪽은 날짜까지 있으므로 `tstzrange` 다.)
--
--     **어느 상태부터 자리를 차지하는가** — `approved`·`confirmed` 만이다.
--     `requested` 까지 막으면 고객이 신청만 해 두고 자리를 선점할 수 있고, 업체가
--     승인할 후보를 여럿 받아 고르는 정상적인 흐름이 막힌다. 대신 **승인 시점에**
--     두 번째 승인이 EXCLUDE 로 거절된다 — 판정이 DB 에서 일어나므로 동시에 두 명을
--     승인해도 한 명만 통과한다(앱이 먼저 조회해 확인하는 방식은 경합에서 진다).
--
--  2. **양측의 '주장' 을 따로 적는다.**
--     §3.4 는 `couple_confirmed_at`·`vendor_confirmed_at`·`outcome` 만 든다. 그런데
--     §3.11 은 "양측 응답이 **일치**하면" 자동 처리하라고 한다 — **응답 시각만으로는
--     일치를 판정할 수 없다.** 무엇을 답했는지가 있어야 한다. 그래서
--     `couple_outcome`·`vendor_outcome` 을 더했다. `outcome` 은 그 둘을 대조한
--     **결론**이며 서버가 넣는다.
--
--  3. **무응답 기본값은 환불이다**(§3.11 NOTE). 이 규칙은 DB 가 아니라 배치가
--     집행하지만, 그 이유를 여기 적어 둔다 — 기본값이 몰취면 업체는 아무것도 하지
--     않는 편이 유리해지고 확인 절차가 형해화된다. 기본값은 **방치가 이득이 되지
--     않는 방향**으로 정한다.
--
--  4. **보증금은 플랫폼의 벌금이 아니다**(D-24). 양측이 합의한 조건을 플랫폼이
--     보관했다가 규칙대로 집행하는 것이다. 그래서 `consultation_deposits` 에
--     `resolution_reason`·`resolved_by` 를 두고 **왜 그렇게 처리했는지**를 남긴다.
--     플랫폼이 재량으로 정하는 값이 아니라 §3.11 의 규칙이 정한 값이다.
--
--  5. **플래너는 상담을 본다.** 채팅(0021)에서는 뺐는데 여기서는 넣는다 —
--     §3.9 가 상담 행에만 "위임 플래너" 를 명시하기 때문이고, 그럴 만한 이유가 있다:
--     상담 일정은 **커플의 일정**이라 대신 챙기는 것이 플래너의 일이지만, 채팅은
--     업체와의 **대화**라 제3자를 넣으면 업체가 동의한 범위가 바뀐다.
--     `planner_id` 는 지금 항상 null 이다(플래너 마켓은 6단계) — 자리만 둔다.
-- =============================================================================

-- =============================================================================
-- 1) 값 집합 (§3.4 consultations 값 집합 표 — 명세가 못박았으므로 ENUM 이다)
-- =============================================================================
create type public.consultation_type as enum ('visit_consult', 'venue_tour', 'phone', 'video');

comment on type public.consultation_type is
  '방문상담 · 탐방 · 전화 · 화상(§3.4). **앞의 두 유형만 보증금 대상**이다 — 업체가 자리를 비워 두고 기다리는 유형이기 때문이고, 전화·화상은 노쇼의 비용이 그만큼 크지 않다.';

create type public.consultation_status as enum (
  'requested', 'approved', 'rejected', 'confirmed',
  'completed', 'no_show', 'cancelled', 'disputed'
);

create type public.consultation_outcome as enum (
  'fulfilled', 'no_show_couple', 'no_show_vendor', 'undetermined'
);

-- =============================================================================
-- 2) consultations (§3.4)
-- =============================================================================
create table public.consultations (
  id                   uuid primary key default gen_random_uuid(),
  couple_id            uuid not null references public.couples (id) on delete cascade,
  vendor_id            uuid not null references public.vendors (id) on delete cascade,
  -- 플래너 마켓은 6단계다. 지금은 항상 null 이며 자리만 둔다(D-19 3자 일정 공유).
  planner_id           uuid references public.planners (id) on delete set null,
  type                 public.consultation_type not null,
  scheduled_at         timestamptz not null,
  -- 슬롯 길이. vendor_availability.slot_minutes 에서 가져와 **박아 둔다** —
  -- 업체가 나중에 슬롯 길이를 바꿔도 이미 잡힌 예약의 구간이 흔들리면 안 된다.
  duration_minutes     integer not null,
  -- **끝 시각을 컬럼으로 들고 있는다.** 아래 EXCLUDE 가 이 값을 쓰는데,
  -- `scheduled_at + interval` 은 IMMUTABLE 이 아니라(타임존 설정에 따라 DST 계산이
  -- 달라진다) 인덱스 식에 넣을 수 없다. 생성 컬럼도 같은 이유로 막힌다.
  -- 그래서 트리거가 채우고 CHECK 가 순서를 지킨다 — 손으로 적는 값이 아니다.
  ends_at              timestamptz not null,
  status               public.consultation_status not null default 'requested',
  location             text,
  requested_at         timestamptz not null default now(),
  approved_at          timestamptz,
  rejected_at          timestamptz,
  reject_reason        text,
  cancelled_at         timestamptz,
  cancel_reason        text,
  cancelled_by         uuid references auth.users (id) on delete set null,
  -- 이행 확인 (§3.11)
  confirm_due_at       timestamptz,
  couple_confirmed_at  timestamptz,
  vendor_confirmed_at  timestamptz,
  couple_outcome       public.consultation_outcome,
  vendor_outcome       public.consultation_outcome,
  outcome              public.consultation_outcome,
  resolved_at          timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  constraint consultations_duration_range
    check (duration_minutes > 0 and duration_minutes <= 1440),

  constraint consultations_ends_after_start
    check (ends_at > scheduled_at),

  -- 거절에는 사유가 있다. 사유 없는 거절은 고객에게 아무것도 알려 주지 못한다.
  constraint consultations_reject_pair_chk
    check ((rejected_at is null) = (reject_reason is null)),

  -- 상태와 시각이 어긋나면 둘 중 하나는 거짓이다.
  constraint consultations_rejected_state_chk
    check ((status = 'rejected') = (rejected_at is not null)),
  constraint consultations_cancelled_state_chk
    check ((status = 'cancelled') = (cancelled_at is not null)),

  -- 확인 응답에는 시각과 주장이 짝이다. 하나만 있으면 대조할 수 없다.
  constraint consultations_couple_confirm_pair_chk
    check ((couple_confirmed_at is null) = (couple_outcome is null)),
  constraint consultations_vendor_confirm_pair_chk
    check ((vendor_confirmed_at is null) = (vendor_outcome is null))
);

comment on table public.consultations is
  '상담·탐방 예약(F-C-29). 신청 → 업체 승인 → (보증금 결제 시) 확정 → 이행 확인. 판정 규칙은 §3.11 이고 그 계산은 lib/core/consultation 의 순수 함수가 한다.';
comment on column public.consultations.planner_id is
  '3자 일정 공유(D-19)의 플래너 자리. 플래너 마켓이 6단계라 지금은 항상 null 이다. **열람 권한은 이 컬럼이 아니라 planner_engagements 위임으로 판정한다**(§3.9) — 여기 값이 없어도 위임받은 플래너는 본다.';
comment on column public.consultations.duration_minutes is
  '예약 구간 길이. vendor_availability.slot_minutes 를 신청 시점에 박아 둔다 — 업체가 나중에 슬롯 길이를 바꿔도 이미 잡힌 예약의 구간이 흔들리면 안 된다(가격 스냅샷과 같은 발상).';
comment on column public.consultations.couple_outcome is
  '고객이 주장한 이행 결과. §3.4 는 확인 **시각**만 들었지만, §3.11 이 "양측 응답이 일치하면" 을 요구하므로 **무엇을 답했는지**가 있어야 대조가 된다.';
comment on column public.consultations.vendor_outcome is
  '업체가 주장한 이행 결과. couple_outcome 과 대조해 outcome 을 정한다(§3.11).';
comment on column public.consultations.outcome is
  '양측 주장을 대조한 **결론**. 서버(배치·API)가 넣으며 당사자가 직접 쓰지 않는다.';
comment on column public.consultations.confirm_due_at
  is '이행 확인 응답 기한. app_settings.consultation.confirm_due_hours 로 계산한다 — 코드에 박지 않는다(§7.4).';

-- ── 슬롯 중복 금지 (위 1번 근거) ──────────────────────────────────────────────
-- `requested` 는 자리를 차지하지 않는다. 승인·확정만이 차지한다.
-- `ends_at` 은 트리거가 채운다. `scheduled_at + interval` 을 식에 바로 쓰면
-- "functions in index expression must be marked IMMUTABLE" 로 거절된다 —
-- timestamptz 덧셈이 타임존 설정에 의존하기 때문이다.
create or replace function public.consultation_set_ends_at()
returns trigger language plpgsql as $$
begin
  new.ends_at := new.scheduled_at + make_interval(mins => new.duration_minutes);

  return new;
end;
$$;

comment on function public.consultation_set_ends_at() is
  '예약 구간의 끝 시각을 채운다. EXCLUDE 가 인덱스 식에서 timestamptz 덧셈을 쓸 수 없어(IMMUTABLE 아님) 값을 컬럼으로 들고 있는다.';

drop trigger if exists trg_consultations_ends_at on public.consultations;
create trigger trg_consultations_ends_at
  before insert or update of scheduled_at, duration_minutes on public.consultations
  for each row execute function public.consultation_set_ends_at();

alter table public.consultations
  add constraint consultations_no_overlap
  exclude using gist (
    vendor_id with =,
    tstzrange(scheduled_at, ends_at, '[)') with &&
  )
  where (status in ('approved', 'confirmed'));

comment on constraint consultations_no_overlap on public.consultations is
  '같은 업체의 확정 예약이 시간상 겹치는 것을 막는다. 시각 하나가 아니라 **구간**의 겹침이라 UNIQUE 가 아니라 EXCLUDE 다(S2-05 기준). 승인 시점에 DB 가 판정하므로 동시 승인에서도 하나만 통과한다.';

create index if not exists idx_consultations_couple on public.consultations (couple_id, scheduled_at desc);
create index if not exists idx_consultations_vendor on public.consultations (vendor_id, scheduled_at desc);

-- 이행 확인 요청 배치(consultation-confirm-request)가 훑을 경로 —
-- 예정 시각이 지났는데 아직 확인 기한이 잡히지 않은 것.
create index if not exists idx_consultations_awaiting_confirm
  on public.consultations (scheduled_at)
  where status = 'confirmed' and confirm_due_at is null;

-- 판정 배치(consultation-resolve)가 훑을 경로 — 확인 기한이 지난 것.
create index if not exists idx_consultations_confirm_due
  on public.consultations (confirm_due_at)
  where status = 'confirmed' and confirm_due_at is not null;

-- 운영자 조율 큐(F-A-16 · S4-10). 화면은 8단계지만 **큐에 쌓이는 것은 지금부터**다.
create index if not exists idx_consultations_disputed
  on public.consultations (created_at desc)
  where status = 'disputed';

select public.attach_set_updated_at('consultations');

-- =============================================================================
-- 3) consultation_deposits (§3.4, D-22 · D-28)
-- =============================================================================
-- **§3.4 의 상태 넷에 `pending`·`failed` 를 더했다.** 넷만으로는 결제의 생애를 적을
-- 수 없다 — 결제를 시도하는 중과 실패한 것을 표현할 자리가 없으면 멱등·재시도를
-- 설계할 수 없고, 실패가 조용히 사라진다(S4-13 이 알림에서 같은 판단을 했다).
create table public.consultation_deposits (
  id                uuid primary key default gen_random_uuid(),
  -- 상담 하나에 보증금 하나. 두 개면 어느 것을 환불할지 정할 수 없다.
  consultation_id   uuid not null unique references public.consultations (id) on delete cascade,
  amount            bigint not null check (amount >= 0),
  currency          text not null default 'KRW',
  payment_id        uuid references public.payments (id) on delete set null,
  refund_id         uuid references public.refunds (id) on delete set null,
  status            text not null default 'pending',
  -- 결제·환불 멱등 열쇠. 같은 상담에 두 번 결제되지 않게 DB 가 막는다
  -- (CLAUDE.md §6 — 결제는 Idempotency-Key 필수).
  idempotency_key   text unique,
  attempt_count     integer not null default 0 check (attempt_count >= 0),
  failure_reason    text,
  -- 스텁·실연동을 구분해 남긴다. 나중에 "이 건은 무엇으로 처리됐나" 를 물을 수 있어야 한다.
  provider          text,
  provider_ref      text,
  held_at           timestamptz,
  resolved_at       timestamptz,
  resolution_reason text,
  resolved_by       uuid references auth.users (id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint consultation_deposits_status_chk
    check (status in ('pending', 'held', 'refunded', 'forfeited', 'disputed', 'failed')),

  -- 보관 중이거나 그 뒤 상태면 보관 시각이 있다.
  constraint consultation_deposits_held_chk
    check (status in ('pending', 'failed') or held_at is not null),

  -- 종결 상태에는 종결 시각과 사유가 있다. 사유 없는 몰취는 집행이 아니라 처분이다(D-24).
  constraint consultation_deposits_resolved_chk
    check (
      status not in ('refunded', 'forfeited')
      or (resolved_at is not null and resolution_reason is not null)
    ),

  constraint consultation_deposits_failure_pair_chk
    check ((status = 'failed') = (failure_reason is not null))
);

comment on table public.consultation_deposits is
  '노쇼 보증금(D-22). **플랫폼의 벌금이 아니라 양측 합의 조건을 플랫폼이 보관했다가 §3.11 규칙대로 집행하는 것**이다(D-24 중개자 지위). 그래서 종결에는 사유가 반드시 붙는다.';
comment on column public.consultation_deposits.idempotency_key is
  '결제·환불 멱등 열쇠. 유니크라 **동시 실행에서도 두 번 결제되지 않는다** — 애플리케이션 확인만으로는 경합에서 둘 다 통과한다(S4-13 의 dedupe_key 와 같은 발상).';
comment on column public.consultation_deposits.provider is
  '어떤 어댑터가 처리했는가(stub | toss …). 실연동 전 기록과 실연동 기록을 구분할 수 있어야 한다(D-28).';
comment on column public.consultation_deposits.resolution_reason is
  '왜 이렇게 처리했는가. §3.11 의 판정 규칙 코드가 들어간다 — 플랫폼의 재량이 아니라 규칙이 정한 결과임을 남기기 위해서다(D-24).';

create index if not exists idx_consultation_deposits_status
  on public.consultation_deposits (status);

select public.attach_set_updated_at('consultation_deposits');

-- =============================================================================
-- 4) 헬퍼 — 정책이 부모를 통해 판정한다 (재귀 방지)
-- =============================================================================
-- 0024 에서 문의 정책의 무한 재귀를 겪었다. 같은 실수를 반복하지 않도록
-- 처음부터 security definer 헬퍼로 감싼다.
create or replace function public.consultation_couple_id(p_consultation_id uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select c.couple_id from public.consultations c where c.id = p_consultation_id;
$$;

create or replace function public.consultation_vendor_id(p_consultation_id uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select c.vendor_id from public.consultations c where c.id = p_consultation_id;
$$;

comment on function public.consultation_couple_id(uuid) is
  '상담이 속한 커플. consultation_deposits 정책이 부모를 통해 커플을 찾기 위한 것이다. 정책 안에서 consultations 를 직접 읽으면 그 표의 정책이 다시 평가된다(0024 에서 겪은 재귀).';

-- =============================================================================
-- 5) RLS (§3.9 상담·보증금 행)
-- -----------------------------------------------------------------------------
--   "consultations 는 해당 커플·업체·**위임 플래너**만.
--    consultation_deposits 는 금전 건이므로 **커플은 owner만** 조회하고,
--    상태 변경은 **서비스롤 전용**이다"
--
-- **플래너를 넣는다.** 0021 의 채팅은 뺐는데 여기는 넣는다 — §3.9 가 상담 행에만
-- 위임 플래너를 명시하기 때문이고, 그 구분에는 이유가 있다:
--   · 상담 일정은 **커플의 일정**이다. 대신 챙기는 것이 플래너의 일이고, 일정을
--     모르는 플래너는 동행할 수도 조율할 수도 없다.
--   · 채팅은 업체와의 **대화**다. 상대 당사자가 있고, 업체는 이 커플과 이야기하기로
--     한 것이지 커플의 플래너와 이야기하기로 한 것이 아니다.
-- 그래서 상담의 커플 쪽 판정에는 `is_couple_member` + `has_planner_scope` 를 쓰고,
-- 쓰기는 당사자(`is_couple_principal`)로 좁힌다 — 플래너가 예약을 잡거나 이행 확인에
-- 답하면 그것은 대리 의사표시이고, 노쇼 판정의 주체가 흔들린다.
-- =============================================================================
alter table public.consultations enable row level security;

create policy consultations_select on public.consultations for select to authenticated
  using (
    public.is_couple_member(couple_id)
    or public.is_vendor_member(vendor_id)
    or public.has_planner_scope(couple_id, 'consultations')
  );

-- 신청은 고객만. 업체가 고객의 일정을 잡을 수는 없다.
create policy consultations_insert on public.consultations for insert to authenticated
  with check (public.is_couple_principal(couple_id));

-- 상태 전이는 양측이 각자의 몫을 한다. 어느 쪽이 무엇을 바꿀 수 있는지는
-- **컬럼 권한**과 **트리거**가 가른다(아래) — RLS 는 행까지만 가른다.
create policy consultations_update on public.consultations for update to authenticated
  using (public.is_couple_principal(couple_id) or public.is_vendor_member(vendor_id))
  with check (public.is_couple_principal(couple_id) or public.is_vendor_member(vendor_id));

-- 삭제는 없다. 지나간 예약은 분쟁의 근거다(D-23).
revoke delete on public.consultations from authenticated, anon;

-- 서버가 정하는 값은 당사자가 만지지 못한다. `outcome` 은 **대조 결과**이지
-- 주장이 아니고, `confirm_due_at`·`resolved_at` 은 배치의 것이다.
revoke update on public.consultations from authenticated, anon;
grant update (
  status, approved_at, rejected_at, reject_reason,
  cancelled_at, cancel_reason, cancelled_by,
  couple_confirmed_at, vendor_confirmed_at, couple_outcome, vendor_outcome,
  location
) on public.consultations to authenticated;

-- ── consultation_deposits ────────────────────────────────────────────────────
alter table public.consultation_deposits enable row level security;

-- 금전 건이라 커플은 **owner 만** 본다(§3.9). 업체는 보관 여부를 알아야 자리를
-- 비워 둘지 판단할 수 있으므로 멤버 열람을 준다 — §3.9 가 커플 쪽만 좁힌 이유는
-- 커플 안에서도 돈 이야기를 owner 로 모으기 위함이지 업체를 빼려는 것이 아니다.
create policy consultation_deposits_select on public.consultation_deposits
  for select to authenticated
  using (
    public.is_couple_owner(public.consultation_couple_id(consultation_id))
    or public.is_vendor_member(public.consultation_vendor_id(consultation_id))
  );

-- **상태 변경은 서비스롤 전용**(§3.9). 정책을 두지 않고 권한도 회수한다 —
-- 정책의 부재만으로는 실패가 조용한 0행이라 "환불했다" 고 믿는 코드가 생긴다
-- (0019·0021·0024 와 같은 판단).
revoke insert, update, delete on public.consultation_deposits from authenticated, anon;

-- =============================================================================
-- 6) 트리거 — 어느 쪽이 무엇을 답할 수 있는가
-- =============================================================================
-- RLS 는 행을 가르고 GRANT 는 컬럼을 가르지만, **"고객은 고객 칸에만 답한다"** 는
-- 둘 다로 표현할 수 없다. 두 컬럼 모두 authenticated 에게 열려 있어야 하기 때문이다.
create or replace function public.assert_consultation_confirm()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- 서비스롤·배치 경로는 통과한다(판정 결과를 쓰는 쪽이다).
  if auth.uid() is null then return new; end if;

  if new.couple_outcome is distinct from old.couple_outcome
     and not public.is_couple_principal(new.couple_id) then
    raise exception '고객 이행 확인은 고객 당사자만 할 수 있습니다.'
      using errcode = 'insufficient_privilege';
  end if;

  if new.vendor_outcome is distinct from old.vendor_outcome
     and not public.is_vendor_member(new.vendor_id) then
    raise exception '업체 이행 확인은 해당 업체만 할 수 있습니다.'
      using errcode = 'insufficient_privilege';
  end if;

  -- 한 번 답한 것은 바꾸지 않는다. 상대의 답을 보고 말을 바꿀 수 있으면
  -- 대조가 의미를 잃는다(D-23 — 증적은 나중에 고쳐지지 않아야 한다).
  if old.couple_outcome is not null and new.couple_outcome is distinct from old.couple_outcome then
    raise exception '이미 제출한 이행 확인은 바꿀 수 없습니다.' using errcode = 'check_violation';
  end if;

  if old.vendor_outcome is not null and new.vendor_outcome is distinct from old.vendor_outcome then
    raise exception '이미 제출한 이행 확인은 바꿀 수 없습니다.' using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

comment on function public.assert_consultation_confirm() is
  '이행 확인을 자기 칸에만, 한 번만 적게 한다(§3.11). RLS 는 행까지, GRANT 는 컬럼까지만 가를 수 있어 "어느 편의 칸인가" 는 트리거의 일이다.';

drop trigger if exists trg_consultations_confirm on public.consultations;
create trigger trg_consultations_confirm
  before update on public.consultations
  for each row execute function public.assert_consultation_confirm();

-- =============================================================================
-- 7) 운영 파라미터 (§3.11 NOTE · §7.4 — 값을 문서에 확정하지 않는다)
-- =============================================================================
-- §3.11 이 "보증금액, 이행 확인 응답 기한, 취소 무료 기한(N시간)은 **전부
-- app_settings 파라미터**이며 이 문서에 값을 확정하지 않는다" 고 못박았다.
-- 초기 운영값을 여기 두는 것은 값을 확정하는 것이 아니라 **행이 없으면 기능이 아예
-- 서지 않기 때문**이다(0022 가 채팅 SLA 에서 쓴 것과 같은 판단). 코드는 행이 없으면
-- 숫자를 지어내지 않고 그 사실을 화면에 적는다.
insert into public.app_settings (key, value_json, description)
values
  (
    'consultation.deposit_amount',
    '{"amount": 30000, "currency": "KRW"}'::jsonb,
    '방문상담·탐방 노쇼 보증금(D-22). 이행 시 전액 환불한다. 플랫폼 수익이 아니라 보관금이다 — 운영이 배포 없이 조정한다.'
  ),
  (
    'consultation.free_cancel_hours',
    '{"hours": 24}'::jsonb,
    '이 시간 전까지의 취소는 노쇼가 아니며 전액 환불한다(§3.11). 초기 운영값 24시간.'
  ),
  (
    'consultation.confirm_due_hours',
    '{"hours": 72}'::jsonb,
    '예정 시각 경과 후 이행 확인 응답 기한(§3.11). 기한 내 양측 무응답이면 **환불**이 기본값이다 — 몰취가 기본이면 방치가 이득이 되는 구조가 된다.'
  )
on conflict (key) do nothing;

-- =============================================================================
-- 이 파일이 한 것
--   테이블 2 — consultations · consultation_deposits (S4-02 잔여분을 채웠다)
--   ENUM 3 — consultation_type · consultation_status · consultation_outcome
--   EXCLUDE 1 — **같은 업체의 확정 예약 시간 겹침 금지**(구간 겹침이라 UNIQUE 가 아니다)
--   UNIQUE 2 — 상담당 보증금 1건 · 멱등 열쇠
--   CHECK 11 — 거절·취소 짝과 상태 일치 / 확인 시각·주장 짝 2 / 보증금 상태·보관·
--              종결 사유·실패 짝
--   함수 4 — consultation_couple_id · consultation_vendor_id ·
--            assert_consultation_confirm · consultation_set_ends_at
--   트리거 2(+ updated_at 2)
--   정책 4 — consultations 3(플래너 열람 포함) · consultation_deposits 1(SELECT 만)
--   GRANT  consultations UPDATE 를 당사자가 답할 수 있는 컬럼으로 좁힘 ·
--          DELETE 회수 / consultation_deposits 쓰기 전면 회수(서비스롤 전용)
--   인덱스 5(부분 3 — 확인 요청·판정·분쟁 큐)
--   app_settings 3행 — 보증금액 · 무료 취소 기한 · 확인 응답 기한
--   기존 마이그레이션 파일 수정 없음
-- =============================================================================
