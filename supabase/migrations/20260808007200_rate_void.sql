-- 요율 무효화 — 잘못 만든 행을 되돌리는 유일한 수단 (FIX-12 · S5-03 · D-16 · D-23)
--
-- ══════════════════════════════════════════════════════════════════════════
-- **무엇이 막혀 있었나.** 오타로 넣은 요율을 되돌리는 길이 셋 다 닫혀 있었다.
-- 로컬에서 재현했다 — 전역 요율을 어제부로 닫고 새 요율을 `7000bp`(70%)로 넣은 뒤:
--
--   1. `delete`                      -> permission denied (0034 가 권한을 걷었다)
--   2. 시작 전으로 `effective_to`    -> commission_rates_effective_range 위반
--   3. 올바른 요율로 덮어쓰기        -> commission_rates_no_overlap 위반
--
-- **셋째가 특히 나쁘다.** 화면이 내는 안내문("잘못 만든 행이면 다른 요율로 덮어
-- 주세요")이 시키는 그 일을 **DB 가 거부한다.** 운영자는 시키는 대로 했는데 안 되는
-- 상태에 놓인다.
--
-- 남는 수단은 "지금부터 끝내고 올바른 요율을 지금부터 넣는다" 하나뿐이며, 그러면
-- **오타 요율이 적용됐던 구간이 그대로 남는다.** 그 구간에 확정된 계약은 70% 를
-- 스냅샷으로 박고(0028 불변 트리거), 요율 변경은 소급되지 않으므로(D-16) 되돌릴 수
-- 없다. 요율 한 줄이 모든 업체의 수입을 바꾸는 표에서(S5-03) 이것은 실서비스 전에
-- 닫아야 할 구멍이다.
--
-- ── 왜 삭제가 아니라 무효화인가 ────────────────────────────────────────────
-- 지우면 "그때 어떤 요율표가 있었나" 를 답할 수 없다(D-23). 정산 분쟁에서 스냅샷의
-- 출처를 대야 하는 것이 이 표다. 그래서 **행은 남기고 '없던 것으로 친다' 는 표시를
-- 붙인다** — 이력은 보존되고 해석에서만 빠진다.
--
-- ── 이 마이그레이션이 하는 일 넷 ───────────────────────────────────────────
--  1. `voided_at` · `void_reason` · `voided_by` 를 두 요율 표에 더한다.
--  2. **겹침 제약을 부분 제약으로 바꾼다** — 무효화된 행은 겹침을 막지 않는다.
--     이것이 없으면 무효화해도 그 구간에 올바른 요율을 넣을 수 없어 반쪽이 된다.
--  3. 사유를 필수로 한다. 사유 없는 무효화는 원장을 읽을 수 없게 만든다(D-24 와 같은 결).
--  4. **무효화된 행은 더 이상 바뀌지 않는다** — 되돌리기도, 다시 종료하기도 막는다
--     (D-23 — 종결은 되돌리지 않는다).
--
-- ── 하지 않는 일 ───────────────────────────────────────────────────────────
-- **이미 확정된 계약의 스냅샷을 건드리지 않는다.** 무효화는 *앞으로의 해석*을 고치지
-- *지나간 계약*을 고치지 않는다(D-16). 화면이 그 사실을 적는다 — 적지 않으면 운영자가
-- "무효화했으니 지난 정산도 바뀌겠지" 로 읽는다.
--
-- **`authenticated` 에게 쓰기를 열지 않는다.** 0034 의 결론 그대로다 — 요율 쓰기는
-- 서비스롤 경유이며 권한 판정은 라우트가 세션으로 한다(§5.5 · lib/rates/admin.ts).
-- 무효화 칸도 같은 규칙을 따른다. 새 컬럼에 `grant` 를 주지 않는 것이 그 결정이다.
-- ══════════════════════════════════════════════════════════════════════════

-- ── 1. 컬럼 ────────────────────────────────────────────────────────────────

alter table public.commission_rates
  add column if not exists voided_at timestamptz,
  add column if not exists void_reason text,
  add column if not exists voided_by uuid references auth.users(id) on delete set null;

alter table public.planner_fee_rates
  add column if not exists voided_at timestamptz,
  add column if not exists void_reason text,
  add column if not exists voided_by uuid references auth.users(id) on delete set null;

comment on column public.commission_rates.voided_at is
  '무효화 시각. 값이 있으면 이 행은 요율 해석에서 빠진다(FIX-12). 행은 이력으로 남는다(D-23).';
comment on column public.commission_rates.void_reason is
  '무효화 사유. 필수다 — 사유 없는 무효화는 원장을 읽을 수 없게 만든다.';
comment on column public.planner_fee_rates.voided_at is
  '무효화 시각. 값이 있으면 이 행은 요율 해석에서 빠진다(FIX-12). 행은 이력으로 남는다(D-23).';
comment on column public.planner_fee_rates.void_reason is
  '무효화 사유. 필수다 — 사유 없는 무효화는 원장을 읽을 수 없게 만든다.';

-- ── 2. 짝·모양 CHECK ───────────────────────────────────────────────────────
-- `voided_by` 는 짝에 넣지 않는다. FK 가 `on delete set null` 이라 계정이 지워지면
-- null 이 되는데, 짝으로 묶으면 그 순간 기존 행이 제약을 어긴다.

alter table public.commission_rates
  add constraint commission_rates_void_pair
    check ((voided_at is null) = (void_reason is null)),
  add constraint commission_rates_void_reason_shape
    check (void_reason is null
           or (length(btrim(void_reason)) between 1 and 300));

alter table public.planner_fee_rates
  add constraint planner_fee_rates_void_pair
    check ((voided_at is null) = (void_reason is null)),
  add constraint planner_fee_rates_void_reason_shape
    check (void_reason is null
           or (length(btrim(void_reason)) between 1 and 300));

-- ── 3. 겹침 제약을 부분 제약으로 ───────────────────────────────────────────
-- **무효화된 행은 자리를 차지하지 않는다.** 그러지 않으면 무효화해 놓고도 그 구간에
-- 올바른 요율을 넣을 수 없어서, 고치는 수단이 되지 못한다.

alter table public.commission_rates drop constraint commission_rates_no_overlap;
alter table public.commission_rates
  add constraint commission_rates_no_overlap
    exclude using gist (
      scope_type with =,
      coalesce(scope_key, '') with =,
      tstzrange(effective_from, effective_to, '[)') with &&
    ) where (voided_at is null);

alter table public.planner_fee_rates drop constraint planner_fee_rates_no_overlap;
alter table public.planner_fee_rates
  add constraint planner_fee_rates_no_overlap
    exclude using gist (
      scope_type with =,
      coalesce(scope_key, '') with =,
      coalesce(service_level, '') with =,
      tstzrange(effective_from, effective_to, '[)') with &&
    ) where (voided_at is null);

-- ── 4. 무효화된 행은 더 이상 바뀌지 않는다 ─────────────────────────────────

create or replace function public.assert_rate_void_final()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- 무효화는 종결이다. 되돌리는 수단을 두지 않는다 — 잘못 무효화했으면 **올바른 행을
  -- 새로 넣는다**(무효화된 행이 겹침을 막지 않으므로 같은 구간에 넣을 수 있다).
  -- 되돌리기를 열면 같은 행이 무효 <-> 유효를 오가고, 그 사이에 확정된 계약의 근거를
  -- 나중에 재현할 수 없다.
  if old.voided_at is not null then
    raise exception '무효화된 요율은 다시 바꿀 수 없습니다. 올바른 요율을 새로 등록하세요.'
      using errcode = 'check_violation', constraint = 'rate_voided_is_final';
  end if;

  return new;
end;
$$;

comment on function public.assert_rate_void_final() is
  '무효화된 요율 행의 UPDATE 를 막는다(FIX-12 · D-23). 되돌리기·재종료 둘 다 포함한다.';

create trigger trg_commission_rates_void_final
  before update on public.commission_rates
  for each row execute function public.assert_rate_void_final();

create trigger trg_planner_fee_rates_void_final
  before update on public.planner_fee_rates
  for each row execute function public.assert_rate_void_final();
