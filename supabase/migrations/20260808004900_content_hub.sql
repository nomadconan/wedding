-- =============================================================================
-- 0049 · SEO 콘텐츠 허브 (S7-10)
-- 근거: docs/07_개발명세서.md §2.1 F-C-24, §3.7 content_posts, §3.9 RLS,
--       §6.2 /guides/[slug], §7.1 SEO
-- =============================================================================
-- 표는 0004 가 이미 만들었고 RLS 도 0005 [58] 이 걸어 두었다
-- (`published_at is not null and published_at <= now()` — anon·authenticated SELECT).
-- 이 파일이 더하는 것은 **불변식과 조회 함수**다.
--
-- 판단이 필요했던 지점과 근거
--
--  1. **슬러그가 URL 그 자체다.** 형식을 DB 가 강제한다. `../` 나 슬래시가 든 값이
--     들어오면 그것은 잘못된 링크가 아니라 **경로 조작 시도가 통하는 모양**이다.
--     코드(`isValidSlug`)와 같은 규칙이며 `db:rls` 가 대조한다.
--
--  2. **발행된 글에는 본문이 있어야 한다.** `published_at` 이 찼는데 `body_md` 가
--     비어 있으면 **제목만 있는 페이지가 색인된다.** 색인은 넣기보다 빼기가 훨씬
--     오래 걸리므로(S3-10 이 robots 에서 세운 판단) 상류에서 막는다.
--
--  3. **`seo_json` 은 객체여야 한다.** 배열이나 스칼라가 들어오면 파서가 조용히
--     기본값으로 읽고 **메타가 통째로 사라진다** — 화면은 정상으로 보이는데 검색
--     결과의 설명이 비어 있다. 조용한 실패라 아무도 즉시 모른다.
--
--  4. **가격 리포트를 시드하지 않는다.** 유형은 enum 에 있지만 글을 만들지 않는다 —
--     참가격 지수의 표본이 대부분 부족하다(S3-08 · 적재는 S8-10). 표본 없는 숫자로
--     리포트를 쓰면 그건 **빈 페이지에 제목만 붙인 것**이다. 화면이 그 이유를 적는다.
--
--  5. **SECURITY DEFINER 함수를 만들지 않았다.** S7-05·S7-07 이 그것을 쓴 이유는
--     **공개 조건이 붙은 표를 임베드로 읽으면 행이 안 보일 때 값이 조용히 사라지기**
--     때문이었다. 여기는 임베드가 없다 — `content_posts` 단일 표 조회이고 경계는
--     0005 [58] 의 공개 정책 그대로다. **`author_id` 를 임베드하지 않는 것**이 그
--     함정을 피하는 방법이며(auth.users 는 anon 에게 보이지 않는다) 화면도 작성자를
--     쓰지 않는다(구조화 데이터에 없는 값을 지어내지 않는다).
--
--  6. **발행 목록 함수는 만든다.** 사이트맵이 "발행됐고 슬러그가 성한" 글만 실어야
--     하는데, 그 판정을 애플리케이션이 다시 하면 **정책과 코드가 갈린다.**
-- =============================================================================

-- =============================================================================
-- 1) 슬러그 — URL 그 자체다
-- =============================================================================
create or replace function public.is_content_slug(p_value text)
returns boolean language sql immutable set search_path = public as $$
  select p_value ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(p_value) <= 80;
$$;

comment on function public.is_content_slug(text) is
  '콘텐츠 슬러그 형식(§6.2 /guides/[slug]). 코드(lib/core/content/content.ts SLUG_PATTERN)와 같은 규칙이며 db:rls 가 대조한다. 슬래시·점을 막는 이유는 잘못된 링크를 막기 위해서가 아니라 경로 조작이 통하는 모양을 만들지 않기 위해서다.';

-- 어긋난 슬러그가 이미 있으면 **지우지 않고 발행을 내린다** — 글은 남기되 공개
-- 경로에서 빠진다(안전한 쪽으로 틀린다).
update public.content_posts set published_at = null
 where not public.is_content_slug(slug) and published_at is not null;

alter table public.content_posts
  drop constraint if exists content_posts_slug_format_chk;
alter table public.content_posts
  add constraint content_posts_slug_format_chk
  check (public.is_content_slug(slug)) not valid;

-- `not valid` 로 붙인 뒤 검증한다 — 기존 행이 어긋나면 어디가 어긋났는지 오류가
-- 알려주고, 그 상태로 마이그레이션이 멈추는 편이 조용히 통과하는 것보다 낫다.
alter table public.content_posts validate constraint content_posts_slug_format_chk;

