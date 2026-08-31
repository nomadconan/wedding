-- =============================================================================
-- 0071 · 플래너 정산·지급 유예 (S6-05)
-- 근거: docs/07_개발명세서.md §3.4 planner_settlements, §4.5 `planner-payout-due`,
--       §3.9 RLS, D-16 · D-17 · D-21 · D-23 · D-28 · FIX-49
-- =============================================================================
-- `planner_settlements` 는 S5-01(0028)이 만들었고 계약 확정 경로가 행을 넣는다.
-- **읽는 화면도 지급하는 코드도 없었다** — 원장만 쌓이고 아무도 꺼내지 않는 상태였다.
-- 이 태스크가 처음으로 그 돈을 내보내므로 표부터 감사했다.
--
-- ── 감사 결과 (세 층) ───────────────────────────────────────────────────────
--
--  층 1 (정책 아래의 권한)
--    · **FIX-49 그대로였다** — `authenticated` 에 표 단위 INSERT·UPDATE·DELETE GRANT 가
--      남아 있었다. 정책이 SELECT 하나뿐이라 오늘은 RLS 가 막지만(latent), 쓰기 정책이
--      한 줄만 붙으면 **플래너가 자기 지급액과 계약 건수를 스스로 적는다.** 이 표는
--      지급 원장이자 마켓 실적(`planner_contract_count`)의 근거다.
--      **담당 태스크가 이번 것이므로 여기서 걷는다.**
--    · `anon` SELECT GRANT 도 남아 있었다(정책이 `authenticated` 전용이라 오늘은
--      아무것도 안 보이지만, `to anon` 정책 한 줄이면 열린다).
--    · **CHECK 은 있었다**(금액·요율 범위·유예 순서·paid 짝·상태 어휘·유니크).
--      다만 **상태 전이가 자유로웠다** — `paid → earned` 도 `void → paid` 도 막는 것이
--      없었다. 그리고 **성공한 지급 기록 없이 `paid` 로 적을 수 있었다**: 0033 이
--      업체 정산에 건 규칙(`settlements_paid_without_payout`)이 이쪽에는 없다.
--      **나가지 않은 돈이 나갔다고 적히는 자리**다.
--
--  층 2 (정책이 다른 표의 정책에 기대는가 · FIX-41) — **위반 없음.**
--    `planner_settlements_select` 의 `exists (select 1 from planners p ...)` 는 안에
--    `p.user_id = auth.uid()` 를 들고 있다. 이 파일이 더하는 정책도 같은 모양을 쓴다.
--
--  층 3 (자격의 근거가 되는 표 · FIX-44 · FIX-47) — **오늘 통하는 길을 찾았다.**
--    이 원장의 주인은 `planners.user_id = auth.uid()` 로 정해진다. 그러므로 물음은
--    "**돈을 받으려는 사람이 `planners` 를 직접 쓸 수 있는가**" 다.
--      · 남의 행은 못 본다·못 고친다(정책이 `user_id = auth.uid()` 를 using·with check
--        양쪽에 든다). **남의 지급을 가로채는 길은 없다.**
--      · 그런데 **자기 행을 `status='active'` 로 INSERT 할 수 있었다.** 0037 의 자가
--        공개 차단 트리거는 **`before update` 전용**이라 INSERT 를 보지 않는다.
--        로컬에서 재현했다 — 아무 로그인 사용자나 한 문장으로 **심사를 건너뛰고
--        공개 플래너가 된다**(FIX-54). 공개는 위임을 받는 전제이고 위임은 계약의
--        전제이며 계약이 곧 이 원장의 입금이다. FIX-30 이 "당사자가 배지를 직접 켤 수
--        있었다" 로 적은 것과 같은 모양이고, 함정 6(당사자가 직접 넣을 수 있는 컬럼이
--        심사를 우회한다)의 교과서적인 사례다.
--
-- ── 이 파일이 정한 것 ───────────────────────────────────────────────────────
--
--  1. **지급 원장은 서비스롤만 쓴다**(FIX-49). `planner_settlements` 에 쓰기 정책을
--     만들지 않고 GRANT 를 걷는다 — `entity_events` 와 같은 규약이다("정책이 없다"
--     가 곧 "클라이언트는 못 쓴다"). 읽기는 **본인과 운영자**뿐이다.
--
--  2. **지급 시도를 따로 든다**(`planner_payouts`). `planner_settlements.paid_at` 한
--     컬럼으로는 "몇 번 시도했고 왜 실패했나" 를 담을 수 없다 — 0030(결제)·0033(업체
--     정산)이 같은 판단을 했고 **지급 어댑터의 재시도 상한도 이 행을 세어 정한다.**
--     그리고 **성공한 지급 행 없이 `paid` 로 갈 수 없게** 한다(위 층 1).
--
--  3. **cascade 를 쓰지 않는다.** `settlement_payouts` 는 `settlements` 에 cascade 로
--     걸려 있지만, 이쪽은 **restrict** 다. 지급 기록은 돈이 나간 증거이고 부모를 지워
--     함께 사라지면 "보냈다는 사실" 만 없어진다(D-23). 어차피 부모도 못 지운다.
--
--  4. **공개는 심사의 결과다**(FIX-54 · D-171). `planners` 의 표 단위 INSERT·UPDATE 를
--     걷고 칸을 나열해 다시 준다 — **`status` 는 넣을 수 없고 고칠 수만 있다**(고치는
--     쪽은 0037 트리거가 값을 가린다: 본인은 `paused`·`pending` 까지). `id`·`user_id`
--     도 넣기만 하고 고칠 수 없다.
--
--  5. **유예 경계는 그대로 시계가 판정한다.** 배치(`planner-payout-due`)가 `earned →
--     payable` 로 옮기지만 화면은 `payable_at` 과 지금 시각으로 답한다
--     (`plannerPayoutState()` · S5-01). **일찍 옮기는 것은 0028 트리거가 막는다** —
--     이 파일은 그 규칙을 건드리지 않는다.
-- =============================================================================

