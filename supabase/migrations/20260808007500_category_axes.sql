-- =============================================================================
-- 카테고리 두 축과 그 사이의 다리 (C-2a · D-206)
--   근거: docs/07_개발명세서.md §3.2 「카테고리 어휘」 · docs/DECISIONS.md D-206
--   코드: lib/core/category/axes.ts (매핑의 단일 진실 — 이 파일은 **어휘만** 든다)
--
-- ── 무엇을 하는가 ───────────────────────────────────────────────────────────
--  1. 어휘 판정 함수 둘 — `is_vendor_category()`(파는 축) · `is_prep_category()`(준비 축).
--     `is_budget_category()`(0045)와 **같은 모양**이다. 새 방식을 만들지 않았다.
--  2. 준비 축 → 파는 축 다리  : `task_templates.vendor_category` · `tasks.vendor_category`
--  3. 글 → 준비 축 다리        : `content_posts.prep_category`
--
-- ── `null` 이 무슨 뜻인지 못 박는다 ─────────────────────────────────────────
-- **`null` 은 "아직 안 했다" 가 아니라 "따로 지정하지 않았다" 다.**
--   · `vendor_category` 가 null 이면 → **준비 축 매핑이 답한다**(`PREP_TO_VENDOR`).
--     그 매핑이 다시 `sold` / `not_sold` 를 가르므로 **답이 없는 상태가 아니다.**
--   · 값이 있으면 → 그 태스크는 **그 카테고리 하나**를 가리킨다(예: 드레스 가봉 → dress).
--     준비 축이 `sdm` 한 칸으로 넷을 덮기 때문에 **행마다 좁힐 자리가 필요하다.**
-- 그래서 이 칸은 **계산 가능한 값의 저장이 아니다** — 매핑에서 유도할 수 없는
-- '이 태스크만의 더 좁은 지정' 이며, 없을 때 유도로 떨어진다(D-124 와 충돌하지 않는다).
--
-- ── 되돌리기 ────────────────────────────────────────────────────────────────
-- 되돌릴 수 있다. 붙이는 것이 전부 **nullable 컬럼 + CHECK + 함수** 라 아래로 원복된다.
-- 기존 행은 건드리지 않으므로 **되돌려도 잃는 데이터가 없다**(백필도 새 칸에만 쓴다).
--
--   alter table public.tasks           drop column if exists vendor_category;
--   alter table public.task_templates  drop column if exists vendor_category;
--   alter table public.content_posts   drop column if exists prep_category;
--   drop function if exists public.is_vendor_category(text);
--   drop function if exists public.is_prep_category(text);
--
-- ── 이번에 손대지 않은 것 (FIX-75 로 적었다) ────────────────────────────────
-- **`vendors.category` 와 `products.category` 에는 CHECK 이 하나도 없다** — 자유
-- 문자열이라 오타 하나가 새 카테고리를 만든다. 0045 가 예산 축에서 지적한 바로 그
-- 문제인데 **파는 축 본체에는 아직 없다.** 여기서 걸지 않은 이유는 그 둘이 입점·상품
-- 등록의 뜨거운 경로이고 기존 행의 이행 계획이 함께 서야 하기 때문이다(C-2b 자리다).
-- =============================================================================

-- ── 1. 어휘 판정 함수 ───────────────────────────────────────────────────────
-- 값 집합은 `lib/core/schemas/vendor.ts` 의 `VENDOR_CATEGORIES` 와 같아야 하며
-- `db:rls` 가 **코드와 DB 를 대조**한다. 사본은 어긋나고 어긋나면 조용하다.
create or replace function public.is_vendor_category(p_value text)
returns boolean language sql immutable set search_path = public as $$
  select p_value in ('hall', 'studio', 'dress', 'makeup', 'video', 'agency');
$$;

comment on function public.is_vendor_category(text) is
  '파는 축 어휘(§2.2 F-V-03 · lib/core/schemas/vendor.ts VENDOR_CATEGORIES). 마켓플레이스가 파는 것.';

-- 값 집합은 `lib/core/schedule/templates.ts` 의 `TASK_CATEGORIES` 와 같아야 한다.
create or replace function public.is_prep_category(p_value text)
returns boolean language sql immutable set search_path = public as $$
  select p_value in ('hall', 'sdm', 'yedan', 'honsu', 'document', 'honeymoon');
$$;

comment on function public.is_prep_category(text) is
  '준비 축 어휘(§2.1 F-C-04 · lib/core/schedule/templates.ts TASK_CATEGORIES). 예비부부가 준비하는 것. 파는 축과 겹치는 값은 hall 하나뿐이며 그것이 두 축을 합칠 수 없는 이유다(D-206).';

-- ── 2. 준비 축 → 파는 축 ────────────────────────────────────────────────────
alter table public.task_templates
  add column if not exists vendor_category text;

alter table public.task_templates
  drop constraint if exists task_templates_vendor_category_vocab;
alter table public.task_templates
  add constraint task_templates_vendor_category_vocab
  check (vendor_category is null or public.is_vendor_category(vendor_category));

