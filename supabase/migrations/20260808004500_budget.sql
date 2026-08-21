-- =============================================================================
-- 0045 · 예산 배분·추적 보강 (S7-07)
-- 근거: docs/07_개발명세서.md §2.1 F-C-05, §3.2 budgets · budget_items · expenses,
--       §3.9 RLS, §6.2 /budget, §4.2 GET/PUT /api/budget
-- =============================================================================
-- 표는 0002 가 이미 만들었고 RLS 도 0005 가 걸어 두었다. 이 파일이 더하는 것은
-- **불변식과 카테고리 어휘**뿐이며 새 표는 없다.
--
-- 판단이 필요했던 지점과 근거
--
--  1. **커플당 예산은 하나다.** `budgets` 에 유니크가 없어 같은 커플에 행이 둘 생길 수
--     있었다. 배우자가 동시에 화면을 열면 API 카운트를 지나가고(D-19 · D-77 이 장바구니
--     에서 겪은 것과 같은 구멍), 그러면 **어느 예산이 진짜인지 화면이 답할 수 없다.**
--
--  2. **카테고리당 계획도 하나다.** `budget_items` 에 (budget_id, category) 유니크가
--     없으면 같은 카테고리가 두 줄로 서고 합계가 조용히 두 배가 된다.
--
--  3. **카테고리 어휘를 DB 가 강제한다.** 예산 카테고리는 **표준 견적 카테고리에서
--     `unmapped` 를 뺀 것**이다(§3 · `lib/core/budget/budget.ts`). `unmapped` 는
--     카테고리가 아니라 "표준으로 옮기지 못했다" 는 표시라(§5.4) 예산 줄로 세우면
--     사용자가 **'확인 필요' 에 돈을 배정하게** 된다. 자유 텍스트로 두면 오타 하나가
--     새 카테고리를 만들고 합계가 갈린다.
--
--  4. **총예산을 여기에 두지 않는다.** `budgets.total_amount` 는 `not null default 0`
--     이라 **'미정' 을 표현할 수 없다.** 0을 미정으로 읽으면 담는 즉시 "예산 0원 대비
--     초과" 가 뜨는데 그것은 사실이 아니라 설정이 빈 것이다. 총예산의 진실은
--     **`couples.total_budget`(nullable) 하나**이며 장바구니 기준선(D-77)이 이미 그
--     값을 쓴다 — 두 곳에 두면 두 화면이 다른 말을 한다. 그래서 이 컬럼은 **쓰지
--     않는다**(컬럼을 지우지는 않는다 · §7.2 — 기존 마이그레이션을 고치지 않는다).
--
--  5. **`contracted_amount`·`spent_amount` 도 쓰지 않는다.** 계약 확정과 결제는
--     `bookings`·`payments` 가 이미 들고 있고, 저장해 두면 **배치가 돌기 전까지 화면이
--     거짓말을 한다**(S7-18 이 `ready`·`waiting` 을 저장하지 않기로 한 것과 같은 판단 ·
--     D-71). 조회 시점에 센다. 죽은 컬럼 셋은 FIX 로 기록했다.
--
--  6. **`expenses.budget_item_id` 대신 카테고리로 잇는다.** 지출은 카테고리에 붙지
--     특정 계획 줄에 붙지 않는다 — 계획을 지웠다고 **이미 쓴 돈이 사라지면 안 된다.**
--     그래서 `expenses` 에 `category` 를 더하고 `budget_item_id` 는 그대로 둔다.
-- =============================================================================

-- =============================================================================
-- 1) 커플당 예산 하나 · 카테고리당 계획 하나
-- =============================================================================
-- 중복이 이미 있으면 유니크가 서지 않는다. **오래된 것을 남기고** 뒤엣것의 항목을
-- 옮긴 뒤 지운다 — 먼저 만든 행이 다른 표에서 참조되고 있을 가능성이 높다.
with keep as (
  select couple_id, min(created_at) as first_at
    from public.budgets group by couple_id
),
survivor as (
  select b.id, b.couple_id
    from public.budgets b join keep k
      on k.couple_id = b.couple_id and k.first_at = b.created_at
),
doomed as (
  select b.id, s.id as into_id
    from public.budgets b join survivor s on s.couple_id = b.couple_id
   where b.id <> s.id
)
update public.budget_items i
   set budget_id = d.into_id
  from doomed d
 where i.budget_id = d.id;

delete from public.budgets b
 where exists (
   select 1 from public.budgets o
    where o.couple_id = b.couple_id
      and (o.created_at < b.created_at or (o.created_at = b.created_at and o.id::text < b.id::text))
 );

create unique index if not exists uq_budgets_couple on public.budgets (couple_id);

comment on column public.budgets.total_amount is
  '**쓰지 않는다**(0045). not null default 0 이라 ''미정''을 표현할 수 없고, 0을 미정으로 읽으면 "예산 0원 대비 초과"라는 거짓말이 된다. 총예산의 진실은 couples.total_budget(nullable) 하나이며 장바구니 예산 기준선(D-77)이 같은 값을 쓴다.';
