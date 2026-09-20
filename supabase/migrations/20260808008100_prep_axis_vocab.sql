-- =============================================================================
-- 0081 · 준비 축 어휘를 잠그고 오프셋 범위를 적는다 (C-4a)
--   근거: 07 §2.1 F-C-04 확장 · §3.2 · B-1 조사 4-2
--
-- ── 무엇이 문제였나 ─────────────────────────────────────────────────────────
-- C-4a 는 준비 항목 넷(답례품 · 상견례 · 예복·한복 · 축의금 정산)을 더한다. 값을
-- 더하기 전에 **그 값을 받는 칸이 무엇을 막고 있는지** 봤고, 두 가지가 나왔다.
--
--   ① **준비 축에 CHECK 이 하나도 없다.** `task_templates.category` 와 `tasks.category`
--      는 그냥 `text not null` 이다. C-2a 가 `is_prep_category()` 함수를 만들어 두고
--      **`content_posts.prep_category` 에만** 걸었다 — 정작 준비 축 **본체**인 두 칸은
--      자유 문자열로 남아 있었다. FIX-75 가 파는 축에서 찾은 것과 **같은 모양**이며,
--      어휘를 여섯에서 아홉으로 늘리는 지금이 이것을 닫을 자리다. 새 값 셋을 더하는데
--      오타와 새 값을 DB 가 구분하지 못하면, 어휘를 늘린 일이 코드에만 남는다.
--      → **FIX-82**
--
--   ② **`offset_days` 에도 CHECK 이 없다.** 원장과 B-1 은 *"오프셋이 전부 음수라 예식
--      뒤를 표현할 수 없다"* 고 적었는데, 실측해 보니 **막고 있던 것은 제약이 아니라
--      목록 자체**였다(제약은 애초에 없었다). 그래서 이 파일이 하는 일은 '푸는' 것이
--      아니라 **처음으로 범위를 적는** 것이다 — 상한이 없으면 오타 하나가 10년 뒤
--      기한을 만들고, 그 태스크는 어느 구간에도 안 뜨면서 목록에만 남는다.
--
-- ── 기존 19종이 깨지지 않는다 ───────────────────────────────────────────────
-- 기존 값은 카테고리 여섯 · 오프셋 -330 ~ -14 로 **둘 다 새 제약 안**이다.
-- `not valid` → `validate` 두 단계로 걸어 어긋난 행이 있으면 어느 단계에서 멈췄는지
-- 분명하게 한다(0076·0080 과 같은 방식).
--
-- ── 값은 여기서 넣지 않는다 ─────────────────────────────────────────────────
-- `task_templates` 는 **시드 데이터**이고 `supabase db reset` 은 **마이그레이션을 먼저,
-- `seed.sql` 을 나중에** 적용한다. 그래서 여기에 `insert`·`update` 를 적으면 **빈 표를
-- 훑고 성공**한다(C-2a 가 실제로 밟았다). 새 템플릿 여섯은 `seed.sql` 이 넣고,
-- 운영 DB 에서는 같은 시드 블록이 `on conflict do update` 로 옮긴다.
-- =============================================================================

-- ── 1. 준비 축 어휘를 아홉으로 ──────────────────────────────────────────────
-- 값 집합은 `lib/core/schedule/templates.ts` 의 `TASK_CATEGORIES` 와 같아야 하며
-- `db:rls` 가 **양방향으로** 대조한다(코드에 있는 값을 DB 가 알고, DB 가 코드보다 더
-- 알지도 않는다).
create or replace function public.is_prep_category(p_value text)
returns boolean language sql immutable set search_path = public as $$
  select p_value in (
    'hall', 'sdm', 'yedan', 'honsu', 'document', 'honeymoon',
    -- C-4a
    'family',   -- 양가가 함께 정하고 정리하는 일 (상견례 · 축의금 정산)
    'attire',   -- 신부 드레스가 아닌 입을 것 (신랑 예복 · 양가 한복)
    'gift'      -- 하객에게 돌려주는 것 (답례품 · 답례 인사)
  );
$$;

comment on function public.is_prep_category(text) is
  '준비 축 어휘(§2.1 F-C-04 · lib/core/schedule/templates.ts TASK_CATEGORIES). 예비부부가 준비하는 것. C-4a 가 여섯에서 아홉으로 늘렸다(family·attire·gift). 파는 축과 겹치는 값은 hall 하나뿐이며 그것이 두 축을 합칠 수 없는 이유다(D-206).';

-- ── 2. 준비 축 본체에 CHECK 을 건다 (FIX-82) ────────────────────────────────
alter table public.task_templates
  drop constraint if exists task_templates_category_vocab;
alter table public.task_templates
  add constraint task_templates_category_vocab
  check (public.is_prep_category(category)) not valid;
alter table public.task_templates validate constraint task_templates_category_vocab;

alter table public.tasks
  drop constraint if exists tasks_category_vocab;
alter table public.tasks
  add constraint tasks_category_vocab
  check (public.is_prep_category(category)) not valid;
alter table public.tasks validate constraint tasks_category_vocab;

comment on column public.tasks.category is
  '준비 축 카테고리(§2.1 F-C-04). 어휘는 is_prep_category() 가 막는다(C-4a · FIX-82) — 그전에는 자유 문자열이라 오타와 새 값을 DB 가 구분하지 못했다.';

-- ── 3. 오프셋 범위 ──────────────────────────────────────────────────────────
-- **양수를 허용한다는 사실을 제약으로 적는다.** 제약이 아예 없으면 다음 사람이
-- "양수가 되나?" 를 또 실측해야 하고, 실측은 기록으로 남지 않는다.
--
-- 하한 -1000 — 예식 3년 전보다 이른 준비 항목은 역산 목록의 뜻이 아니다.
-- 상한  365  — 예식 1년 뒤보다 늦은 일은 '준비' 가 아니다. 축의금 정산(+7) ·
--              답례 인사(+14) · 혼인신고 제출(+30) 이 넉넉히 들어간다.
alter table public.task_templates
  drop constraint if exists task_templates_offset_range;
alter table public.task_templates
  add constraint task_templates_offset_range
  check (offset_days between -1000 and 365) not valid;
alter table public.task_templates validate constraint task_templates_offset_range;

comment on column public.task_templates.offset_days is
  '예식일 기준 오프셋(D-360 → -360). **양수는 예식 뒤다**(C-4a — 축의금 정산·답례 인사·혼인신고 제출). 역산 생성에 사용한다. 범위 -1000~365.';

-- =============================================================================
-- 이 파일이 한 것
--   함수 1 — is_prep_category(text) 를 여섯 → 아홉으로 (family·attire·gift)
--   CHECK 3 — task_templates.category · tasks.category (FIX-82) · offset_days 범위
--   값 변경 없음 — 새 템플릿 여섯은 seed.sql 이 넣는다
--   새 표·새 칸·새 정책 없음
-- =============================================================================
