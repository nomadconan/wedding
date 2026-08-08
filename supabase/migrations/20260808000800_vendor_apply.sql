-- =============================================================================
-- 0008 · 입점 신청·심사 (S2-01)
-- 근거: docs/07_개발명세서.md §2.2 F-V-01, §2.3 F-A-01, §3.3, §3.8, §3.9, §3.10,
--       §7.2 · §7.3, D-23
-- =============================================================================
-- 이 파일이 만드는 것
--  1) `entity_events` — §3.8 증거 보존 테이블. **insert-only**(D-23).
--     심사 상태 전이를 여기에 남긴다. 전체 스키마·타임라인 조회 API는 S4-03 이 이어받는다.
--  2) `vendor_applications` — 입점 신청서. **명세 §3 에 없는 신규 테이블이다.**
--     사유는 아래 NOTE 참조. §3.3 에 추가하도록 제안한다.
--  3) `vendor-documents` Storage 버킷(비공개). §3.10 목록에 없으나 F-V-01 의 서류 제출에
--     반드시 필요하다. 이것도 §3.10 에 추가하도록 제안한다.
--
-- NOTE — `vendor_applications` 를 새로 만든 이유
--   §2.2 F-V-01 은 심사 상태를 **신청 → 보완 → 승인·반려** 4단계로 요구하는데
--   §3.3 `vendors.status` 는 `pending|active|suspended` 3값뿐이라 '보완요청'·'반려'를
--   표현할 수 없다. 명세 내부가 어긋나 있다.
--   `vendor_status` 열거를 늘리는 대신 신청서를 별도 테이블로 둔 이유:
--     * `vendors` 는 **공개 카탈로그**의 기준 테이블이다. 심사 진행 상태·반려 사유·
--       대표자 연락처 같은 심사 전용 정보를 공개 테이블에 얹지 않는다.
--     * 재신청·재심사 이력을 남기려면 어차피 별도 레코드가 필요하다.
--   `vendors.status` 는 명세 그대로 두고 **승인 시 pending → active** 로만 바꾼다.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) entity_events (§3.8, D-23)
-- -----------------------------------------------------------------------------
create type public.entity_event_source as enum ('web', 'app', 'system', 'admin');

create table public.entity_events (
  id           uuid primary key default gen_random_uuid(),
  entity_type  text not null,
  entity_id    uuid not null,
  event_type   text not null,
  actor_id     uuid references auth.users (id) on delete set null,
  actor_role   text,
  before_state text,
  after_state  text,
  source       public.entity_event_source not null default 'web',
  ip_hash      text,
  occurred_at  timestamptz not null default now(),
  memo         text,
  created_at   timestamptz not null default now()
);

comment on table public.entity_events is
  '증거 보존의 단일 진실(D-23). insert-only — UPDATE·DELETE 정책을 어떤 역할에도 부여하지 않는다. 정정은 정정 이벤트 추가로만 한다.';
comment on column public.entity_events.memo is
  '요약만 기록. 원문 내용·Storage 경로를 담지 않는다(CLAUDE.md §5.3).';

create index if not exists idx_entity_events_entity
  on public.entity_events (entity_type, entity_id, occurred_at desc);
create index if not exists idx_entity_events_actor
  on public.entity_events (actor_id, occurred_at desc);

-- updated_at 을 두지 않는다. 수정되지 않는 테이블이므로 갱신 트리거도 붙이지 않는다.

-- -----------------------------------------------------------------------------
-- 2) vendor_applications (F-V-01 · F-A-01)
-- -----------------------------------------------------------------------------
create type public.vendor_application_status as enum (
  'submitted', 'revision_requested', 'approved', 'rejected'
);

