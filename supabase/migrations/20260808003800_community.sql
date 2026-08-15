-- =============================================================================
-- 0038 · 커뮤니티 (S7-14)
-- 근거: docs/07_개발명세서.md §2.1 F-C-32·33·34, §2.2 F-V-18, §2.3 F-A-18,
--       §3.7 커뮤니티 6표 + NOTE(수의 저장·계산), §3.9 RLS, D-03 · D-23 · D-26
-- =============================================================================
-- T-00f 가 D-26 을 명세에 넣으며 구현을 S7-14~S7-17 에 배정했고, 이 파일이 그 첫
-- 조각이다 — **스키마·RLS·불변식까지**이며 화면은 S7-15(소비자)·S7-16(업체)·
-- S7-17(운영자)이다. 도메인 판정은 `lib/core/community` 가 갖는다.
--
-- **왜 마이그레이션을 앞세우는가.** 세 면이 같은 표를 쓴다. 소비자 화면과 모더레이션이
-- 같은 판정을 두 벌 만들면 한쪽만 고쳐지는 날이 온다(S5-11·S7-14 가 같은 모양).
--
-- 이 파일이 정한 것 — 판단이 필요했던 지점과 근거
--
--  1. **업체 언급은 태그로만 한다**(D-26). 자유 텍스트 업체명을 막는 장치는 스키마가
--     아니라 **본문 필터**(`lib/core/community`)다 — 본문은 자유 텍스트일 수밖에 없기
--     때문이다. 그래서 스키마가 하는 일은 **태그를 유일한 구조적 언급 수단으로 만드는
--     것**이다: `community_post_tags` 가 `vendors.id` 를 참조하므로 등록되지 않은
--     업체는 태그될 수 없고, 태그된 글은 업체 화면(F-V-18)에서 조회된다.
--     **완전 차단을 약속하지 않는다** — 필터는 첫 층이고 둘째가 신고·모더레이션,
--     셋째가 라벨링이다.
--
--  2. **`verified_purchase` 가 참이어도 검증 후기가 아니다.** 이 값은 **작성 시점의
--     거래 이력 유무 스냅샷**이며(D-16 스냅샷 원칙), 검증 후기는 `reviews`(F-C-17 ·
--     S8-11)가 따로 갖는다. 컬럼 주석에 그 사실을 박아 두어 화면이 '미검증 경험담'
--     라벨을 떼는 근거로 쓰이지 않게 한다.
--
--  3. **좋아요는 행이 권위, 컬럼은 캐시다**(§3.7 NOTE). `community_likes` 행이 진실이고
--     `like_count` 는 **같은 트랜잭션의 트리거**가 유지한다. 트리거는 시계가 아니라
--     행 변경에 반응하므로 늦을 수 없다 — 0027·0032 가 "계산되는 상태를 저장하지
--     마라" 고 한 규칙과 어긋나지 않는 이유가 여기 있다. 어긋나면 행으로 재계산한다.
--
--  4. **조회수는 저장한다. 셀 원본을 만들지 않기로 했기 때문이다.** 조회를 행으로
--     남기면 "누가 무엇을 읽었는가" 가 쌓이는데 그것은 증적이 아니라 **감시**이고
--     §7.3 최소화 원칙에 어긋난다. 대신 **정확성을 약속하지 않는다**(근사치).
--     증가는 `bump_post_view` 하나로만 하며 임의 UPDATE 는 권한에서 막는다.
--
--  5. **삭제는 행 제거가 아니라 묘비다**(D-23). 대댓글이 달린 댓글을 지우면 대화가
--     끊기고, 신고된 글을 지우면 신고 처리의 근거가 사라진다. `status` 로 가리고
--     본문은 보존한다(`chat_messages.retracted_at` 과 같은 방식).
--
--  6. **신고는 신고자와 운영자만 본다.** 피신고자에게 열면 보복이 신고를 막는다.
--     같은 사람이 같은 대상을 두 번 신고하지 않는다(부분 유니크) — 중복 신고가
--     큐를 채우면 진짜 신고가 묻힌다.
--
--  7. **모더레이션은 서비스롤 경유다.** 운영자에게 UPDATE 정책을 주면 그 권한이
--     클라이언트 번들이 닿는 자리에 놓인다. 비공개·삭제는 **되돌릴 수 없는 권한**이라
--     서버를 지난다(S7-17 이 화면을 만든다).
--
--  8. **조회수·좋아요를 랭킹에 쓰지 않는다.** 스키마가 그것을 강제할 수는 없으므로
--     주석과 `lib/core/community` 의 정렬 함수가 지킨다. 둘 다 조작 비용이 낮아
--     순위에 넣으면 어뷰징 표면이 되고, "돈이 평가에 개입하지 않는다"(D-03)를
--     다른 방식으로 무너뜨린다.
-- =============================================================================