comment on column public.budgets.allocation_json is
  '**권장 배분의 근거 스냅샷**. 어떤 참가격 지수(중앙값·표본 수·출처)로 권장액을 냈는지 남긴다 — 지수가 갱신돼도 "그때 무엇을 근거로 권했나"를 답할 수 있어야 한다(D-16·D-23 과 같은 이유).';
comment on column public.budgets.index_version is
  '스냅샷을 뜬 시점의 price_index.version. allocation_json 과 짝이다.';

-- 같은 카테고리가 두 줄로 서면 합계가 조용히 두 배가 된다. 중복은 합쳐서 남긴다.
-- `min(uuid)` 는 없다. 남길 행은 **가장 작은 id 를 텍스트로 견주어** 고른다 —
-- 어느 행을 남기느냐보다 **하나만 남는다**는 사실이 중요하고, 규칙이 고정이면
-- 다시 돌려도 같은 결과가 나온다.
with merged as (
  select budget_id, category,
         (select i2.id from public.budget_items i2
           where i2.budget_id = i.budget_id and i2.category = i.category
           order by i2.id::text limit 1) as keep_id,
         sum(planned_amount) as planned
    from public.budget_items i
   group by budget_id, category
  having count(*) > 1
)
update public.budget_items i
   set planned_amount = m.planned
  from merged m
 where i.id = m.keep_id;

delete from public.budget_items i
 where exists (
   select 1 from public.budget_items o
    where o.budget_id = i.budget_id and o.category = i.category and o.id::text < i.id::text
 );

create unique index if not exists uq_budget_items_category
  on public.budget_items (budget_id, category);

comment on column public.budget_items.contracted_amount is
  '**쓰지 않는다**(0045). 확정 예약 금액은 bookings 가 들고 있고 조회 시점에 센다 — 저장하면 배치가 돌기 전까지 화면이 거짓말을 한다(D-71 과 같은 판단).';
comment on column public.budget_items.spent_amount is
  '**쓰지 않는다**(0045). 결제는 payments 가, 손으로 적은 지출은 expenses 가 들고 있다. 위와 같은 이유로 조회 시점에 센다.';

-- =============================================================================
-- 2) 카테고리 어휘 — DB 가 강제한다
-- =============================================================================
-- 표준 견적 카테고리(§3)에서 `unmapped` 를 뺀 것이다. 코드(`lib/core/budget/budget.ts`)
-- 와 같은 집합이어야 하며 `db:rls` 가 **코드와 DB 를 대조**한다(검출 룰 S7-01 과 같은 구조).
create or replace function public.is_budget_category(p_value text)
returns boolean language sql immutable set search_path = public as $$
  select p_value in (
    'hall', 'meal', 'studio', 'dress', 'makeup', 'video', 'snap',
    'flower', 'invitation', 'gift', 'officiant', 'helper', 'etc'
  );
$$;

comment on function public.is_budget_category(text) is
  '예산 카테고리 어휘(§3 표준 견적 카테고리 - unmapped). 자유 텍스트로 두면 오타 하나가 새 카테고리를 만들고 합계가 갈린다. unmapped 를 뺀 이유는 그것이 카테고리가 아니라 "표준으로 옮기지 못했다"는 표시이기 때문이다.';

-- 어휘 밖의 값이 이미 있으면 CHECK 가 서지 않는다. **지우지 않고 `etc` 로 옮긴다** —
-- 계약·지출이 예산에서 조용히 사라지는 편이 더 나쁘다.
update public.budget_items set category = 'etc' where not public.is_budget_category(category);

alter table public.budget_items
  drop constraint if exists budget_items_category_vocab;
alter table public.budget_items
  add constraint budget_items_category_vocab check (public.is_budget_category(category));

-- =============================================================================
-- 3) expenses — 카테고리로 잇는다
-- =============================================================================
-- 지출은 **카테고리에 붙지 특정 계획 줄에 붙지 않는다.** 계획을 지웠다고 이미 쓴 돈이
-- 사라지면 안 되고, `budget_item_id` 는 `on delete set null` 이라 지우는 순간
-- **그 지출이 어느 카테고리였는지 알 수 없게 된다.**
alter table public.expenses
  add column if not exists category text;

update public.expenses e
   set category = coalesce(
         (select i.category from public.budget_items i where i.id = e.budget_item_id),
         'etc')
 where e.category is null;

alter table public.expenses
  alter column category set not null;

alter table public.expenses
  drop constraint if exists expenses_category_vocab;
alter table public.expenses
  add constraint expenses_category_vocab check (public.is_budget_category(category));

