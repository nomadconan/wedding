-- 0063 피처 플래그 콘솔 (S8-12 · F-A-10 · §6.4 `/admin/flags` · §4.3 `PUT /api/admin/flags/[key]`)
--
-- ══════════════════════════════════════════════════════════════════════════
-- 1. 표를 만지기 전에 권한부터 봤다 — **이번엔 걷을 것이 없었다**
-- ══════════════════════════════════════════════════════════════════════════
--
-- 열 번째 감사다. 결과가 앞선 아홉과 다르다.
--
--   `feature_flags`  `anon`·`authenticated` 에 **권한이 하나도 없다.** SELECT 조차 없다.
--                    정책도 없다. `service_role` 만 갖는다.
--
-- **public 스키마에서 유일한 표다.** 0005 가 다른 아홉 표는 "GRANT 는 있으나 정책이
-- 없어 행이 안 보이는" 상태로 두면서 **이 표만 테이블 GRANT 까지 회수**했다(D-15) —
-- 이유는 열람의 대상이 데이터가 아니라 **미공개 기능의 존재 자체**이기 때문이다.
-- 플래그 키 목록이 곧 로드맵이고, 로드맵은 행 하나 보이는 것보다 넓게 샌다.
--
-- ── 그래서 이 콘솔은 그 경계를 깨지 않는다 ─────────────────────────────────
--
-- 다른 운영자 콘솔은 전부 **정책**으로 열었다(D-115 — 행이 목적이면 정책이다).
-- 여기서 같은 방식을 쓰려면 `grant select on feature_flags to authenticated` 가
-- 필요하고, **그 순간 D-15 가 세운 두 번째 층이 사라진다**: 다음 사람이 정책 하나를
-- 잘못 쓰면 로드맵이 통째로 새고, 그 정책은 지금 우리가 없앤 안전망 없이 홀로 선다.
--
-- **그래서 GRANT 를 복구하지 않고 SECURITY DEFINER 함수를 문 하나로 둔다**
-- (S8-01 이 지표에서 쓴 방식). 행이 목적인데 함수를 쓰는 것은 D-115 의 기본값과
-- 다르지만, **이 표에는 이미 더 강한 결정이 있고 그것을 되돌릴 이유가 없다.**
-- 경계는 여전히 DB 안에 있다 — 함수 첫 줄이 `is_operator()` 다.

-- ══════════════════════════════════════════════════════════════════════════
-- 2. 어휘·형식을 DB 가 강제한다 — CHECK 이 하나도 없었다
-- ══════════════════════════════════════════════════════════════════════════
--
-- `key` 는 코드가 문자열로 부르는 값이라(`isFeatureEnabled("community.enabled")`)
-- 오타가 들어가면 **그 행은 영원히 아무도 안 읽는다** — 켜 두었는데 기능은 닫혀 있고,
-- 화면은 "켜짐" 이라 적는다. 형식을 못 박아 그런 행을 만들 수 없게 한다.
alter table public.feature_flags drop constraint if exists feature_flags_key_format_chk;
alter table public.feature_flags
  add constraint feature_flags_key_format_chk
  check (key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$');

-- `rollout_json` 은 **객체여야 한다.** 배열이나 스칼라가 들어오면 `featureRollout` 이
-- 그것을 그대로 돌려주고 `enabledViews` 가 키를 찾다가 조용히 전부 꺼진 것으로 읽는다.
alter table public.feature_flags drop constraint if exists feature_flags_rollout_object_chk;
alter table public.feature_flags
  add constraint feature_flags_rollout_object_chk
  check (jsonb_typeof(rollout_json) = 'object');

comment on column public.feature_flags.key is
  'S8-12. 코드가 문자열로 부르는 값이다(lib/flags.ts). 형식이 어긋난 행은 영원히 아무도 읽지 않으면서 화면에는 "켜짐" 으로 보인다 — CHECK 이 그런 행을 막는다.';
comment on column public.feature_flags.rollout_json is
  'S8-12. 부분 공개 스위치와 **개방 조건 서술**이 함께 들어 있다(D-67). 콘솔은 **코드가 선언한 부분 스위치만** 토글하고 나머지 키는 보존한다 — 자유 JSON 편집은 오타 하나로 기능을 닫는다.';

-- ══════════════════════════════════════════════════════════════════════════
-- 3. 운영자 열람 — **GRANT 대신 함수** (D-15 를 지키면서 D-115 의 목적을 달성)
-- ══════════════════════════════════════════════════════════════════════════
--
-- **경계를 함수 안에 넣는다**(S8-01 과 같은 모양). 첫 줄이 `is_operator()` 이고,
-- 서비스롤이 불러도 `auth.uid()` 가 없어 막힌다 — `db:rls` 가 그것을 확인한다.
--
-- **뷰를 만들지 않았다.** 집계 뷰에는 걸 소유자가 없고, 필터 없는 뷰는 다음 사람이
-- `security_invoker` 를 끄는 순간 통로가 된다(S8-01 이 정한 것과 같은 이유).
create or replace function public.admin_feature_flags()
returns table (
  key          text,
  enabled      boolean,
  rollout_json jsonb,
  updated_by   uuid,
  updated_at   timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  -- `is_operator()` 자체도 DEFINER 이며 `auth.uid()` 의 profiles.role 을 본다.
  -- 서비스롤로 부르면 `auth.uid()` 가 null 이라 여기서 끊긴다.
  if not public.is_operator() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return query
    select f.key, f.enabled, f.rollout_json, f.updated_by, f.updated_at
      from public.feature_flags f
     order by f.key;
end;
$$;

comment on function public.admin_feature_flags() is
  'F-A-10. 플래그 목록. **테이블 GRANT 를 복구하지 않기 위해** 함수로 연다(D-15) — 키 목록이 곧 미공개 기능 로드맵이라 다른 콘솔처럼 정책으로 열지 않았다. 경계는 함수 안의 is_operator() 이며 서비스롤로 부르면 auth.uid() 가 없어 막힌다.';

-- **`revoke all ... from public` 은 service_role 이 물려받은 몫까지 걷어간다**(함정 5 ·
-- S7-12 사고). 필요한 역할에 다시 명시적으로 준다.
revoke all on function public.admin_feature_flags() from public;
grant execute on function public.admin_feature_flags() to authenticated, service_role;

-- ══════════════════════════════════════════════════════════════════════════
-- 4. 쓰기 — 정책을 만들지 않는다
-- ══════════════════════════════════════════════════════════════════════════
--
-- 토글은 **서비스롤 경유**다(D-62). 정책을 주려면 GRANT 부터 복구해야 하고 그것이
-- 3번에서 피한 바로 그 일이다. `updated_by` 도 서버가 세션에서 채운다 — 입력으로
-- 받으면 남의 이름으로 "이 사람이 켰다" 는 기록이 만들어진다(S8-09 가 담당자
-- 배정에서 만난 것과 같은 자리 · D-144).
--
-- **새 표를 만들지 않았다.** 전환 이력은 `entity_events`(전이)와 `audit_logs`(근거
-- event id)가 갖는다 — 짧은 값이라 `before_json`/`after_json` 이 그대로 담는다
-- (S8-06 이 룰 변경에서 정한 것과 같은 판단이고, S8-08 이 리비전 표를 만든 것과는
-- 다른 쪽이다: 그쪽은 본문을 덮어써 다시 셀 수 없었다).

-- TRUNCATE 는 0053 이 전역으로 걷었고 이 표는 애초에 GRANT 가 없다. 매번 다시 센다.
revoke truncate on public.feature_flags from anon, authenticated;