-- =============================================================================
-- 2) 발행 불변식 — 빈 페이지를 색인시키지 않는다
-- =============================================================================
alter table public.content_posts
  drop constraint if exists content_posts_published_body_chk;
alter table public.content_posts
  add constraint content_posts_published_body_chk
  check (
    published_at is null
    or (length(btrim(coalesce(body_md, ''))) > 0 and length(btrim(title)) > 0)
  );

alter table public.content_posts
  drop constraint if exists content_posts_seo_object_chk;
alter table public.content_posts
  add constraint content_posts_seo_object_chk
  check (jsonb_typeof(seo_json) = 'object');

comment on column public.content_posts.published_at is
  '발행 시각. **null 이면 미발행**이고 미래면 예약이다 — RLS(0005 [58])가 published_at <= now() 로 거른다. 발행되려면 본문과 제목이 비어 있지 않아야 한다(제목만 있는 페이지가 색인되면 되돌리기 어렵다 · S3-10).';
comment on column public.content_posts.seo_json is
  '글이 갖는 메타. description · keywords[] · tools[](도구 CTA 키 · lib/core/content 레지스트리) · region_code · category. **객체가 아니면 파서가 조용히 기본값으로 읽어 메타가 통째로 사라진다** — 그래서 CHECK 로 막는다. 모르는 키는 무시하고 페이지는 선다.';
comment on column public.content_posts.author_id is
  '작성자. **화면과 구조화 데이터가 쓰지 않는다** — auth.users 는 anon 에게 보이지 않으므로 임베드하면 행이 조용히 사라지고(S7-05 함정), 없는 값을 JSON-LD 에 넣는 것은 검색엔진에 거짓을 신고하는 일이다.';

-- =============================================================================
-- 3) 발행 목록 — 사이트맵과 화면이 같은 판정을 본다
-- =============================================================================
-- **`security invoker` 다.** 정책을 우회할 이유가 없다 — 이 함수가 답해야 하는 것은
-- "공개된 글이 무엇인가" 이고 그 판정은 0005 [58] 이 이미 갖고 있다. definer 로 두면
-- 미발행 글이 사이트맵에 실릴 수 있는 경로를 스스로 만드는 셈이다.
create or replace function public.published_content(p_type public.content_post_type default null)
returns table (
  slug text,
  type public.content_post_type,
  title text,
  body_md text,
  seo_json jsonb,
  published_at timestamptz,
  updated_at timestamptz
)
language sql stable security invoker set search_path = public as $$
  select c.slug, c.type, c.title, c.body_md, c.seo_json, c.published_at, c.updated_at
    from public.content_posts c
   where c.published_at is not null
     and c.published_at <= now()
     and public.is_content_slug(c.slug)
     and (p_type is null or c.type = p_type)
   order by c.published_at desc;
$$;

comment on function public.published_content(public.content_post_type) is
  '발행된 콘텐츠(F-C-24). **security invoker** — 공개 판정은 RLS(0005 [58])가 하고 이 함수는 정렬과 슬러그 성함만 더한다. 사이트맵·목록·상세가 같은 것을 본다.';

-- **`revoke ... from public` 을 쓰지 않는다.** S7-12 에서 그 한 줄이 service_role
-- 상속분까지 걷어가 함수가 서버에서 안 돌았다. 필요한 역할에만 명시적으로 준다.
grant execute on function public.published_content(public.content_post_type)
  to anon, authenticated, service_role;

-- 목록은 발행 시각 역순으로 읽는다. 0004 의 (type, published_at desc) 인덱스는
-- 유형별 조회용이고, 유형을 가리지 않는 목록에는 이것이 쓰인다.
create index if not exists idx_content_posts_published_at
  on public.content_posts (published_at desc)
  where published_at is not null;

-- =============================================================================
-- 0049 산출 요약
-- =============================================================================
--   테이블 0 (0004 가 이미 만들었다) · 함수 2 · CHECK 3 · 인덱스 1 · 주석 3
--
--   **RLS 를 새로 걸지 않았다** — 0005 [58] 이 공개 SELECT 를 이미 걸어 두었고
--   쓰기 정책은 없다(발행은 서비스롤 · F-A-05 는 8단계).
--   **가격 리포트 행을 만들지 않았다** — 표본이 없다(위 4번).
-- =============================================================================