comment on column public.expenses.category is
  '예산 카테고리. **budget_item_id 대신 이 값으로 집계한다** — 계획 줄을 지워도(on delete set null) 이미 쓴 돈이 어느 카테고리였는지는 남아야 한다.';
comment on column public.expenses.source_ref is
  '출처 표시. 사용자가 손으로 적은 지출은 null 이고, 자동 반영분은 그 근거를 가리킨다. **계약 금액은 여기 넣지 않는다** — bookings 가 진실이며 옮겨 적으면 두 곳이 갈린다.';
comment on column public.expenses.memo is
  '커플이 자기 행에 적는 짧은 메모. **증적(entity_events)에 옮기지 않는다**(§7.3).';

create index if not exists idx_expenses_couple_category
  on public.expenses (couple_id, category);

-- =============================================================================
-- 4) 계약 확정 자동 반영 — 업체 카테고리를 커플이 읽지 못해도 잡힌다
-- =============================================================================
-- **흐름 점검이 잡았다.** 처음에는 라우트가 PostgREST 임베드(`bookings.vendors(category)`)
-- 로 업체 카테고리를 읽었는데, `vendors` 는 공개 조건이 붙은 표라 **커플이 그 행을 못
-- 읽으면 임베드가 `null` 로 오고 계약이 통째로 `etc` 로 떨어졌다.** 12,000,000원짜리
-- 홀 계약이 '기타' 에 붙는 것이다 — 조용히 틀리는 종류의 실패다.
--
-- 더 나쁜 것은 **나중에 업체가 노출에서 빠지면 이미 잡혀 있던 계약이 카테고리를 옮긴다**
-- 는 점이다. 사용자는 아무것도 하지 않았는데 예산표가 바뀐다.
--
-- 그래서 분류를 **SECURITY DEFINER 함수**로 옮긴다. 업체 행의 열람 가능 여부와 무관하게
-- 같은 답을 내며, **경계는 함수 안의 권한 검사**다 — 커플 구성원이거나 `budgets` 를
-- 위임받은 플래너여야 한다(§3.9 · D-43). 그 줄이 없으면 아무 커플 id 나 넣어 남의
-- 계약 금액을 셀 수 있다.
create or replace function public.budget_contracted(p_couple_id uuid)
returns table (category text, contracted bigint, paid bigint)
language sql stable security definer set search_path = public as $$
  with confirmed as (
    select b.id,
           b.total_amount,
           -- **코드의 `VENDOR_TO_BUDGET_CATEGORY` 와 같은 표다**(db:rls 가 대조한다).
           -- 모르는 업종도 `etc` 로 간다 — 계약이 예산에서 사라지는 편이 더 나쁘다.
           case v.category
             when 'hall'   then 'hall'
             when 'studio' then 'studio'
             when 'dress'  then 'dress'
             when 'makeup' then 'makeup'
             when 'video'  then 'video'
             else 'etc'
           end as category
      from public.bookings b
      join public.vendors v on v.id = b.vendor_id
     -- **확정된 것만 센다.** hold·cancelled 를 세면 아직 잡히지 않은 돈이 예산을 먹는다.
     where b.couple_id = p_couple_id
       and b.status = 'confirmed'
       and (
         public.is_couple_member(p_couple_id)
         or public.has_planner_scope(p_couple_id, 'budgets')
       )
  )
  select c.category,
         sum(c.total_amount)::bigint as contracted,
         coalesce(
           sum((select coalesce(sum(p.amount), 0) from public.payments p
                 where p.booking_id = c.id and p.status = 'paid')),
           0
         )::bigint as paid
    from confirmed c
   group by c.category;
$$;

comment on function public.budget_contracted(uuid) is
  '확정된 예약을 예산 카테고리별로 센다(F-C-05). **SECURITY DEFINER 인 이유** — vendors 는 공개 조건이 붙은 표라 커플이 그 행을 못 읽으면 임베드가 null 로 오고 계약이 통째로 etc 로 떨어진다(흐름 점검이 잡았다). 업체 노출이 바뀌었다고 이미 잡힌 계약의 카테고리가 움직이면 안 된다. **경계는 함수 안의 권한 검사**다 — 커플 구성원이거나 budgets 를 위임받은 플래너여야 한다(§3.9).';

revoke all on function public.budget_contracted(uuid) from public;
grant execute on function public.budget_contracted(uuid) to authenticated;

-- =============================================================================
-- 0045 산출 요약
-- =============================================================================
--   테이블 0 (0002 가 이미 만들었다) · 컬럼 1(expenses.category)
--   유니크 2 — 커플당 예산 하나 · 카테고리당 계획 하나
--   함수 1 · CHECK 2 · 인덱스 1 · 주석 7
--
--   **RLS 를 새로 걸지 않았다** — 0005 [12][13][14] 가 budgets·budget_items·expenses 에
--   이미 커플 스코프 + 플래너 위임을 걸어 두었다. `db:rls` 가 그 사실을 확인한다.
-- =============================================================================
