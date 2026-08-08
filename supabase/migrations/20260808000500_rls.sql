-- =============================================================================
-- 0005 · RLS 활성화 + 정책
-- 근거: docs/07_개발명세서.md §3.9(RLS 정책 원칙), §1.4(역할)
--
-- 원칙
--  1) 전 테이블 RLS 활성화. 기본은 거부이며 필요한 것만 허용한다.
--  2) 커플 데이터: couple_members 소속 user_id 만. 결제·계약 서명은 member_role='owner' 추가.
--  3) 업체 데이터: vendor_members 소속 + vendor_role 조건. staff 는 가격·정산 UPDATE 불가.
--  4) 플래너 위임: planner_engagements.status='active' 이고 기간 이내이며 scope 에
--     해당 테이블이 지정된 경우에만 SELECT.
--  5) 공개 데이터: vendors(active) / products / price_index / content_posts 는 anon SELECT.
--  6) 운영자(ops·admin): 클라이언트 정책을 부여하지 않는다. 서비스롤 경유 Route Handler
--     에서만 접근한다(service_role 은 RLS 를 우회한다).
--
--  "정책 없음(서비스롤 전용)" 블록은 RLS 만 켜고 정책을 만들지 않는다 = 전면 거부.
-- =============================================================================

-- =============================================================================
-- RLS 보조 함수 (security definer — 정책 내부 재귀 평가 방지)
-- =============================================================================

create or replace function public.is_couple_member(p_couple_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.couple_members m
    where m.couple_id = p_couple_id and m.user_id = auth.uid()
  );
$$;

create or replace function public.is_couple_owner(p_couple_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.couple_members m
    where m.couple_id = p_couple_id
      and m.user_id = auth.uid()
      and m.member_role = 'owner'
  );
$$;

-- couples.owner_id 직접 확인 — 커플 생성 직후 owner 멤버 행을 만들기 위한 부트스트랩용.
create or replace function public.owns_couple_record(p_couple_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.couples c
    where c.id = p_couple_id and c.owner_id = auth.uid()
  );
$$;

create or replace function public.shares_couple_with(p_user_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from public.couple_members me
    join public.couple_members other on other.couple_id = me.couple_id
    where me.user_id = auth.uid() and other.user_id = p_user_id
  );
$$;

create or replace function public.is_vendor_member(p_vendor_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.vendor_members vm
    where vm.vendor_id = p_vendor_id and vm.user_id = auth.uid()
  );
$$;

create or replace function public.is_vendor_owner(p_vendor_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.vendor_members vm
    where vm.vendor_id = p_vendor_id
      and vm.user_id = auth.uid()
      and vm.vendor_role = 'owner'
  );
$$;

-- 플래너 위임: status='active' + 기간 이내 + scope_json.tables 에 해당 테이블 지정.
create or replace function public.has_planner_scope(p_couple_id uuid, p_scope text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from public.planner_engagements e
    join public.planners p on p.id = e.planner_id
    where e.couple_id = p_couple_id
      and p.user_id = auth.uid()
      and e.status = 'active'
      and (e.valid_from is null or e.valid_from <= now())
      and (e.valid_to is null or e.valid_to >= now())
      and coalesce(e.scope_json -> 'tables', '[]'::jsonb) ? p_scope
  );
$$;

comment on function public.has_planner_scope(uuid, text) is
  '플래너 위임 열람 판정(§3.9). 범위·기간을 모두 만족해야 true.';

-- =============================================================================
-- §3.1 사용자 · 커플
-- =============================================================================

-- [01] profiles — 본인 + 같은 커플 구성원에게만 노출
alter table public.profiles enable row level security;
create policy profiles_select on public.profiles for select to authenticated
  using (user_id = auth.uid() or public.shares_couple_with(user_id));
create policy profiles_insert on public.profiles for insert to authenticated
  with check (user_id = auth.uid());
create policy profiles_update on public.profiles for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- [02] couples — 구성원 열람, 소유자만 변경. 플래너는 위임 범위 내 열람.
alter table public.couples enable row level security;
create policy couples_select on public.couples for select to authenticated
  using (public.is_couple_member(id) or public.has_planner_scope(id, 'couples'));
create policy couples_insert on public.couples for insert to authenticated
  with check (owner_id = auth.uid());
create policy couples_update on public.couples for update to authenticated
  using (public.is_couple_owner(id)) with check (public.is_couple_owner(id));
create policy couples_delete on public.couples for delete to authenticated
  using (public.is_couple_owner(id));

-- [03] couple_members — 소유자가 구성원을 관리. 생성 직후 부트스트랩 허용.
alter table public.couple_members enable row level security;
create policy couple_members_select on public.couple_members for select to authenticated
  using (public.is_couple_member(couple_id));
create policy couple_members_insert on public.couple_members for insert to authenticated
  with check (
    public.is_couple_owner(couple_id)
    or (user_id = auth.uid() and public.owns_couple_record(couple_id))
  );
create policy couple_members_update on public.couple_members for update to authenticated
  using (public.is_couple_owner(couple_id)) with check (public.is_couple_owner(couple_id));
create policy couple_members_delete on public.couple_members for delete to authenticated
  using (public.is_couple_owner(couple_id));

