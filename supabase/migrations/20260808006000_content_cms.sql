-- 0060 콘텐츠 CMS (S8-08 · F-A-05 · §6.4 `/admin/cms` · §4.3 `CRUD /api/admin/content`)
--
-- ══════════════════════════════════════════════════════════════════════════
-- 1. 표를 만지기 전에 권한부터 봤다 (FIX-30·35·36·37·39·41 이 가르친 것)
-- ══════════════════════════════════════════════════════════════════════════
--
-- 일곱 번째다. `content_posts` 는 **anon 이 읽는 유일한 콘텐츠 표**이고, 지금
-- `authenticated` 에 **INSERT·UPDATE·DELETE 가 전부 열려 있다.**
--
-- 정책이 `content_posts_select_public` 하나뿐이라 오늘은 RLS 가 쓰기를 막는다.
-- 그러나 이 표에 쓰기 정책이 생기는 날 — 그리고 CMS 를 만드는 태스크가 바로 그런
-- 정책을 붙이고 싶어지는 자리다 — **아무 로그인 사용자나 우리 이름으로 글을 발행**할
-- 수 있게 된다. 그 글은 `/guides/<slug>` 로 색인되고 JSON-LD 까지 달고 나간다.
--
-- **그래서 쓰기 정책을 아예 만들지 않는다.** CMS 의 쓰기는 전부 서비스롤 경유이고
-- (D-62) 권한은 여기서 걷어 둔다 — 정책과 권한 둘 다 닫혀 있어야 한 쪽을 잘못
-- 고치는 날에도 남는다.
revoke insert, update, delete on public.content_posts from anon, authenticated;

-- ══════════════════════════════════════════════════════════════════════════
-- 2. 발행 상태를 저장하지 않는다
-- ══════════════════════════════════════════════════════════════════════════
--
-- 초안·예약·발행은 **`published_at` 하나에서 계산된다**: null 이면 초안,
-- 미래면 예약, 과거면 발행. `status` 컬럼을 따로 두면 두 값이 갈리고, 갈렸을 때
-- **어느 쪽이 공개 여부의 진실인지 화면으로는 알 수 없다** — 공개 판정은 이미
-- `content_posts_select_public`(`published_at <= now()`)이 하고 있고 그것이 유일한
-- 경계다(0005 [58]). 계산 가능한 값을 저장하지 않는다(D-124).
--
-- **예약 발행에 배치가 필요 없다는 뜻이기도 하다.** 시각이 지나면 정책이 스스로
-- 참이 된다 — 배치가 상태를 갈아 주는 구조였다면 배치가 멈춘 날 글이 안 나간다.

-- ── 제목은 언제나 비어 있으면 안 된다 ──────────────────────────────────────
-- 기존 CHECK(`content_posts_published_body_chk`)은 **발행할 때만** 제목·본문을
-- 요구한다. 초안은 본문이 없어도 되지만 **제목까지 비면 목록에서 그 글을 다시 찾을
-- 수 없다** — 편집기에서 만든 빈 행이 영원히 남는다.
alter table public.content_posts drop constraint if exists content_posts_title_chk;
alter table public.content_posts
  add constraint content_posts_title_chk
  check (length(btrim(title)) > 0);

comment on column public.content_posts.published_at is
  'S8-08. null=초안 · 미래=예약 · 과거=발행. 상태 컬럼을 따로 두지 않는다(계산된다). 공개 판정은 content_posts_select_public 하나이며 예약은 시각이 지나면 스스로 참이 된다 — 배치가 없다.';

-- ══════════════════════════════════════════════════════════════════════════
-- 3. 운영자 열람 — **행이 목적이라 정책이다** (D-115)
-- ══════════════════════════════════════════════════════════════════════════
--
-- 편집하려면 **미발행 글이 보여야 한다.** 공개 정책은 발행된 것만 보여주므로
-- 운영자는 자기가 쓴 초안조차 못 읽는 상태였다.
--
-- **FIX-41 을 방금 겪었으므로 한 번 더 확인한다** — 이 정책은 다른 표의 RLS 에
-- 기대지 않는다(`is_operator()` 하나로 자기 조건을 스스로 말한다). 그리고 이 표를
-- 부모로 삼는 자식 표는 아래 `content_revisions` 뿐이며, 그쪽도 소유자 조건을
-- 직접 적는다.
create policy content_posts_select_operator on public.content_posts for select to authenticated
  using (public.is_operator());