-- =============================================================================
-- 1) FIX-49 — 지급 원장의 쓰기를 걷는다
-- -----------------------------------------------------------------------------
-- **컬럼만 걷으면 표 단위 권한이 남아 무효가 된다**(FIX-36). 표에서 걷는다.
-- 다시 주지 않는다 — 이 원장에 손대는 것은 계약 확정·해지·배치·지급뿐이고 전부
-- 서버(서비스롤) 경로다.
-- =============================================================================
revoke insert, update, delete on public.planner_settlements from authenticated, anon;
revoke select on public.planner_settlements from anon;

-- **운영자도 읽어야 한다.** 지급을 집행하는 화면이 그 목록을 보고, 정산 이의가 오면
-- 근거(요율 스냅샷)를 대조한다. 0033 이 `settlements_select_operator` 를 둔 것과 같은
-- 자리이며, **경계를 앱이 아니라 RLS 에 둔다**(§5.5).
drop policy if exists planner_settlements_select_operator on public.planner_settlements;
create policy planner_settlements_select_operator on public.planner_settlements
  for select to authenticated using (public.is_operator());

comment on table public.planner_settlements is
  '플래너 수수료 원장(D-17 · D-21). 계약 확정 시 earned_at 이 박히고 유예가 지나면 payable, 성공한 지급 뒤에 paid 다. **쓰기 정책이 없다** — 계약·해지·배치·지급이 전부 서버 경로이며 당사자가 자기 지급액을 적을 수 없다(FIX-49). 읽기는 본인과 운영자뿐이다.';

-- =============================================================================
-- 2) planner_payouts — 지급 시도 (D-28)
-- =============================================================================
create table if not exists public.planner_payouts (
  id                    uuid primary key default gen_random_uuid(),
  -- **cascade 가 아니다**(위 근거 3). 돈이 나간 증거는 부모를 따라 사라지지 않는다.
  planner_settlement_id uuid not null references public.planner_settlements (id) on delete restrict,
  amount                bigint not null,
  status                text not null default 'pending',
  provider              text,
  provider_ref          text,
  /** 나가는 요청의 멱등 열쇠. `planner_settlement:<id>:payout:<attempt>` 형태다. */
  idempotency_key       text not null unique,
  attempt_count         integer not null default 1,
  failure_reason        text,
  paid_at               timestamptz,
  failed_at             timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  -- **허용 값을 나열한다**(부정형 금지). 0033 의 지급 상태와 같은 어휘다 —
  -- 두 지급이 다른 말을 쓰면 운영자가 같은 화면에서 두 어휘를 읽는다.
  constraint planner_payouts_status_values
    check (status in ('pending', 'paid', 'failed', 'cancelled')),
  constraint planner_payouts_amount_positive check (amount >= 1),
  constraint planner_payouts_attempt_positive check (attempt_count >= 1),
  constraint planner_payouts_paid_pair check ((status = 'paid') = (paid_at is not null)),
  constraint planner_payouts_failed_pair check ((status = 'failed') = (failed_at is not null))
);

