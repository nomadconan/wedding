-- =============================================================================
-- 0042 · 마이그레이션 9차 — 태스크 의존 관계 (S7-18)
-- 근거: docs/07_개발명세서.md §2.1 F-C-04·F-C-37, §3.2 task_dependencies ·
--       task_template_dependencies + 불변식 표, §3.9 RLS, §7.4 파라미터,
--       IDEA-02 · T-00g
-- =============================================================================
-- T-00g 가 IDEA-02 를 명세에 넣으며 구현을 S7-18(이 파일)·S7-08(CRUD)·S7-19(표현)에
-- 배정했다. 이 파일은 **표와 불변식까지**이며 화면도 API 도 만들지 않는다.
--
-- **왜 마이그레이션을 앞세우는가.** 순환 방지·어드바이저리 락·위상 정렬은 **화면 없이
-- 검증되는 층**이다. 화면 태스크에 묶으면 그래프 불변식 시험이 UI 리뷰에 섞인다
-- (S5-11 · S7-14 와 같은 모양).
--
-- 이 파일이 정한 것 — 판단이 필요했던 지점과 근거
--
--  1. **간선은 표다. 배열이 아니다**(§3.2). `tasks.depends_on uuid[]` 로 두면 원소별
--     외래키를 걸 수 없어 **삭제된 태스크의 id 가 배열에 남는다.** 그 값은 조회할 때마다
--     "없는 선행" 이 되고, 화면은 영영 오지 않을 무언가를 기다린다.
--
--  2. **순환은 CHECK 로 못 막는다.** CHECK 는 행 하나만 본다. 트리거 + **재귀 CTE** 가
--     표준 수단이며, `depends_on_task_id` 에서 출발해 `task_id` 에 도달하면 거절한다.
--
--  3. **동시 삽입에는 구멍이 있다.** 두 트랜잭션이 서로 반대 방향의 간선을 동시에 넣으면
--     각자의 검사는 통과하고 커밋 뒤에 순환이 남는다. 그래서 트리거 진입 시
--     **커플 단위 어드바이저리 락**을 잡아 같은 커플의 그래프 변경을 직렬화한다 —
--     커플 단위라 다른 커플의 쓰기를 막지 않는다.
--
--  4. **깊이 상한은 파라미터다**(§7.4). 검사 폭주를 막는 값이며 코드에 박지 않는다.
--     **값이 없으면 간선을 받지 않는다** — 상한 없는 재귀는 사고이고, 없는 값을
--     '무제한' 으로 읽으면 그 사고가 조용히 열린다(D-49 와 같은 규칙).
--
--  5. **템플릿 표에도 같은 트리거를 건다.** 시드가 순환을 담고 들어오면 그것이 **모든
--     커플에게 복제**된다. 커플 그래프만 막는 것은 상류를 열어 두는 일이다.
--
--  6. **`ready`·`waiting` 을 저장하지 않는다.** 선행이 완료되는 순간 화면이 바뀌어야
--     하는데 저장하면 배치가 돌기 전까지 화면이 거짓말을 한다. 그래서 이 파일에는
--     그 컬럼이 없고 판정은 `lib/core/schedule` 이 조회 시점에 한다.
--
--  7. **중간 태스크를 지워도 앞뒤를 잇지 않는다.** A→B→C 에서 B 가 사라지면 A 와 C 는
--     무관해진다(`on delete cascade` 가 간선만 지운다). 추론으로 이으면 **사용자가 지운
--     순서를 시스템이 되살리는 셈**이고 그 결과는 사용자가 만들지 않은 그래프다.
-- =============================================================================

-- =============================================================================
-- 1) 운영 파라미터 — 값을 코드에 박지 않는다 (§7.4)
-- =============================================================================
-- **여기에는 값을 넣는다.** 다른 미결 파라미터(요율·SLA)와 다른 성격이기 때문이다 —
-- 이것은 운영 정책이 아니라 **검사 폭주를 막는 기술적 상한**이고, 값이 없으면 간선을
-- 하나도 받을 수 없어 기능이 서지 않는다. 운영이 배포 없이 조정할 수 있게 표에 둔다.
insert into public.app_settings (key, value_json, description)
values (
  'tasks.max_dependency_depth',
  '{"value": 20, "unit": "depth"}'::jsonb,
  '태스크 의존 그래프의 재귀 검사 상한(§3.2·§7.4). 순환 검사 폭주를 막는 기술적 상한이며 운영 정책이 아니다. 넘으면 간선 추가를 거절한다. **값이 없으면 간선을 받지 않는다** — 상한 없는 재귀는 사고다.'
)
on conflict (key) do nothing;