create table public.vendor_applications (
  id                  uuid primary key default gen_random_uuid(),
  -- 업체당 신청서 1건. 재신청은 같은 행을 갱신하고 이력은 entity_events 가 남긴다.
  vendor_id           uuid not null unique references public.vendors (id) on delete cascade,
  applicant_id        uuid not null references auth.users (id) on delete cascade,
  representative_name text not null,
  -- 심사 담당자가 연락해야 하므로 평문으로 둔다. 이 테이블은 공개 읽기가 없고
  -- 신청자·해당 업체 멤버만 조회한다. 화면에는 마스킹해 노출한다(§7.3).
  contact_phone       text not null,
  -- 통신판매업 신고번호. 미신고 업체가 있을 수 있어 필수로 두지 않는다.
  mail_order_no       text,
  -- 사업자등록번호는 **평문으로 저장하지 않는다**(§7.2).
  -- 원본은 `vendors.biz_no_enc` 에 SHA-256 해시로만 남고, 화면 표시는 이 마스킹 값을 쓴다.
  biz_no_masked       text not null,
  -- 사업자 상태 조회 API 연동은 이번 범위 밖이다. 운영자가 서류를 보고 수동 확인한다.
  -- TODO(S2-01 후속): 국세청 사업자 상태 조회 API 연동 시 자동 대조로 교체한다.
  biz_no_verified_at  timestamptz,
  biz_no_verified_by  uuid references auth.users (id) on delete set null,
  status              public.vendor_application_status not null default 'submitted',
  review_note         text,
  reviewed_by         uuid references auth.users (id) on delete set null,
  reviewed_at         timestamptz,
  submitted_at        timestamptz not null default now(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  -- 반려·보완요청은 사유 없이 통과시키지 않는다(F-A-01 "승인·반려 사유 기록").
  constraint vendor_applications_review_note_required
    check (
      status not in ('rejected', 'revision_requested')
      or (review_note is not null and length(btrim(review_note)) > 0)
    )
);

comment on table public.vendor_applications is
  '입점 신청서(F-V-01)·심사 결과(F-A-01). 심사 전용 정보를 공개 테이블(vendors)에서 분리한다.';
comment on column public.vendor_applications.biz_no_masked is
  '표시용 마스킹 값. 원본은 vendors.biz_no_enc 에 해시로만 남는다 — 평문 조회 경로를 만들지 않는다.';

create index if not exists idx_vendor_applications_status
  on public.vendor_applications (status, submitted_at desc);
create index if not exists idx_vendor_applications_applicant
  on public.vendor_applications (applicant_id);

select public.attach_set_updated_at('vendor_applications');

-- -----------------------------------------------------------------------------
-- 3) Storage 버킷 — 심사 서류(비공개)
-- -----------------------------------------------------------------------------
-- §3.10 목록에는 없지만 F-V-01 의 서류 제출에 필요하다. 공개 버킷은 `vendor-media` 외에
-- 두지 않는다(CLAUDE.md §5.5)는 원칙에 따라 **비공개**로 만든다.
-- 접근은 서버가 발급하는 **서명 URL** 로만 한다 — storage.objects 에 정책을 만들지 않으므로
-- anon·authenticated 는 직접 접근할 수 없고 service_role 만 우회한다.
insert into storage.buckets (id, name, public)
values ('vendor-documents', 'vendor-documents', false)
on conflict (id) do nothing;

-- =============================================================================
-- RLS (§3.9)
--
--  * `entity_events` 는 **insert-only**다. UPDATE·DELETE 정책을 만들지 않는다.
--    INSERT 정책도 두지 않는다 — 이벤트는 서버(Route Handler)가 서비스롤로만 기록한다.
--    당사자 SELECT 는 자기 업체 이벤트에 한한다. 다른 엔티티 타입의 열람 정책은
--    해당 도메인을 만드는 태스크(S4-03 등)에서 **정책을 추가**한다.
--  * `vendor_applications` 는 §3.9 "입점 심사·상태 변경은 서비스롤(운영자)" 원칙을 따른다.
--    신청서 생성·심사는 전부 Route Handler(서비스롤)를 거치고, 클라이언트에는
--    **자기 신청서 SELECT 만** 허용한다.
-- =============================================================================

alter table public.entity_events enable row level security;

-- [01] 업체 이벤트는 해당 업체 멤버만 조회한다.
create policy entity_events_select_vendor on public.entity_events
  for select to authenticated
  using (entity_type = 'vendor' and public.is_vendor_member(entity_id));

alter table public.vendor_applications enable row level security;

-- [02] 신청자 본인 또는 해당 업체 멤버만 조회한다.
create policy vendor_applications_select on public.vendor_applications
  for select to authenticated
  using (applicant_id = auth.uid() or public.is_vendor_member(vendor_id));

-- =============================================================================
-- 이 파일이 생성한 것
--   테이블 2 — entity_events, vendor_applications
--   열거 2 — entity_event_source, vendor_application_status
--   Storage 버킷 1 — vendor-documents(비공개)
--   제약 — CHECK 1(반려·보완 사유 필수), FK 6, UNIQUE 1
--   인덱스 4, RLS 정책 2(SELECT 전용)
-- =============================================================================