-- **작성자 칸은 `auth.uid()` 를 기본값으로 둔다.** 정책(`WITH CHECK`)이 경계이지만,
-- 기본값이 있으면 호출부가 그 칸을 **잊을 수 없다** — 잊으면 NOT NULL 이 아니라
-- "남의 이름으로 쓰려 했다" 는 정책 거절이 나고, 그 오류는 원인을 가리킨다.
-- 서비스롤은 언제나 값을 명시하므로 영향을 받지 않는다.

-- =============================================================================
-- 1) community_posts — 게시물
-- =============================================================================
create table if not exists public.community_posts (
  id          uuid primary key default gen_random_uuid(),
  author_id   uuid not null default auth.uid() references auth.users (id) on delete cascade,
  board_type  text not null,
  category    text,
  title       text not null,
  body        text not null,
  status      text not null default 'published',
  /** 근사치다. 셀 원본(조회 로그)을 만들지 않기로 한 결과다(근거 4). */
  view_count  integer not null default 0,
  /** `community_likes` 행의 **캐시**. 권위 있는 값은 행이다(근거 3). */
  like_count  integer not null default 0,
  /** 운영자만 세운다. 정책이 아니라 **서비스롤 경유**로 바뀐다(근거 7). */
  is_pinned   boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint community_posts_board_values
    check (board_type in ('free', 'experience', 'qna')),
  constraint community_posts_status_values
    check (status in ('published', 'hidden', 'deleted')),
  constraint community_posts_title_present check (nullif(btrim(title), '') is not null),
  constraint community_posts_body_present check (nullif(btrim(body), '') is not null),
  constraint community_posts_counts_nonneg check (view_count >= 0 and like_count >= 0)
);

comment on table public.community_posts is
  '커뮤니티 게시물(F-C-32 · D-26). 삭제는 행 제거가 아니라 status 묘비다 — 신고된 글을 지우면 신고 처리의 근거가 사라진다.';
comment on column public.community_posts.view_count is
  '근사치다. 조회를 행으로 남기면 "누가 무엇을 읽었는가" 가 쌓이고 그것은 증적이 아니라 감시다(§7.3). 정확성을 약속하지 않으며 랭킹에 쓰지 않는다.';
comment on column public.community_posts.like_count is
  'community_likes 행의 캐시다. 권위는 행이며 트리거가 같은 트랜잭션에서 유지한다 — 어긋나면 행으로 재계산한다. **랭킹 가중에 쓰지 않는다**(조작 비용이 낮다 · D-03).';
comment on column public.community_posts.is_pinned is
  '운영자 고정. 정책으로 열지 않고 서비스롤 경유로만 세운다 — 고정은 노출을 정하는 힘이라 클라이언트에 두지 않는다.';

create index if not exists idx_community_posts_board
  on public.community_posts (board_type, created_at desc)
  where status = 'published';
create index if not exists idx_community_posts_author on public.community_posts (author_id);
create index if not exists idx_community_posts_status on public.community_posts (status);

select public.attach_set_updated_at('community_posts');

-- =============================================================================
-- 2) community_comments — 댓글·대댓글
-- =============================================================================
create table if not exists public.community_comments (
  id         uuid primary key default gen_random_uuid(),
  post_id    uuid not null references public.community_posts (id) on delete cascade,
  author_id  uuid not null default auth.uid() references auth.users (id) on delete cascade,
  /** null 이면 최상위 댓글이다. */
  parent_id  uuid references public.community_comments (id) on delete cascade,
  body       text not null,
  status     text not null default 'published',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint community_comments_status_values
    check (status in ('published', 'hidden', 'deleted')),
  constraint community_comments_body_present check (nullif(btrim(body), '') is not null),
  constraint community_comments_not_self check (parent_id is null or parent_id <> id)
);

