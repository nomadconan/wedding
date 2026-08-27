-- 0054 개인정보 감사·파기 배치 (S8-04 · F-A-08 · 명세서 §6.4 `/admin/privacy` · §4.3 · §7.3)
--
-- ══════════════════════════════════════════════════════════════════════════
-- 1. 삭제 요청을 **당사자가 스스로 처리 완료로 만들 수 없게** 한다
-- ══════════════════════════════════════════════════════════════════════════
--
-- **이 태스크가 발견한 것(함정 6).** `data_deletion_requests_insert` 정책의 조건은
-- `user_id = auth.uid()` 하나뿐이었고 `status` 는 제한이 없었다. 그래서:
--
--   set local role authenticated;  -- 아무 소비자
--   insert into public.data_deletion_requests(user_id, scope, status, completed_at)
--     values (auth.uid(), 'account', 'completed', now());   -- 성공
--
-- 요청자가 **자기 요청을 이미 처리된 것으로** 넣을 수 있었다. 그러면 그 요청은
-- **운영자의 SLA 큐에 아예 뜨지 않는다.** F-A-08 이 추적하려는 바로 그 값이
-- 요청자의 입력 한 줄로 사라지는 것이라, 큐를 세우기 전에 이 구멍을 먼저 막는다.
--
-- **정책이 아니라 컬럼 권한으로 좁힌다.** 정책의 `with_check` 로도 막을 수 있지만,
-- 컬럼 권한은 **정책을 누가 잘못 고쳐도 남는다**(0053 이 TRUNCATE 에서 배운 것과 같다).
-- `status` 의 기본값이 `'pending'` 이므로 컬럼을 못 쓰면 자동으로 pending 으로 들어온다.

alter table public.data_deletion_requests
  add column if not exists resolved_by uuid references auth.users (id) on delete set null,
  add column if not exists resolution_reason text;

comment on column public.data_deletion_requests.resolved_by is
  'S8-04. 처리한 운영자. 당사자 취소(cancelled)에는 없다.';
comment on column public.data_deletion_requests.resolution_reason is
  'S8-04. 처리 사유. completed·rejected 에는 필수다(아래 CHECK).';

-- **조치에는 사유가 필수다**(S7-17 이 모더레이션에서 정한 규칙과 같다).
-- 당사자 취소(`cancelled`)는 제외한다 — 자기 요청을 거두는 데 사유를 요구할 이유가 없다.
alter table public.data_deletion_requests
  drop constraint if exists data_deletion_requests_resolution_reason_chk;
alter table public.data_deletion_requests
  add constraint data_deletion_requests_resolution_reason_chk
  check (
    status <> all (array['completed', 'rejected'])
    or nullif(btrim(coalesce(resolution_reason, '')), '') is not null
  );

-- 처리한 사람이 누구인지도 남아야 한다. 운영자가 닫은 건에는 `resolved_by` 가 있다.
alter table public.data_deletion_requests
  drop constraint if exists data_deletion_requests_resolved_by_chk;
alter table public.data_deletion_requests
  add constraint data_deletion_requests_resolved_by_chk
  check (
    status <> all (array['completed', 'rejected'])
    or resolved_by is not null
  );

-- ── 컬럼 권한 (함정 6) ──────────────────────────────────────────────────────
-- 요청자가 넣을 수 있는 것은 **누가·무엇을** 뿐이다. 상태·처리자·사유·완료시각은
-- 서버(서비스롤)만 쓴다.
--
-- **표 단위 권한을 먼저 걷어야 한다.** PostgreSQL 에서 컬럼 권한은 표 권한을
-- **줄이지 못한다** — `revoke insert (status) ...` 만 쓰면 표 단위 INSERT 가 남아
-- 있어 아무 효과가 없다(처음 그렇게 썼다가 물렸다). 표에서 걷고 필요한 칸만 다시 준다.
revoke insert on public.data_deletion_requests from anon, authenticated;
grant insert (user_id, scope, requested_at) on public.data_deletion_requests to authenticated;

-- 당사자는 `data_deletion_requests_cancel` 정책으로 **pending → cancelled** 만 할 수 있다.
-- 그 경로에 필요한 두 칸(`status`·`completed_at`)만 남기고 나머지는 주지 않는다 —
-- 특히 `resolution_reason` 을 쓸 수 있으면 **처리 사유를 요청자가 적게 된다.**
revoke update on public.data_deletion_requests from anon, authenticated;
grant update (status, completed_at) on public.data_deletion_requests to authenticated;

-- 삭제 권한은 아무에게도 주지 않는다. 접수 기록이 사라지면 SLA 추적이 뜻을 잃는다 —
-- 거두는 것은 `cancelled` 로 남기는 것이지 지우는 것이 아니다.
revoke delete on public.data_deletion_requests from anon, authenticated;

-- ── 운영자 열람 (D-115 — 목적이 행이면 경계는 RLS 다) ───────────────────────
-- SLA 큐는 **행을 읽고 하나씩 처리하는** 화면이다. 합계가 아니므로 함수로 감싸지 않는다.
create policy data_deletion_requests_select_operator
  on public.data_deletion_requests
  for select
  using (public.is_operator());

-- **운영자에게 UPDATE 정책을 주지 않는다**(D-62). 삭제 요청 처리는 되돌릴 수 없는
-- 조치라 클라이언트 번들이 닿는 자리에 그 권한을 두지 않는다. 변경은 서비스롤 경유다.

