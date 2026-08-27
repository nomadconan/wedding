-- 0058 검증 후기 (S8-11 · F-C-17 · F-V-11 · F-A-13 · §6.2 `/reviews/new/[bookingId]`
--      · §6.3 `/vendor/reviews` · §6.4 `/admin/reviews`)
--
-- ══════════════════════════════════════════════════════════════════════════
-- 1. 표를 만지기 전에 권한부터 봤다 (FIX-30·35·36·37 이 가르친 것)
-- ══════════════════════════════════════════════════════════════════════════
--
-- 다섯 번째다. 그리고 이번 것이 그중 가장 나쁘다.
--
-- `reviews_update` 정책은 `is_couple_member(couple_id)` **하나만** 본다. 그런데
-- `authenticated` 에 UPDATE 가 **전 컬럼** 열려 있다. 두 사실을 합치면:
--
--   · 작성자가 자기 후기의 **`vendor_id` 를 다른 업체로 바꿀 수 있다.**
--     `with check` 는 `couple_id` 만 보므로 통과한다. 거래한 적 없는 업체에
--     **검증 후기**가 붙는다 — `reviews_insert` 가 거래 이력(`bookings.status in
--     ('confirmed','fulfilled')`)으로 잠근 문을 UPDATE 가 옆으로 연다.
--   · 작성자가 `status` 를 아무 값으로 쓸 수 있다. 운영자가 F-A-13 으로 **비공개한
--     후기를 작성자가 `published` 로 되돌린다.** 조치가 조치로 남지 않는다.
--   · `booking_id` 도 바꿀 수 있다. 한 예약에 후기 하나라는 unique 제약이
--     "어느 예약인가" 를 작성자가 고르는 값으로 만든다.
--
-- **검증 후기는 이 서비스가 광고를 받지 않는 대신 내놓는 신뢰의 형식이다**(D-03).
-- 거래하지 않은 업체를 평가할 수 있으면 '검증' 이라는 말이 거짓이 된다.
--
-- 그리고 `reviews_delete` — 작성자(커플 대표)가 후기를 **지울 수 있다.**
-- `review_reports.review_id` 는 `on delete cascade` 라 **신고 기록이 함께 사라진다.**
-- 신고당한 후기를 지우는 것으로 신고를 지우는 셈이다(D-23 이 채팅에서 이미 막은 것과
-- 같은 모양 — 사용자의 '삭제' 는 묘비이지 소거가 아니다).
--
-- FIX-39 로 적는다.

-- ── (가) 쓰기 권한을 걷는다 ─────────────────────────────────────────────────
-- **삭제는 아무에게도 주지 않는다.** 후기는 업체의 평판에 대한 기록이고 답변·신고가
-- 매달리는 자리라, 지울 수 있으면 그 셋이 함께 사라진다.
drop policy if exists reviews_delete on public.reviews;
revoke delete on public.reviews from anon, authenticated;
revoke update, delete on public.review_reports from anon, authenticated;

-- ── (나) 작성자가 만질 수 있는 칸을 나열한다 (FIX-36 이 쓴 컬럼 권한 · 함정 6) ──
-- 정책으로는 이걸 못 막는다. `with check` 는 **바뀐 뒤의 행**을 보는 것이라
-- "이 칸은 바뀌면 안 된다" 를 말할 수 없다. 권한은 칸 단위로 말할 수 있다.
--
-- 되돌려 주는 `grant` 는 **§2 끝**에 있다 — 허용 목록이 §2 에서 만드는 철회 칸을
-- 가리키므로 칸이 생긴 뒤라야 적을 수 있다. 그 사이에는 UPDATE 가 아예 없다.
revoke update on public.reviews from authenticated;

-- 신고는 **접수만** 한다. `status`·`resolved_*` 는 운영자 몫이라 칸을 주지 않는다 —
-- FIX-36 과 정확히 같은 모양이다(요청자가 자기 요청을 '처리 완료' 로 접수하면
-- 그 요청은 운영자 큐에 뜨지 않는다).
revoke insert on public.review_reports from authenticated;
grant insert (review_id, reporter_id, reason_code) on public.review_reports to authenticated;

