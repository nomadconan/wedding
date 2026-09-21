-- =============================================================================
-- 준비 항목 상태의 어휘 (FIX-86)
--   근거: docs/TASKS.md FIX-86 · docs/07_개발명세서.md §3.2 · D-239
--   코드: lib/core/schedule/graph.ts 의 TASK_STATUSES 가 단일 진실
--
-- ── 무엇이 문제였나 ─────────────────────────────────────────────────────────
-- `tasks.status` 가 **CHECK 없는 `text`** 였다. `tasks` 는 **표 단위 UPDATE** 라
-- (`grant ... update on public.tasks to authenticated`) 커플이 API 를 거치지 않고
-- 직접 쓸 수 있고, 그래서 `status = '아무거나'` 가 **그대로 들어갔다**(착수 전 실측).
--
-- FIX-75(`vendors.category`·`products.category`) · FIX-82(`tasks.category`·
-- `task_templates.category`) · FIX-85(`community_posts.category`)와 **같은 모양이며
-- 네 번째**다.
--
-- ── 앞의 셋보다 위험한 이유 ─────────────────────────────────────────────────
-- 카테고리가 오염되면 **화면이 코드를 라벨 대신 날것으로 그리는** 선에서 끝난다.
-- `status` 는 다르다 — **세는 값**이다:
--
--   · 진행 게이지(`categoryProgress`)      `status === 'done'` 을 센다
--   · 다음 할 일 / 준비 순서(`readinessOf`) `'done'` 이 아닌 것을 막힌 것으로 본다
--   · 기한 알림 배치(C-4d `lib/notify/task-due.ts:163`) `'done'` 이면 안 보낸다
--
-- `'완료'`·`'Done'`·`'done '` 같은 값이 들어가면 **끝낸 일을 재촉**하거나
-- **안 끝낸 일을 건너뛴다.** 조용히 틀리고, 사용자는 알림이 안 온 이유를 모른다.
--
-- ── 무엇을 하는가 ───────────────────────────────────────────────────────────
--  1. 어휘 판정 함수 `is_task_status()` — 0075 의 `is_vendor_category()`·
--     `is_prep_category()` 와 **같은 모양**이다. 새 방식을 만들지 않았다.
--     함수로 두는 이유는 `db:rls` 가 **코드와 DB 를 양방향으로 대조**할 수 있기
--     때문이다(`select public.is_task_status('x')`). 인라인 `in (...)` 이면
--     제약 정의 문자열을 파싱해야 하고, 그 파싱이 또 하나의 사본이 된다.
--  2. `tasks.status` 에 CHECK. `not valid` → `validate` 두 단계다.
--
-- ── 쓰기를 걷지 않는다 ──────────────────────────────────────────────────────
-- **커플이 자기 할 일을 완료 처리하는 것은 정상이다.** C-2f 가 `vendors.region_code`
-- 에서 한 것처럼 권한을 표에서 걷고 칸으로 다시 주는 방식은 **여기서 맞지 않다** —
-- 그 칸은 *공유 통계의 분모*였고 이 칸은 *자기 목록의 상태*다. 막을 것은
-- **어휘 밖 값**이지 쓰기 자체가 아니다.
--
-- ── 기존 행 ────────────────────────────────────────────────────────────────
-- 착수 전 실측: `todo` · `doing` · `done` **셋뿐**이고 전부 어휘 안이다.
-- `not valid` → `validate` 가 그것을 확인한다 — 어긋난 행이 있으면 **여기서 멈춘다**.
--
-- ── 되돌리기 ────────────────────────────────────────────────────────────────
--   alter table public.tasks drop constraint if exists tasks_status_vocab;
--   drop function if exists public.is_task_status(text);
-- =============================================================================

-- ── 1. 어휘 판정 함수 ───────────────────────────────────────────────────────
-- 값 집합은 `lib/core/schedule/graph.ts` 의 `TASK_STATUSES` 와 같아야 하며
-- `db:rls` 가 **코드와 DB 를 대조**한다. 사본은 어긋나고 어긋나면 조용하다.
create or replace function public.is_task_status(p_value text)
returns boolean language sql immutable set search_path = public as $$
  select p_value in ('todo', 'doing', 'done');
$$;

comment on function public.is_task_status(text) is
  '준비 항목 상태 어휘(§3.2 · lib/core/schedule/graph.ts TASK_STATUSES). '
  '진행 게이지·준비 순서·기한 알림(C-4d)이 전부 이 값을 세므로 어휘 밖 값은 조용히 계산을 틀리게 한다(FIX-86).';

-- ── 2. CHECK ────────────────────────────────────────────────────────────────
alter table public.tasks
  drop constraint if exists tasks_status_vocab;

alter table public.tasks
  add constraint tasks_status_vocab
  check (public.is_task_status(status))
  not valid;

-- 어긋난 행이 있으면 **여기서 멈춘다.** 조용히 넘어가면 CHECK 이 새 행만 막고
-- 옛 행은 그대로 남아, 계산은 여전히 틀린 채로 굴러간다.
alter table public.tasks
  validate constraint tasks_status_vocab;

comment on column public.tasks.status is
  '준비 항목 상태. 어휘는 public.is_task_status() 가 판정하고 lib/core/schedule/graph.ts 의 '
  'TASK_STATUSES 와 같아야 한다(FIX-86). 커플이 직접 쓴다 — 막는 것은 어휘 밖 값이지 쓰기가 아니다.';
