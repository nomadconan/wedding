-- job_runs.started_at 을 NOT NULL 로 (FIX-38 · fix/admin-client-error)
--
-- ══════════════════════════════════════════════════════════════════════════
-- **왜.** `started_at` 이 nullable 이라 시작 시각 없는 실행 기록이 만들어질 수 있었고,
-- 그런 행 하나가 `/admin/privacy` 를 통째로 빈 화면으로 만들었다:
--
--   Error: Cannot read properties of null (reading 'replace')
--
-- 화면 쪽은 이미 고쳤다(`formatTimestamp`). 여기서는 **애초에 그런 행이 생기지 않게** 한다.
-- **시작 시각 없는 실행 기록은 뜻이 없다.** 배치가 돌기 시작했다는 사실이 곧 그 행의
-- 존재 이유인데, 언제 시작했는지를 모르면 이력으로 쓸 수가 없다 — 파기 배치가
-- 기한을 지켰는지 따지는 것이 이 표의 용도다(§5.1).
--
-- 화면의 방어를 그대로 두는 이유: **DB 가 막는 것과 화면이 견디는 것은 다른 층이다.**
-- 여기서 막아도 `finished_at` 은 여전히 정상적으로 nullable 이고(아직 안 끝난 실행),
-- 다음에 nullable 컬럼을 화면에 붙이는 사람이 또 같은 곳을 밟는다.

-- 1) 기존 null 을 메운다. **지어내지 않는다** — 행이 만들어진 시각(`created_at`)이
--    시작 시각에 가장 가까운 사실이다. 그마저 없으면 now() 로 둔다.
update public.job_runs
set started_at = coalesce(created_at, now())
where started_at is null;

-- 2) 앞으로는 안 적어도 채워진다.
alter table public.job_runs
  alter column started_at set default now();

-- 3) 비워 둘 수 없게 한다.
alter table public.job_runs
  alter column started_at set not null;

comment on column public.job_runs.started_at is
  '배치 시작 시각. NOT NULL — 시작 시각 없는 실행 기록은 이력으로 쓸 수 없다(FIX-38).';
