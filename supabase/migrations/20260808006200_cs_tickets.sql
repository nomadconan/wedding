-- 0062 CS·신고 처리 (S8-09 · F-A-06 · §6.4 `/admin/tickets` · §4.3 `CRUD /api/admin/tickets`)
--
-- ══════════════════════════════════════════════════════════════════════════
-- 1. 표를 만지기 전에 권한부터 봤다 — 이번 것은 **이미 열려 있는 구멍**이다
-- ══════════════════════════════════════════════════════════════════════════
--
-- 아홉 번째다. 앞선 여덟은 대개 "정책이 없어 오늘은 막힌다" 였는데, **여기는 정책이
-- 있고 그 정책이 뚫려 있다.**
--
--   `tickets_insert`   `with check (reporter_id = auth.uid())` **하나뿐**이고
--                      `authenticated` 에 **표 단위 INSERT** 가 열려 있다.
--
-- 그래서 신고자가 접수하면서 `status`·`assignee_id`·`resolution` 을 **직접 쓸 수 있다.**
-- `status = 'resolved'` 로 넣으면 그 티켓은 **운영자 큐에 아예 뜨지 않는다** — 접수는
-- 됐고 아무도 보지 않는다. `FIX-36`(요청자가 자기 삭제 요청을 '처리 완료' 로 접수)과
-- **글자 그대로 같은 모양**이며, S8-11(`review_reports`)·S8-07(`finding_reports`)에서
-- 이미 두 번 같은 방식으로 막았다.
--
-- 변형이 하나 더 있다: **`assignee_id` 를 남의 것으로 적을 수 있다.** "저 운영자가
-- 담당" 이라는 기록이 신고자의 입력 한 줄로 만들어진다.
--
-- **`FIX-43` 으로 적는다.** 앞의 것들과 달리 이것은 **오늘 이미 통하는** 경로다.
--
-- ── 층 2: 정책이 다른 표의 정책에 기대는가 (FIX-41) ────────────────────────
-- `tickets_select`·`tickets_insert` 는 `reporter_id = auth.uid()` 로 **자기 조건을
-- 스스로 말한다.** 아래에서 더하는 운영자 정책도 `is_operator()` 하나다 —
-- `exists (select 1 from <부모>)` 모양이 아니고, `tickets` 를 부모로 삼는 자식 표도 없다.

-- **표에서 걷고 필요한 칸만 다시 준다**(FIX-36 이 가르친 것 — `revoke insert (컬럼)`
-- 만으로는 표 권한을 줄이지 못한다).
revoke insert, update, delete on public.tickets from anon, authenticated;
grant insert (reporter_id, category, subject, body) on public.tickets to authenticated;

-- 비로그인은 티켓을 읽을 이유가 없다(본문에 연락처·거래 내용이 섞인다).
revoke select on public.tickets from anon;

-- ══════════════════════════════════════════════════════════════════════════
-- 2. 어휘를 DB 가 강제한다 — CHECK 이 하나도 없었다
-- ══════════════════════════════════════════════════════════════════════════
--
-- `status` 도 `category` 도 자유 문자열이었다. 오타가 들어가면 저장은 성공하고
-- **화면만 그 티켓을 못 읽는다**(FIX-33 과 같은 모양) — 접수된 신고가 조용히 사라지는
-- 것이 이 표에서 가장 나쁜 실패다.
--
-- **허용 값을 나열한다.** "종결이 아니면 열림" 같은 부정형으로 쓰면 값이 늘 때마다
-- 뜻이 조용히 바뀐다(S8-03 이 물린 자리).
--
-- **`resolved` 와 `rejected` 는 신고자에 대한 판정이 아니다**(D-24). 앞은 "우리가
-- 조치했다", 뒤는 "조치하지 않기로 했다" 이며 **둘 다 사유를 요구한다** — '조치 없음'
-- 도 설명해야 한다는 규칙에 예외를 두면 거절이 곧 무시가 된다(S8-04·S8-11 과 같다).
alter table public.tickets drop constraint if exists tickets_status_vocab;
alter table public.tickets
  add constraint tickets_status_vocab
  check (status = any (array['open', 'assigned', 'resolved', 'rejected']));

alter table public.tickets drop constraint if exists tickets_category_vocab;
alter table public.tickets
  add constraint tickets_category_vocab
  check (category = any (array[
    'account',    -- 계정·로그인
    'payment',    -- 결제·환불
    'vendor',     -- 업체 관련 신고
    'content',    -- 게시물·후기 외 콘텐츠 신고
    'abuse',      -- 괴롭힘·부적절한 연락
    'bug',        -- 오류 제보
    'other'
  ]));

alter table public.tickets drop constraint if exists tickets_subject_chk;
alter table public.tickets
  add constraint tickets_subject_chk
  check (nullif(btrim(subject), '') is not null);

-- 처리자·처리 시각. 종결에는 셋(사유·처리자·시각)이 함께 있어야 한다.
alter table public.tickets
  add column if not exists resolved_by uuid references auth.users (id) on delete set null,
  add column if not exists resolved_at timestamptz;

alter table public.tickets drop constraint if exists tickets_resolution_chk;
alter table public.tickets
  add constraint tickets_resolution_chk
  check (
    (
      status = any (array['open', 'assigned'])
      and resolved_by is null and resolved_at is null and resolution is null
    )
    or (
      status = any (array['resolved', 'rejected'])
      and resolved_by is not null
      and resolved_at is not null
      and nullif(btrim(resolution), '') is not null
    )
  );