-- [04] couple_invites — 초대 발급은 소유자 전용. 코드 조회는 서버(서비스롤)에서 처리.
alter table public.couple_invites enable row level security;
create policy couple_invites_select on public.couple_invites for select to authenticated
  using (public.is_couple_member(couple_id));
create policy couple_invites_insert on public.couple_invites for insert to authenticated
  with check (public.is_couple_owner(couple_id));
create policy couple_invites_update on public.couple_invites for update to authenticated
  using (public.is_couple_owner(couple_id)) with check (public.is_couple_owner(couple_id));
create policy couple_invites_delete on public.couple_invites for delete to authenticated
  using (public.is_couple_owner(couple_id));

-- [05] onboarding_answers — 커플 구성원 전체
alter table public.onboarding_answers enable row level security;
create policy onboarding_answers_select on public.onboarding_answers for select to authenticated
  using (public.is_couple_member(couple_id));
create policy onboarding_answers_insert on public.onboarding_answers for insert to authenticated
  with check (public.is_couple_member(couple_id));
create policy onboarding_answers_update on public.onboarding_answers for update to authenticated
  using (public.is_couple_member(couple_id)) with check (public.is_couple_member(couple_id));
create policy onboarding_answers_delete on public.onboarding_answers for delete to authenticated
  using (public.is_couple_member(couple_id));

-- [06] memberships — 본인 것만. 상태 전이는 결제 웹훅(서비스롤)이 수행한다.
alter table public.memberships enable row level security;
create policy memberships_select on public.memberships for select to authenticated
  using (user_id = auth.uid());
create policy memberships_insert on public.memberships for insert to authenticated
  with check (user_id = auth.uid());

-- [07] subscription_payments — 본인 멤버십 이력 열람만. 쓰기는 서비스롤 전용.
alter table public.subscription_payments enable row level security;
create policy subscription_payments_select on public.subscription_payments for select to authenticated
  using (exists (
    select 1 from public.memberships m
    where m.id = subscription_payments.membership_id and m.user_id = auth.uid()
  ));

-- [08] consents — 본인 동의 로그. 사후 수정·삭제 불가(감사 목적).
alter table public.consents enable row level security;
create policy consents_select on public.consents for select to authenticated
  using (user_id = auth.uid());
create policy consents_insert on public.consents for insert to authenticated
  with check (user_id = auth.uid());

-- [09] data_deletion_requests — 본인 요청 생성·조회. 처리는 운영(서비스롤).
alter table public.data_deletion_requests enable row level security;
create policy data_deletion_requests_select on public.data_deletion_requests for select to authenticated
  using (user_id = auth.uid());
create policy data_deletion_requests_insert on public.data_deletion_requests for insert to authenticated
  with check (user_id = auth.uid());

-- =============================================================================
-- §3.2 일정 · 예산
-- =============================================================================

-- [10] task_templates — 체크리스트 생성 원본(개인정보 없음). 로그인 사용자 열람 허용.
alter table public.task_templates enable row level security;
create policy task_templates_select on public.task_templates for select to authenticated
  using (true);

-- [11] tasks — 커플 구성원 전체 + 플래너 위임 열람
alter table public.tasks enable row level security;
create policy tasks_select on public.tasks for select to authenticated
  using (public.is_couple_member(couple_id) or public.has_planner_scope(couple_id, 'tasks'));
create policy tasks_insert on public.tasks for insert to authenticated
  with check (public.is_couple_member(couple_id));
create policy tasks_update on public.tasks for update to authenticated
  using (public.is_couple_member(couple_id)) with check (public.is_couple_member(couple_id));
create policy tasks_delete on public.tasks for delete to authenticated
  using (public.is_couple_member(couple_id));

-- [12] budgets — 커플 구성원 전체 + 플래너 위임 열람
alter table public.budgets enable row level security;
create policy budgets_select on public.budgets for select to authenticated
  using (public.is_couple_member(couple_id) or public.has_planner_scope(couple_id, 'budgets'));
create policy budgets_insert on public.budgets for insert to authenticated
  with check (public.is_couple_member(couple_id));
create policy budgets_update on public.budgets for update to authenticated
  using (public.is_couple_member(couple_id)) with check (public.is_couple_member(couple_id));
create policy budgets_delete on public.budgets for delete to authenticated
  using (public.is_couple_member(couple_id));

-- [13] budget_items — 상위 budgets 를 통해 스코프 결정
alter table public.budget_items enable row level security;
create policy budget_items_select on public.budget_items for select to authenticated
  using (exists (select 1 from public.budgets b where b.id = budget_items.budget_id));
create policy budget_items_insert on public.budget_items for insert to authenticated
  with check (exists (
    select 1 from public.budgets b
    where b.id = budget_items.budget_id and public.is_couple_member(b.couple_id)
  ));
create policy budget_items_update on public.budget_items for update to authenticated
  using (exists (
    select 1 from public.budgets b
    where b.id = budget_items.budget_id and public.is_couple_member(b.couple_id)
  ))
  with check (exists (
    select 1 from public.budgets b
    where b.id = budget_items.budget_id and public.is_couple_member(b.couple_id)
  ));
create policy budget_items_delete on public.budget_items for delete to authenticated
  using (exists (
    select 1 from public.budgets b
    where b.id = budget_items.budget_id and public.is_couple_member(b.couple_id)
  ));