-- ══════════════════════════════════════════════════════════════════════════
-- 2. 배치 실행 이력을 운영자가 읽는다
-- ══════════════════════════════════════════════════════════════════════════
-- `job_runs` 는 RLS 가 켜져 있는데 **정책이 하나도 없었다** — 아무도 못 읽는다.
-- F-A-08 이 요구하는 '파기 배치 이력' 이 그것이라 정책 하나를 더한다.
-- 쓰기는 배치(서비스롤)만 한다 — INSERT·UPDATE 정책을 두지 않는다.
create policy job_runs_select_operator
  on public.job_runs
  for select
  using (public.is_operator());

-- ══════════════════════════════════════════════════════════════════════════
-- 3. 문서 파기 현황은 **집계로만** 낸다
-- ══════════════════════════════════════════════════════════════════════════
--
-- **여기는 D-115 의 반대쪽이다.** 삭제 요청은 행을 읽어야 하지만 `documents` 는
-- **행을 보여 주면 안 된다** — `storage_path` 가 들어 있고 §5.3 은 그것을 **어떤
-- 로그에도** 남기지 말라고 한다. 운영자가 알아야 하는 것은 "몇 건이 밀렸나" 이지
-- "어느 파일이 남았나" 가 아니며, 실제로 지우는 것은 사람이 아니라 배치다.
--
-- 그래서 집계 전용 SECURITY DEFINER 함수다(D-107 과 같은 모양). 경계는 첫 줄의
-- `is_operator()` 이고 반환은 **개수와 경과 시간뿐** — 경로도 id 도 나가지 않는다.
create or replace function public.admin_purge_audit()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_result jsonb;
begin
  if not public.is_operator() then
    raise exception 'ADMIN_PRIVACY_FORBIDDEN'
      using errcode = '42501', hint = '운영자만 조회할 수 있습니다.';
  end if;

  select jsonb_build_object(
    'documentsTotal', (select count(*) from public.documents),
    'purged', (select count(*) from public.documents where purged_at is not null),
    -- **잔존**: 파기 예정 시각이 지났는데 아직 안 지워진 것. F-A-08 의 '잔존 건' 이다.
    'overdue', (
      select count(*) from public.documents
      where purged_at is null and purge_scheduled_at <= now()
    ),
    -- 아직 기한 전인 것. 잔존과 섞으면 "밀린 건" 이 실제보다 많아 보인다.
    'scheduled', (
      select count(*) from public.documents
      where purged_at is null and purge_scheduled_at > now()
    ),
    -- 가장 오래 밀린 건이 몇 시간째인가. 개수만으로는 심각도를 알 수 없다.
    -- 없으면 **0 이 아니라 null** 이다 — 0시간은 "방금 밀리기 시작했다" 는 뜻이라
    -- "밀린 것이 없다" 와 겹쳐 읽힌다(D-108 과 같은 규칙).
    'oldestOverdueHours', (
      select floor(extract(epoch from (now() - min(purge_scheduled_at))) / 3600)::int
      from public.documents
      where purged_at is null and purge_scheduled_at <= now()
    ),
    -- 마스킹 실패(§5.2). `analyze.ts` 가 `masking_incomplete` 이벤트로 남긴다.
    'maskingFailures', (
      select count(*) from public.entity_events
      where event_type = 'masking_incomplete'
    ),
    'maskingFailures24h', (
      select count(*) from public.entity_events
      where event_type = 'masking_incomplete'
        and occurred_at >= now() - interval '24 hours'
    )
  ) into v_result;

  return v_result;
end;
$$;

comment on function public.admin_purge_audit() is
  'F-A-08 문서 파기 현황. SECURITY DEFINER 이지만 is_operator() 가 경계이며 개수·경과시간만 돌려준다(storage_path·id 미포함).';

-- `revoke ... from public` 은 **service_role 이 물려받은 몫까지 걷어간다**(S7-12 사고).
revoke all on function public.admin_purge_audit() from public;
grant execute on function public.admin_purge_audit() to authenticated, service_role;

-- ══════════════════════════════════════════════════════════════════════════
-- 4. 삭제 요청 처리 기한은 **미결이다** (O-18 신설)
-- ══════════════════════════════════════════════════════════════════════════
--
-- §7.3 은 "접수 후 SLA 내 처리" 라고만 적고 **시간을 정하지 않았다**. 개인정보 삭제
-- 요청의 법정 처리 기한은 관할·근거법에 따라 다르고, 그것은 코드가 고를 값이 아니다
-- (O-03 법무 결론과 같은 층이다).
--
-- **값을 비워 둔다.** `community.report_sla_hours` 가 O-14 를 기다리는 것과 같은 모양이며,
-- 값이 없으면 화면은 **경과 시간만 보여주고 초과 여부를 판정하지 않는다.**
-- 지어낸 기한으로 "지연" 이라 적으면 그것이 곧 운영 기준으로 굳는다.
insert into public.app_settings (key, value_json, description)
values (
  'privacy.deletion_sla_hours',
  '{"unit": "hours", "value": null, "status": "undecided", "openIssue": "O-18"}'::jsonb,
  'TODO: O-18 확정 후 입력 — 계정·데이터 삭제 요청의 처리 목표 시간(§7.3). 값이 없으면 화면이 경과 시간만 보여주고 지연 판정을 하지 않는다. 법정 기한은 관할·근거법 소관이며 코드가 고르지 않는다.'
)
on conflict (key) do nothing;

-- ══════════════════════════════════════════════════════════════════════════
-- 5. 새 표를 만들지 않았다 (FIX-35 확인)
-- ══════════════════════════════════════════════════════════════════════════
-- 0053 이 `alter default privileges ... revoke truncate` 를 걸어 두었으므로 이후에
-- 만들어지는 표는 자동으로 막힌다. 이 마이그레이션은 표를 더하지 않아 확인만 한다 —
-- `db:rls` 가 "public 어느 표에도 TRUNCATE 가 열려 있지 않다" 를 매번 다시 센다.