-- **담당자가 있어야 `assigned` 다.** 상태만 바꾸고 사람을 안 붙이면 그 티켓은
-- "누군가 보고 있다" 고 적힌 채 아무도 안 본다.
alter table public.tickets drop constraint if exists tickets_assigned_chk;
alter table public.tickets
  add constraint tickets_assigned_chk
  check (status <> 'assigned' or assignee_id is not null);

comment on column public.tickets.status is
  'S8-09. open | assigned | resolved | rejected. **접수 시 open 고정**(컬럼 권한이 강제) — 신고자가 자기 신고를 닫으면 운영자 큐에 뜨지 않는다(FIX-43 · FIX-36 과 같은 모양).';
comment on column public.tickets.resolution is
  'S8-09. 처리 사유. **''조치하지 않음''도 사유가 필수다**(CHECK) — 사유 없는 거절은 처리가 아니라 무시다.';

create index if not exists idx_tickets_open
  on public.tickets (created_at desc) where status = any (array['open', 'assigned']);
create index if not exists idx_tickets_assignee on public.tickets (assignee_id);

-- ══════════════════════════════════════════════════════════════════════════
-- 3. 운영자 열람 — **행이 목적이라 정책이다** (D-115)
-- ══════════════════════════════════════════════════════════════════════════
--
-- 티켓 본문을 읽지 않고는 처리할 수 없다. 합계가 아니라 행이 목적이므로 정책이다.
--
-- **신고자에게 처리 결과가 보인다.** 기존 `tickets_select`(`reporter_id = auth.uid()`)가
-- 그대로 살아 있어 자기 티켓의 상태·사유를 읽는다 — 접수만 받고 결과를 안 보여주면
-- 그것은 처리가 아니다.
create policy tickets_select_operator on public.tickets for select to authenticated
  using (public.is_operator());

-- 쓰기 정책을 두지 않는다 — **처리는 서비스롤 경유**(D-62)다. 운영자에게 UPDATE 를
-- 주면 컬럼 권한이 역할 단위라 **신고자에게도 같은 칸이 열린다**(D-130 이 후기에서
-- 만난 제약과 같다).

-- ══════════════════════════════════════════════════════════════════════════
-- 4. 제재 — **집행할 수 있는 것만 집행한다**
-- ══════════════════════════════════════════════════════════════════════════
--
-- F-A-06 은 '사용자·업체 제재 조치' 를 적는다. 둘의 사정이 다르다.
--
--   업체   **집행 수단이 이미 있다.** `vendors.status = 'suspended'` 이고
--          `vendors_select_public` 이 `status = 'active'` 만 공개하므로 정지하면
--          탐색·검색·상세에서 실제로 사라진다. 그래서 콘솔이 이것을 집행한다.
--
--   사용자 **집행 수단이 없다.** `profiles` 에 상태 칸이 없고, 칸만 만들면 화면은
--          "정지됨" 이라 적는데 그 사용자는 계속 서비스를 쓴다 — **화면이 거짓말을
--          하는 상태**가 되고, 그것이 이 리포에서 가장 피하는 실패다.
--
-- **그래서 사용자 제재 칸을 만들지 않는다.** 무엇을 근거로 정지하고 정지가 무엇을
-- 막으며 이의제기를 어떻게 받는지는 **O-14(커뮤니티 운영 정책)와 같은 층의 미결**이며,
-- 새 오픈 이슈를 만들지 않고 그쪽을 인용한다(번호를 남발하지 않는다).
-- 콘솔은 티켓에 **조치 기록**을 남길 수 있게 하고, 사용자 정지는 그 사실을 적는다.
--
-- **업체 제재도 새 표를 만들지 않는다.** `vendors.status` 를 바꾸는 일이고 그 전이는
-- `entity_events`(vendor)에 이미 남는다. 세 번째 사본을 만들면 어느 것이 이력인지 갈린다.

-- ══════════════════════════════════════════════════════════════════════════
-- 5. 큐를 합치지 않는다
-- ══════════════════════════════════════════════════════════════════════════
--
-- 신고가 쌓이는 자리가 이제 넷이다 — 커뮤니티(S7-17)·후기(S8-11)·오탐(S8-07)·CS(여기).
-- S8-03 이 분쟁에서 넷을 한 큐로 합친 선례가 있지만(D-121) **여기서는 합치지 않는다.**
--
-- 분쟁 넷은 **같은 사건(예약 하나)에 대한 다른 기록**이라 하나를 안 보면 그 사건을
-- 놓쳤다. 신고 넷은 **대상도 조치도 다르다** — 게시물을 가리는 일, 후기를 내리는 일,
-- 룰을 손보는 일, 계정·결제 문의에 답하는 일이 한 목록에 섞이면 처리 절차가 서로 다른
-- 건이 같은 줄에 놓인다(S7-17 이 커뮤니티 신고를 CS 와 나눈 것과 같은 이유).
--
-- 대신 **화면이 나머지 셋의 열린 건수와 링크를 함께 보인다** — 합치지 않되 놓치지
-- 않게 한다. 새 표도 뷰도 만들지 않았다(계산이다).

-- TRUNCATE 는 0053 이 전역으로 걷었지만 매번 다시 센다(FIX-35).
revoke truncate on public.tickets from anon, authenticated;
