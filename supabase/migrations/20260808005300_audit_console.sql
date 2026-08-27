-- 0053 감사 로그 콘솔 (S8-02 · F-A-09 · 명세서 §6.4 `/admin/audit` · §4.3)
--
-- ══════════════════════════════════════════════════════════════════════════
-- 1. 증적 표를 **실제로** 추가 전용으로 만든다
-- ══════════════════════════════════════════════════════════════════════════
--
-- **이 태스크가 발견한 것.** `entity_events` 는 D-23 이 "insert-only" 로 못 박은 표이고
-- `audit_logs` 는 §7.2 가 "예외 없이 기록한다" 고 한 표다. 그런데 **아무 로그인 사용자나
-- 두 표를 통째로 지울 수 있었다**:
--
--   begin;
--   set local role authenticated;
--   set local request.jwt.claims = '{"sub":"<아무 소비자 id>", ...}';
--   truncate table public.entity_events;   -- 성공. 남은 행 0.
--
-- **RLS 는 TRUNCATE 에 적용되지 않는다.** 정책을 아무리 촘촘히 짜도 TRUNCATE 권한이
-- 있으면 표가 비워진다. Supabase 기본 셋업의 `grant all on all tables ... to anon,
-- authenticated` 가 그 권한을 준 채였고, **public 스키마 106개 표 전부**가 같은 상태였다
-- (anon 은 104개). 즉 비로그인 방문자도 대부분의 표를 비울 수 있었다.
--
-- 증적을 지울 수 있는 감사 콘솔은 **콘솔이 아니라 거짓말**이다 — 화면이 "이것이 일어난
-- 일의 전부" 라고 말하는데 그 전제가 보장되지 않는다. 그래서 콘솔을 세우기 전에 표를 먼저 막는다.
--
-- **왜 전 표인가.** 두 표만 막으면 나머지 104개는 그대로다. 이 REVOKE 는 동작을 바꾸지
-- 않는다 — 앱은 어디서도 TRUNCATE 를 쓰지 않는다(마이그레이션에도 없다). 잃는 것이 없다.
revoke truncate on all tables in schema public from anon, authenticated;

-- 앞으로 만들어질 표에도 같은 기본값을 건다. 이것이 없으면 **다음 마이그레이션이 만든
-- 표부터 다시 열린다** — 그때는 아무도 눈치채지 못한다.
alter default privileges in schema public revoke truncate on tables from anon, authenticated;

-- ── 감사 로그는 당사자가 고치거나 지울 수 없다 ──────────────────────────────
-- RLS 정책이 없어 지금도 막히지만 **권한 자체를 걷는다.** 정책은 누군가 나중에
-- 추가할 수 있고(그럴 이유도 있다 — 아래에서 SELECT 정책을 하나 더한다), 그때
-- 열려 있던 UPDATE 권한이 함께 살아난다.
revoke insert, update, delete on public.audit_logs from anon, authenticated;
revoke select on public.audit_logs from anon;
revoke select on public.entity_events from anon;

-- ── 서비스롤도 못 고치게 한다 ───────────────────────────────────────────────
-- 위 REVOKE 는 `authenticated`·`anon` 을 막을 뿐이고, **실제 위험은 서비스롤**이다 —
-- Route Handler 하나가 실수로(혹은 일부러) `.update()` 를 부르면 증적이 조용히 바뀐다.
-- 권한으로는 막을 수 없다(서비스롤은 쓰기를 해야 한다). 그래서 트리거로 막는다.
--
-- **삭제 요청(§7.3)과 부딪히지 않는가.** 부딪힐 수 있다 — 그러나 그 답을 **여기서**
-- 정하지 않는다. 개인정보 파기와 증거 보존의 경계는 S8-04 의 물음이고, 지금 DELETE 를
-- 열어 두면 그 결론이 나오기 전에 누군가 지운다. 필요해지면 이 트리거를 아는 채로 연다.
create or replace function public.reject_evidence_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'EVIDENCE_APPEND_ONLY'
    using
      errcode = '42501',
      hint = '증적 표는 추가 전용이다(D-23 · §7.2). 상태가 바뀌었으면 새 행을 넣는다.';
end;
$$;

comment on function public.reject_evidence_mutation() is
  'S8-02. entity_events·audit_logs 의 UPDATE·DELETE 를 막는다. 서비스롤에도 적용된다.';

drop trigger if exists trg_entity_events_append_only on public.entity_events;
create trigger trg_entity_events_append_only
  before update or delete on public.entity_events
  for each row execute function public.reject_evidence_mutation();

drop trigger if exists trg_audit_logs_append_only on public.audit_logs;
create trigger trg_audit_logs_append_only
  before update or delete on public.audit_logs
  for each row execute function public.reject_evidence_mutation();

-- ══════════════════════════════════════════════════════════════════════════
-- 2. 운영자가 감사 로그를 읽는다
-- ══════════════════════════════════════════════════════════════════════════
--
-- **SECURITY DEFINER 함수를 쓰지 않는다.** S8-01 의 지표는 **합계**라 행을 열 이유가
-- 없었지만, 감사 로그는 **행을 읽는 것이 목적**이다. 목적이 행이면 경계는 RLS 여야 한다
-- (CLAUDE.md §5.5). `entity_events` 가 이미 같은 모양이다(`entity_events_select_operator`).
create policy audit_logs_select_operator
  on public.audit_logs
  for select
  using (public.is_operator());

-- ══════════════════════════════════════════════════════════════════════════
-- 3. 행위자 이름만 좁게 연다
-- ══════════════════════════════════════════════════════════════════════════
--
-- 감사 로그의 첫 물음은 "누가" 다. 그런데 `audit_logs` 에는 `actor_id` 만 있고 이름은
-- `profiles` 에 있는데, **`profiles` 에는 운영자 정책이 없다**
-- (`profiles_select` = 본인 또는 같은 커플). 그래서:
--
--   (가) PostgREST 임베드로 `profiles(display_name)` 을 붙이면 → **이름이 조용히
--        사라진다.** 오류가 아니라 null 이라 화면은 "이름 없는 행위자" 를 그린다.
--   (나) `profiles` 에 운영자 SELECT 정책을 주면 → 이름 하나 때문에 **전 사용자의
--        프로필 행**(연락처 해시·역할·마케팅 수신 여부까지)이 열린다.
--
-- 그래서 **필요한 두 칸만** 돌려주는 함수를 둔다. 경계는 함수 안의 `is_operator()` 이고
-- 반환은 `display_name`·`role` 뿐이다 — `phone_hash` 는 나가지 않는다.
create or replace function public.admin_actor_labels(p_ids uuid[])
returns table (user_id uuid, display_name text, role text)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_operator() then
    raise exception 'ADMIN_ACTORS_FORBIDDEN'
      using errcode = '42501', hint = '운영자만 조회할 수 있습니다.';
  end if;

  return query
  select p.user_id, p.display_name, p.role::text
  from public.profiles p
  where p.user_id = any(coalesce(p_ids, '{}'::uuid[]));
end;
$$;

comment on function public.admin_actor_labels(uuid[]) is
  'F-A-09 감사 로그의 행위자 이름. SECURITY DEFINER 이지만 is_operator() 가 경계이고 display_name·role 만 돌려준다(phone_hash 미포함).';

-- `revoke ... from public` 은 **service_role 이 물려받은 몫까지 걷어간다**(S7-12 사고).
-- 필요한 역할에 다시 명시적으로 준다.
revoke all on function public.admin_actor_labels(uuid[]) from public;
grant execute on function public.admin_actor_labels(uuid[]) to authenticated, service_role;