-- ══════════════════════════════════════════════════════════════════════════
-- 2. 철회는 소거가 아니라 묘비다 (D-23)
-- ══════════════════════════════════════════════════════════════════════════
--
-- 작성자가 후기를 거둘 수단 자체는 있어야 한다 — 없으면 쓴 말을 영원히 못 무른다.
-- 다만 **행은 남는다.** 업체 답변과 신고가 그 행에 매달려 있고, "무엇에 대한
-- 답변이었나" 를 나중에 답할 수 있어야 한다.
--
-- **`status` 에 'retracted' 를 넣지 않았다.** 운영자 비공개(`hidden`)와 작성자
-- 철회는 **다른 사건**이라 한 칸에 넣으면 나중에 일어난 쪽이 앞의 사실을 덮는다 —
-- 비공개된 후기를 작성자가 철회하면 비공개였다는 사실이 지워진다. 칸을 나눈다.
alter table public.reviews
  add column if not exists retracted_at timestamptz,
  add column if not exists retracted_by uuid references auth.users (id) on delete set null;

comment on column public.reviews.retracted_at is
  'S8-11. 작성자가 거둔 시각. 행은 지우지 않는다(D-23) — 답변·신고가 매달려 있다. 공개 조건은 status=published AND retracted_at IS NULL 이다.';
comment on column public.reviews.retracted_by is
  'S8-11. 거둔 사람. RLS 가 auth.uid() 와 일치를 요구한다.';

-- ── §1(나) 가 예고한 허용 목록 ──────────────────────────────────────────────
-- **`vendor_id`·`booking_id`·`couple_id` 가 없다** — 후기가 누구의 무엇에 대한
-- 것인지는 작성 시점에 정해지고 그 뒤로 바뀌지 않는다.
-- **`status`·`hidden_*` 도 없다** — 그것은 플랫폼의 조치다(F-A-13).
-- **`vendor_reply*` 도 없다** — 그것은 업체의 말이다(F-V-11).
grant update (
  score_price,
  score_response,
  score_fulfillment,
  body,
  disclosed_amount,
  retracted_at,
  retracted_by
) on public.reviews to authenticated;

-- ══════════════════════════════════════════════════════════════════════════
-- 3. 어휘를 DB 가 강제한다 (FIX-33 이 가르친 것)
-- ══════════════════════════════════════════════════════════════════════════
--
-- `reviews.status` 와 `review_reports.status`·`reason_code` 에 CHECK 이 **하나도
-- 없었다.** 어휘는 코드에만 있고 표는 오타를 그대로 저장한다 — 저장은 성공하고
-- 화면만 그 행을 못 읽는다.
--
-- **허용 값을 나열한다.** "비공개가 아니면 공개" 같은 부정형으로 쓰면 값이 늘 때마다
-- 뜻이 조용히 바뀐다(S8-03 이 물린 자리).
alter table public.reviews drop constraint if exists reviews_status_vocab;
alter table public.reviews
  add constraint reviews_status_vocab
  check (status = any (array['published', 'hidden']));

-- ── 비공개에는 사유와 처리자가 있어야 한다 (S8-04·S8-10 과 같은 규칙) ────────
-- 후기를 내리는 것은 업체의 평판을 움직이는 일이라 **왜 내렸는지 답할 수 있어야
-- 한다.** F-A-13 은 '복구' 도 조치로 두므로 되돌릴 때 사유 칸을 비운다.
alter table public.reviews
  add column if not exists hidden_reason text,
  add column if not exists hidden_by uuid references auth.users (id) on delete set null,
  add column if not exists hidden_at timestamptz;

alter table public.reviews drop constraint if exists reviews_hidden_chk;
alter table public.reviews
  add constraint reviews_hidden_chk
  check (
    (status = 'published' and hidden_reason is null and hidden_by is null and hidden_at is null)
    or (
      status = 'hidden'
      and nullif(btrim(hidden_reason), '') is not null
      and hidden_by is not null
      and hidden_at is not null
    )
  );

comment on column public.reviews.hidden_reason is
  'S8-11. 비공개 사유. 빈 문자열은 사유가 아니다(CHECK). 화면·라우트·DB 세 층이 같은 말을 한다.';

-- ── 업체 답변 (F-V-11) ──────────────────────────────────────────────────────
-- §3.7 `reviews` 행에 답변 칸이 없어 추가한다(명세 반영 제안).
--
-- **별도 표를 만들지 않았다** — 후기 하나에 답변 하나이고, 표를 나누면 조인 없이는
-- 후기를 읽을 수 없게 된다. 답변이 여럿이 될 근거가 지금 없다.
--
-- **업체에 UPDATE 정책을 주지 않는다.** 컬럼 권한은 **역할 단위**라 업체에게 UPDATE 를
-- 열면 같은 `authenticated` 인 작성자에게도 같은 칸이 열린다. 그래서 답변은
-- 서비스롤 경유다(D-62). 이것이 이 표에서 권한을 칸으로 나눈 대가이며, 대가가
-- 더 싸다 — 반대로 하면 업체가 남의 후기 본문을 고칠 수 있다.
alter table public.reviews
  add column if not exists vendor_reply text,
  add column if not exists vendor_replied_at timestamptz,
  add column if not exists vendor_replied_by uuid references auth.users (id) on delete set null;