comment on table public.community_comments is
  '댓글·대댓글. 삭제는 status 묘비다 — 대댓글이 달린 댓글을 지우면 대화가 끊긴다(chat_messages 회수와 같은 방식 · D-23).';

create index if not exists idx_community_comments_post
  on public.community_comments (post_id, created_at);
create index if not exists idx_community_comments_parent on public.community_comments (parent_id);
create index if not exists idx_community_comments_author on public.community_comments (author_id);

select public.attach_set_updated_at('community_comments');

-- **대댓글의 깊이를 2단으로 제한한다.** 무한 중첩은 375px 화면에서 읽을 수 없고,
-- 깊이를 화면이 자르면 데이터에는 남아 있는데 보이지 않는 댓글이 생긴다.
create or replace function public.community_comment_depth_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_parent_parent uuid;
  v_parent_post   uuid;
begin
  if new.parent_id is null then
    return new;
  end if;

  select parent_id, post_id into v_parent_parent, v_parent_post
    from public.community_comments where id = new.parent_id;

  if v_parent_post is null then
    raise exception '상위 댓글을 찾을 수 없습니다.' using errcode = 'foreign_key_violation';
  end if;

  -- 다른 글의 댓글에 대댓글을 달 수 없다. 외래키만으로는 막히지 않는다.
  if v_parent_post <> new.post_id then
    raise exception '다른 글의 댓글에는 답글을 달 수 없습니다.'
      using errcode = 'check_violation';
  end if;

  if v_parent_parent is not null then
    raise exception '답글의 답글은 달 수 없습니다.' using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

comment on function public.community_comment_depth_guard() is
  '대댓글 2단 제한 + 같은 글 소속 강제. 깊이를 화면이 자르면 데이터에는 남아 있는데 보이지 않는 댓글이 생긴다.';

drop trigger if exists trg_community_comment_depth on public.community_comments;
create trigger trg_community_comment_depth
  before insert or update of parent_id on public.community_comments
  for each row execute function public.community_comment_depth_guard();

