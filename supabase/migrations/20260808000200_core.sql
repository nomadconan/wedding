-- =============================================================================
-- 0002 · 코어 (사용자·커플 / 일정·예산 / 커플 스코프 부가 데이터)
-- 근거: docs/07_개발명세서.md §3.1(사용자·커플), §3.2(일정·예산),
--       §3.7 중 커플 스코프 테이블(guests, seating_plans)
-- RLS 는 0005 에서만 작성한다.
-- =============================================================================

-- =============================================================================
-- §3.1 사용자 · 커플
-- =============================================================================

-- auth.users 확장 프로필. 전화번호는 원문이 아니라 해시로 저장한다(§7.3).
create table public.profiles (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null unique references auth.users (id) on delete cascade,
  display_name     text,
  phone_hash       text,
  role             public.user_role not null default 'consumer',
  avatar_url       text,
  marketing_opt_in boolean not null default false,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
comment on column public.profiles.phone_hash is '전화번호 해시. 원문 저장 금지(§7.3).';
create index if not exists idx_profiles_role on public.profiles (role);
select public.attach_set_updated_at('profiles');

-- 서비스 데이터의 기준 스코프. 온보딩 결과로 생성된다(F-C-01).
create table public.couples (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null references auth.users (id) on delete restrict,
  wedding_date date,
  region_code  text,
  guest_count  integer check (guest_count is null or guest_count >= 0),
  total_budget bigint  check (total_budget is null or total_budget >= 0),
  style_tags   text[] not null default '{}',
  stage        text not null default 'onboarding',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
comment on column public.couples.stage is
  '온보딩·준비 단계. 값 집합은 명세서 미확정이므로 text 로 둔다.';
create index if not exists idx_couples_owner_id on public.couples (owner_id);
create index if not exists idx_couples_wedding_date on public.couples (wedding_date);
create index if not exists idx_couples_region_code on public.couples (region_code);
select public.attach_set_updated_at('couples');

-- 동일 couple_id 데이터 공유 범위를 정의한다. RLS 의 기준 테이블(§3.9).
create table public.couple_members (
  id          uuid primary key default gen_random_uuid(),
  couple_id   uuid not null references public.couples (id) on delete cascade,
  user_id     uuid not null references auth.users (id) on delete cascade,
  member_role public.couple_member_role not null,
  joined_at   timestamptz not null default now(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (couple_id, user_id)
);
create index if not exists idx_couple_members_user_id on public.couple_members (user_id);
create index if not exists idx_couple_members_couple_id on public.couple_members (couple_id);
select public.attach_set_updated_at('couple_members');

-- 초대 코드·딥링크(F-C-02)
create table public.couple_invites (
  id          uuid primary key default gen_random_uuid(),
  couple_id   uuid not null references public.couples (id) on delete cascade,
  code        text not null unique,
  expires_at  timestamptz not null,
  accepted_by uuid references auth.users (id) on delete set null,
  accepted_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists idx_couple_invites_couple_id on public.couple_invites (couple_id);
create index if not exists idx_couple_invites_expires_at on public.couple_invites (expires_at);
select public.attach_set_updated_at('couple_invites');

-- 온보딩 6문항. 초기 체크리스트·예산 배분의 입력.
create table public.onboarding_answers (
  id           uuid primary key default gen_random_uuid(),
  couple_id    uuid not null references public.couples (id) on delete cascade,
  question_key text not null,
  answer_json  jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (couple_id, question_key)
);
create index if not exists idx_onboarding_answers_couple_id on public.onboarding_answers (couple_id);
select public.attach_set_updated_at('onboarding_answers');

-- 멤버십 상태(F-C-19)
create table public.memberships (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  plan       public.membership_plan not null default 'free',
  status     text not null default 'active',
  started_at timestamptz,
  expires_at timestamptz,
  source     text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_memberships_user_id on public.memberships (user_id);
create index if not exists idx_memberships_expires_at on public.memberships (expires_at);
select public.attach_set_updated_at('memberships');

-- 정기결제 이력
create table public.subscription_payments (
  id               uuid primary key default gen_random_uuid(),
  membership_id    uuid not null references public.memberships (id) on delete cascade,
  toss_payment_key text unique,
  amount           bigint not null check (amount >= 0),
  billing_cycle    text,
  status           text not null default 'pending',
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists idx_subscription_payments_membership_id
  on public.subscription_payments (membership_id);
select public.attach_set_updated_at('subscription_payments');

-- 약관·개인정보·문서파기 정책 동의 로그
create table public.consents (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  consent_type text not null,
  version      text not null,
  agreed_at    timestamptz not null default now(),
  ip_hash      text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
comment on column public.consents.ip_hash is 'IP 해시. 원문 IP 저장 금지(§7.3).';
create index if not exists idx_consents_user_type on public.consents (user_id, consent_type);
select public.attach_set_updated_at('consents');

-- 삭제 요청 SLA 추적(F-A-08)
create table public.data_deletion_requests (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  requested_at timestamptz not null default now(),
  scope        text not null,
  status       text not null default 'pending',
  completed_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists idx_data_deletion_requests_user_id
  on public.data_deletion_requests (user_id);
create index if not exists idx_data_deletion_requests_status
  on public.data_deletion_requests (status);
select public.attach_set_updated_at('data_deletion_requests');

-- =============================================================================
-- §3.2 일정 · 예산
-- =============================================================================

-- D-360~D-0 역산 생성 원본 (시드 데이터 — 시드 자체는 별도 태스크)
create table public.task_templates (
  id            uuid primary key default gen_random_uuid(),
  category      text not null,
  title         text not null,
  offset_days   integer not null,
  default_owner text,
  description   text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
comment on column public.task_templates.offset_days is
  '예식일 기준 오프셋(D-360 → -360). 역산 생성에 사용한다.';
create index if not exists idx_task_templates_category on public.task_templates (category);
select public.attach_set_updated_at('task_templates');

-- 체크리스트(F-C-04)
create table public.tasks (
  id          uuid primary key default gen_random_uuid(),
  couple_id   uuid not null references public.couples (id) on delete cascade,
  category    text not null,
  title       text not null,
  due_date    date,
  status      text not null default 'todo',
  assignee_id uuid references auth.users (id) on delete set null,
  source      public.task_source not null default 'manual',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists idx_tasks_couple_id on public.tasks (couple_id);
create index if not exists idx_tasks_couple_due on public.tasks (couple_id, due_date);
create index if not exists idx_tasks_status on public.tasks (status);
select public.attach_set_updated_at('tasks');

-- 카테고리별 권장 배분 결과(F-C-05)
create table public.budgets (
  id              uuid primary key default gen_random_uuid(),
  couple_id       uuid not null references public.couples (id) on delete cascade,
  total_amount    bigint not null default 0 check (total_amount >= 0),
  allocation_json jsonb not null default '{}'::jsonb,
  index_version   text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists idx_budgets_couple_id on public.budgets (couple_id);
select public.attach_set_updated_at('budgets');

-- 계획 대비 실지출
create table public.budget_items (
  id                uuid primary key default gen_random_uuid(),
  budget_id         uuid not null references public.budgets (id) on delete cascade,
  category          text not null,
  planned_amount    bigint not null default 0 check (planned_amount >= 0),
  contracted_amount bigint not null default 0 check (contracted_amount >= 0),
  spent_amount      bigint not null default 0 check (spent_amount >= 0),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists idx_budget_items_budget_id on public.budget_items (budget_id);
create index if not exists idx_budget_items_category on public.budget_items (category);
select public.attach_set_updated_at('budget_items');

-- 견적·계약 확정 시 자동 반영
create table public.expenses (
  id             uuid primary key default gen_random_uuid(),
  couple_id      uuid not null references public.couples (id) on delete cascade,
  budget_item_id uuid references public.budget_items (id) on delete set null,
  amount         bigint not null check (amount >= 0),
  paid_at        timestamptz,
  memo           text,
  source_ref     text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists idx_expenses_couple_id on public.expenses (couple_id);
create index if not exists idx_expenses_budget_item_id on public.expenses (budget_item_id);
select public.attach_set_updated_at('expenses');

-- =============================================================================
-- §3.7 중 커플 스코프 테이블 (하객·좌석 — 커플 데이터이므로 코어에 배치)
-- =============================================================================

-- 하객 관리(F-C-22). 연락처는 해시 저장.
create table public.guests (
  id           uuid primary key default gen_random_uuid(),
  couple_id    uuid not null references public.couples (id) on delete cascade,
  name         text not null,
  side         text,
  contact_hash text,
  rsvp_status  text not null default 'pending',
  party_size   integer not null default 1 check (party_size >= 0),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
comment on column public.guests.contact_hash is '연락처 해시. 원문 저장 금지(§7.3).';
create index if not exists idx_guests_couple_id on public.guests (couple_id);
create index if not exists idx_guests_rsvp_status on public.guests (rsvp_status);
select public.attach_set_updated_at('guests');

-- 좌석 배치 초안
create table public.seating_plans (
  id          uuid primary key default gen_random_uuid(),
  couple_id   uuid not null references public.couples (id) on delete cascade,
  layout_json jsonb not null default '{}'::jsonb,
  version     integer not null default 1,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists idx_seating_plans_couple_id on public.seating_plans (couple_id);
select public.attach_set_updated_at('seating_plans');

-- =============================================================================
-- 이 파일이 생성한 테이블: 16
--   §3.1(9) profiles, couples, couple_members, couple_invites, onboarding_answers,
--           memberships, subscription_payments, consents, data_deletion_requests
--   §3.2(5) task_templates, tasks, budgets, budget_items, expenses
--   §3.7(2) guests, seating_plans
-- =============================================================================
