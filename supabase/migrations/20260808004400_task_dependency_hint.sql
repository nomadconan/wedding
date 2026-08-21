-- =============================================================================
-- 0044 · 선행 관계 거절 사유를 API 가 읽을 수 있게 한다 (S7-19)
-- 근거: docs/07_개발명세서.md §4.2 POST/DELETE /api/tasks/[id]/dependencies
--       (TASK_CYCLE · TASK_FOREIGN_COUPLE · TASK_DEPTH_EXCEEDED) · §4.1 응답 포맷
-- =============================================================================
-- **왜 이 파일이 필요했나 — 흐름 점검이 잡았다.**
--
-- 0042 의 트리거는 거절 사유를 `using constraint = 'task_cycle'` 로 붙였다. psql 은
-- 그 이름을 그대로 보여 주고 `db:rls` 도 그것으로 검사한다. 그런데 **PostgREST 는
-- `constraint` 를 응답에 싣지 않는다** — 실제로 돌아오는 것은 이것뿐이다:
--
--     {"code":"23514","details":null,"hint":null,"message":"선행 관계가 순환합니다."}
--
-- 그래서 라우트는 순환·타 커플·깊이를 **구분할 수 없었고**, §4.2 가 정한 세 코드
-- 대신 500 으로 답했다. 사용자에게는 "순서를 잇지 못했어요" 만 남는다 — **무엇을
-- 잘못했는지 모른 채 거절만 받는 상태**이고, 이 화면에서 가장 흔한 실수가 바로
-- 순환이라 그 침묵의 값이 크다.
--
-- 판단이 필요했던 지점과 근거
--
--  1. **메시지 문자열로 분기하지 않는다.** 그것이 유일하게 남는 신호이긴 하나,
--     문안을 다듬는 날 조용히 500 으로 돌아간다 — **코드가 산문에 의존하면 안 된다.**
--
--  2. **`hint` 를 쓴다.** PostgREST 가 그대로 실어 주는 칸이고(`details` 도 되지만
--     그쪽은 값의 자리다) 사용자에게 보이지 않는다 — 라우트는 자기 문장으로 답한다
--     (`TASK_DEPENDENCY_ERRORS`). `constraint` 도 **그대로 남긴다**: psql 경로와
--     `db:rls` 가 그 이름으로 보고 있으므로 한쪽만 남기면 다른 쪽이 조용히 깨진다.
--
--  3. **기존 마이그레이션을 고치지 않았다.** 0042 는 이미 적용된 파일이고 고치면
--     적용 이력과 파일이 갈린다(§7.2 — 마이그레이션이 단일 진실이다). 함수는
--     `create or replace` 로 **새 파일에서** 갈아 끼운다.
--
--  4. **판정 자체는 한 글자도 바꾸지 않았다.** 재귀 CTE · 어드바이저리 락 · 깊이
--     상한 · "값이 없으면 받지 않는다"(D-71) 는 0042 그대로다. 이 파일이 바꾸는 것은
--     **거절을 어떻게 말하는가** 하나다.
-- =============================================================================

create or replace function public.task_dependency_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_couple      uuid;
  v_dep_couple  uuid;
  v_max_depth   integer;
  v_reaches     boolean;
  v_depth       integer;