-- =============================================================================
-- 3) community_post_tags — 업체 태그 (F-C-33)
-- =============================================================================
create table if not exists public.community_post_tags (
  id                uuid primary key default gen_random_uuid(),
  post_id           uuid not null references public.community_posts (id) on delete cascade,
  vendor_id         uuid not null references public.vendors (id) on delete cascade,
  tagged_by         uuid not null default auth.uid() references auth.users (id) on delete cascade,
  /**
   * **작성 시점의 거래 이력 유무 스냅샷**이다(D-16 과 같은 원칙).
   * **참이어도 검증 후기가 아니다** — 검증 후기는 reviews(F-C-17 · S8-11)가 갖는다.
   */
  verified_purchase boolean not null default false,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

comment on table public.community_post_tags is
  '업체 태그(F-C-33 · D-26). **자유 텍스트 업체명 대신 이 표가 유일한 구조적 언급 수단**이다 — 등록된 업체만 태그될 수 있다. 본문의 자유 텍스트 업체명은 lib/core/community 의 필터가 잡으며, 그것은 첫 층일 뿐이고 완전 차단을 약속하지 않는다.';
comment on column public.community_post_tags.verified_purchase is
  '작성 시점의 거래 이력 유무 스냅샷. **참이어도 검증 후기(reviews)가 아니다** — 화면은 미검증 경험담 라벨을 유지한다.';

-- 한 글에 같은 업체를 두 번 태그하지 않는다(§3.7).
create unique index if not exists uq_community_post_tags
  on public.community_post_tags (post_id, vendor_id);
create index if not exists idx_community_post_tags_vendor
  on public.community_post_tags (vendor_id, created_at desc);

select public.attach_set_updated_at('community_post_tags');

-- **승인된 업체만 태그된다.** 심사 중·거절된 업체를 태그하면 그 업체의 화면(F-V-18)에
-- 닿지 않는 글이 생기고, 존재하지 않아야 할 업체가 커뮤니티에서 언급된다.
create or replace function public.community_tag_vendor_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not exists (
    select 1 from public.vendors v where v.id = new.vendor_id and v.status = 'active'
  ) then
    raise exception '승인된 업체만 태그할 수 있습니다.' using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_community_tag_vendor on public.community_post_tags;
create trigger trg_community_tag_vendor
  before insert on public.community_post_tags
  for each row execute function public.community_tag_vendor_guard();

-- =============================================================================
-- 4) community_likes — 좋아요 (행이 권위, 컬럼이 캐시)
-- =============================================================================
create table if not exists public.community_likes (
  id         uuid primary key default gen_random_uuid(),
  post_id    uuid not null references public.community_posts (id) on delete cascade,
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.community_likes is
  '좋아요. **행이 권위 있는 값**이고 community_posts.like_count 는 캐시다(§3.7 NOTE).';

-- 한 사람이 두 번 누르지 않는다.
create unique index if not exists uq_community_likes on public.community_likes (post_id, user_id);
create index if not exists idx_community_likes_user on public.community_likes (user_id);

select public.attach_set_updated_at('community_likes');

-- 캐시를 **같은 트랜잭션에서** 맞춘다. 배치가 아니므로 늦을 수 없다.
create or replace function public.sync_post_like_count()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    update public.community_posts
       set like_count = like_count + 1
     where id = new.post_id;

    return new;
  end if;

  update public.community_posts
     set like_count = greatest(0, like_count - 1)
   where id = old.post_id;

  return old;
end;
$$;

comment on function public.sync_post_like_count() is
  '좋아요 캐시 유지. 진실은 community_likes 행이며 이 함수는 사본을 맞춘다 — 어긋나면 행으로 재계산한다(recount_post_likes).';

drop trigger if exists trg_community_likes_count on public.community_likes;
create trigger trg_community_likes_count
  after insert or delete on public.community_likes
  for each row execute function public.sync_post_like_count();

-- 캐시가 어긋났을 때 **행으로 되돌린다.** 진실이 어느 쪽인지 코드로 못박아 둔다.
create or replace function public.recount_post_likes(p_post_id uuid)
returns integer language plpgsql security definer set search_path = public as $$
declare
  v_count integer;
begin
  select count(*) into v_count from public.community_likes where post_id = p_post_id;

  update public.community_posts set like_count = v_count where id = p_post_id;

  return v_count;
end;
$$;

comment on function public.recount_post_likes(uuid) is
  '좋아요 캐시를 행으로 재계산한다. 운영·점검용이며 진실이 행이라는 사실을 코드로 남긴다.';

-- =============================================================================
-- 5) community_scraps — 스크랩 (본인만)
-- =============================================================================
create table if not exists public.community_scraps (
  id         uuid primary key default gen_random_uuid(),
  post_id    uuid not null references public.community_posts (id) on delete cascade,
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.community_scraps is
  '스크랩. **본인만 조회한다** — 누가 무엇을 모아 두는지는 남에게 보일 정보가 아니다(§3.7).';

create unique index if not exists uq_community_scraps on public.community_scraps (post_id, user_id);
create index if not exists idx_community_scraps_user
  on public.community_scraps (user_id, created_at desc);

select public.attach_set_updated_at('community_scraps');

-- =============================================================================
-- 6) community_reports — 신고 (F-C-34 · F-A-18)
-- =============================================================================
create table if not exists public.community_reports (
  id          uuid primary key default gen_random_uuid(),
  target_type text not null,
  target_id   uuid not null,
  reporter_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  reason_code text not null,
  status      text not null default 'open',
  /** 처리 사유. **필수다** — 사유 없는 비공개·삭제는 나중에 설명할 수 없다(F-A-18). */
  resolution  text,
  resolved_by uuid references auth.users (id) on delete set null,
  resolved_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint community_reports_target_values check (target_type in ('post', 'comment')),
  constraint community_reports_status_values
    check (status in ('open', 'reviewing', 'resolved', 'rejected')),
  -- 사유 코드는 **집합으로 제한한다.** 자유 텍스트면 통계도 SLA 판정도 설 수 없다.
  constraint community_reports_reason_values
    check (
      reason_code in (
        'spam',
        'abuse',
        'commercial',
        'personal_info',
        'false_info',
        'other'
      )
    ),
  -- **끝난 신고에는 사유가 있어야 한다.** 되돌릴 수 없는 처리라 근거를 강제한다.
  constraint community_reports_resolution_shape
    check (
      status in ('open', 'reviewing')
      or (
        nullif(btrim(resolution), '') is not null
        and resolved_by is not null
        and resolved_at is not null
      )
    )
);