-- [14] expenses — 커플 구성원 전체 + 플래너 위임 열람
alter table public.expenses enable row level security;
create policy expenses_select on public.expenses for select to authenticated
  using (public.is_couple_member(couple_id) or public.has_planner_scope(couple_id, 'expenses'));
create policy expenses_insert on public.expenses for insert to authenticated
  with check (public.is_couple_member(couple_id));
create policy expenses_update on public.expenses for update to authenticated
  using (public.is_couple_member(couple_id)) with check (public.is_couple_member(couple_id));
create policy expenses_delete on public.expenses for delete to authenticated
  using (public.is_couple_member(couple_id));

-- =============================================================================
-- §3.7 중 커플 스코프 (0002 에서 생성)
-- =============================================================================

-- [15] guests — 커플 구성원 전체
alter table public.guests enable row level security;
create policy guests_select on public.guests for select to authenticated
  using (public.is_couple_member(couple_id) or public.has_planner_scope(couple_id, 'guests'));
create policy guests_insert on public.guests for insert to authenticated
  with check (public.is_couple_member(couple_id));
create policy guests_update on public.guests for update to authenticated
  using (public.is_couple_member(couple_id)) with check (public.is_couple_member(couple_id));
create policy guests_delete on public.guests for delete to authenticated
  using (public.is_couple_member(couple_id));

-- [16] seating_plans — 커플 구성원 전체
alter table public.seating_plans enable row level security;
create policy seating_plans_select on public.seating_plans for select to authenticated
  using (public.is_couple_member(couple_id) or public.has_planner_scope(couple_id, 'seating_plans'));
create policy seating_plans_insert on public.seating_plans for insert to authenticated
  with check (public.is_couple_member(couple_id));
create policy seating_plans_update on public.seating_plans for update to authenticated
  using (public.is_couple_member(couple_id)) with check (public.is_couple_member(couple_id));
create policy seating_plans_delete on public.seating_plans for delete to authenticated
  using (public.is_couple_member(couple_id));

-- =============================================================================
-- §3.3 업체 · 상품 · 가격
-- =============================================================================

-- [17] vendors — active 는 공개. 입점 심사·상태 변경은 서비스롤(운영자).
alter table public.vendors enable row level security;
create policy vendors_select_public on public.vendors for select to anon, authenticated
  using (status = 'active');
create policy vendors_select_member on public.vendors for select to authenticated
  using (public.is_vendor_member(id));
create policy vendors_update_owner on public.vendors for update to authenticated
  using (public.is_vendor_owner(id)) with check (public.is_vendor_owner(id));

-- [18] vendor_documents — 심사 서류. 업체 owner 전용, 심사는 서비스롤.
alter table public.vendor_documents enable row level security;
create policy vendor_documents_select on public.vendor_documents for select to authenticated
  using (public.is_vendor_owner(vendor_id));
create policy vendor_documents_insert on public.vendor_documents for insert to authenticated
  with check (public.is_vendor_owner(vendor_id));
create policy vendor_documents_update on public.vendor_documents for update to authenticated
  using (public.is_vendor_owner(vendor_id)) with check (public.is_vendor_owner(vendor_id));
create policy vendor_documents_delete on public.vendor_documents for delete to authenticated
  using (public.is_vendor_owner(vendor_id));

-- [19] vendor_members — 멤버 초대·권한 변경은 owner 전용(§1.4)
alter table public.vendor_members enable row level security;
create policy vendor_members_select on public.vendor_members for select to authenticated
  using (user_id = auth.uid() or public.is_vendor_member(vendor_id));
create policy vendor_members_insert on public.vendor_members for insert to authenticated
  with check (public.is_vendor_owner(vendor_id));
create policy vendor_members_update on public.vendor_members for update to authenticated
  using (public.is_vendor_owner(vendor_id)) with check (public.is_vendor_owner(vendor_id));
create policy vendor_members_delete on public.vendor_members for delete to authenticated
  using (public.is_vendor_owner(vendor_id));

-- [20] vendor_media — 공개 버킷 메타. active 업체는 공개 열람, 등록은 멤버(staff 포함).
alter table public.vendor_media enable row level security;
create policy vendor_media_select_public on public.vendor_media for select to anon, authenticated
  using (exists (
    select 1 from public.vendors v where v.id = vendor_media.vendor_id and v.status = 'active'
  ));
create policy vendor_media_select_member on public.vendor_media for select to authenticated
  using (public.is_vendor_member(vendor_id));
create policy vendor_media_insert on public.vendor_media for insert to authenticated
  with check (public.is_vendor_member(vendor_id));
create policy vendor_media_update on public.vendor_media for update to authenticated
  using (public.is_vendor_member(vendor_id)) with check (public.is_vendor_member(vendor_id));
create policy vendor_media_delete on public.vendor_media for delete to authenticated
  using (public.is_vendor_member(vendor_id));

-- [21] products — 공개 데이터(§3.9). 가격 테이블이므로 쓰기는 owner 전용(staff 불가).
alter table public.products enable row level security;
create policy products_select_public on public.products for select to anon, authenticated
  using (exists (
    select 1 from public.vendors v where v.id = products.vendor_id and v.status = 'active'
  ));
create policy products_select_member on public.products for select to authenticated
  using (public.is_vendor_member(vendor_id));
create policy products_insert on public.products for insert to authenticated
  with check (public.is_vendor_owner(vendor_id));
