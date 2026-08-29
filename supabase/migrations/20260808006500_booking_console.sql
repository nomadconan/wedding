-- 0065 예약 승인·거절 · 예약 상세 (S5-10 · F-V-08 · §6.2 `/bookings/[id]` · §6.3 `/vendor/bookings`)
--
-- ══════════════════════════════════════════════════════════════════════════
-- 1. 표를 만지기 전에 권한부터 봤다 — **이번엔 이미 뚫려 있었다** (FIX-44)
-- ══════════════════════════════════════════════════════════════════════════
--
-- 열두 번째 감사다. 앞선 열한 번과 달리 **잠재된 구멍이 아니라 오늘 통하는 경로**였다.
--
-- ── 무엇이 열려 있었나 ─────────────────────────────────────────────────────
--
--   `bookings`  `authenticated` 에 **표 단위 INSERT·DELETE** 와 `UPDATE (status)`
--               정책 `bookings_insert`  = `is_couple_member(couple_id)` 하나
--               정책 `bookings_update`  = `is_couple_owner(...) or is_vendor_member(...)`
--
-- 즉 **커플 구성원이 업체 동의 없이 예약 행을 만들 수 있었고**, 그 행의 `status`·
-- `total_amount`·`deposit_amount` 를 스스로 정할 수 있었다. 다음이 실제로 통했다
-- (로컬에서 재현 확인):
--
--   1. `insert into bookings (couple_id, vendor_id, status, total_amount, deposit_amount)`
--      `values (내 커플, 아무 업체, 'confirmed', 0, 0)`  → **성공**
--   2. 그 예약으로 `reviews` INSERT → **성공**
--
-- `reviews_insert` 정책은 `bookings.status in ('confirmed','fulfilled')` 를 자격으로
-- 삼는다(D-129). 그 자격의 근거가 되는 표를 **자격을 얻으려는 사람이 직접 쓸 수 있으면**
-- 자격 검사는 아무것도 검사하지 않는다. **거래한 적 없는 업체에 '검증 후기' 를 남길 수
-- 있었다** — 플랫폼 차별성의 근간이 걸린 자리다(CLAUDE.md §1).
--
-- 곁가지 셋도 같은 구멍에서 나온다.
--   · `total_amount = 0` 으로 만든 예약은 정산 근거를 0 으로 만든다.
--   · `trg_bookings_slot_movement` 는 **INSERT 에도 걸리므로** 위조 예약이
--     `inventory_slots.remaining` 을 깎는다(남의 재고를 소진시킬 수 있다).
--   · 요율 스냅샷 강제 트리거(`assert_booking_rate_snapshot`)는 **UPDATE 전용**이라
--     INSERT 로 곧장 `confirmed` 를 만들면 요율 없이 확정된 계약이 생긴다.
--
-- ── 층 2 (FIX-41) ──────────────────────────────────────────────────────────
--
-- `contracts_select` 가 `exists (select 1 from planners p where p.id = planner_id
-- and p.user_id = auth.uid())` 모양이지만 **소유자 조건(`p.user_id = auth.uid()`)을
-- 자기가 들고 있다** — 부모 표의 정책에 기대지 않는다. `bookings_select` 도 세 갈래
-- 모두 `is_couple_member`·`is_vendor_member`·`has_planner_scope` 로 스스로 말한다.
-- **이번 감사에서 층 2 위반은 없었다.**
--
-- ── 어떻게 막는가 ──────────────────────────────────────────────────────────
--
-- **컬럼 권한으로 좁히지 않는다.** `total_amount` 만 걷어도 `status='confirmed'` 로
-- 만드는 길이 남고, `status` 까지 걷으면 `hold` 예약을 무한히 만들어 남의 재고를
-- 깎는 길이 남는다. **예약 생성 자체가 당사자의 직접 쓰기여서는 안 되는 사건**이다 —
-- 표에서 걷는다(D-62 — 쓰기는 서비스롤 경유).

-- **표에서 걷고 필요한 것만 다시 준다**(FIX-36 이 가르친 것). 컬럼 GRANT 는 표 GRANT 를
-- 회수해도 따로 남으므로 `revoke all` 로 한 번에 걷은 뒤 SELECT 만 돌려준다.
revoke all privileges on public.bookings from anon, authenticated;

-- 읽기는 그대로 둔다 — **행이 목적**이고 정책이 소유자를 가른다(D-115).
-- `anon` 에게는 돌려주지 않는다: 예약은 공개 데이터가 아니고, 정책이 없어 지금도
-- 안 보이지만 **GRANT 가 남아 있으면 다음 사람이 정책 한 줄로 여는 순간 열린다.**
grant select on public.bookings to authenticated;

