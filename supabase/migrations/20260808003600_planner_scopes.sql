-- =============================================================================
-- 0036 · 마이그레이션 7차 — 플래너 범위 (S6-01)
-- 근거: docs/07_개발명세서.md §2.1 F-C-18·F-C-31, §3.7 planner_scopes·
--       planner_engagements, §3.9 RLS, D-16 · D-17 · D-18 · D-23 · D-25
-- =============================================================================
-- 명세 §3.7 이 `planner_scopes` 를 적어 뒀는데 이 리포에 없었다. T-03(0004)이 만든
-- 것은 `planner_engagements` 뿐이고 둘은 **다른 표**다 — 아래 근거 1.
--
-- 이 파일이 정한 것 — 판단이 필요했던 지점과 근거
--
--  1. **축이 둘이고 합치지 않는다.** 이 태스크의 핵심 판단이다.
--       · `planner_engagements`(0004) — **데이터 열람 권한 위임**. "이 플래너가 우리
--         커플의 어떤 **표**를 볼 수 있는가" 이며 RLS(`has_planner_scope`)가 판정한다.
--       · `planner_scopes`(이 파일) — **카테고리별 이용 여부**. "홀은 직접, 스드메만
--         플래너" 이며 **과금의 축**이다(F-C-31).
--     합치면 표현할 수 없는 상태가 생긴다 — "예산은 보게 하되 어느 카테고리에도
--     플래너를 쓰지 않는다"(상담만 받는 단계)와 "드레스만 맡기지만 장바구니 전체를
--     보여준다" 는 둘 다 자연스럽다. 명세가 두 표를 따로 둔 이유다.
--
--  2. **요율을 여기 저장하지 않는다**(명세가 명시). 요율은 `planner_fee_rates`(0006)가
--     갖고 계약 확정 시 `bookings.applied_planner_fee_rate_bp` 로 스냅샷된다(D-16).
--     여기 두면 요율의 진실이 셋이 되고, 카테고리 선택을 바꿀 때마다 과거 계약의
--     근거가 흔들린다.
--
--  3. **해제 행을 지우지 않는다**(D-23). "언제부터 언제까지 이 카테고리에 플래너를
--     썼는가" 는 정산 분쟁에서 실제로 묻는 질문이다. 그래서 해제는 `status='released'`
--     + `released_at` 이고, 재선택은 **새 행**이다. 동시에 선택된 것이 하나임은
--     **부분 유니크**가 지킨다.
--
--  4. **커플 구성원 누구나 고른다.** 결제·계약 서명은 owner 전용이지만(§3.9) 이것은
--     **구성 선택**이지 돈을 움직이는 확정이 아니다 — 실제 과금은 계약 확정 시점에
--     스냅샷된다(D-17). 장바구니 항목 토글(`cart_items.planner_selected`)을 배우자도
--     바꿀 수 있는 것과 같은 층이며, 여기만 owner 로 좁히면 두 화면의 권한이 갈린다.
--
--  5. **플래너 본인도 읽는다.** 자기가 어느 카테고리를 맡았는지 모르면 일을 할 수
--     없다. 다만 **쓰지는 못한다** — 플래너가 스스로 범위를 넓히면 그것이 곧 자기
--     수수료를 늘리는 행위가 된다.
--
--  6. **활성 위임이 없으면 선택할 수 없다.** 위임(`planner_engagements`)이 없는
--     플래너를 카테고리에 붙이면 "보지도 못하는 플래너에게 수수료가 붙는" 상태가
--     된다. 두 축은 독립이지만 **선택의 전제**로는 위임이 필요하다 — 트리거가 본다.
--
--  7. **해제가 이미 성사된 계약을 건드리지 않는다.** DB 는 그것을 강제할 필요가 없다 —
--     `bookings.applied_planner_fee_rate_bp` 불변 트리거(0028)와 `planner_settlements`
--     원장이 이미 지키고 있다. 이 파일은 **아무것도 소급하지 않는다**는 사실을 주석과
--     화면 문구(`lib/core/planner`)로 남긴다.
-- =============================================================================