create policy products_update on public.products for update to authenticated
  using (public.is_vendor_owner(vendor_id)) with check (public.is_vendor_owner(vendor_id));
create policy products_delete on public.products for delete to authenticated
  using (public.is_vendor_owner(vendor_id));

-- [22] product_options — 사전 등록 추가금. 공개 열람, 쓰기는 owner 전용.
alter table public.product_options enable row level security;
create policy product_options_select_public on public.product_options for select to anon, authenticated
  using (exists (select 1 from public.products p where p.id = product_options.product_id));
create policy product_options_insert on public.product_options for insert to authenticated
  with check (exists (
    select 1 from public.products p
    where p.id = product_options.product_id and public.is_vendor_owner(p.vendor_id)
  ));
create policy product_options_update on public.product_options for update to authenticated
  using (exists (
    select 1 from public.products p
    where p.id = product_options.product_id and public.is_vendor_owner(p.vendor_id)
  ))
  with check (exists (
    select 1 from public.products p
    where p.id = product_options.product_id and public.is_vendor_owner(p.vendor_id)
  ));
create policy product_options_delete on public.product_options for delete to authenticated
  using (exists (
    select 1 from public.products p
    where p.id = product_options.product_id and public.is_vendor_owner(p.vendor_id)
  ));

-- [23] price_rules — 가격 테이블. staff 는 UPDATE 불가(§3.9). 비공개.
alter table public.price_rules enable row level security;
create policy price_rules_select on public.price_rules for select to authenticated
  using (public.is_vendor_member(vendor_id));
create policy price_rules_insert on public.price_rules for insert to authenticated
  with check (public.is_vendor_owner(vendor_id));
create policy price_rules_update on public.price_rules for update to authenticated
  using (public.is_vendor_owner(vendor_id)) with check (public.is_vendor_owner(vendor_id));
create policy price_rules_delete on public.price_rules for delete to authenticated
  using (public.is_vendor_owner(vendor_id));

-- [24] price_index — 공개 데이터(§3.9). 갱신은 배치(서비스롤).
alter table public.price_index enable row level security;
create policy price_index_select_public on public.price_index for select to anon, authenticated
  using (true);

-- [25] price_sources — 표본·제외 사유는 운영 큐레이션 정보. 정책 없음(서비스롤 전용).
alter table public.price_sources enable row level security;

-- =============================================================================
-- §3.4 재고 · 거래 · 결제
-- =============================================================================

-- [26] inventory_slots — active 업체 재고는 공개 열람. 등록은 멤버(staff 포함, §1.4).
alter table public.inventory_slots enable row level security;
create policy inventory_slots_select_public on public.inventory_slots for select to anon, authenticated
  using (exists (
    select 1 from public.vendors v where v.id = inventory_slots.vendor_id and v.status = 'active'
  ));
create policy inventory_slots_select_member on public.inventory_slots for select to authenticated
  using (public.is_vendor_member(vendor_id));
create policy inventory_slots_insert on public.inventory_slots for insert to authenticated
  with check (public.is_vendor_member(vendor_id));
create policy inventory_slots_update on public.inventory_slots for update to authenticated
  using (public.is_vendor_member(vendor_id)) with check (public.is_vendor_member(vendor_id));
create policy inventory_slots_delete on public.inventory_slots for delete to authenticated
  using (public.is_vendor_member(vendor_id));

-- [27] inquiries — 작성 커플 + 수신 업체
alter table public.inquiries enable row level security;
create policy inquiries_select on public.inquiries for select to authenticated
  using (
    public.is_couple_member(couple_id)
    or exists (
      select 1 from public.inquiry_targets t
      where t.inquiry_id = inquiries.id and public.is_vendor_member(t.vendor_id)
    )
  );
create policy inquiries_insert on public.inquiries for insert to authenticated
  with check (public.is_couple_member(couple_id));
create policy inquiries_update on public.inquiries for update to authenticated
  using (public.is_couple_member(couple_id)) with check (public.is_couple_member(couple_id));

-- [28] inquiry_targets — 커플은 생성·열람, 업체는 응답 상태 갱신
alter table public.inquiry_targets enable row level security;
create policy inquiry_targets_select on public.inquiry_targets for select to authenticated
  using (
    public.is_vendor_member(vendor_id)
    or exists (
      select 1 from public.inquiries i
      where i.id = inquiry_targets.inquiry_id and public.is_couple_member(i.couple_id)
    )
  );
create policy inquiry_targets_insert on public.inquiry_targets for insert to authenticated
  with check (exists (
    select 1 from public.inquiries i
    where i.id = inquiry_targets.inquiry_id and public.is_couple_member(i.couple_id)
  ));
create policy inquiry_targets_update on public.inquiry_targets for update to authenticated
  using (public.is_vendor_member(vendor_id)) with check (public.is_vendor_member(vendor_id));

-- [29] quotes — 발행 업체 + 수신 커플
alter table public.quotes enable row level security;
create policy quotes_select on public.quotes for select to authenticated
  using (exists (
    select 1 from public.inquiry_targets t
    join public.inquiries i on i.id = t.inquiry_id
    where t.id = quotes.inquiry_target_id
      and (public.is_vendor_member(t.vendor_id)
           or public.is_couple_member(i.couple_id)
           or public.has_planner_scope(i.couple_id, 'quotes'))
  ));
