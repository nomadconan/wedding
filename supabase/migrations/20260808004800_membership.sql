-- =============================================================================
-- 0048 · 멤버십 구독 (S7-11)
-- 근거: docs/07_개발명세서.md §2.1 F-C-19, §3.1 memberships · subscription_payments,
--       §3.9 RLS, §6.2 /membership, §7.4 파라미터, D-28(외부 계약 스텁)
-- =============================================================================
-- 표는 0002 가 이미 만들었고 RLS 도 0005 [06][07] 이 걸어 두었다. 이 파일이 더하는 것은
-- **불변식과 파라미터 자리**다.
--
-- 판단이 필요했던 지점과 근거
--
--  1. **한 사람에 구독 하나다.** `memberships` 에 유니크가 없어 같은 사용자에게 행이
--     둘 생길 수 있었다. 그러면 **어느 것이 지금 등급인지 화면이 답할 수 없고**,
--     결제 재시도·웹훅 재전송이 행을 하나 더 만드는 순간 조용히 갈린다.
--
--  2. **상태 어휘를 DB 가 강제한다.** `status` 가 자유 텍스트면 오타 하나가 **등급
--     판정에서 빠지는 상태**를 만든다 — `canceled` 를 `cancelled` 로 적으면 코드는
--     그것을 활성으로 읽는다.
--
--  3. **등급을 저장하지 않는다.** `plan` 은 **무엇을 샀는가**이고 **지금 유효한 등급**은
--     거기에 시각을 더해 계산한다(`membershipState`). 만료를 배치가 옮겨 적기를
--     기다리면 그 사이 화면이 거짓말을 한다(D-71·D-84 와 같은 판단). 그래서 이 파일에
--     `effective_plan` 같은 컬럼이 없다.
--
--  4. **가격을 시드하지 않는다.** `membership.monthly_price` 는 **자리만** 만든다 —
--     가격은 사업 결정이고 아직 정해진 값이 없다(**O-17** 신설). 값을 넣으면 그것이
--     운영 기준처럼 굳고(D-40 이 요율 상한에서, D-66 이 어뷰징 임계값에서 세운 규칙)
--     **0으로 읽지도 않는다** — 0원 구독은 "공짜로 준다" 는 뜻인데 그렇게 정한 적이 없다.
--     값이 없으면 화면이 **가입 버튼을 열지 않고 그 사실을 적는다**.
--
--  5. **구독 결제 이력은 고칠 수 없다.** `subscription_payments` 는 0005 [07] 이
--     읽기만 열어 두었다. 쓰기는 서비스롤(어댑터 경유)이며 **UPDATE 를 회수**한다 —
--     결제 이력을 고칠 수 있으면 "얼마를 언제 받았나" 를 답할 수 없다(D-23).
-- =============================================================================

-- =============================================================================
-- 1) 한 사람에 구독 하나
-- =============================================================================
-- 중복이 이미 있으면 유니크가 서지 않는다. **가장 늦게 만든 것을 남긴다** —
-- 구독은 마지막 것이 현재 상태이고, 앞의 행은 지나간 기록이다.
delete from public.memberships m
 where exists (
   select 1 from public.memberships o
    where o.user_id = m.user_id
      and (o.created_at > m.created_at
           or (o.created_at = m.created_at and o.id::text > m.id::text))
 );

create unique index if not exists uq_memberships_user on public.memberships (user_id);

comment on column public.memberships.plan is
  '**무엇을 샀는가**. 지금 유효한 등급은 이 값에 status·expires_at·현재 시각을 더해 계산한다(lib/core/membership). **effective_plan 같은 컬럼을 두지 않는다** — 만료를 배치가 옮겨 적기를 기다리면 그 사이 화면이 거짓말을 한다(D-71·D-84).';
comment on column public.memberships.status is
  'active | canceled | expired. **canceled 는 지금 끊긴 것이 아니라 갱신하지 않겠다는 뜻**이다 — 이미 낸 기간은 그대로 쓴다. 그래서 등급 판정은 status 가 아니라 기한이 정한다.';
comment on column public.memberships.source is
  '어떤 경로로 생긴 구독인가(결제 어댑터 이름·운영 보정 등). 실연동 전에는 스텁 이름이 들어간다(D-28).';

-- =============================================================================
-- 2) 상태 어휘 — 오타 하나가 등급 판정을 비껴가지 않게
-- =============================================================================
create or replace function public.is_membership_status(p_value text)
returns boolean language sql immutable set search_path = public as $$
  select p_value in ('active', 'canceled', 'expired');