-- 정책도 함께 걷는다. GRANT 만 회수하고 정책을 남기면 다음 사람이 GRANT 를 되돌리는
-- 순간 **정책이 이미 허락하고 있어** 같은 구멍이 조용히 되살아난다.
drop policy if exists bookings_insert on public.bookings;
drop policy if exists bookings_update on public.bookings;

comment on table public.bookings is
  'S5-10/FIX-44. 당사자 직접 쓰기를 걷었다 — 커플 구성원이 업체 동의 없이 confirmed 예약을 만들고 그것으로 검증 후기를 쓸 수 있었다(재현 확인). 생성·승인·거절·확정은 전부 서비스롤 경유(D-62)이며 각 경로가 자격을 판정한다. 읽기만 정책이 가른다.';

-- TRUNCATE 는 0053 이 전역으로 걷었다. 매번 다시 센다(함정 7 — RLS 는 TRUNCATE 에 안 걸린다).
revoke truncate on public.bookings from anon, authenticated;

-- ══════════════════════════════════════════════════════════════════════════
-- 2. 승인·거절은 상태가 아니라 **사건**이다 (D-36)
-- ══════════════════════════════════════════════════════════════════════════
--
-- `booking_status` 는 `hold|confirmed|cancelled|fulfilled` 넷이고 **`confirmed` 는
-- 계약 확정을 뜻한다**(`activateContract` 가 그 자리에서 찍는다). D-36 이 "계약 확정과
-- 예약 확정은 다른 사건" 이라고 정했으므로 **업체의 승인을 `confirmed` 로 적으면 안
-- 된다** — 그러면 서명 없는 계약이 확정된 것으로 읽힌다.
--
-- **열거형에 값을 더하지 않는다.** `booking_status` 는 정책·트리거·후기 자격이 함께
-- 읽는 값이라 값 하나를 더하면 그 모두를 다시 봐야 한다. 대신 **짝 컬럼**을 둔다 —
-- `contracts` 가 `activated_at`·`cancelled_at`·`cancel_reason` 으로 쓰는 것과 같은 모양이다.
alter table public.bookings
  add column if not exists accepted_at    timestamptz,
  add column if not exists accepted_by    uuid references auth.users(id) on delete set null,
  add column if not exists declined_at    timestamptz,
  add column if not exists decline_reason text;

comment on column public.bookings.accepted_at is
  'S5-10. 업체가 이 예약을 받겠다고 한 시각. **계약 확정(status=confirmed)과 다른 사건이다**(D-36) — 승인은 계약 발행의 선행이고, 확정은 서명이 끝난 뒤다.';
comment on column public.bookings.accepted_by is
  'S5-10. 승인한 업체 멤버. **null 은 "승인자를 모른다" 다** — 0065 이전에 이미 진행된 예약을 이관하며 시각만 채웠고 사람을 지어내지 않았다(측정하지 않은 것을 쓰지 않는다).';
comment on column public.bookings.decline_reason is
  'S5-10. 거절 사유. **거절에는 사유가 필수다**(D-24 — 플랫폼은 조율자이고, 사유 없는 거절은 조율의 근거가 되지 못한다). CHECK 이 강제한다.';

-- ── 이관: 이미 hold 를 지난 예약은 승인을 거친 것으로 본다 ──────────────────
-- **시각만 채우고 사람은 비운다.** `accepted_by` 를 업체 대표로 채우면 그 사람이
-- 누르지도 않은 승인을 누른 것이 된다 — 증적을 지어내는 일이다(D-23).
update public.bookings
   set accepted_at = created_at
 where accepted_at is null
   and status in ('confirmed', 'fulfilled');

-- ── 제약: **허용 조합을 나열한다**(부정형으로 쓰지 않는다) ──────────────────

-- 승인자 없이 승인 시각만 있는 것은 이관분이라 허용한다. 그 반대(사람은 있는데
-- 시각이 없다)는 허용하지 않는다 — 언제 승인했는지 모르는 승인은 증적이 아니다.
alter table public.bookings drop constraint if exists bookings_accept_shape;
alter table public.bookings
  add constraint bookings_accept_shape
  check (
    (accepted_at is null     and accepted_by is null)     -- 아직 결정 전
    or (accepted_at is not null and accepted_by is null)  -- 0065 이관분
    or (accepted_at is not null and accepted_by is not null)
  );