-- =============================================================================
-- 2) task_templates.code — 안정 키 (§3.2)
-- =============================================================================
-- 템플릿의 정체성은 uuid 가 아니라 **코드**다. 시드를 다시 넣어 uuid 가 바뀌어도
-- 순서 표와 `tasks.template_code` 가 가리키는 값은 그대로여야 한다.
alter table public.task_templates
  add column if not exists code text;

update public.task_templates
   set code = 'T-' || substr(md5(category || '|' || title), 1, 12)
 where code is null;

alter table public.task_templates
  alter column code set not null;

create unique index if not exists uq_task_templates_code on public.task_templates (code);

comment on column public.task_templates.code is
  '안정 키. 시드를 다시 넣어 uuid 가 바뀌어도 이 값은 유지된다 — task_template_dependencies 와 tasks.template_code 가 이 값을 가리킨다.';

-- =============================================================================
-- 3) task_template_dependencies — 템플릿의 순서 (시드가 순서를 갖는다)
-- =============================================================================
create table if not exists public.task_template_dependencies (
  template_code   text not null references public.task_templates (code) on delete cascade,
  depends_on_code text not null references public.task_templates (code) on delete cascade,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  primary key (template_code, depends_on_code),
  constraint task_template_dependencies_not_self check (template_code <> depends_on_code)
);

comment on table public.task_template_dependencies is
  '역산 템플릿의 순서(IDEA-02). 시드가 순서를 갖고, 자동 생성이 그것을 tasks 로 옮긴다. **순환 방지 트리거를 여기에도 건다** — 시드가 순환을 담으면 모든 커플에게 복제된다.';

create index if not exists idx_task_template_dependencies_depends
  on public.task_template_dependencies (depends_on_code);

select public.attach_set_updated_at('task_template_dependencies');

-- =============================================================================
-- 4) tasks 보강 — template_code · completed_out_of_order (§3.2)
-- =============================================================================
alter table public.tasks
  add column if not exists template_code text references public.task_templates (code) on delete set null,
  add column if not exists completed_out_of_order boolean not null default false;

comment on column public.tasks.template_code is
  '자동 생성의 출처 템플릿. 코드↔태스크를 이어 두어야 템플릿 순서를 task_dependencies 로 옮길 수 있다(§3.2). 수동 태스크는 null 이다.';
comment on column public.tasks.completed_out_of_order is
  '**선행이 미완인 채 완료했다는 기록**이다. 경고가 아니다 — 우리가 가진 것은 템플릿 추정이지 사실이 아니므로 잠그지 않는다(§3.2). 나중에 예산·날짜 충돌을 설명할 때 쓰인다.';

create index if not exists idx_tasks_template_code on public.tasks (template_code);

-- =============================================================================
-- 5) task_dependencies — 간선 표 (§3.2)
-- =============================================================================
create table if not exists public.task_dependencies (
  task_id            uuid not null references public.tasks (id) on delete cascade,
  depends_on_task_id uuid not null references public.tasks (id) on delete cascade,
  created_by         uuid references auth.users (id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  -- 길이 1 순환. 나머지 길이는 트리거가 본다.
  primary key (task_id, depends_on_task_id),
  constraint task_dependencies_not_self check (task_id <> depends_on_task_id)
);

comment on table public.task_dependencies is
  '태스크 간 선행 관계(F-C-37 · IDEA-02). **간선 1개 = 행 1개**이며 배열이 아니다 — 배열은 원소별 외래키를 걸 수 없어 삭제된 태스크 id 가 남는다. 중간 태스크가 사라져도 앞뒤를 잇지 않는다(사용자가 지운 순서를 되살리지 않는다).';
comment on column public.task_dependencies.depends_on_task_id is
  '이 태스크보다 **먼저** 끝나야 하는 태스크. ready·waiting 은 저장하지 않고 조회 시점에 계산한다.';

create index if not exists idx_task_dependencies_depends
  on public.task_dependencies (depends_on_task_id);

select public.attach_set_updated_at('task_dependencies');

-- =============================================================================
-- 6) 순환 방지 — 재귀 CTE + 커플 단위 어드바이저리 락
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
      using errcode = 'check_violation', constraint = 'task_foreign_couple';
  end if;

  -- **같은 커플의 그래프 변경을 직렬화한다.** 두 트랜잭션이 서로 반대 방향의 간선을
  -- 동시에 넣으면 각자의 검사는 통과하고 커밋 뒤에 순환이 남는다. 커플 단위라
  -- 다른 커플의 쓰기는 막지 않는다.
  perform pg_advisory_xact_lock(hashtext(v_couple::text));

  -- 상한은 파라미터다(§7.4). **없으면 받지 않는다** — 상한 없는 재귀는 사고다.
  select nullif(value_json->>'value', '')::integer into v_max_depth
    from public.app_settings where key = 'tasks.max_dependency_depth';

  if v_max_depth is null or v_max_depth < 1 then
    raise exception '의존 깊이 상한이 설정되지 않았습니다.'
      using errcode = 'check_violation', constraint = 'task_depth_unconfigured';
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
      using errcode = 'check_violation', constraint = 'task_cycle';
  end if;

  -- 깊이 상한에 닿았다면 그래프가 이미 상한만큼 깊다. 더 얹지 않는다.
  if coalesce(v_depth, 0) >= v_max_depth then
    raise exception '의존 깊이 상한(%)을 넘습니다.', v_max_depth
      using errcode = 'check_violation', constraint = 'task_depth_exceeded';
  end if;

  return new;
