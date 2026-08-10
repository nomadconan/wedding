-- =============================================================================
-- 0018 · 계정·데이터 삭제 요청 (S3-09)
-- 근거: docs/07_개발명세서.md §2.1 F-C-23, §3.1 data_deletion_requests, §3.9,
--       §7.3(삭제 요청은 접수 후 SLA 내 처리하고 F-A-08 에서 추적한다)
-- =============================================================================
-- 테이블은 T-03 이 이미 만들었다. 여기서는 **성립하지 않는 상태를 DB 가 거부하도록**
-- 값 집합을 못박고, 사용자가 요청을 거둘 수 있는 구간을 정책으로 표현한다.
--
-- 값 집합은 text + CHECK 다 — 명세가 `scope`·`status` 의 값을 정하지 않았고,
-- 0001 의 원칙이 "명세가 못박지 않은 status 계열은 text 로 두고 확정 시 제약 추가" 다.
-- =============================================================================

-- 1) 삭제 범위
--    account      계정과 모든 데이터
--    service_data 준비 기록만 (로그인은 유지)
--  둘로 나누는 이유: 결혼 준비가 끝나 기록만 지우려는 사람과 서비스를 떠나는 사람은
--  다른 요구를 갖는다. 하나로 합치면 전자가 계정을 잃는다.
alter table public.data_deletion_requests
  add constraint data_deletion_requests_scope_chk
  check (scope in ('account', 'service_data'));

comment on column public.data_deletion_requests.scope is
  'account(계정과 모든 데이터) | service_data(준비 기록만, 로그인 유지).';

-- 2) 처리 상태
alter table public.data_deletion_requests
  add constraint data_deletion_requests_status_chk
  check (status in ('pending', 'in_progress', 'completed', 'rejected', 'cancelled'));

comment on column public.data_deletion_requests.status is
  'pending(접수) | in_progress(처리 중) | completed | rejected | cancelled(사용자가 거둠). 처리는 운영(F-A-08)이 하고 사용자는 pending 에서만 거둘 수 있다.';

-- 3) 끝난 요청에는 처리 시각이 있어야 한다.
--    completed 인데 completed_at 이 없으면 SLA 를 잴 수 없고, 그러면 F-A-08 의
--    추적이 성립하지 않는다(§7.3).
alter table public.data_deletion_requests
  add constraint data_deletion_requests_completed_pair_chk
  check (
    status not in ('completed', 'rejected', 'cancelled')
    or completed_at is not null
  );

-- 4) **열린 요청은 사람당 하나.**
--    두 개가 열려 있으면 어느 것을 처리했는지, SLA 를 어느 쪽 기준으로 재는지
--    정할 수 없다. 끝난 요청은 몇 개든 쌓인다(부분 유니크).
create unique index if not exists uq_deletion_requests_open_per_user
  on public.data_deletion_requests (user_id)
  where status in ('pending', 'in_progress');

comment on index public.uq_deletion_requests_open_per_user is
  '처리 중인 삭제 요청은 사람당 하나. 끝난 요청은 이력으로 쌓인다.';

-- SLA 추적 경로. F-A-08 이 "접수한 지 오래된 요청" 을 훑는다.
create index if not exists idx_deletion_requests_open_requested
  on public.data_deletion_requests (requested_at)
  where status in ('pending', 'in_progress');

-- =============================================================================
-- 5) RLS — 사용자는 **거두기만** 할 수 있다 (§3.9)
-- -----------------------------------------------------------------------------
-- T-03 은 SELECT·INSERT 만 열어 뒀다. 요청을 거두려면 UPDATE 가 필요한데, 그렇다고
-- 상태를 마음대로 바꾸게 하면 사용자가 자기 요청을 `completed` 로 만들어 버릴 수 있다.
--
-- 그래서 **전이 하나만** 연다 — `using` 이 출발 상태를(pending), `with check` 가
-- 도착 상태를(cancelled) 제한한다. 이 조합이 "pending 에서 cancelled 로만" 을
-- 정책 자체로 표현한다. 앱 코드가 아니라 DB 가 경계다.
--
-- 처리(`in_progress`·`completed`·`rejected`)는 운영자가 서비스롤로 한다(F-A-08).
-- =============================================================================
create policy data_deletion_requests_cancel on public.data_deletion_requests
  for update to authenticated
  using (user_id = auth.uid() and status = 'pending')
  with check (user_id = auth.uid() and status = 'cancelled');

comment on policy data_deletion_requests_cancel on public.data_deletion_requests is
  '본인이 접수 상태의 요청을 거두는 전이만 허용한다. 처리가 시작된 뒤에는 이미 지워진 데이터가 있을 수 있어 거둘 수 없다.';

-- =============================================================================
-- 이 파일이 한 것
--   CHECK 3 — 범위 / 상태 값 집합 / 끝난 요청의 처리 시각
--   UNIQUE 인덱스 1 — 사람당 열린 요청 하나
--   인덱스 1 — SLA 추적 경로
--   정책 1 — pending -> cancelled 전이만
--   신규 테이블 없음
-- =============================================================================