-- =============================================================================
-- 1) planner_scopes — 카테고리별 이용 여부 (F-C-31)
-- =============================================================================
create table if not exists public.planner_scopes (
  id          uuid primary key default gen_random_uuid(),
  couple_id   uuid not null references public.couples (id) on delete cascade,
  planner_id  uuid not null references public.planners (id) on delete restrict,
  /** 상품 카테고리. 값 집합은 `lib/core/planner/scope.ts` 의 PLANNER_CATEGORIES 와 같다. */
  category    text not null,
  status      text not null default 'selected',
  selected_at timestamptz not null default now(),
  released_at timestamptz,
  /** 커플 구성원 중 누가 골랐는가. 배우자와 소유자를 가르지 않되 기록은 남긴다. */
  selected_by uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint planner_scopes_status_values check (status in ('selected', 'released')),

  -- 해제의 짝. 상태와 시각이 어긋나면 "언제 뺐는가" 를 답할 수 없다(D-23).
  constraint planner_scopes_released_pair
    check ((status = 'released') = (released_at is not null)),
  constraint planner_scopes_released_order
    check (released_at is null or released_at >= selected_at),

  -- **판매가가 있는 카테고리만.** 플래너 수수료는 판매가에 붙는 비율이라(F-C-31)
  -- 판매가가 없는 항목(헬퍼비·식대 등)에는 붙을 자리가 없다.
  constraint planner_scopes_category_values
    check (
      category in (
        'hall', 'studio', 'dress', 'makeup', 'video', 'snap', 'flower', 'invitation'
      )
    )
);

comment on table public.planner_scopes is
  '카테고리별 플래너 이용 여부(F-C-31 · §3.7). **planner_engagements 와 다른 축이다** — 그쪽은 "어떤 표를 볼 수 있는가"(열람 권한)이고 이쪽은 "어느 카테고리에 플래너를 쓰는가"(과금)다. 합치면 "예산은 보게 하되 플래너는 안 쓴다" 같은 정상 상태를 표현할 수 없다. **요율을 저장하지 않는다** — 계약 확정 시 bookings.applied_planner_fee_rate_bp 로 스냅샷된다(D-16).';
comment on column public.planner_scopes.status is
  'selected(플래너 이용) | released(직접 진행). **해제 행을 지우지 않는다** — "언제부터 언제까지 썼는가" 가 정산 분쟁의 질문이다(D-23). 재선택은 새 행이며 동시에 선택된 것이 하나임은 부분 유니크가 지킨다.';
comment on column public.planner_scopes.category is
  '상품 카테고리. 값 집합은 lib/core/planner/scope.ts 의 PLANNER_CATEGORIES 와 같아야 하며 db:rls 가 정합을 본다. **판매가가 있는 카테고리만** 담는다 — 플래너 수수료는 판매가에 붙는 비율이다.';

-- **한 카테고리에 동시에 선택된 플래너는 하나다.** 둘이면 같은 항목에 수수료가 두 번
-- 붙는다. `released` 는 이력이므로 제한을 받지 않는다(재선택이 가능해야 한다).
create unique index if not exists uq_planner_scopes_selected
  on public.planner_scopes (couple_id, category)
  where status = 'selected';

create index if not exists idx_planner_scopes_couple on public.planner_scopes (couple_id);
create index if not exists idx_planner_scopes_planner on public.planner_scopes (planner_id);

select public.attach_set_updated_at('planner_scopes');

-- =============================================================================
-- 2) 불변식 트리거 (위 근거 6)
-- =============================================================================
create or replace function public.assert_planner_scope()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_active integer;
begin
  if new.status <> 'selected' then return new; end if;
  if tg_op = 'UPDATE' and old.status = 'selected' then return new; end if;

  -- **위임이 없는 플래너를 카테고리에 붙일 수 없다.** 붙이면 보지도 못하는 플래너에게
  -- 수수료가 붙는 상태가 된다. 두 축은 독립이지만 선택의 **전제**로는 위임이 필요하다.
  select count(*) into v_active
  from public.planner_engagements e
  where e.couple_id = new.couple_id
    and e.planner_id = new.planner_id
    and e.status = 'active'
    and (e.valid_from is null or e.valid_from <= now())
    and (e.valid_to is null or e.valid_to >= now());

  if v_active = 0 then
    raise exception '위임이 활성 상태인 플래너만 카테고리에 지정할 수 있습니다.'
      using errcode = 'check_violation', constraint = 'planner_scopes_no_engagement';
  end if;

  return new;
end;
$$;