end;
$$;

comment on function public.task_dependency_guard() is
  '순환·타 커플·깊이 검사. CHECK 로는 행 하나만 보므로 불가능하다 — 재귀 CTE 가 표준 수단이고, 동시 삽입 구멍은 커플 단위 어드바이저리 락으로 닫는다(§3.2).';

drop trigger if exists trg_task_dependency_guard on public.task_dependencies;
create trigger trg_task_dependency_guard
  before insert or update on public.task_dependencies
  for each row execute function public.task_dependency_guard();

-- **템플릿 표에도 같은 트리거를 건다**(근거 5). 시드가 순환을 담으면 모든 커플에
-- 복제된다. 커플 개념이 없으므로 락과 커플 대조는 빠지고 순환·깊이만 본다.
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
      using errcode = 'check_violation', constraint = 'task_depth_unconfigured';
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
      using errcode = 'check_violation', constraint = 'task_template_cycle';
  end if;

  if coalesce(v_depth, 0) >= v_max_depth then
    raise exception '의존 깊이 상한(%)을 넘습니다.', v_max_depth
      using errcode = 'check_violation', constraint = 'task_depth_exceeded';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_task_template_dependency_guard on public.task_template_dependencies;
create trigger trg_task_template_dependency_guard
  before insert or update on public.task_template_dependencies
  for each row execute function public.task_template_dependency_guard();

-- =============================================================================
-- 7) RLS (§3.9 — 커플 데이터)
-- =============================================================================
alter table public.task_dependencies enable row level security;
alter table public.task_template_dependencies enable row level security;

-- 정책이 자기 표를 다시 조회하면 무한 재귀가 된다. definer 로 고리를 끊는다.
create or replace function public.owns_task(p_task_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.tasks t
    where t.id = p_task_id and public.is_couple_member(t.couple_id)
  );
$$;

comment on function public.owns_task(uuid) is
  '이 태스크가 내 커플 것인가. task_dependencies 정책이 tasks 를 직접 조회해도 되지만, 판정을 한 곳에 모아 두면 간선 양쪽을 같은 규칙으로 본다.';

-- **간선의 양쪽이 모두 내 커플 것이어야 한다.** 한쪽만 보면 남의 태스크를 선행으로
-- 세우는 행이 만들어지고, 트리거가 막더라도 정책이 먼저 거르는 편이 낫다.
create policy task_dependencies_select on public.task_dependencies
  for select to authenticated
  using (public.owns_task(task_id));

create policy task_dependencies_insert on public.task_dependencies
  for insert to authenticated
  with check (public.owns_task(task_id) and public.owns_task(depends_on_task_id));

create policy task_dependencies_delete on public.task_dependencies
  for delete to authenticated
  using (public.owns_task(task_id));

comment on policy task_dependencies_delete on public.task_dependencies is
  '간선은 지울 수 있다 — 순서는 사용자의 판단이고 우리 추정이 아니다. 다만 **지운 뒤 앞뒤를 잇지 않는다**(§3.2).';

-- **UPDATE 정책을 두지 않는다.** 간선에 고칠 것이 없다(양끝이 곧 정체성이다) —
-- 방향을 바꾸는 일은 지우고 다시 만드는 것이고, 그래야 트리거가 새 간선을 검사한다.
revoke update on public.task_dependencies from authenticated, anon;

-- 템플릿 순서는 **모두가 읽고 아무도 쓰지 않는다.** 시드·운영자(서비스롤)의 것이다.
create policy task_template_dependencies_select on public.task_template_dependencies
  for select to anon, authenticated
  using (true);

revoke insert, update, delete on public.task_template_dependencies from authenticated, anon;

-- =============================================================================
-- 0042 산출 요약
-- =============================================================================
--   테이블 2 — task_dependencies · task_template_dependencies
--   컬럼  3 — task_templates.code · tasks.template_code · tasks.completed_out_of_order
--   함수  3 — task_dependency_guard · task_template_dependency_guard · owns_task
--   트리거 2 · 정책 4 · 권한 회수 2 · 운영 파라미터 1
--
--   **화면도 API 도 없다.** CRUD 는 S7-08, 표현 넷은 S7-19 다.
--   도메인 판정(위상 정렬 · ready/waiting · 역산 타임라인)은 `lib/core/schedule` 이다.
-- =============================================================================