comment on column public.task_templates.vendor_category is
  '이 준비 항목이 가리키는 파는 카테고리(C-2a). null 이면 준비 축 매핑(PREP_TO_VENDOR)이 답한다 — "아직 안 했다" 가 아니라 "따로 좁히지 않았다" 는 뜻이다. sdm 한 칸이 파는 축 넷을 덮으므로 행마다 좁힐 자리가 필요하다.';

alter table public.tasks
  add column if not exists vendor_category text;

alter table public.tasks
  drop constraint if exists tasks_vendor_category_vocab;
alter table public.tasks
  add constraint tasks_vendor_category_vocab
  check (vendor_category is null or public.is_vendor_category(vendor_category));

comment on column public.tasks.vendor_category is
  '이 태스크가 가리키는 파는 카테고리(C-2a). 템플릿에서 생성될 때 복사되고, 손으로 추가한 태스크는 null 로 시작해 준비 축 매핑으로 떨어진다.';

-- ── 3. 글 → 준비 축 ─────────────────────────────────────────────────────────
-- `content_posts.type`(guide/price_report/glossary)은 **글의 종류**이지 준비 단계가
-- 아니다. 대체하지 않고 **따로 붙인다**(D-206).
alter table public.content_posts
  add column if not exists prep_category text;

alter table public.content_posts
  drop constraint if exists content_posts_prep_category_vocab;
alter table public.content_posts
  add constraint content_posts_prep_category_vocab
  check (prep_category is null or public.is_prep_category(prep_category));

comment on column public.content_posts.prep_category is
  '이 글이 도와주는 준비 단계(C-2a · C-4c 가 체크리스트에서 이리로 잇는다). null 이면 특정 단계에 묶이지 않은 글이다. type 은 글의 종류라 이 칸을 대체하지 않는다(D-206).';

-- ── 4. 템플릿 19종의 값은 **여기서 넣지 않는다** ────────────────────────────
-- `task_templates` 는 **시드 데이터**이고 `supabase db reset` 은 **마이그레이션을 먼저,
-- `seed.sql` 을 나중에** 적용한다. 그래서 여기에 `update` 를 적으면 **빈 표를 훑고
-- 아무것도 안 한 채 성공**한다 — 조용히 헛도는 문장이 된다.
-- 값은 `supabase/seed.sql` 의 `insert ... on conflict do update` 가 든다.
--
-- 넣는 규칙: **준비 축 매핑에서 유도할 수 없는 것만** 좁힌다.
--   · 홀 다섯 → 'hall'   · 스튜디오 촬영·앨범 → 'studio'   · 드레스 가봉 → 'dress'
--   · **`T-sdm-contract` 는 일부러 null 이다** — 스드메 계약은 넷을 한꺼번에 묶는
--     일이라 하나로 좁히면 나머지 셋으로 가는 길이 사라진다. 매핑이 넷을 다 돌려준다.
--   · 준비 축이 `not_sold` 인 항목(예단·혼수·서류·허니문)도 null 이다.

-- ── 5. 인덱스 ───────────────────────────────────────────────────────────────
-- C-4c 가 "이 카테고리를 가리키는 준비 항목" 을 되묻는다. 부분 인덱스로 둔다 —
-- 대부분의 행이 null 이라 전체 인덱스는 자리만 차지한다.
create index if not exists idx_task_templates_vendor_category
  on public.task_templates (vendor_category) where vendor_category is not null;
create index if not exists idx_tasks_vendor_category
  on public.tasks (vendor_category) where vendor_category is not null;
create index if not exists idx_content_posts_prep_category
  on public.content_posts (prep_category) where prep_category is not null;

-- ── 6. 권한 — 새 칸이 기존 경계 안에 들어오는지 확인한다 ────────────────────
-- **층 1 (표 단위 권한).** `content_posts` 는 0060 이 **표에서** insert/update/delete 를
-- 걷었다(`revoke ... on public.content_posts from anon, authenticated`). 표 단위로 걷었기
-- 때문에 **새 컬럼도 자동으로 걷힌 상태**로 들어온다 — 칸마다 걷었다면 여기서 다시
-- 걷어야 했고, 그것이 §5.5 가 적은 "칸만 걷으면 무효다" 의 뒷면이다.
-- 그래도 **가정하지 않고 다시 건다**(멱등이며 db:rls 가 음성 대조로 확인한다).
revoke insert, update, delete on public.content_posts from anon, authenticated;

-- `task_templates` 는 RLS 가 켜져 있고 **select 정책만** 있다(0005 [10]).
-- insert/update/delete 정책이 없으므로 로그인 사용자는 쓸 수 없다. 새 칸도 같다.
--
-- `tasks.vendor_category` 는 **커플 구성원이 자기 행에 쓸 수 있다**(0005 [11]).
-- 그것이 맞다 — 이 칸은 **자격이 아니라 길 안내**다. 값을 바꿔도 얻는 권한이 없고
-- (층 3), 남의 행은 RLS 가 막는다. 판매가·정산처럼 돈에 닿는 칸과 다르다.
