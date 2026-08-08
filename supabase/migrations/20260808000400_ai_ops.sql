-- =============================================================================
-- 0004 · 계약검토 · 룰엔진 / AI 플래너 · 운영 로그 / 후기 · 플래너 · 콘텐츠 · 알림
--        / 운영 · 시스템
-- 근거: docs/07_개발명세서.md §3.5, §3.6, §3.7(커플 스코프 제외분), §3.8
-- RLS 는 0005 에서만 작성한다.
-- =============================================================================

-- =============================================================================
-- §3.5 계약 검토 · 견적 정규화
-- =============================================================================

-- 업로드 원문. 분석 완료 후 24시간 내 파기 대상(CLAUDE.md §5.1).
-- purge_scheduled_at 는 NOT NULL — 파기 예약 누락을 구조적으로 차단한다.
-- storage_path 는 어떤 로그에도 남기지 않는다.
create table public.documents (
  id                 uuid primary key default gen_random_uuid(),
  couple_id          uuid not null references public.couples (id) on delete cascade,
  doc_type           public.document_type not null,
  storage_path       text not null,
  mime               text,
  page_count         integer check (page_count is null or page_count >= 0),
  purge_scheduled_at timestamptz not null,
  purged_at          timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
comment on column public.documents.purge_scheduled_at is
  'NOT NULL 필수. 파기 예약 누락 차단(CLAUDE.md §5.1). 배치가 이 시각 기준으로 원문을 삭제한다.';
comment on column public.documents.storage_path is
  '로그 금지 대상. purged_at IS NOT NULL 이면 API 응답에서 제외한다(§3.9).';
create index if not exists idx_documents_couple_id on public.documents (couple_id);
create index if not exists idx_documents_purge_pending
  on public.documents (purge_scheduled_at) where purged_at is null;
select public.attach_set_updated_at('documents');

-- 분석 실행 단위
create table public.document_analyses (
  id             uuid primary key default gen_random_uuid(),
  document_id    uuid not null references public.documents (id) on delete cascade,
  status         text not null default 'queued',
  rule_version   text,
  prompt_version text,
  model          text,
  risk_score     integer check (risk_score is null or (risk_score between 0 and 100)),
  latency_ms     integer,
  token_in       integer,
  token_out      integer,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists idx_document_analyses_document_id
  on public.document_analyses (document_id);
create index if not exists idx_document_analyses_status on public.document_analyses (status);
select public.attach_set_updated_at('document_analyses');

-- 인용 대조 실패 finding 은 개별 폐기(§5.2). 저장되는 인용은 마스킹본이다.
create table public.findings (
  id                    uuid primary key default gen_random_uuid(),
  analysis_id           uuid not null references public.document_analyses (id) on delete cascade,
  rule_code             text not null,
  severity              public.finding_severity not null,
  clause_excerpt_masked text,
  basis_ref             text,
  explanation           text,
  negotiation_script    text,
  citation_verified     boolean not null default false,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
comment on column public.findings.clause_excerpt_masked is
  '마스킹된 조항 인용만 저장한다. 원문 저장 금지(CLAUDE.md §5.1·§5.2).';
create index if not exists idx_findings_analysis_id on public.findings (analysis_id);
create index if not exists idx_findings_rule_code on public.findings (rule_code);
create index if not exists idx_findings_severity on public.findings (severity);
select public.attach_set_updated_at('findings');

-- 검출 룰 20종. lib/core/rules 와 seed.sql 로 동기화한다(시드는 별도 태스크).
create table public.detect_rules (
  id               uuid primary key default gen_random_uuid(),
  code             text not null unique,
  title            text not null,
  category         text,
  severity_default public.finding_severity not null,
  pattern_json     jsonb not null default '{}'::jsonb,
  prompt_fragment  text,
  basis_ref        text,
  version          text not null,
  is_active        boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists idx_detect_rules_active on public.detect_rules (is_active);
select public.attach_set_updated_at('detect_rules');

-- 소비자분쟁해결기준 기반 결정적 계산. LLM 미사용(CLAUDE.md §3.1).
create table public.penalty_rules (
  id            uuid primary key default gen_random_uuid(),
  category      text not null,
  cancel_window text not null,
  standard_rate numeric not null check (standard_rate >= 0),
  basis_ref     text,
  version       text not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (category, cancel_window, version)
);
create index if not exists idx_penalty_rules_category on public.penalty_rules (category);
select public.attach_set_updated_at('penalty_rules');

-- 시뮬레이터 결과 저장(F-C-08). 초과분은 '기준 대비 비교값'으로만 표현한다(§7.7).
create table public.penalty_simulations (
  id              uuid primary key default gen_random_uuid(),
  couple_id       uuid not null references public.couples (id) on delete cascade,
  inputs_json     jsonb not null default '{}'::jsonb,
  standard_amount bigint not null default 0,
  contract_amount bigint not null default 0,
  excess_amount   bigint not null default 0,
  rule_version    text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists idx_penalty_simulations_couple_id
  on public.penalty_simulations (couple_id);
select public.attach_set_updated_at('penalty_simulations');

-- 견적 업로드 단위
create table public.estimate_uploads (
  id                 uuid primary key default gen_random_uuid(),
  document_id        uuid not null references public.documents (id) on delete cascade,
  vendor_name_masked text,
  parsed_status      text not null default 'pending',
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists idx_estimate_uploads_document_id
  on public.estimate_uploads (document_id);
select public.attach_set_updated_at('estimate_uploads');

-- 표준 카테고리 매핑 결과
create table public.estimate_items (
  id                 uuid primary key default gen_random_uuid(),
  estimate_upload_id uuid not null references public.estimate_uploads (id) on delete cascade,
  raw_label          text not null,
  mapped_category    text,
  amount             bigint not null default 0,
  is_option          boolean not null default false,
  confidence         numeric check (confidence is null or (confidence between 0 and 1)),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists idx_estimate_items_upload_id
  on public.estimate_items (estimate_upload_id);
select public.attach_set_updated_at('estimate_items');

-- 2~5개 병렬 비교표(F-C-06)
create table public.estimate_comparisons (
  id              uuid primary key default gen_random_uuid(),
  couple_id       uuid not null references public.couples (id) on delete cascade,
  upload_ids      uuid[] not null default '{}',
  normalized_json jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists idx_estimate_comparisons_couple_id
  on public.estimate_comparisons (couple_id);
select public.attach_set_updated_at('estimate_comparisons');

-- =============================================================================
-- §3.6 AI 플래너 · 운영 로그
-- =============================================================================

-- 플래너 대화 세션
create table public.ai_conversations (
  id                    uuid primary key default gen_random_uuid(),
  couple_id             uuid not null references public.couples (id) on delete cascade,
  title                 text,
  context_snapshot_json jsonb not null default '{}'::jsonb,
  last_message_at       timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index if not exists idx_ai_conversations_couple_id on public.ai_conversations (couple_id);
create index if not exists idx_ai_conversations_last_message_at
  on public.ai_conversations (last_message_at desc);
select public.attach_set_updated_at('ai_conversations');

-- 스트리밍 결과 저장
create table public.ai_messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.ai_conversations (id) on delete cascade,
  role            text not null,
  content         text,
  tool_calls_json jsonb,
  token_in        integer,
  token_out       integer,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists idx_ai_messages_conversation_id
  on public.ai_messages (conversation_id, created_at);
select public.attach_set_updated_at('ai_messages');

-- 툴 호출 감사(§5.5)
create table public.ai_tool_calls (
  id             uuid primary key default gen_random_uuid(),
  message_id     uuid not null references public.ai_messages (id) on delete cascade,
  tool_name      text not null,
  arguments_json jsonb,
  result_summary text,
  latency_ms     integer,
  error          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists idx_ai_tool_calls_message_id on public.ai_tool_calls (message_id);
create index if not exists idx_ai_tool_calls_tool_name on public.ai_tool_calls (tool_name);
select public.attach_set_updated_at('ai_tool_calls');

-- 품질·비용 대시보드 원천(F-A-04)
create table public.ai_call_logs (
  id                uuid primary key default gen_random_uuid(),
  feature           public.ai_feature not null,
  model             text,
  prompt_version    text,
  validation_result text,
  retry_count       integer not null default 0 check (retry_count >= 0),
  cost_estimate     numeric,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists idx_ai_call_logs_feature_created
  on public.ai_call_logs (feature, created_at desc);
select public.attach_set_updated_at('ai_call_logs');

-- 배포·롤백 이력(F-A-03)
create table public.prompt_versions (
  id            uuid primary key default gen_random_uuid(),
  feature       public.ai_feature not null,
  version       text not null,
  system_prompt text not null,
  schema_hash   text,
  deployed_at   timestamptz,
  deployed_by   uuid references auth.users (id) on delete set null,
  rollback_of   uuid references public.prompt_versions (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (feature, version)
);
select public.attach_set_updated_at('prompt_versions');

-- =============================================================================
-- §3.7 후기 · 플래너 · 콘텐츠 · 알림 (커플 스코프 guests/seating_plans 는 0002)
-- =============================================================================

-- 결제·계약 이력자만 작성(F-C-17). 업체 평가는 사실·기준 대비 편차로만(§7.7).
create table public.reviews (
  id                 uuid primary key default gen_random_uuid(),
  booking_id         uuid not null unique references public.bookings (id) on delete cascade,
  couple_id          uuid not null references public.couples (id) on delete cascade,
  vendor_id          uuid not null references public.vendors (id) on delete cascade,
  score_price        integer check (score_price is null or (score_price between 1 and 5)),
  score_response     integer check (score_response is null or (score_response between 1 and 5)),
  score_fulfillment  integer check (score_fulfillment is null or (score_fulfillment between 1 and 5)),
  body               text,
  disclosed_amount   bigint check (disclosed_amount is null or disclosed_amount >= 0),
  status             text not null default 'published',
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists idx_reviews_vendor_id on public.reviews (vendor_id);
create index if not exists idx_reviews_couple_id on public.reviews (couple_id);
select public.attach_set_updated_at('reviews');

-- 부당 후기 신고(F-V-11)
create table public.review_reports (
  id          uuid primary key default gen_random_uuid(),
  review_id   uuid not null references public.reviews (id) on delete cascade,
  reporter_id uuid references auth.users (id) on delete set null,
  reason_code text not null,
  status      text not null default 'open',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists idx_review_reports_review_id on public.review_reports (review_id);
select public.attach_set_updated_at('review_reports');

-- 플래너 마켓(F-C-18)
create table public.planners (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null unique references auth.users (id) on delete cascade,
  profile_json jsonb not null default '{}'::jsonb,
  fee_json     jsonb not null default '{}'::jsonb,
  regions      text[] not null default '{}',
  rating_avg   numeric,
  status       text not null default 'pending',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists idx_planners_status on public.planners (status);
select public.attach_set_updated_at('planners');

-- 데이터 열람 권한 위임(범위·기간). RLS 플래너 정책의 기준 테이블(§3.9).
-- scope_json 형식: {"tables": ["tasks", "budgets", ...]}
create table public.planner_engagements (
  id         uuid primary key default gen_random_uuid(),
  planner_id uuid not null references public.planners (id) on delete cascade,
  couple_id  uuid not null references public.couples (id) on delete cascade,
  scope_json jsonb not null default '{}'::jsonb,
  valid_from timestamptz,
  valid_to   timestamptz,
  status     text not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on column public.planner_engagements.scope_json is
  '위임 범위. {"tables": ["tasks","budgets"]} 형식. RLS 가 이 목록으로 SELECT 를 제한한다.';
create index if not exists idx_planner_engagements_couple_id
  on public.planner_engagements (couple_id);
create index if not exists idx_planner_engagements_planner_id
  on public.planner_engagements (planner_id);
select public.attach_set_updated_at('planner_engagements');

-- CMS·SEO(F-C-24, F-A-05). 공개 데이터(§3.9).
create table public.content_posts (
  id           uuid primary key default gen_random_uuid(),
  slug         text not null unique,
  type         public.content_post_type not null,
  title        text not null,
  body_md      text,
  seo_json     jsonb not null default '{}'::jsonb,
  published_at timestamptz,
  author_id    uuid references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists idx_content_posts_type_published
  on public.content_posts (type, published_at desc);
select public.attach_set_updated_at('content_posts');

-- 푸시·이메일·알림톡 발송 이력
create table public.notifications (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  topic        text not null,
  payload_json jsonb not null default '{}'::jsonb,
  channel      text not null,
  sent_at      timestamptz,
  read_at      timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists idx_notifications_user_created
  on public.notifications (user_id, created_at desc);
select public.attach_set_updated_at('notifications');

-- 토픽별 수신 설정
create table public.notification_prefs (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  topic         text not null,
  channel_flags jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (user_id, topic)
);
create index if not exists idx_notification_prefs_user_id on public.notification_prefs (user_id);
select public.attach_set_updated_at('notification_prefs');

-- 만료형 공유 링크(F-C-20)
create table public.share_links (
  id            uuid primary key default gen_random_uuid(),
  resource_type text not null,
  resource_id   uuid not null,
  token         text not null unique,
  expires_at    timestamptz not null,
  view_count    integer not null default 0 check (view_count >= 0),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_share_links_resource
  on public.share_links (resource_type, resource_id);
create index if not exists idx_share_links_expires_at on public.share_links (expires_at);
select public.attach_set_updated_at('share_links');

-- =============================================================================
-- §3.8 운영 · 시스템
-- =============================================================================

-- admin·vendor 상태 변경 전수 기록.
-- 쓰기 경로 생성 이후 추가하면 전면 재작업이 되므로 1차에 포함한다.
create table public.audit_logs (
  id          uuid primary key default gen_random_uuid(),
  actor_id    uuid references auth.users (id) on delete set null,
  actor_role  public.user_role,
  action      text not null,
  target_type text not null,
  target_id   uuid,
  before_json jsonb,
  after_json  jsonb,
  ip_hash     text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
comment on table public.audit_logs is
  '감사 로그. 계약서 원문·Storage 경로·마스킹 맵을 기록하지 않는다(CLAUDE.md §5.3).';
create index if not exists idx_audit_logs_actor_id on public.audit_logs (actor_id);
create index if not exists idx_audit_logs_target on public.audit_logs (target_type, target_id);
create index if not exists idx_audit_logs_created_at on public.audit_logs (created_at desc);
select public.attach_set_updated_at('audit_logs');

-- R1~R3 공개 제어(§1.3). D-09 '만들어 두고 켜지 않는다'의 구현 수단.
create table public.feature_flags (
  id           uuid primary key default gen_random_uuid(),
  key          text not null unique,
  enabled      boolean not null default false,
  rollout_json jsonb not null default '{}'::jsonb,
  updated_by   uuid references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
comment on table public.feature_flags is
  '공개 시점 제어의 유일한 수단(CLAUDE.md §2.1). 기능 범위 축소로 대체하지 않는다.';
select public.attach_set_updated_at('feature_flags');

-- 수수료 요율·임계값 등 미결 파라미터 분리(O-02·O-03).
create table public.app_settings (
  id          uuid primary key default gen_random_uuid(),
  key         text not null unique,
  value_json  jsonb not null default '{}'::jsonb,
  description text,
  updated_by  uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
comment on table public.app_settings is
  '미결 파라미터(수수료 요율 O-02 등)를 코드에서 분리한다. 코드 하드코딩 금지.';
select public.attach_set_updated_at('app_settings');

-- CS·신고(F-A-06)
create table public.tickets (
  id          uuid primary key default gen_random_uuid(),
  reporter_id uuid references auth.users (id) on delete set null,
  category    text not null,
  subject     text not null,
  body        text,
  assignee_id uuid references auth.users (id) on delete set null,
  status      text not null default 'open',
  resolution  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists idx_tickets_reporter_id on public.tickets (reporter_id);
create index if not exists idx_tickets_status on public.tickets (status);
select public.attach_set_updated_at('tickets');

-- 배치 실행 이력(파기·지수·정산). 파기 실패는 F-A-08 경보로 이어진다(§5.1).
create table public.job_runs (
  id              uuid primary key default gen_random_uuid(),
  job_name        text not null,
  started_at      timestamptz,
  finished_at     timestamptz,
  status          text not null default 'running',
  processed_count integer not null default 0 check (processed_count >= 0),
  error_summary   text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
comment on column public.job_runs.error_summary is
  '요약만 기록. 원문 내용·Storage 경로를 실어 보내지 않는다(CLAUDE.md §5.3).';
create index if not exists idx_job_runs_job_name_started
  on public.job_runs (job_name, started_at desc);
select public.attach_set_updated_at('job_runs');

-- =============================================================================
-- 이 파일이 생성한 테이블: 27
--   §3.5(9) documents, document_analyses, findings, detect_rules, penalty_rules,
--           penalty_simulations, estimate_uploads, estimate_items, estimate_comparisons
--   §3.6(5) ai_conversations, ai_messages, ai_tool_calls, ai_call_logs, prompt_versions
--   §3.7(8) reviews, review_reports, planners, planner_engagements, content_posts,
--           notifications, notification_prefs, share_links
--   §3.8(5) audit_logs, feature_flags, app_settings, tickets, job_runs
-- =============================================================================
