-- 0052 운영자 지표 집계 (S8-01 · F-A-07 · 명세서 §6.4 `/admin` · §4.3 GET /api/admin/metrics)
--
-- ── 왜 함수 하나인가 ────────────────────────────────────────────────────────
-- 대시보드가 필요한 것은 **행이 아니라 합계**다. 그런데 그 합계의 재료인 `couples` ·
-- `carts` · `inquiries` · `bookings` · `memberships` · `document_analyses` 에는
-- **운영자용 RLS 정책이 없다**(0033 이 정책을 준 것은 `settlements` 와 `entity_events`
-- 둘뿐이다). 그래서 운영자 세션으로 그냥 세면 `count(*)` 가 **조용히 0** 을 돌려준다 —
-- 화면에는 "가입 0명 · 예약 0건" 이 뜨고 그것이 사실처럼 읽힌다. 값이 사라졌는데
-- 오류는 나지 않는 것이 이 종류 버그의 본질이다(S7-05·S7-07 이 임베드에서 물린 것과 같다).
--
-- ── 그래서 SECURITY DEFINER 다. 다만 관성으로 쓰지 않는다 ───────────────────
-- 대안 둘을 먼저 버렸다.
--   (가) 운영자에게 위 표들의 SELECT 정책을 준다
--        → 합계를 보여주려고 **커플의 개별 행을 통째로 여는 것**이다. 예산·예식일·
--          하객 명단까지 열린다. 지표 하나 때문에 열 문이 아니다.
--   (나) invoker 함수로 둔다
--        → 위에 적은 대로 **틀린 0** 이 나온다. 오류라도 나면 낫지만 나지 않는다.
-- 그래서 DEFINER 로 두되 **경계를 함수 안에 넣는다**: 첫 줄이 `is_operator()` 이고
-- 통과하지 못하면 예외를 던진다. 그리고 **집계만 돌려준다** — 이 함수는 어떤 행도,
-- 어떤 id 도, 어떤 개인정보도 밖으로 내보내지 않는다(§7.3). 개수와 합계뿐이다.
--
-- ── 뷰를 만들지 않았다 ──────────────────────────────────────────────────────
-- 뷰로 열면 소유자 필터를 걸어야 하는데(운영자 전용이어도 마찬가지다) 집계 뷰에는
-- 걸 소유자가 없다. 필터 없는 뷰는 `security_invoker` 를 켜도 다음 사람이 끄는 순간
-- 전 테이블 통로가 된다. **함수는 인자와 권한 검사를 갖는다** — 그래서 함수다.