comment on table public.community_reports is
  '신고(F-C-34 · F-A-18). **신고자와 운영자만** 본다 — 피신고자가 신고자를 알면 보복이 신고를 막는다. 처리에는 사유가 필수다(CHECK).';
comment on column public.community_reports.reason_code is
  '사유 코드 집합. 자유 텍스트면 통계도 SLA 판정도 설 수 없다. 기준·SLA 는 O-14 대기이며 값 집합만 먼저 고정한다.';

-- 같은 사람이 같은 대상을 두 번 신고하지 않는다. 중복이 큐를 채우면 진짜 신고가 묻힌다.
create unique index if not exists uq_community_reports_reporter
  on public.community_reports (target_type, target_id, reporter_id);
create index if not exists idx_community_reports_open
  on public.community_reports (created_at) where status in ('open', 'reviewing');

select public.attach_set_updated_at('community_reports');

-- =============================================================================
-- 7) 조회수 — 증가 경로를 하나로 좁힌다 (근거 4)
-- =============================================================================
create or replace function public.bump_post_view(p_post_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  -- 공개된 글만 센다. 숨겨진 글의 조회수를 올리면 그 수가 무엇을 뜻하는지 알 수 없다.
  update public.community_posts
     set view_count = view_count + 1
   where id = p_post_id and status = 'published';
end;
$$;

comment on function public.bump_post_view(uuid) is
  '조회수 증가. **유일한 증가 경로**이며 임의 UPDATE 는 권한에서 막는다 — 셀 원본이 없는 값이라 경로를 좁히는 것이 유일한 방어다.';

grant execute on function public.bump_post_view(uuid) to authenticated, anon;

-- =============================================================================
-- 8) RLS (§3.9)
-- =============================================================================
alter table public.community_posts enable row level security;
alter table public.community_comments enable row level security;
alter table public.community_post_tags enable row level security;
alter table public.community_likes enable row level security;
alter table public.community_scraps enable row level security;
alter table public.community_reports enable row level security;

-- 정책이 자기 표를 다시 조회하면 무한 재귀가 된다. definer 로 고리를 끊는다(0032 방식).
create or replace function public.is_published_post(p_post_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.community_posts p
    where p.id = p_post_id and p.status = 'published'
  );
$$;

create or replace function public.owns_post(p_post_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.community_posts p
    where p.id = p_post_id and p.author_id = auth.uid()
  );
$$;

/** 이 업체 멤버가 태그된 글을 볼 수 있는가(F-V-18 — 자사 태그 글 조회). */
create or replace function public.is_tagged_vendor_member(p_post_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.community_post_tags t
    where t.post_id = p_post_id and public.is_vendor_member(t.vendor_id)
  );
$$;

comment on function public.is_tagged_vendor_member(uuid) is
  '자사가 태그된 글인가. 업체는 이 글을 **읽고 댓글로 답변만** 한다 — 본문을 고치는 권한은 어디에도 없다(F-V-18).';

-- ── community_posts ───────────────────────────────────────────────────────
-- **published 만 비로그인에게 열린다**(§3.9). SEO 와 열람이 그 위에 선다.
create policy community_posts_select_published on public.community_posts
  for select to anon, authenticated
  using (status = 'published');

-- 작성자는 자기 글을 상태와 무관하게 본다 — 운영자가 가린 글을 본인은 볼 수 있어야
-- "왜 안 보이나" 를 물을 수 있다.
create policy community_posts_select_author on public.community_posts
  for select to authenticated
  using (author_id = auth.uid());

create policy community_posts_select_operator on public.community_posts
  for select to authenticated
  using (public.is_operator());

create policy community_posts_insert on public.community_posts
  for insert to authenticated
  with check (author_id = auth.uid());

-- **작성자만 수정한다.** 상태를 스스로 바꿀 수 있으나 그것은 `deleted`(자기 삭제)까지이며,
-- `hidden`(운영자 비공개)으로 옮기는 것은 트리거가 막는다.
create policy community_posts_update_author on public.community_posts
  for update to authenticated
  using (author_id = auth.uid())
  with check (author_id = auth.uid());

comment on policy community_posts_update_author on public.community_posts is
  '작성자만 수정한다. **DELETE 정책은 없다** — 삭제는 행 제거가 아니라 status 묘비이며, 행을 지우면 신고 처리의 근거가 사라진다(D-23).';

-- **운영자에게 UPDATE 정책을 주지 않는다**(근거 7). 비공개·삭제는 서비스롤 경유다.