-- ══════════════════════════════════════════════════════════════════════════
-- 4. 리비전 — 덮어쓴 판본은 계산할 수 없다
-- ══════════════════════════════════════════════════════════════════════════
--
-- F-A-05 가 '리비전 관리' 를 요구한다. 발행 상태와 달리 **이것은 저장해야 한다** —
-- `body_md` 를 덮어쓰면 이전 판본은 어디에도 남지 않는다.
--
-- **왜 필요한가.** 공개된 글은 검색에 색인되고 사용자가 그것을 근거로 판단한다.
-- "그때 이 가이드에 뭐라고 적혀 있었나" 는 나중에 실제로 묻는 질문이고(D-23 이
-- 증적에서 정한 것과 같은 이유), 지금은 답할 방법이 없다.
create table public.content_revisions (
  id          uuid primary key default gen_random_uuid(),
  post_id     uuid not null references public.content_posts (id) on delete cascade,
  -- 몇 번째 판본인가. 글마다 1부터 센다.
  revision    integer not null check (revision >= 1),
  title       text not null,
  body_md     text,
  seo_json    jsonb not null default '{}'::jsonb,
  -- 이 판본이 저장될 때 글이 어떤 공개 상태였나. **문자열이 아니라 시각 그대로** 남긴다
  -- — 상태로 접으면 '예약' 이 언제로 잡혀 있었는지가 사라진다.
  published_at timestamptz,
  editor_id   uuid references auth.users (id) on delete set null,
  /** 무엇을 왜 고쳤나. **필수다** — 사유 없는 판본은 목록에서 서로 구분되지 않는다. */
  note        text not null,
  created_at  timestamptz not null default now(),
  unique (post_id, revision)
);

alter table public.content_revisions drop constraint if exists content_revisions_note_chk;
alter table public.content_revisions
  add constraint content_revisions_note_chk
  check (nullif(btrim(note), '') is not null);

alter table public.content_revisions drop constraint if exists content_revisions_seo_object_chk;
alter table public.content_revisions
  add constraint content_revisions_seo_object_chk
  check (jsonb_typeof(seo_json) = 'object');

create index if not exists idx_content_revisions_post
  on public.content_revisions (post_id, revision desc);

comment on table public.content_revisions is
  'S8-08 · F-A-05. 덮어쓴 판본은 계산할 수 없어 저장한다. on delete cascade 는 의도적이다 — 글 자체를 지우는 경로가 없으므로(아래 5번) 이 cascade 가 실제로 도는 길은 없고, 있다면 그때는 글이 존재한 적 없는 것으로 만드는 것이 맞다.';

alter table public.content_revisions enable row level security;

-- **운영자만 읽는다.** 리비전에는 미발행 초안의 본문이 들어 있다 — 발행 전 문안이
-- 공개되면 발행 시점을 정하는 의미가 없다.
create policy content_revisions_select_operator on public.content_revisions for select to authenticated
  using (public.is_operator());

-- 쓰기 정책을 두지 않는다 — **기록은 서비스롤 경유**(D-62)다. 운영자에게 INSERT 를
-- 주면 `editor_id` 를 남의 것으로 적을 수 있고, 판본 기록의 요점이 "누가 고쳤나" 다.
revoke insert, update, delete on public.content_revisions from anon, authenticated;
revoke select on public.content_revisions from anon;
revoke truncate on public.content_revisions from anon, authenticated;

-- ══════════════════════════════════════════════════════════════════════════
-- 5. 글을 지우는 경로를 만들지 않았다
-- ══════════════════════════════════════════════════════════════════════════
--
-- 발행된 글의 URL 은 색인되고 밖에서 링크된다. 행을 지우면 그 링크가 전부 404 가
-- 되고, **되돌릴 방법이 없다**(슬러그를 다시 만들어도 리비전이 없으면 본문을 복원할
-- 수 없다).
--
-- 그래서 '내리기' 는 **`published_at = null`** 이다 — 공개 정책이 즉시 가리고
-- 행과 리비전은 남는다. D-129 가 후기에서 정한 것과 같은 판단이며, 다시 올릴 때
-- 같은 슬러그로 돌아온다.
--
-- DELETE 권한은 1번에서 이미 걷었고 정책도 없다. **서비스롤에는 남아 있다** —
-- 스팸·법적 요구로 실제 삭제가 필요한 날이 있을 수 있고, 그때는 사람이 판단해
-- 서버에서 한다. 앱에는 그 버튼이 없다.

-- ══════════════════════════════════════════════════════════════════════════
-- 6. 새 표 마무리 감사
-- ══════════════════════════════════════════════════════════════════════════
--
-- 0053 이 전역으로 TRUNCATE 를 걷고 default privileges 까지 덮어 두었지만 매번 다시
-- 센다 — 기본값에 기대는 검사는 기본값이 바뀌는 날 조용히 무력해진다(FIX-35).
revoke truncate on public.content_posts from anon, authenticated;