create policy quotes_insert on public.quotes for insert to authenticated
  with check (exists (
    select 1 from public.inquiry_targets t
    where t.id = quotes.inquiry_target_id and public.is_vendor_member(t.vendor_id)
  ));
create policy quotes_update on public.quotes for update to authenticated
  using (exists (
    select 1 from public.inquiry_targets t
    where t.id = quotes.inquiry_target_id and public.is_vendor_member(t.vendor_id)
  ))
  with check (exists (
    select 1 from public.inquiry_targets t
    where t.id = quotes.inquiry_target_id and public.is_vendor_member(t.vendor_id)
  ));

-- [30] quote_items — 상위 quotes 스코프를 그대로 따른다
alter table public.quote_items enable row level security;
create policy quote_items_select on public.quote_items for select to authenticated
  using (exists (select 1 from public.quotes q where q.id = quote_items.quote_id));
create policy quote_items_insert on public.quote_items for insert to authenticated
  with check (exists (
    select 1 from public.quotes q
    join public.inquiry_targets t on t.id = q.inquiry_target_id
    where q.id = quote_items.quote_id and public.is_vendor_member(t.vendor_id)
  ));
create policy quote_items_update on public.quote_items for update to authenticated
  using (exists (
    select 1 from public.quotes q
    join public.inquiry_targets t on t.id = q.inquiry_target_id
    where q.id = quote_items.quote_id and public.is_vendor_member(t.vendor_id)
  ))
  with check (exists (
    select 1 from public.quotes q
    join public.inquiry_targets t on t.id = q.inquiry_target_id
    where q.id = quote_items.quote_id and public.is_vendor_member(t.vendor_id)
  ));
create policy quote_items_delete on public.quote_items for delete to authenticated
  using (exists (
    select 1 from public.quotes q
    join public.inquiry_targets t on t.id = q.inquiry_target_id
    where q.id = quote_items.quote_id and public.is_vendor_member(t.vendor_id)
  ));

-- [31] bookings — 커플과 업체 양측 열람. 예약 생성은 커플, 상태 갱신은 커플 소유자·업체.
alter table public.bookings enable row level security;
create policy bookings_select on public.bookings for select to authenticated
  using (
    public.is_couple_member(couple_id)
    or public.is_vendor_member(vendor_id)
    or public.has_planner_scope(couple_id, 'bookings')
  );
create policy bookings_insert on public.bookings for insert to authenticated
  with check (public.is_couple_member(couple_id));
create policy bookings_update on public.bookings for update to authenticated
  using (public.is_couple_owner(couple_id) or public.is_vendor_member(vendor_id))
  with check (public.is_couple_owner(couple_id) or public.is_vendor_member(vendor_id));

-- [32] contracts — 당사자 열람만. 발행·상태 전이는 서버(서비스롤).
alter table public.contracts enable row level security;
create policy contracts_select on public.contracts for select to authenticated
  using (exists (
    select 1 from public.bookings b
    where b.id = contracts.booking_id
      and (public.is_couple_member(b.couple_id) or public.is_vendor_member(b.vendor_id))
  ));

-- [33] contract_signatures — 서명은 owner 권한 필요(§3.9)
alter table public.contract_signatures enable row level security;
create policy contract_signatures_select on public.contract_signatures for select to authenticated
  using (exists (
    select 1 from public.contracts c
    join public.bookings b on b.id = c.booking_id
    where c.id = contract_signatures.contract_id
      and (public.is_couple_member(b.couple_id) or public.is_vendor_member(b.vendor_id))
  ));
create policy contract_signatures_insert on public.contract_signatures for insert to authenticated
  with check (
    signer_id = auth.uid()
    and exists (
      select 1 from public.contracts c
      join public.bookings b on b.id = c.booking_id
      where c.id = contract_signatures.contract_id
        and (public.is_couple_owner(b.couple_id) or public.is_vendor_owner(b.vendor_id))
    )
  );

-- [34] payments — 결제는 owner 권한(§3.9). 쓰기는 웹훅(서비스롤) 전용.
alter table public.payments enable row level security;
create policy payments_select on public.payments for select to authenticated
  using (
    exists (
      select 1 from public.bookings b
      where b.id = payments.booking_id
        and (public.is_couple_owner(b.couple_id) or public.is_vendor_member(b.vendor_id))
    )
    or exists (
      select 1 from public.memberships m
      where m.id = payments.membership_id and m.user_id = auth.uid()
    )
  );

-- [35] escrow_holds — 열람만. 집행 로직은 O-03 확정 대기(서비스롤).
alter table public.escrow_holds enable row level security;
create policy escrow_holds_select on public.escrow_holds for select to authenticated
  using (exists (
    select 1 from public.payments p
    join public.bookings b on b.id = p.booking_id
    where p.id = escrow_holds.payment_id
      and (public.is_couple_owner(b.couple_id) or public.is_vendor_member(b.vendor_id))
  ));

-- [36] refunds — 커플 소유자 열람만. 산정·집행은 서비스롤.
alter table public.refunds enable row level security;
create policy refunds_select on public.refunds for select to authenticated
  using (exists (
    select 1 from public.payments p
    join public.bookings b on b.id = p.booking_id
    where p.id = refunds.payment_id and public.is_couple_owner(b.couple_id)
  ));