alter table public.reviews drop constraint if exists reviews_vendor_reply_chk;
alter table public.reviews
  add constraint reviews_vendor_reply_chk
  check (
    (vendor_reply is null and vendor_replied_at is null and vendor_replied_by is null)
    or (
      nullif(btrim(vendor_reply), '') is not null
      and vendor_replied_at is not null
      and vendor_replied_by is not null
    )
  );

comment on column public.reviews.vendor_reply is
  'S8-11 · F-V-11. 사업자 답변. 서비스롤로만 쓴다(D-62) — 컬럼 권한이 역할 단위라 업체에 UPDATE 를 열면 작성자에게도 같은 칸이 열린다.';

-- ── 신고 어휘·처리 (F-V-11 접수 → F-A-13 처리) ──────────────────────────────
-- 사유 코드의 어휘는 `lib/core/review/report.ts` 가 갖고 이 CHECK 이 강제한다.
-- **커뮤니티 신고(S7-17)의 어휘를 재사용하지 않았다** — 저쪽은 게시물이고 이쪽은
-- 거래 후기라 물어야 할 것이 다르다("거래 사실과 다르다" 는 커뮤니티에 없는 사유이고,
-- 후기에서는 이것이 가장 흔한 신고 사유다).
alter table public.review_reports drop constraint if exists review_reports_reason_vocab;
alter table public.review_reports
  add constraint review_reports_reason_vocab
  check (reason_code = any (array[
    'not_a_customer',   -- 거래 사실이 없다
    'false_statement',  -- 사실과 다른 내용
    'defamation',       -- 비방·욕설
    'privacy',          -- 개인정보 노출
    'irrelevant',       -- 거래와 무관한 내용
    'competitor'        -- 경쟁사 방해 의심
  ]));

alter table public.review_reports
  add column if not exists resolved_by uuid references auth.users (id) on delete set null,
  add column if not exists resolved_at timestamptz,
  add column if not exists resolution_note text;

-- **'거절' 도 사유를 요구한다**(S8-04 가 정한 것과 같다). 신고를 받아들이지 않은
-- 이유를 답할 수 없으면 업체 입장에서 그것은 처리가 아니라 무시다.
alter table public.review_reports drop constraint if exists review_reports_status_chk;
alter table public.review_reports
  add constraint review_reports_status_chk
  check (
    (status = 'open' and resolved_by is null and resolved_at is null and resolution_note is null)
    or (
      status = any (array['upheld', 'rejected'])
      and resolved_by is not null
      and resolved_at is not null
      and nullif(btrim(resolution_note), '') is not null
    )
  );

comment on column public.review_reports.status is
  'S8-11. open | upheld | rejected. 접수 시 open 고정(컬럼 권한이 강제) — 신고자가 자기 신고를 닫으면 운영자 큐에 뜨지 않는다(FIX-36 과 같은 모양).';

create index if not exists idx_review_reports_open
  on public.review_reports (created_at desc) where status = 'open';

-- ══════════════════════════════════════════════════════════════════════════
-- 4. 열람 정책
-- ══════════════════════════════════════════════════════════════════════════
--
-- 공개 조건에 **철회 여부를 더한다.** 기존 정책은 `status='published'` 만 보므로
-- 철회한 후기가 그대로 공개된다.
drop policy if exists reviews_select_public on public.reviews;
create policy reviews_select_public on public.reviews for select to anon, authenticated
  using (status = 'published' and retracted_at is null);

-- 철회는 **본인만** 할 수 있다. 칸은 권한이 열어 줬지만 "누구의 이름으로" 는
-- 정책이 정한다.
--
-- **`using` 이 이미 거둔 행과 내려간 행을 대상에서 뺀다.** `with check` 로는 이걸
-- 못 쓴다 — 그쪽은 바뀐 뒤의 행만 보므로 `retracted_at` 을 다시 null 로 만드는
-- 수정을 통과시킨다. 그러면 묘비를 본인이 지울 수 있고, 지울 수 있는 묘비는
-- 묘비가 아니다(D-23). 거둔 후기는 그대로 둔다.
drop policy if exists reviews_update on public.reviews;
create policy reviews_update on public.reviews for update to authenticated
  using (
    public.is_couple_member(couple_id)
    and status = 'published'
    and retracted_at is null
  )
  with check (
    public.is_couple_member(couple_id)
    and (retracted_by is null or retracted_by = auth.uid())
  );