$$;

comment on function public.is_membership_status(text) is
  '멤버십 구독 상태 어휘(§3.1). 코드(lib/core/membership/membership.ts)와 같은 집합이며 db:rls 가 대조한다. 자유 텍스트로 두면 `cancelled` 같은 오타가 활성으로 읽힌다.';

-- 어휘 밖의 값이 있으면 **지우지 않고 `expired` 로 옮긴다** — 구독이 있었다는 사실은
-- 남기되 알 수 없는 상태를 활성으로 읽지 않는다(안전한 쪽으로 틀린다).
update public.memberships set status = 'expired' where not public.is_membership_status(status);

alter table public.memberships
  drop constraint if exists memberships_status_vocab;
alter table public.memberships
  add constraint memberships_status_vocab check (public.is_membership_status(status));

-- **유료 구독에는 시작 시각이 있다.** 없으면 "언제부터 쓴 것인가" 를 답할 수 없다.
alter table public.memberships
  drop constraint if exists memberships_premium_started_chk;
alter table public.memberships
  add constraint memberships_premium_started_chk
  check (plan = 'free' or started_at is not null);

-- =============================================================================
-- 3) 결제 이력은 고칠 수 없다
-- =============================================================================
revoke update on public.subscription_payments from authenticated, anon;

comment on table public.subscription_payments is
  '멤버십 구독 결제 이력(F-C-19). **읽기만 열려 있고 쓰기는 서비스롤**(결제 어댑터 경유 · 0005 [07])이며 UPDATE 를 회수했다 — 고칠 수 있으면 "얼마를 언제 받았나" 를 답할 수 없다(D-23). 실연동 전에는 스텁이 만든 행이며 금액은 app_settings 가 정한 값이다.';

create index if not exists idx_subscription_payments_created_at
  on public.subscription_payments (membership_id, created_at desc);

-- =============================================================================
-- 4) 운영 파라미터 — 자리만 만들고 값은 넣지 않는다 (§7.4 · O-17)
-- =============================================================================
-- **`membership.monthly_price` 는 값이 비어 있다.** 가격은 사업 결정이며 정해진 값이
-- 없다 — 넣으면 그것이 운영 기준처럼 굳는다. 값이 없는 동안 화면은 **가입 버튼을 열지
-- 않고 그 사실을 적는다**(D-49·D-90 과 같은 규칙 — 미설정을 0·무제한으로 읽지 않는다).
--
-- 기간(`period_days`)은 **값을 넣는다** — 이것은 가격이 아니라 **구독 한 주기의 길이**이고,
-- 없으면 만료 시각을 만들 수 없어 기능이 아예 서지 않는다(0042 가 깊이 상한에 값을 넣은
-- 것과 같은 이유: 운영 정책이 아니라 기술적 전제다).
insert into public.app_settings (key, value_json, description)
values
  (
    'membership.monthly_price',
    '{"value": null, "unit": "KRW"}'::jsonb,
    '멤버십 월 구독가(원). **값이 비어 있다 — O-17 대기.** 가격은 사업 결정이며 코드가 고르지 않는다. 값이 없으면 가입 화면이 열리지 않고 그 사실을 화면이 적는다(0원으로 읽지 않는다 — 0원 구독은 "공짜로 준다"는 뜻이다).'
  ),
  (
    'membership.currency',
    '{"value": "KRW"}'::jsonb,
    '멤버십 결제 통화. 가격과 함께 읽는다.'
  ),
  (
    'membership.period_days',
    '{"value": 30, "unit": "days"}'::jsonb,
    '구독 한 주기의 길이(일). **가격과 달리 값을 넣는다** — 없으면 만료 시각을 만들 수 없어 기능이 서지 않는다(기술적 전제이지 운영 정책이 아니다). 운영이 배포 없이 조정한다(§7.4).'
  )
on conflict (key) do nothing;

-- =============================================================================
-- 0048 산출 요약
-- =============================================================================
--   테이블 0 (0002 가 이미 만들었다) · 함수 1 · 유니크 1 · CHECK 2 ·
--   권한 회수 1 · 인덱스 1 · 운영 파라미터 3(그중 **가격은 값이 비어 있다** · O-17)
--
--   **RLS 를 새로 걸지 않았다** — 0005 [06][07] 이 memberships(본인 것만)·
--   subscription_payments(본인 이력 읽기)를 이미 걸어 두었다.
--   **등급 판정 컬럼을 만들지 않았다** — 계산값이다(lib/core/membership).
-- =============================================================================