comment on function public.assert_planner_scope() is
  '카테고리 선택의 전제를 강제한다 — **활성 위임이 있는 플래너만** 지정할 수 있다. 없으면 보지도 못하는 플래너에게 수수료가 붙는다. 해제(released)로 가는 것은 막지 않는다 — 위임이 먼저 끊긴 뒤에도 카테고리는 정리할 수 있어야 한다.';

drop trigger if exists trg_planner_scopes_guard on public.planner_scopes;
create trigger trg_planner_scopes_guard
  before insert or update on public.planner_scopes
  for each row execute function public.assert_planner_scope();

-- =============================================================================
-- 3) RLS (§3.9)
-- -----------------------------------------------------------------------------
-- **커플 구성원 누구나 고른다**(위 근거 4). 결제·서명과 달리 이것은 구성 선택이고,
-- 장바구니 항목 토글을 배우자도 바꿀 수 있는 것과 같은 층이다.
-- **플래너는 읽기만**(위 근거 5) — 스스로 범위를 넓히면 자기 수수료를 늘리는 행위다.
-- =============================================================================
alter table public.planner_scopes enable row level security;

create policy planner_scopes_select on public.planner_scopes for select to authenticated
  using (
    public.is_couple_member(couple_id)
    or exists (
      select 1 from public.planners p
      where p.id = planner_scopes.planner_id and p.user_id = auth.uid()
    )
    or public.is_operator()
  );

create policy planner_scopes_insert on public.planner_scopes for insert to authenticated
  with check (public.is_couple_member(couple_id));

create policy planner_scopes_update on public.planner_scopes for update to authenticated
  using (public.is_couple_member(couple_id))
  with check (public.is_couple_member(couple_id));

comment on policy planner_scopes_insert on public.planner_scopes is
  '카테고리 선택은 **커플 구성원 누구나** 한다. 결제·계약 서명이 owner 전용인 것과 다른 이유 — 이것은 구성 선택이지 돈을 움직이는 확정이 아니며(실제 과금은 계약 확정 시 스냅샷), 장바구니 항목 토글을 배우자도 바꿀 수 있는 것과 같은 층이다. **플래너에게는 쓰기를 주지 않는다** — 스스로 범위를 넓히면 자기 수수료를 늘리는 행위가 된다.';

-- **삭제 권한을 회수한다**(위 근거 3). 해제는 status 를 바꾸는 것이지 행을 지우는
-- 것이 아니다 — 지우면 "언제부터 언제까지 썼는가" 를 재현할 수 없다.
revoke delete on public.planner_scopes from authenticated, anon;

-- =============================================================================
-- 4) 증적 열람 (D-23 · 0019 의 방식)
-- =============================================================================
create policy entity_events_select_planner_scope on public.entity_events
  for select to authenticated
  using (
    entity_type = 'planner_scope'
    and exists (
      select 1 from public.planner_scopes s
      where s.id = entity_events.entity_id and public.is_couple_member(s.couple_id)
    )
  );

-- =============================================================================
-- 5) 열람 위임에 planner_scopes 를 얹지 않는다
-- -----------------------------------------------------------------------------
-- **`has_planner_scope`(0005)를 고치지 않는다.** 그 함수는 `planner_engagements` 의
-- `scope_json.tables` 로 열람을 판정하며, 카테고리 선택과는 축이 다르다(근거 1).
-- 카테고리를 열람 판정에 섞으면 "드레스만 맡겼으니 예산 표는 못 본다" 같은 규칙이
-- 생기는데, 그것은 명세가 정한 위임 구조가 아니다 — 위임은 **표 단위**다.
-- =============================================================================

-- =============================================================================
-- 이 파일이 한 것
--   테이블 1 — planner_scopes (카테고리별 이용 여부 · **요율 없음**)
--   CHECK 4 · UNIQUE 1(카테고리당 동시에 선택된 플래너 1)
--   함수/트리거 1 — 활성 위임이 있는 플래너만 지정 가능
--   정책 4 — SELECT(커플·플래너·운영자) · INSERT·UPDATE(커플 구성원) · entity_events
--   GRANT  DELETE 회수 (해제는 status 변경이지 삭제가 아니다 · D-23)
--   기존 마이그레이션 수정 없음
--   **`has_planner_scope`(0005)를 건드리지 않았다** — 열람과 과금은 다른 축이다.
-- =============================================================================