begin
  select couple_id into v_couple from public.tasks where id = new.task_id;
  select couple_id into v_dep_couple from public.tasks where id = new.depends_on_task_id;

  if v_couple is null or v_dep_couple is null then
    raise exception '태스크를 찾을 수 없습니다.' using errcode = 'foreign_key_violation';
  end if;

  -- **남의 일정이 내 화면에 끼지 않게 한다**(§3.2 불변식 표).
  if v_couple <> v_dep_couple then
    raise exception '다른 커플의 태스크는 선행으로 둘 수 없습니다.'
      using errcode = 'check_violation',
            constraint = 'task_foreign_couple',
            hint = 'task_foreign_couple';
  end if;

  -- **같은 커플의 그래프 변경을 직렬화한다.** 두 트랜잭션이 서로 반대 방향의 간선을
  -- 동시에 넣으면 각자의 검사는 통과하고 커밋 뒤에 순환이 남는다. 커플 단위라
  -- 다른 커플의 쓰기는 막지 않는다.
  perform pg_advisory_xact_lock(hashtext(v_couple::text));

  -- 상한은 파라미터다(§7.4). **없으면 받지 않는다** — 상한 없는 재귀는 사고다(D-71).
  select nullif(value_json->>'value', '')::integer into v_max_depth
    from public.app_settings where key = 'tasks.max_dependency_depth';

  if v_max_depth is null or v_max_depth < 1 then
    raise exception '의존 깊이 상한이 설정되지 않았습니다.'
      using errcode = 'check_violation',
            constraint = 'task_depth_unconfigured',
            hint = 'task_depth_unconfigured';
  end if;

  -- **선행에서 출발해 이 태스크에 도달하면 순환이다.** 새 간선을 넣기 전에 본다.
  with recursive walk(id, depth) as (
    select new.depends_on_task_id, 1
    union all
    select d.depends_on_task_id, w.depth + 1
      from public.task_dependencies d
      join walk w on d.task_id = w.id
     where w.depth < v_max_depth
  )
  select bool_or(id = new.task_id), max(depth) into v_reaches, v_depth from walk;

  if coalesce(v_reaches, false) then
    raise exception '선행 관계가 순환합니다.'
      using errcode = 'check_violation',
            constraint = 'task_cycle',
            hint = 'task_cycle';
  end if;

  -- 깊이 상한에 닿았다면 그래프가 이미 상한만큼 깊다. 더 얹지 않는다.
  if coalesce(v_depth, 0) >= v_max_depth then
    raise exception '의존 깊이 상한(%)을 넘습니다.', v_max_depth
      using errcode = 'check_violation',
            constraint = 'task_depth_exceeded',
            hint = 'task_depth_exceeded';
  end if;

  return new;
end;
$$;

comment on function public.task_dependency_guard() is
  '순환·타 커플·깊이 검사(0042). CHECK 로는 행 하나만 보므로 불가능하다 — 재귀 CTE 가 표준 수단이고, 동시 삽입 구멍은 커플 단위 어드바이저리 락으로 닫는다(§3.2). **거절 사유를 `hint` 에도 싣는다**(0044): PostgREST 가 `constraint` 를 응답에 싣지 않아 API 가 순환과 깊이를 구분할 수 없었고, 메시지 문자열로 분기하면 문안을 다듬는 날 조용히 깨진다.';

-- 템플릿 표도 같은 이유로 갈아 끼운다. 지금 이 경로를 부르는 API 는 없지만(시드·
-- 운영자만 쓴다) **두 함수가 다른 방식으로 말하면 다음 사람이 한쪽만 보고 헷갈린다.**
create or replace function public.task_template_dependency_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_max_depth integer;
  v_reaches   boolean;
  v_depth     integer;
begin
  select nullif(value_json->>'value', '')::integer into v_max_depth
    from public.app_settings where key = 'tasks.max_dependency_depth';

  if v_max_depth is null or v_max_depth < 1 then
    raise exception '의존 깊이 상한이 설정되지 않았습니다.'
      using errcode = 'check_violation',
            constraint = 'task_depth_unconfigured',
            hint = 'task_depth_unconfigured';
  end if;

  with recursive walk(code, depth) as (
    select new.depends_on_code, 1
    union all
    select d.depends_on_code, w.depth + 1
      from public.task_template_dependencies d
      join walk w on d.template_code = w.code
     where w.depth < v_max_depth
  )
  select bool_or(code = new.template_code), max(depth) into v_reaches, v_depth from walk;

  if coalesce(v_reaches, false) then
    raise exception '템플릿 순서가 순환합니다.'
      using errcode = 'check_violation',
            constraint = 'task_template_cycle',
            hint = 'task_template_cycle';
  end if;

  if coalesce(v_depth, 0) >= v_max_depth then
    raise exception '의존 깊이 상한(%)을 넘습니다.', v_max_depth
      using errcode = 'check_violation',
            constraint = 'task_depth_exceeded',
            hint = 'task_depth_exceeded';
  end if;

  return new;
end;
$$;

-- =============================================================================
-- 0044 산출 요약
-- =============================================================================
--   테이블 0 · 컬럼 0 · 정책 0 · 트리거 0 (붙어 있는 트리거는 그대로다)
--   함수 2 갈아끼움 — 거절 사유를 `hint` 에도 싣는다
--
--   **판정은 바뀌지 않았다.** 바뀐 것은 거절을 말하는 방식 하나이며,
--   §4.2 의 세 코드(TASK_CYCLE · TASK_FOREIGN_COUPLE · TASK_DEPTH_EXCEEDED)가
--   그 덕에 실제로 나간다.
-- =============================================================================