comment on table public.planner_payouts is
  '플래너 지급 실행(D-28). **한 원장에 시도가 여럿일 수 있다**(실패·재시도) — planner_settlements.paid_at 한 컬럼으로는 "몇 번 시도했고 왜 실패했나" 를 담을 수 없고, 재시도 상한도 이 행을 세어 정한다. 실연동 전에는 스텁이 돌며 **프로덕션에서는 어댑터가 거부한다** — 보내지 않은 돈이 나갔다고 적히면 플래너는 정산서의 "지급 완료" 를 보고 입금을 기다린다.';
comment on column public.planner_payouts.idempotency_key is
  '나가는 요청의 멱등 열쇠. **자동 재시도에서 바꾸지 않는다** — 바꾸면 재시도가 새 이체가 되고 돈이 두 번 나간다. 명시적 재지급만 attempt 를 올려 다른 열쇠를 만든다(업체 지급과 같은 규칙).';

-- **원장당 진행 중인 지급은 하나다.** 둘이 승인되면 같은 수수료가 두 번 나간다.
create unique index if not exists uq_planner_payouts_pending
  on public.planner_payouts (planner_settlement_id)
  where status = 'pending';
-- 성공한 지급도 하나뿐이다.
create unique index if not exists uq_planner_payouts_paid
  on public.planner_payouts (planner_settlement_id)
  where status = 'paid';

create index if not exists idx_planner_payouts_settlement
  on public.planner_payouts (planner_settlement_id);

select public.attach_set_updated_at('planner_payouts');

-- ── RLS ─────────────────────────────────────────────────────────────────────
-- **쓰기 정책이 없다.** 지급은 서버가 실행하고 그 기록도 서버가 쓴다.
alter table public.planner_payouts enable row level security;

-- **부모 정책에 기대지 않는다**(FIX-41 · 층 2). `exists` 안에 소유자 조건
-- (`p.user_id = auth.uid()`)을 직접 들고 있다 — 부모(`planner_settlements`)의 정책이
-- 언젠가 넓어져도 이 표가 함께 열리지 않는다.
create policy planner_payouts_select on public.planner_payouts
  for select to authenticated
  using (
    public.is_operator()
    or exists (
      select 1
      from public.planner_settlements s
      join public.planners p on p.id = s.planner_id
      where s.id = planner_payouts.planner_settlement_id
        and p.user_id = auth.uid()
    )
  );

comment on policy planner_payouts_select on public.planner_payouts is
  '본인과 운영자만 읽는다. exists 안에 소유자 조건을 직접 들고 있어 **부모 표의 정책이 넓어져도 함께 열리지 않는다**(FIX-41 이 드러낸 모양).';

-- **새 표의 권한을 나열한다**(함정 7 — RLS 는 TRUNCATE 에 적용되지 않는다).
revoke all on public.planner_payouts from authenticated, anon;
grant select on public.planner_payouts to authenticated;

