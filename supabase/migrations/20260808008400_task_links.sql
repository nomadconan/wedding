-- =============================================================================
-- 준비 항목 → 커뮤니티 다리의 어휘 (C-4c)
--   근거: docs/07_개발명세서.md §2.1 F-C-39 · §3.2 「카테고리 어휘」 · D-233
--   코드: lib/core/task/links.ts (다리) · lib/core/category/axes.ts (매핑의 단일 진실)
--
-- ── 무엇을 하는가 ───────────────────────────────────────────────────────────
-- `community_posts.category` 에 **준비 축 어휘 CHECK** 을 건다. 그게 전부다.
-- 새 표도 새 칸도 만들지 않는다.
--
-- ── 왜 지금인가 — 쓸 수 있는데 아무도 안 보고 있었다 ────────────────────────
-- 이 칸은 0038 이 만들 때부터 **`text` 자유 문자열**이었고, 같은 파일이
--
--     grant update (title, body, category, status) on public.community_posts to authenticated;
--
-- 로 **작성자에게 쓰기를 열어 뒀다.** 즉 **아무 문자열이나 들어갈 수 있는 칸이
-- 이미 열려 있었다.** 그런데 코드 어디에서도 읽지도 쓰지도 않아(C-4c 착수 중 실측:
-- 참조 0건) 아무도 그 사실을 몰랐다 — **쓰기가 열린 칸에 CHECK 이 없는 것**은
-- FIX-75(파는 축)·FIX-82(준비 축 본체)와 **같은 모양**이며 세 번째다.
--
-- C-4c 가 이 칸을 **쓰기 시작하므로** 여기서 닫는다. 어휘를 정하지 않고 쓰기
-- 시작하면 오타 하나가 새 카테고리를 만들고, **화면은 그 코드를 라벨 대신 날것으로
-- 그린다**(FIX-82 가 실제로 그랬다).
--
-- ── 왜 준비 축인가 ─────────────────────────────────────────────────────────
-- 커뮤니티 글은 **"무엇을 준비하며 겪은 일"** 이지 "무엇을 파는가" 가 아니다.
-- `board_type`(free·experience·qna)은 **글의 성격**이고 이 칸은 **준비 단계**라
-- 서로를 대신하지 못한다. `content_posts.prep_category`(C-2a)와 **같은 어휘·같은
-- 판정 함수**를 쓴다 — 가이드와 커뮤니티가 다른 어휘를 쓰면 같은 태스크에서
-- 나가는 두 다리가 서로 다른 곳을 가리킨다.
--
-- ── 기존 행 ────────────────────────────────────────────────────────────────
-- `null` 을 허용한다. **`null` 은 "아직 안 했다" 가 아니라 "따로 지정하지 않았다"** 다
-- (0075 가 같은 말을 적었다) — 카테고리 없는 잡담은 정상이고, 그 글은 준비 항목
-- 다리에 안 잡힐 뿐 커뮤니티 목록에는 그대로 뜬다.
-- `not valid` → `validate` 로 **어긋난 행이 있으면 여기서 멈추게** 한다.
--
-- ── 되돌리기 ────────────────────────────────────────────────────────────────
--   alter table public.community_posts drop constraint if exists community_posts_prep_category_vocab;
--   drop index if exists idx_community_posts_category;
-- =============================================================================

-- ── 1. 어휘 CHECK ───────────────────────────────────────────────────────────
-- `is_prep_category()` 는 0075 가 만들고 0081(C-4a)이 아홉으로 넓혔다. 사본을
-- 만들지 않는다 — 어휘가 두 벌이면 어긋나고, 어긋나면 조용하다.
alter table public.community_posts
  drop constraint if exists community_posts_prep_category_vocab;

alter table public.community_posts
  add constraint community_posts_prep_category_vocab
  check (category is null or public.is_prep_category(category))
  not valid;

alter table public.community_posts
  validate constraint community_posts_prep_category_vocab;

comment on column public.community_posts.category is
  '준비 축 카테고리(C-4c). null 은 "따로 지정하지 않았다" 이며 정상이다. '
  '어휘는 public.is_prep_category() 가 판정하고 lib/core/schedule/templates.ts 의 '
  'TASK_CATEGORIES 와 같아야 한다 — db:rls 가 코드와 DB 를 대조한다.';

-- ── 2. 다리가 쓰는 색인 ─────────────────────────────────────────────────────
-- 준비 항목 다리는 "이 카테고리의 공개 글" 을 세고 목록으로 보낸다. 부분 색인이라
-- 숨은 글·삭제된 글은 애초에 들어오지 않는다.
create index if not exists idx_community_posts_category
  on public.community_posts (category, created_at desc)
  where status = 'published' and category is not null;

-- ── 3. 가이드 색인 ──────────────────────────────────────────────────────────
-- `content_posts.prep_category` 는 0075 가 만들었고 **색인이 없었다.** 다리가 이
-- 칸으로 매번 거르므로 붙인다. 발행된 글만 본다.
create index if not exists idx_content_posts_prep_category
  on public.content_posts (prep_category, published_at desc)
  where published_at is not null and prep_category is not null;