-- **고칠 수 있는 칸을 권한으로 좁힌다.**
--
-- 정책은 "어느 행" 을 고를 뿐 "어떤 칸" 은 보지 않는다. 트리거로 값을 비교할 수도
-- 있지만, 그러면 **좋아요 캐시를 올리는 우리 트리거 자신이 그 검사에 걸린다**
-- (같은 세션의 `auth.uid()` 로 도는 탓이다 — 실제로 `db:rls` 가 그것을 잡아냈다).
-- 그래서 DB 가 원래 가진 수단인 **열 단위 GRANT** 로 좁힌다:
--   · `is_pinned` · `like_count` · `view_count` 는 authenticated 가 아예 못 고친다.
--   · SECURITY DEFINER 함수(트리거·`bump_post_view`)는 소유자 권한으로 돌아 지나간다.
-- 0005 의 일괄 GRANT 를 이 표에 한해 덜어 내는 방식이며, feature_flags 가 같은 자리에서
-- 같은 일을 한다(그쪽은 테이블 전체를 회수했다).
revoke update on public.community_posts from authenticated, anon;
grant update (title, body, category, status) on public.community_posts to authenticated;

-- 남은 하나 — **작성자가 스스로 `hidden` 으로 옮기는 것**은 값 비교라야 잡힌다.
-- `status` 는 작성자도 고쳐야 하는 칸이라(자기 삭제) 열 단위 GRANT 로는 갈리지 않는다.
create or replace function public.community_post_author_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- 서비스롤은 지나간다. 모더레이션이 그 경로다.
  if auth.uid() is null then
    return new;
  end if;

  if new.status = 'hidden' and old.status <> 'hidden' then
    raise exception '비공개 처리는 운영자만 할 수 있습니다.' using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

comment on function public.community_post_author_guard() is
  '작성자가 스스로 비공개로 옮기는 것을 막는다. 고정·집계는 열 단위 GRANT 가 막으므로 여기서 보지 않는다 — 값 비교로 막으면 좋아요 캐시 트리거 자신이 걸린다.';

drop trigger if exists trg_community_post_author_guard on public.community_posts;
create trigger trg_community_post_author_guard
  before update of status on public.community_posts
  for each row execute function public.community_post_author_guard();

-- ── community_comments ────────────────────────────────────────────────────
create policy community_comments_select_published on public.community_comments
  for select to anon, authenticated
  using (status = 'published' and public.is_published_post(post_id));

create policy community_comments_select_author on public.community_comments
  for select to authenticated
  using (author_id = auth.uid());

create policy community_comments_select_operator on public.community_comments
  for select to authenticated
  using (public.is_operator());

-- 답변하려면 글을 볼 수 있어야 하고, 업체는 자사 태그 글을 본다(F-V-18).
create policy community_comments_insert on public.community_comments
  for insert to authenticated
  with check (
    author_id = auth.uid()
    and (public.is_published_post(post_id) or public.is_tagged_vendor_member(post_id))
  );

create policy community_comments_update_author on public.community_comments
  for update to authenticated
  using (author_id = auth.uid())
  with check (author_id = auth.uid());

-- ── community_post_tags ───────────────────────────────────────────────────
create policy community_post_tags_select on public.community_post_tags
  for select to anon, authenticated
  using (public.is_published_post(post_id));

create policy community_post_tags_select_vendor on public.community_post_tags
  for select to authenticated
  using (public.is_vendor_member(vendor_id));

create policy community_post_tags_select_operator on public.community_post_tags
  for select to authenticated
  using (public.is_operator());

-- **글쓴이만 태그를 붙인다.** 남의 글에 업체를 태그하면 그 업체 화면에 엉뚱한 글이 뜬다.
create policy community_post_tags_insert on public.community_post_tags
  for insert to authenticated
  with check (tagged_by = auth.uid() and public.owns_post(post_id));

create policy community_post_tags_delete on public.community_post_tags
  for delete to authenticated
  using (public.owns_post(post_id));

comment on policy community_post_tags_select_vendor on public.community_post_tags is
  '업체는 자사 태그를 본다 — 글이 비공개로 내려가도 태그는 보인다. 답변할 글을 찾는 경로이기 때문이다(F-V-18).';