-- [37] settlements — 업체 멤버 열람만. 정산 집행은 admin(서비스롤), staff UPDATE 불가.
alter table public.settlements enable row level security;
create policy settlements_select on public.settlements for select to authenticated
  using (public.is_vendor_member(vendor_id));

-- [38] settlement_items — 상위 settlements 스코프 열람만
alter table public.settlement_items enable row level security;
create policy settlement_items_select on public.settlement_items for select to authenticated
  using (exists (select 1 from public.settlements s where s.id = settlement_items.settlement_id));

-- [39] disputes — 당사자가 제기·열람. 중재 결정은 운영자(서비스롤).
alter table public.disputes enable row level security;
create policy disputes_select on public.disputes for select to authenticated
  using (exists (
    select 1 from public.bookings b
    where b.id = disputes.booking_id
      and (public.is_couple_member(b.couple_id) or public.is_vendor_member(b.vendor_id))
  ));
create policy disputes_insert on public.disputes for insert to authenticated
  with check (
    raised_by = auth.uid()
    and exists (
      select 1 from public.bookings b
      where b.id = disputes.booking_id
        and (public.is_couple_member(b.couple_id) or public.is_vendor_member(b.vendor_id))
    )
  );

-- =============================================================================
-- §3.5 계약 검토 · 견적 정규화
-- =============================================================================

-- [40] documents — 소유 커플만(§3.9). purged_at 이후 storage_path 는 API 계층에서 제외한다.
alter table public.documents enable row level security;
create policy documents_select on public.documents for select to authenticated
  using (public.is_couple_member(couple_id));
create policy documents_insert on public.documents for insert to authenticated
  with check (public.is_couple_member(couple_id));
create policy documents_update on public.documents for update to authenticated
  using (public.is_couple_member(couple_id)) with check (public.is_couple_member(couple_id));
create policy documents_delete on public.documents for delete to authenticated
  using (public.is_couple_member(couple_id));

-- [41] document_analyses — 상위 documents 스코프. 실행·갱신은 서버(서비스롤).
alter table public.document_analyses enable row level security;
create policy document_analyses_select on public.document_analyses for select to authenticated
  using (exists (select 1 from public.documents d where d.id = document_analyses.document_id));

-- [42] findings — 상위 analyses 스코프. 생성은 파이프라인(서비스롤).
alter table public.findings enable row level security;
create policy findings_select on public.findings for select to authenticated
  using (exists (
    select 1 from public.document_analyses a where a.id = findings.analysis_id
  ));

-- [43] detect_rules — prompt_fragment 포함(내부 자산). 정책 없음(서비스롤 전용).
alter table public.detect_rules enable row level security;

-- [44] penalty_rules — 결정적 계산은 서버에서 수행. 정책 없음(서비스롤 전용).
alter table public.penalty_rules enable row level security;

-- [45] penalty_simulations — 커플 구성원 전체
alter table public.penalty_simulations enable row level security;
create policy penalty_simulations_select on public.penalty_simulations for select to authenticated
  using (public.is_couple_member(couple_id));
create policy penalty_simulations_insert on public.penalty_simulations for insert to authenticated
  with check (public.is_couple_member(couple_id));
create policy penalty_simulations_delete on public.penalty_simulations for delete to authenticated
  using (public.is_couple_member(couple_id));

-- [46] estimate_uploads — 상위 documents 스코프
alter table public.estimate_uploads enable row level security;
create policy estimate_uploads_select on public.estimate_uploads for select to authenticated
  using (exists (select 1 from public.documents d where d.id = estimate_uploads.document_id));

-- [47] estimate_items — 상위 estimate_uploads 스코프
alter table public.estimate_items enable row level security;
create policy estimate_items_select on public.estimate_items for select to authenticated
  using (exists (
    select 1 from public.estimate_uploads u where u.id = estimate_items.estimate_upload_id
  ));

-- [48] estimate_comparisons — 커플 구성원 전체
alter table public.estimate_comparisons enable row level security;
create policy estimate_comparisons_select on public.estimate_comparisons for select to authenticated
  using (public.is_couple_member(couple_id));
create policy estimate_comparisons_insert on public.estimate_comparisons for insert to authenticated
  with check (public.is_couple_member(couple_id));
create policy estimate_comparisons_delete on public.estimate_comparisons for delete to authenticated
  using (public.is_couple_member(couple_id));

-- =============================================================================
-- §3.6 AI 플래너 · 운영 로그
-- =============================================================================

-- [49] ai_conversations — 커플 구성원 전체
alter table public.ai_conversations enable row level security;
create policy ai_conversations_select on public.ai_conversations for select to authenticated
  using (public.is_couple_member(couple_id));
create policy ai_conversations_insert on public.ai_conversations for insert to authenticated
  with check (public.is_couple_member(couple_id));
create policy ai_conversations_update on public.ai_conversations for update to authenticated
  using (public.is_couple_member(couple_id)) with check (public.is_couple_member(couple_id));
create policy ai_conversations_delete on public.ai_conversations for delete to authenticated
  using (public.is_couple_member(couple_id));

-- [50] ai_messages — 상위 대화 스코프. 저장은 서버(서비스롤).
alter table public.ai_messages enable row level security;
create policy ai_messages_select on public.ai_messages for select to authenticated
  using (exists (
    select 1 from public.ai_conversations c where c.id = ai_messages.conversation_id
  ));