-- ── 집계 함수 ───────────────────────────────────────────────────────────────
create or replace function public.admin_metrics(
  p_from timestamptz,
  p_to   timestamptz
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_result jsonb;
begin
  -- **경계는 여기다.** DEFINER 는 RLS 를 지나치므로 이 검사가 유일한 문이다.
  -- `is_operator()` 자체도 DEFINER 이며 `auth.uid()` 의 profiles.role 을 본다.
  if not public.is_operator() then
    raise exception 'ADMIN_METRICS_FORBIDDEN'
      using errcode = '42501', hint = '운영자만 조회할 수 있습니다.';
  end if;

  if p_from is null or p_to is null or p_from >= p_to then
    raise exception 'ADMIN_METRICS_BAD_PERIOD'
      using errcode = '22023', hint = '조회 기간이 올바르지 않습니다.';
  end if;

  select jsonb_build_object(
    -- ── 가입 ────────────────────────────────────────────────────────────────
    'signups', (
      select count(*) from public.profiles
      where created_at >= p_from and created_at < p_to
    ),
    -- **소비자 가입은 따로 센다.** 퍼널의 첫 칸과 멤버십 전환율의 분모는 소비자여야
    -- 한다 — 운영자·업체·플래너 계정까지 분모에 넣으면 "온보딩 전환 11%" 같은 숫자가
    -- 나오고, 그 11% 는 운영자가 만든 자기 계정 때문에 낮아진 값이다.
    'consumerSignups', (
      select count(*) from public.profiles
      where created_at >= p_from and created_at < p_to
        and role = 'consumer'
    ),

    -- ── MAU ─────────────────────────────────────────────────────────────────
    -- **정의를 여기서 고정한다**: 기록이 남는 행위를 한 사람. 기간 인자와 무관하게
    -- 늘 30일이다 — MAU 의 M 은 월이고, 7일 창으로 잰 값을 MAU 라 부를 수는 없다.
    'mau', (
      select count(distinct actor_id) from public.entity_events
      where actor_id is not null
        and occurred_at >= p_to - interval '30 days'
        and occurred_at < p_to
    ),

    -- ── 계약 검토 리포트 ────────────────────────────────────────────────────
    'reportsRequested', (
      select count(*) from public.document_analyses
      where created_at >= p_from and created_at < p_to
    ),
    -- 상태 어휘는 `lib/core/report/pipeline.ts` 의 `ANALYSIS_STATUSES` 다:
    -- queued · running · **done** · failed. `succeeded` 가 아니다 — 틀린 값으로 세면
    -- 오류 없이 늘 0이 나온다.
    'reportsSucceeded', (
      select count(*) from public.document_analyses
      where created_at >= p_from and created_at < p_to
        and status = 'done'
    ),

    -- ── 문의·상담·예약·계약 ─────────────────────────────────────────────────
    'inquiries', (
      select count(*) from public.inquiries
      where created_at >= p_from and created_at < p_to
    ),
    'consultations', (
      select count(*) from public.consultations
      where created_at >= p_from and created_at < p_to
        and status in ('confirmed', 'completed')
    ),
    -- `hold` 은 자리만 잡아 둔 상태이고 `cancelled` 는 없던 일이다. 둘 다 빼야
    -- "예약" 이 사람이 생각하는 예약과 같은 뜻이 된다.
    'bookings', (
      select count(*) from public.bookings
      where created_at >= p_from and created_at < p_to
        and status in ('confirmed', 'fulfilled')
    ),
    'contracts', (
      select count(*) from public.contracts
      where created_at >= p_from and created_at < p_to
        and status in ('issued', 'active')
    ),

    -- ── GMV ─────────────────────────────────────────────────────────────────
    -- 예약 총액의 합. **원 단위 정수**이며 소수를 만들지 않는다.
    'gmvAmount', (
      select coalesce(sum(total_amount), 0) from public.bookings
      where created_at >= p_from and created_at < p_to
        and status in ('confirmed', 'fulfilled')
    ),

    -- ── 수수료 ──────────────────────────────────────────────────────────────
    -- **여기서는 세기만 한다.** 이 값을 보여도 되는지는 `settlement.fee_basis`(O-15)가
    -- 정하며 그 판단은 lib/core/metrics/admin.ts 의 `feeRevenue()` 가 한다.
    -- `blocked` 정산은 기준이 없어 계산되지 않은 행이라 합계에 넣지 않는다.
    'feeAmount', (
      select coalesce(sum(fee_amount), 0) from public.settlements
      where created_at >= p_from and created_at < p_to
        and status <> 'blocked'
    ),
    'settlementRows', (
      select count(*) from public.settlements
      where created_at >= p_from and created_at < p_to
        and status <> 'blocked'
    ),

    -- ── 멤버십 ──────────────────────────────────────────────────────────────
    'membershipsStarted', (
      select count(*) from public.memberships
      where plan = 'premium'
        and started_at >= p_from and started_at < p_to
    ),
    -- 해지·만료는 **갱신 시각**으로 센다. 상태를 바꾼 시점이 그 행에 남는 유일한 시각이다.
    'membershipsCanceled', (
      select count(*) from public.memberships
      where plan = 'premium' and status = 'canceled'
        and updated_at >= p_from and updated_at < p_to
    ),
    'membershipsExpired', (
      select count(*) from public.memberships
      where plan = 'premium' and status = 'expired'
        and updated_at >= p_from and updated_at < p_to
    ),
    -- 기간 **말** 기준 활성. 이탈률의 분모를 만드는 값이다.
    'membershipsActive', (
      select count(*) from public.memberships
      where plan = 'premium' and status = 'active'
        and started_at < p_to
    ),

    -- ── 퍼널 중간 단계 ──────────────────────────────────────────────────────
    -- 온보딩 완료는 `couples.stage = 'active'` 로 본다(S3-01 이 정한 상태값).
    'onboardedCouples', (
      select count(*) from public.couples
      where created_at >= p_from and created_at < p_to
        and stage = 'active'
    ),
    -- 장바구니를 **만든** 커플이 아니라 **담은** 커플이다. 빈 장바구니는 행위가 아니다.
    'couplesWithCart', (
      select count(distinct c.couple_id)
      from public.carts c
      where exists (
        select 1 from public.cart_items i
        where i.cart_id = c.id
          and i.created_at >= p_from and i.created_at < p_to
      )
    )
  ) into v_result;

  return v_result;
end;
$$;

comment on function public.admin_metrics(timestamptz, timestamptz) is
  'F-A-07 운영자 지표. SECURITY DEFINER 이지만 첫 줄의 is_operator() 가 경계이며 집계값만 돌려준다(행·id·개인정보 없음).';

-- ── 권한 ────────────────────────────────────────────────────────────────────
-- `revoke ... from public` 은 **service_role 이 public 에게서 물려받은 몫까지 걷어간다.**
-- 그래서 필요한 롤에 다시 명시적으로 준다. 다만 이 함수는 세션 롤로 부를 때만 뜻이
-- 있다(`auth.uid()` 가 없으면 `is_operator()` 가 거짓이라 service_role 이 불러도 막힌다).
-- 그래도 `service_role` 에 실행 권한을 남겨 두는 이유는 **점검 스크립트(`db:rls`)가
-- "서비스롤이 불러도 막히는가" 를 실제로 확인해야 하기 때문**이다 — 실행조차 못 하면
-- 그 검사는 권한 부족을 경계 동작으로 착각한다.
revoke all on function public.admin_metrics(timestamptz, timestamptz) from public;
grant execute on function public.admin_metrics(timestamptz, timestamptz) to authenticated, service_role;

-- `anon` 에는 주지 않는다. 비로그인은 `is_operator()` 에서 어차피 막히지만,
-- **막히는 이유가 둘이면 하나가 사라져도 눈치채지 못한다.**