-- 거절은 **시각과 사유가 함께** 선다. 사유가 빈 문자열인 것도 사유 없음이다.
alter table public.bookings drop constraint if exists bookings_decline_shape;
alter table public.bookings
  add constraint bookings_decline_shape
  check (
    (declined_at is null     and nullif(btrim(coalesce(decline_reason, '')), '') is null)
    or (declined_at is not null and nullif(btrim(coalesce(decline_reason, '')), '') is not null)
  );

-- 한 예약이 승인이면서 동시에 거절일 수는 없다. **설 수 있는 셋을 적는다.**
alter table public.bookings drop constraint if exists bookings_decision_shape;
alter table public.bookings
  add constraint bookings_decision_shape
  check (
    (accepted_at is null     and declined_at is null)      -- 대기
    or (accepted_at is not null and declined_at is null)   -- 승인
    or (accepted_at is null     and declined_at is not null) -- 거절
  );

-- 거절된 예약은 **살아 있으면 안 된다.** 거절해 두고 상태가 `hold` 로 남으면 화면은
-- 그 예약을 여전히 진행 중으로 그리고, 재고도 잡힌 채 남는다.
alter table public.bookings drop constraint if exists bookings_declined_status_shape;
alter table public.bookings
  add constraint bookings_declined_status_shape
  check (
    (declined_at is null)
    or (declined_at is not null and status = 'cancelled')
  );

create index if not exists idx_bookings_vendor_pending
  on public.bookings (vendor_id, created_at desc)
  where accepted_at is null and declined_at is null;

create index if not exists idx_bookings_couple_recent
  on public.bookings (couple_id, created_at desc);

-- ══════════════════════════════════════════════════════════════════════════
-- 3. 승인 스냅샷은 되돌릴 수 없다
-- ══════════════════════════════════════════════════════════════════════════
--
-- 서비스롤은 RLS 를 비켜 가므로 이 표의 마지막 방어선은 **트리거**다. 요율 스냅샷이
-- 이미 같은 방식으로 서 있고(`assert_booking_rate_snapshot`), 결정도 같은 성질이다 —
-- **되돌릴 수 있는 결정은 결정이 아니다**(D-23).
create or replace function public.assert_booking_decision_immutable()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.accepted_at is not null and new.accepted_at is distinct from old.accepted_at then
    raise exception '이미 승인한 예약의 승인 시각은 바꿀 수 없습니다.'
      using errcode = 'check_violation', constraint = 'bookings_accept_immutable';
  end if;

  if old.declined_at is not null and new.declined_at is distinct from old.declined_at then
    raise exception '이미 거절한 예약의 거절 기록은 바꿀 수 없습니다.'
      using errcode = 'check_violation', constraint = 'bookings_decline_immutable';
  end if;

  -- **거절한 예약을 되살리지 않는다.** 되살리려면 새 예약을 만든다 — 거절된 예약이
  -- 다시 진행되면 "언제부터 유효했나" 를 아무도 답할 수 없다.
  if old.declined_at is not null and new.status <> 'cancelled' then
    raise exception '거절된 예약은 다시 진행할 수 없습니다. 새 예약을 만드세요.'
      using errcode = 'check_violation', constraint = 'bookings_declined_final';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_bookings_decision_immutable on public.bookings;
create trigger trg_bookings_decision_immutable
  before update on public.bookings
  for each row execute function public.assert_booking_decision_immutable();

comment on function public.assert_booking_decision_immutable() is
  'S5-10. 승인·거절은 서비스롤 경유라 RLS 가 보지 않는다. 마지막 경계는 트리거다 — 되돌릴 수 있는 결정은 결정이 아니다(D-23). assert_booking_rate_snapshot 과 같은 자리.';

-- ══════════════════════════════════════════════════════════════════════════
-- 4. 새 표를 만들지 않았다
-- ══════════════════════════════════════════════════════════════════════════
--
-- **승인 이력 표를 만들지 않는다.** 전이는 `entity_events`(insert-only)가 갖고
-- 근거는 `audit_logs` 가 갖는다 — 승인·거절은 각각 한 번뿐인 사건이라 짝 컬럼으로
-- 충분하고, 여러 번 일어나는 사건이 아니다(S8-08 이 리비전 표를 만든 쪽과 반대 판단).
--
-- **'승인 대기 건수' 같은 집계 컬럼도 두지 않는다** — 계산 가능한 값이다(D-124).