-- [51] ai_tool_calls — 툴 호출 감사. 상위 메시지 스코프 열람만.
alter table public.ai_tool_calls enable row level security;
create policy ai_tool_calls_select on public.ai_tool_calls for select to authenticated
  using (exists (select 1 from public.ai_messages m where m.id = ai_tool_calls.message_id));

-- [52] ai_call_logs — 품질·비용 대시보드 원천(운영자). 정책 없음(서비스롤 전용).
alter table public.ai_call_logs enable row level security;

-- [53] prompt_versions — 시스템 프롬프트 원문 보유. 정책 없음(서비스롤 전용).
alter table public.prompt_versions enable row level security;

-- =============================================================================
-- §3.7 후기 · 플래너 · 콘텐츠 · 알림
-- =============================================================================

-- [54] reviews — 공개 후기. 작성은 결제·계약 이력이 있는 커플 구성원만(F-C-17).
alter table public.reviews enable row level security;
create policy reviews_select_public on public.reviews for select to anon, authenticated
  using (status = 'published');
create policy reviews_select_author on public.reviews for select to authenticated
  using (public.is_couple_member(couple_id) or public.is_vendor_member(vendor_id));
create policy reviews_insert on public.reviews for insert to authenticated
  with check (
    public.is_couple_member(couple_id)
    and exists (
      select 1 from public.bookings b
      where b.id = reviews.booking_id
        and b.couple_id = reviews.couple_id
        and b.vendor_id = reviews.vendor_id
        and b.status in ('confirmed', 'fulfilled')
    )
  );
create policy reviews_update on public.reviews for update to authenticated
  using (public.is_couple_member(couple_id)) with check (public.is_couple_member(couple_id));
create policy reviews_delete on public.reviews for delete to authenticated
  using (public.is_couple_owner(couple_id));

-- [55] review_reports — 신고자와 대상 업체만 열람. 처리는 운영자(서비스롤).
alter table public.review_reports enable row level security;
create policy review_reports_select on public.review_reports for select to authenticated
  using (
    reporter_id = auth.uid()
    or exists (
      select 1 from public.reviews r
      where r.id = review_reports.review_id and public.is_vendor_member(r.vendor_id)
    )
  );
create policy review_reports_insert on public.review_reports for insert to authenticated
  with check (reporter_id = auth.uid());

-- [56] planners — active 프로필은 공개(마켓). 본인만 등록·수정.
alter table public.planners enable row level security;
create policy planners_select_public on public.planners for select to anon, authenticated
  using (status = 'active');
create policy planners_select_self on public.planners for select to authenticated
  using (user_id = auth.uid());
create policy planners_insert on public.planners for insert to authenticated
  with check (user_id = auth.uid());
create policy planners_update on public.planners for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- [57] planner_engagements — 위임 생성·철회는 커플 소유자. 플래너는 본인 건 열람.
alter table public.planner_engagements enable row level security;
create policy planner_engagements_select on public.planner_engagements for select to authenticated
  using (
    public.is_couple_member(couple_id)
    or exists (
      select 1 from public.planners p
      where p.id = planner_engagements.planner_id and p.user_id = auth.uid()
    )
  );
create policy planner_engagements_insert on public.planner_engagements for insert to authenticated
  with check (public.is_couple_owner(couple_id));
create policy planner_engagements_update on public.planner_engagements for update to authenticated
  using (public.is_couple_owner(couple_id)) with check (public.is_couple_owner(couple_id));
create policy planner_engagements_delete on public.planner_engagements for delete to authenticated
  using (public.is_couple_owner(couple_id));

-- [58] content_posts — 공개 데이터(§3.9). 발행은 운영자(서비스롤).
alter table public.content_posts enable row level security;
create policy content_posts_select_public on public.content_posts for select to anon, authenticated
  using (published_at is not null and published_at <= now());

-- [59] notifications — 본인 수신함. 읽음 처리만 갱신 가능.
alter table public.notifications enable row level security;
create policy notifications_select on public.notifications for select to authenticated
  using (user_id = auth.uid());
create policy notifications_update on public.notifications for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- [60] notification_prefs — 본인 수신 설정
alter table public.notification_prefs enable row level security;
create policy notification_prefs_select on public.notification_prefs for select to authenticated
  using (user_id = auth.uid());
create policy notification_prefs_insert on public.notification_prefs for insert to authenticated
  with check (user_id = auth.uid());
create policy notification_prefs_update on public.notification_prefs for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy notification_prefs_delete on public.notification_prefs for delete to authenticated
  using (user_id = auth.uid());

-- [61] share_links — 토큰 대조는 서버에서만 수행한다. 정책 없음(서비스롤 전용).
alter table public.share_links enable row level security;

-- =============================================================================
-- §3.8 운영 · 시스템
-- =============================================================================

-- [62] audit_logs — 감사 기록. 클라이언트 접근 전면 차단. 정책 없음(서비스롤 전용).
alter table public.audit_logs enable row level security;