-- ── community_likes ───────────────────────────────────────────────────────
-- **본인 행만** 읽고 쓴다. 누가 눌렀는지는 남에게 보일 정보가 아니며, 총합은
-- like_count 가 이미 공개한다.
create policy community_likes_own on public.community_likes
  for select to authenticated
  using (user_id = auth.uid());

create policy community_likes_insert on public.community_likes
  for insert to authenticated
  with check (user_id = auth.uid() and public.is_published_post(post_id));

create policy community_likes_delete on public.community_likes
  for delete to authenticated
  using (user_id = auth.uid());

-- ── community_scraps ──────────────────────────────────────────────────────
create policy community_scraps_own on public.community_scraps
  for select to authenticated
  using (user_id = auth.uid());

create policy community_scraps_insert on public.community_scraps
  for insert to authenticated
  with check (user_id = auth.uid() and public.is_published_post(post_id));

create policy community_scraps_delete on public.community_scraps
  for delete to authenticated
  using (user_id = auth.uid());

-- ── community_reports ─────────────────────────────────────────────────────
create policy community_reports_select_reporter on public.community_reports
  for select to authenticated
  using (reporter_id = auth.uid());

create policy community_reports_select_operator on public.community_reports
  for select to authenticated
  using (public.is_operator());

create policy community_reports_insert on public.community_reports
  for insert to authenticated
  with check (reporter_id = auth.uid() and status = 'open');

comment on policy community_reports_insert on public.community_reports is
  '신고는 본인 이름으로만 접수한다. **처리는 정책으로 열지 않는다** — 운영자의 처리는 서비스롤 경유(S7-17)이며, 그래야 모더레이션 권한이 클라이언트 번들이 닿는 자리에 놓이지 않는다.';

-- 신고를 지우거나 고칠 수 없다. 처리 이력이 감사의 근거다(D-23).
revoke update, delete on public.community_reports from authenticated, anon;

-- 집계 컬럼을 직접 올리는 경로를 권한에서도 닫는다(0019·0032 가 쓴 방식).
revoke delete on public.community_posts from authenticated, anon;

-- =============================================================================
-- 9) 증적 열람 (D-23)
-- =============================================================================
create policy entity_events_select_community on public.entity_events
  for select to authenticated
  using (
    entity_type = 'community_post'
    and public.owns_post(entity_events.entity_id)
  );

-- =============================================================================
-- 10) 운영 파라미터 (§7.4 — 값을 코드에 박지 않는다)
-- =============================================================================
-- **기준·SLA 는 O-14 대기다.** 값을 지어내지 않고 키만 만들어 둔다 — 구조는 있고
-- 정책은 없다는 사실을 표가 들고 있게 한다(seed.sql 의 다른 미결 파라미터와 같다).
insert into public.app_settings (key, value_json, description)
values
  (
    'community.report_sla_hours',
    '{"value": null, "unit": "hours", "status": "undecided"}'::jsonb,
    'TODO: O-14 확정 후 입력 — 신고 처리 목표 시간. 값이 없으면 SLA 판정을 하지 않는다(지어낸 기한으로 운영자를 재촉하지 않는다).'
  ),
  (
    'community.post_daily_limit',
    '{"value": null, "unit": "posts", "status": "undecided"}'::jsonb,
    'TODO: O-14 확정 후 입력 — 1인 일일 작성 상한(어뷰징 방어). 값이 없으면 상한 판정을 하지 않는다.'
  )
on conflict (key) do nothing;

-- =============================================================================
-- 0038 산출 요약
-- =============================================================================
--   테이블 6 — community_posts · community_comments · community_post_tags ·
--              community_likes · community_scraps · community_reports
--   트리거 4 — 대댓글 깊이·소속 / 승인 업체 태그 / 좋아요 캐시 / 작성자 수정 경계
--   함수  6 — community_comment_depth_guard · community_tag_vendor_guard ·
--             sync_post_like_count · recount_post_likes · bump_post_view ·
--             community_post_author_guard
--   판정  3 — is_published_post · owns_post · is_tagged_vendor_member
--   정책 21 + 권한 회수 3 + 운영 파라미터 2
--
--   **화면은 없다.** S7-15(소비자) · S7-16(업체) · S7-17(운영자)이 만든다.
--   모더레이션(S7-17) 없이 커뮤니티를 열지 않는다 — 신고를 받고도 처리 경로가 없다.
-- =============================================================================