-- ── 운영자 열람 (D-115) ─────────────────────────────────────────────────────
-- F-A-13 은 **행을 읽는 것이 목적**이다(비공개된 후기·철회된 후기·신고 내용).
-- 목적이 행이면 경계는 정책이지 집계 함수가 아니다(S8-02 가 정한 갈림길).
create policy reviews_select_operator on public.reviews for select to authenticated
  using (public.is_operator());

create policy review_reports_select_operator on public.review_reports for select to authenticated
  using (public.is_operator());

-- ══════════════════════════════════════════════════════════════════════════
-- 5. 몰아쓰기 임계는 **비워 둔다** (O-20 신설 · D-123 과 같은 규칙)
-- ══════════════════════════════════════════════════════════════════════════
--
-- F-A-13 은 '어뷰징 탐지 큐' 를 요구하지만 **무엇이 어뷰징인지 명세가 정해 주지
-- 않았다.** 신고와 '본문 없는 극단 점수' 는 세는 데 기준이 필요 없어 바로 돈다.
-- 남는 것이 '짧은 기간 몰아쓰기' 인데, 여기에는 **"얼마나 짧은 기간에 몇 건"** 이
-- 필요하고 그 숫자가 없다.
--
-- 그리고 이 도메인에서는 지어낸 숫자가 특히 위험하다 — 웨딩 준비는 홀·스드메·
-- 사진·본식영상을 몇 달 안에 한꺼번에 계약하는 일이라 **정상 사용자가 하루에 다섯
-- 건을 쓰는 것이 자연스럽다.** 임계를 대충 잡으면 큐가 곧 정상 사용자 목록이 되고,
-- 운영자는 그 목록을 보며 무고한 후기를 내리게 된다.
--
-- **값이 없으면 그 신호는 세지 않고 화면이 그 사실을 적는다.**
insert into public.app_settings (key, value_json, description)
values
  (
    'reviews.burst_window_hours',
    '{"unit": "hours", "value": null, "status": "undecided", "openIssue": "O-20"}'::jsonb,
    'TODO: O-20 확정 후 입력 — 몰아쓰기 판정 창(시간). 이 시간 안에 같은 커플이 burst_min_count 건 이상 쓰면 큐에 올린다. 웨딩 준비는 여러 계약이 몰리는 일이라 정상 사용자를 큐에 올리기 쉽다. 값이 없으면 이 신호를 세지 않는다.'
  ),
  (
    'reviews.burst_min_count',
    '{"unit": "count", "value": null, "status": "undecided", "openIssue": "O-20"}'::jsonb,
    'TODO: O-20 확정 후 입력 — 몰아쓰기 판정 건수. 2 이상이어야 뜻이 있다(1건은 모든 후기를 뜻한다). 값이 없으면 이 신호를 세지 않는다.'
  )
on conflict (key) do nothing;

-- ══════════════════════════════════════════════════════════════════════════
-- 6. 새 표를 만들지 않았다
-- ══════════════════════════════════════════════════════════════════════════
--
-- **어뷰징 탐지 큐를 저장하지 않는다**(D-124 와 같은 판단). 신호는 `reviews` 와
-- `review_reports` 에서 **세어지는 값**이고, 저장하면 후기가 철회되거나 신고가
-- 처리될 때 큐가 낡는다. 화면은 볼 때마다 같은 순수 함수로 다시 센다.
--
-- **평균 평점도 컬럼으로 두지 않는다.** `vendors` 에 캐시 칸을 만들면 후기 하나가
-- 바뀔 때마다 두 곳이 갈릴 수 있고, 갈렸을 때 어느 쪽이 맞는지 화면으로는 모른다.
-- 표본이 수십 건 규모라 셀 때마다 세는 편이 옳다.
--
-- **검증 상태도 컬럼이 아니다.** 후기가 검증됐다는 것은 `bookings` 에 확정된 예약이
-- 있다는 뜻이고, 그 사실은 `reviews_insert` 정책이 이미 강제한다. 같은 사실을 칸에
-- 또 적으면 그 칸이 진실인 척하게 된다(FIX-38 이 타입에서 물린 것과 같은 결).