-- [63] feature_flags — 정책 없음(서비스롤 전용).
--
--      클라이언트에 플래그 목록을 노출하지 않는다. 미공개 R2·R3 기능의 '존재' 자체가
--      드러나면 D-09 의 '만들어 두고 켜지 않는다' 전략이 무력해지기 때문이다(§1.3).
--      플래그 평가는 Route Handler(서비스롤)에서만 수행하고 클라이언트에는
--      평가 결과만 내려보낸다. anon·authenticated 는 SELECT 도 갖지 않는다
--      (아래 GRANT 절에서 명시적으로 revoke).
alter table public.feature_flags enable row level security;

-- [64] app_settings — 수수료 요율 등 운영 파라미터. 정책 없음(서비스롤 전용).
alter table public.app_settings enable row level security;

-- [65] tickets — 본인 문의만 열람·생성. 처리는 운영자(서비스롤).
alter table public.tickets enable row level security;
create policy tickets_select on public.tickets for select to authenticated
  using (reporter_id = auth.uid());
create policy tickets_insert on public.tickets for insert to authenticated
  with check (reporter_id = auth.uid());

-- [66] job_runs — 배치 실행 이력. 정책 없음(서비스롤 전용).
alter table public.job_runs enable row level security;

-- =============================================================================
-- 역할별 테이블 권한 (GRANT)
-- =============================================================================
-- 마이그레이션은 postgres 역할로 실행된다. Supabase 의 기본 권한(pg_default_acl)은
-- postgres 가 만든 테이블에 대해 anon·authenticated·service_role 에게 Dxtm
-- (TRUNCATE/REFERENCES/TRIGGER/MAINTAIN)만 부여하고 SELECT/INSERT/UPDATE/DELETE 는
-- 부여하지 않는다. GRANT 가 없으면 정책 평가 이전에 permission denied 로 막히므로
-- 위 정책이 전부 무력해진다. 따라서 여기서 명시적으로 부여한다.
--
-- 실제 행 단위 경계는 어디까지나 위의 RLS 정책이다(CLAUDE.md §5.5).
-- GRANT 는 그보다 앞선 거친 필터일 뿐이며, anon 에는 SELECT 만 준다.
-- =============================================================================

grant usage on schema public to anon, authenticated, service_role;

grant select on all tables in schema public to anon;
grant select, insert, update, delete on all tables in schema public to authenticated, service_role;
grant usage, select on all sequences in schema public to anon, authenticated, service_role;

-- feature_flags 는 위 일괄 GRANT 의 예외다. 미공개 기능의 존재 노출을 막기 위해
-- 클라이언트 역할에서 테이블 권한 자체를 회수한다([63] 참조). 서비스롤만 접근한다.
revoke all on public.feature_flags from anon, authenticated;

-- 이후 마이그레이션에서 추가되는 테이블에도 같은 권한이 자동 적용되도록 한다.
alter default privileges in schema public
  grant select on tables to anon;
alter default privileges in schema public
  grant select, insert, update, delete on tables to authenticated, service_role;
alter default privileges in schema public
  grant usage, select on sequences to anon, authenticated, service_role;

-- =============================================================================
-- 검산표 — 테이블 수 = 정책 블록 수
-- =============================================================================
--
--  파일                          테이블 수   정책 블록 수
--  ---------------------------   ---------   ------------
--  0002_core.sql                        16             16   ([01]~[16])
--  0003_vendor_commerce.sql             23             23   ([17]~[39])
--  0004_ai_ops.sql                      27             27   ([40]~[66])
--  ---------------------------   ---------   ------------
--  합계                                 66             66
--
--  블록 번호는 1..66 연속이며 누락·중복이 없다.
--  "정책 없음(서비스롤 전용)" 블록 10종은 RLS 만 활성화한 전면 거부 블록이다:
--    [25] price_sources   [43] detect_rules    [44] penalty_rules
--    [52] ai_call_logs    [53] prompt_versions [61] share_links
--    [62] audit_logs      [63] feature_flags   [64] app_settings
--    [66] job_runs
--
--  이 중 feature_flags 만 테이블 GRANT 까지 회수한다(anon·authenticated 권한 없음).
--  나머지 9종은 GRANT 는 있으나 정책이 없어 행이 하나도 보이지 않는 상태다.
--
--  검산 쿼리 (로컬에서 직접 확인):
--    -- (1) RLS 미활성 테이블이 0건이어야 한다
--    select c.relname from pg_class c
--      join pg_namespace n on n.oid = c.relnamespace
--     where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity = false;
--
--    -- (2) public 테이블 수가 66 이어야 한다
--    select count(*) from pg_class c
--      join pg_namespace n on n.oid = c.relnamespace
--     where n.nspname = 'public' and c.relkind = 'r';
--
--    -- (3) 정책이 하나도 없는 테이블은 위 10종과 정확히 일치해야 한다
--    select c.relname from pg_class c
--      join pg_namespace n on n.oid = c.relnamespace
--      left join pg_policy p on p.polrelid = c.oid
--     where n.nspname = 'public' and c.relkind = 'r'
--     group by c.relname having count(p.oid) = 0 order by 1;
--
--    -- (4) anon·authenticated 가 SELECT 권한을 갖지 않는 테이블은 feature_flags 뿐이어야 한다
--    select c.relname from pg_class c
--      join pg_namespace n on n.oid = c.relnamespace
--     where n.nspname = 'public' and c.relkind = 'r'
--       and not has_table_privilege('authenticated', c.oid, 'SELECT')
--     order by 1;
-- =============================================================================
