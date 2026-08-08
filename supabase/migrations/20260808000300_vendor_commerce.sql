-- =============================================================================
-- 0003 · 업체 · 상품 · 가격 / 재고 · 거래 · 결제
-- 근거: docs/07_개발명세서.md §3.3(업체·상품·가격), §3.4(재고·거래·결제)
-- RLS 는 0005 에서만 작성한다.
--
-- 금지 확인(CLAUDE.md §2.2): 광고·유료 상위 노출·리베이트를 전제로 한 컬럼은
-- 이 파일에 존재하지 않는다. (ad_boost / sponsored_rank / promoted 류 전면 부재)
-- =============================================================================

-- =============================================================================
-- §3.3 업체 · 상품 · 가격
-- =============================================================================

-- 사업자번호는 암호화 저장. 배지는 투명계약·응답우수 등 사실 기반만 부여한다.
create table public.vendors (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  category    text not null,
  region_code text,
  biz_no_enc  text,
  status      public.vendor_status not null default 'pending',
  badge_flags text[] not null default '{}',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
comment on column public.vendors.biz_no_enc is '사업자번호 암호화 값. 평문 저장 금지.';
comment on column public.vendors.badge_flags is
  '사실 기반 배지(투명계약·응답우수)만. 유료 노출 배지 금지(CLAUDE.md §2.2).';
create index if not exists idx_vendors_region_category on public.vendors (region_code, category);
create index if not exists idx_vendors_status on public.vendors (status);
select public.attach_set_updated_at('vendors');

-- 입점 심사 서류(F-V-01)
create table public.vendor_documents (
  id           uuid primary key default gen_random_uuid(),
  vendor_id    uuid not null references public.vendors (id) on delete cascade,
  doc_type     text not null,
  storage_path text not null,
  verified_at  timestamptz,
  verifier_id  uuid references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists idx_vendor_documents_vendor_id on public.vendor_documents (vendor_id);
select public.attach_set_updated_at('vendor_documents');

-- 가격·정산은 owner 전용(§3.9)
create table public.vendor_members (
  id               uuid primary key default gen_random_uuid(),
  vendor_id        uuid not null references public.vendors (id) on delete cascade,
  user_id          uuid not null references auth.users (id) on delete cascade,
  vendor_role      public.vendor_member_role not null,
  permissions_json jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (vendor_id, user_id)
);
create index if not exists idx_vendor_members_user_id on public.vendor_members (user_id);
create index if not exists idx_vendor_members_vendor_id on public.vendor_members (vendor_id);
select public.attach_set_updated_at('vendor_members');

-- 공개 버킷(vendor-media)
create table public.vendor_media (
  id           uuid primary key default gen_random_uuid(),
  vendor_id    uuid not null references public.vendors (id) on delete cascade,
  type         text not null,
  storage_path text not null,
  sort_order   integer not null default 0,
  alt_text     text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists idx_vendor_media_vendor_sort
  on public.vendor_media (vendor_id, sort_order);
select public.attach_set_updated_at('vendor_media');

-- 총액 표기 강제(F-V-03). base_price_total NOT NULL 이 '별도 문의' 등록 차단의
-- 스키마 근거다 — 이 제약을 완화하지 말 것.
create table public.products (
  id                  uuid primary key default gen_random_uuid(),
  vendor_id           uuid not null references public.vendors (id) on delete cascade,
  category            text not null,
  name                text not null,
  base_price_total    bigint not null check (base_price_total >= 0),
  included_items_json jsonb not null default '[]'::jsonb,
  capacity_min        integer check (capacity_min is null or capacity_min >= 0),
  capacity_max        integer check (capacity_max is null or capacity_max >= 0),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint products_capacity_range_chk
    check (capacity_min is null or capacity_max is null or capacity_min <= capacity_max)
);
comment on column public.products.base_price_total is
  '총액 표기 강제(F-V-03). NOT NULL — 별도 문의 가격 등록 차단의 스키마 근거.';
create index if not exists idx_products_vendor_id on public.products (vendor_id);
create index if not exists idx_products_category on public.products (category);
create index if not exists idx_products_vendor_category on public.products (vendor_id, category);
select public.attach_set_updated_at('products');

-- 추가금 사전 등록. 미등록 항목 사후 청구 불가(F-V-04).
create table public.product_options (
  id                uuid primary key default gen_random_uuid(),
  product_id        uuid not null references public.products (id) on delete cascade,
  name              text not null,
  price             bigint not null check (price >= 0),
  is_mandatory      boolean not null default false,
  trigger_condition jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists idx_product_options_product_id on public.product_options (product_id);
select public.attach_set_updated_at('product_options');

-- 다이내믹 프라이싱(F-V-06). 할인 하한/상한 클램프는 lib/core/pricing 에서 계산한다.
create table public.price_rules (
  id             uuid primary key default gen_random_uuid(),
  vendor_id      uuid not null references public.vendors (id) on delete cascade,
  product_id     uuid references public.products (id) on delete cascade,
  rule_type      public.price_rule_type not null,
  condition_json jsonb not null default '{}'::jsonb,
  adjust_type    text not null,
  adjust_value   numeric not null,
  floor_price    bigint check (floor_price is null or floor_price >= 0),
  cap_price      bigint check (cap_price is null or cap_price >= 0),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint price_rules_floor_cap_chk
    check (floor_price is null or cap_price is null or floor_price <= cap_price)
);
create index if not exists idx_price_rules_vendor_id on public.price_rules (vendor_id);
create index if not exists idx_price_rules_product_id on public.price_rules (product_id);
select public.attach_set_updated_at('price_rules');

-- 참가격 인덱스(F-C-09). 공개 데이터(§3.9).
create table public.price_index (
  id           uuid primary key default gen_random_uuid(),
  region_code  text not null,
  category     text not null,
  guest_bucket text not null,
  season       text not null,
  p25          bigint check (p25 is null or p25 >= 0),
  p50          bigint check (p50 is null or p50 >= 0),
  p75          bigint check (p75 is null or p75 >= 0),
  sample_size  integer not null default 0 check (sample_size >= 0),
  source_type  text,
  collected_at timestamptz,
  version      text not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (region_code, category, guest_bucket, season, version)
);
create index if not exists idx_price_index_region_category
  on public.price_index (region_code, category);
select public.attach_set_updated_at('price_index');

-- 출처·표본 추적, 이상치 제외 사유
create table public.price_sources (
  id              uuid primary key default gen_random_uuid(),
  index_id        uuid not null references public.price_index (id) on delete cascade,
  source_name     text not null,
  source_url      text,
  raw_value       bigint check (raw_value is null or raw_value >= 0),
  verified_by     uuid references auth.users (id) on delete set null,
  excluded_reason text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists idx_price_sources_index_id on public.price_sources (index_id);
select public.attach_set_updated_at('price_sources');

-- =============================================================================
-- §3.4 재고 · 거래 · 결제
-- =============================================================================

-- 실재고 캘린더(F-V-05)
create table public.inventory_slots (
  id         uuid primary key default gen_random_uuid(),
  vendor_id  uuid not null references public.vendors (id) on delete cascade,
  product_id uuid references public.products (id) on delete cascade,
  slot_date  date not null,
  slot_time  time,
  capacity   integer not null default 1 check (capacity >= 0),
  remaining  integer not null default 1 check (remaining >= 0),
  status     text not null default 'open',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint inventory_slots_remaining_chk check (remaining <= capacity)
);
create index if not exists idx_inventory_slots_vendor_date
  on public.inventory_slots (vendor_id, slot_date);
create index if not exists idx_inventory_slots_product_date
  on public.inventory_slots (product_id, slot_date);
create index if not exists idx_inventory_slots_slot_date on public.inventory_slots (slot_date);
select public.attach_set_updated_at('inventory_slots');

-- 표준 요청 폼 1:N 문의
create table public.inquiries (
  id           uuid primary key default gen_random_uuid(),
  couple_id    uuid not null references public.couples (id) on delete cascade,
  request_json jsonb not null default '{}'::jsonb,
  status       text not null default 'open',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists idx_inquiries_couple_id on public.inquiries (couple_id);
select public.attach_set_updated_at('inquiries');

-- 업체별 응답 상태·SLA
create table public.inquiry_targets (
  id           uuid primary key default gen_random_uuid(),
  inquiry_id   uuid not null references public.inquiries (id) on delete cascade,
  vendor_id    uuid not null references public.vendors (id) on delete cascade,
  status       text not null default 'pending',
  responded_at timestamptz,
  sla_deadline timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (inquiry_id, vendor_id)
);
create index if not exists idx_inquiry_targets_vendor_id on public.inquiry_targets (vendor_id);
create index if not exists idx_inquiry_targets_inquiry_id on public.inquiry_targets (inquiry_id);
create index if not exists idx_inquiry_targets_sla_deadline on public.inquiry_targets (sla_deadline);
select public.attach_set_updated_at('inquiry_targets');

-- 표준 견적서(자유 텍스트 금지)
create table public.quotes (
  id                uuid primary key default gen_random_uuid(),
  inquiry_target_id uuid not null references public.inquiry_targets (id) on delete cascade,
  product_id        uuid references public.products (id) on delete set null,
  total_amount      bigint not null check (total_amount >= 0),
  valid_until       timestamptz,
  status            text not null default 'draft',
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists idx_quotes_inquiry_target_id on public.quotes (inquiry_target_id);
create index if not exists idx_quotes_product_id on public.quotes (product_id);
select public.attach_set_updated_at('quotes');

-- 정규화 항목. 실총액 환산 기준.
create table public.quote_items (
  id            uuid primary key default gen_random_uuid(),
  quote_id      uuid not null references public.quotes (id) on delete cascade,
  category_code text not null,
  label         text not null,
  amount        bigint not null check (amount >= 0),
  is_option     boolean not null default false,
  is_mandatory  boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_quote_items_quote_id on public.quote_items (quote_id);
select public.attach_set_updated_at('quote_items');

-- 예약 상태 보드(F-V-08)
create table public.bookings (
  id             uuid primary key default gen_random_uuid(),
  couple_id      uuid not null references public.couples (id) on delete cascade,
  vendor_id      uuid not null references public.vendors (id) on delete restrict,
  product_id     uuid references public.products (id) on delete set null,
  slot_id        uuid references public.inventory_slots (id) on delete set null,
  status         public.booking_status not null default 'hold',
  total_amount   bigint not null check (total_amount >= 0),
  deposit_amount bigint not null default 0 check (deposit_amount >= 0),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists idx_bookings_couple_id on public.bookings (couple_id);
create index if not exists idx_bookings_vendor_id on public.bookings (vendor_id);
create index if not exists idx_bookings_slot_id on public.bookings (slot_id);
create index if not exists idx_bookings_status on public.bookings (status);
select public.attach_set_updated_at('bookings');

-- 전자계약(F-C-15)
create table public.contracts (
  id               uuid primary key default gen_random_uuid(),
  booking_id       uuid not null references public.bookings (id) on delete cascade,
  template_version text,
  clauses_json     jsonb not null default '{}'::jsonb,
  status           text not null default 'draft',
  pdf_path         text,
  issued_at        timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists idx_contracts_booking_id on public.contracts (booking_id);
select public.attach_set_updated_at('contracts');

-- 본인확인 SMS 결과 포함
create table public.contract_signatures (
  id                  uuid primary key default gen_random_uuid(),
  contract_id         uuid not null references public.contracts (id) on delete cascade,
  signer_id           uuid references auth.users (id) on delete set null,
  signer_role         text not null,
  signed_at           timestamptz,
  verification_method text,
  ip_hash             text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
comment on column public.contract_signatures.ip_hash is 'IP 해시. 원문 IP 저장 금지(§7.3).';
create index if not exists idx_contract_signatures_contract_id
  on public.contract_signatures (contract_id);
select public.attach_set_updated_at('contract_signatures');

-- 웹훅 멱등 처리 키 보유(§6 코드 스타일 — Idempotency-Key)
create table public.payments (
  id               uuid primary key default gen_random_uuid(),
  booking_id       uuid references public.bookings (id) on delete set null,
  membership_id    uuid references public.memberships (id) on delete set null,
  toss_payment_key text unique,
  purpose          public.payment_purpose not null,
  amount           bigint not null check (amount >= 0),
  status           text not null default 'pending',
  raw_webhook_json jsonb,
  idempotency_key  text unique,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint payments_target_chk
    check (booking_id is not null or membership_id is not null)
);
create index if not exists idx_payments_booking_id on public.payments (booking_id);
create index if not exists idx_payments_membership_id on public.payments (membership_id);
create index if not exists idx_payments_status on public.payments (status);
select public.attach_set_updated_at('payments');

-- 에스크로(F-C-16). O-03(법무 결론) 확정 전까지 컬럼 정의만 유지하고
-- 집행 로직은 구현하지 않는다(CLAUDE.md §7.6).
create table public.escrow_holds (
  id                 uuid primary key default gen_random_uuid(),
  payment_id         uuid not null references public.payments (id) on delete cascade,
  held_amount        bigint not null check (held_amount >= 0),
  release_condition  jsonb not null default '{}'::jsonb,
  released_at        timestamptz,
  hold_reason        text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
comment on table public.escrow_holds is
  '에스크로 홀드. O-03 법무 결론 대기 — 컬럼 정의만 유지, 집행 로직 미구현.';
create index if not exists idx_escrow_holds_payment_id on public.escrow_holds (payment_id);
select public.attach_set_updated_at('escrow_holds');

-- 위약금 산정 결과 연결
create table public.refunds (
  id               uuid primary key default gen_random_uuid(),
  payment_id       uuid not null references public.payments (id) on delete cascade,
  amount           bigint not null check (amount >= 0),
  reason_code      text,
  penalty_applied  bigint not null default 0 check (penalty_applied >= 0),
  status           text not null default 'pending',
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists idx_refunds_payment_id on public.refunds (payment_id);
select public.attach_set_updated_at('refunds');

-- 정산. fee_rate 는 app_settings 파라미터를 적용 시점에 스냅샷한 값이다(O-02).
-- 코드에 요율을 하드코딩하지 않는다.
create table public.settlements (
  id           uuid primary key default gen_random_uuid(),
  vendor_id    uuid not null references public.vendors (id) on delete cascade,
  period_start date not null,
  period_end   date not null,
  gross_amount bigint not null default 0 check (gross_amount >= 0),
  fee_rate     numeric not null check (fee_rate >= 0),
  fee_amount   bigint not null default 0 check (fee_amount >= 0),
  net_amount   bigint not null default 0,
  status       text not null default 'draft',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (vendor_id, period_start, period_end),
  constraint settlements_period_chk check (period_start <= period_end)
);
comment on column public.settlements.fee_rate is
  '적용 수수료율 스냅샷. 기준값은 app_settings 참조(O-02 미확정). 하드코딩 금지.';
create index if not exists idx_settlements_vendor_id on public.settlements (vendor_id);
create index if not exists idx_settlements_period on public.settlements (period_start, period_end);
select public.attach_set_updated_at('settlements');

-- 건별 명세
create table public.settlement_items (
  id            uuid primary key default gen_random_uuid(),
  settlement_id uuid not null references public.settlements (id) on delete cascade,
  booking_id    uuid references public.bookings (id) on delete set null,
  amount        bigint not null default 0,
  adjustment    bigint not null default 0,
  memo          text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_settlement_items_settlement_id
  on public.settlement_items (settlement_id);
create index if not exists idx_settlement_items_booking_id
  on public.settlement_items (booking_id);
select public.attach_set_updated_at('settlement_items');

-- 분쟁 중재(F-A-12)
create table public.disputes (
  id              uuid primary key default gen_random_uuid(),
  booking_id      uuid not null references public.bookings (id) on delete cascade,
  raised_by       uuid references auth.users (id) on delete set null,
  reason_code     text not null,
  evidence_paths  text[] not null default '{}',
  status          text not null default 'open',
  resolution_json jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists idx_disputes_booking_id on public.disputes (booking_id);
create index if not exists idx_disputes_status on public.disputes (status);
select public.attach_set_updated_at('disputes');

-- =============================================================================
-- 이 파일이 생성한 테이블: 23
--   §3.3(9)  vendors, vendor_documents, vendor_members, vendor_media, products,
--            product_options, price_rules, price_index, price_sources
--   §3.4(14) inventory_slots, inquiries, inquiry_targets, quotes, quote_items,
--            bookings, contracts, contract_signatures, payments, escrow_holds,
--            refunds, settlements, settlement_items, disputes
-- =============================================================================