-- =============================================================================
-- 3) 불변식 — 전이와 지급 근거
-- =============================================================================
create or replace function public.assert_planner_settlement_transition()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_paid integer;
begin
  if tg_op = 'UPDATE' and new.status is distinct from old.status then
    -- **허용 전이를 나열한다**(부정형 금지). 해지가 원장을 무효로 돌리는 길은
    -- 어느 단계에서나 열려 있다(`lib/cancellation`) — 그러나 **되돌아오지는 않는다.**
    if not (
      (old.status = 'earned' and new.status in ('payable', 'void'))
      or (old.status = 'payable' and new.status in ('paid', 'earned', 'void'))
    ) then
      raise exception '허용되지 않은 플래너 정산 상태 전이입니다: % -> %', old.status, new.status
        using errcode = 'check_violation', constraint = 'planner_settlements_transition';
    end if;
  end if;

  -- **지급 완료는 근거를 요구한다.** 0033 이 업체 정산에 건 것과 같은 규칙이며,
  -- 없으면 **나가지 않은 돈이 나갔다고** 기록된다.
  if new.status = 'paid' and (tg_op = 'INSERT' or old.status is distinct from 'paid') then
    select count(*) into v_paid
    from public.planner_payouts
    where planner_settlement_id = new.id and status = 'paid';

    if v_paid = 0 then
      raise exception '성공한 지급 기록 없이 플래너 정산을 지급 완료로 적을 수 없습니다.'
        using errcode = 'check_violation', constraint = 'planner_settlements_paid_without_payout';
    end if;
  end if;

  return new;
end;
$$;

comment on function public.assert_planner_settlement_transition() is
  '플래너 정산 불변식. (가) 허용된 상태 전이만 — payable 에서 earned 로 돌아오는 것은 허용한다(배치가 잘못 옮긴 것을 되돌리는 길이며 유예 전 payable 은 0028 이 이미 막는다). (나) **성공한 지급 기록 없이 paid 로 적을 수 없다** — 0033 이 업체 정산에 건 것과 같은 규칙이고, 없으면 나가지 않은 돈이 나갔다고 기록된다.';

drop trigger if exists trg_planner_settlements_transition on public.planner_settlements;
create trigger trg_planner_settlements_transition
  before insert or update on public.planner_settlements
  for each row execute function public.assert_planner_settlement_transition();

-- =============================================================================
-- 4) FIX-54 — 공개는 심사의 결과다 (D-171)
-- -----------------------------------------------------------------------------
-- 0037 의 자가 공개 차단 트리거는 **`before update` 전용**이라 INSERT 를 보지 않았다.
-- 그래서 아무나 `status='active'` 로 **처음부터 공개 플래너로 등록**할 수 있었다.
-- 트리거를 INSERT 로 넓히지 않고 **컬럼 권한으로 막는다** — 값에 따른 판정은 트리거의
-- 일이지만, "이 칸을 아예 못 쓴다" 는 권한의 일이고 그쪽이 더 좁다.
-- =============================================================================
revoke insert, update on public.planners from authenticated;

-- 등록할 때 담는 것: 누가 · 무엇을 · 어디서. **`status` 가 없다** — 시작 값은 기본값
-- (`pending`)이며 공개는 심사가 정한다. `id`·`fee_json` 도 기본값이 진실이다
-- (`fee_json` 은 빈 객체여야 한다는 CHECK 이 0037 에 있다 · D-16).
grant insert (user_id, profile_json, regions) on public.planners to authenticated;

-- 고칠 수 있는 것: 프로필과 상태뿐이다. **`user_id` 를 못 고친다** — 고칠 수 있으면
-- 남의 프로필을 자기 것으로 옮기는 길이 되고, 그 프로필에 달린 **지급 원장까지 따라
-- 온다.** `status` 는 열어 두되 값은 0037 트리거가 가린다(본인은 paused·pending 까지).
grant update (profile_json, regions, status) on public.planners to authenticated;

-- =============================================================================
-- 이 파일이 한 것
--   표 1 신설 — planner_payouts (CHECK 5 · 부분 유니크 2 · 정책 1 · GRANT 나열)
--   GRANT  — planner_settlements 쓰기 회수(FIX-49) · anon SELECT 회수 ·
--            planners 표 단위 INSERT·UPDATE 회수 후 컬럼 재부여(FIX-54)
--   정책 1 신설 — planner_settlements 운영자 조회
--   트리거 1 신설 — 상태 전이 · 성공한 지급 없이 paid 금지
--   **기존 마이그레이션 파일 수정 없음** — 0028 의 유예 트리거와 0037 의 상태 트리거는
--   그대로 두고 이 파일이 옆에 덧붙였다.
-- =============================================================================
