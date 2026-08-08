-- =============================================================================
-- 0001 · 확장 · 공통 헬퍼 · 열거 타입
-- 근거: docs/07_개발명세서.md §3(데이터 모델) 서문, §1.4(역할)
-- =============================================================================
-- 원칙
--  * 모든 테이블은 id uuid PK(gen_random_uuid) + created_at + updated_at 을 보유하고
--    updated_at 은 set_updated_at 트리거로 갱신한다.
--  * ENUM 은 명세서가 값 집합을 명시한 컬럼에만 만든다.
--    명세서가 값을 못박지 않은 status 계열은 text 로 두고 확정 시 제약을 추가한다
--    (CLAUDE.md §7.6 — 미결정 사항을 임의 확정하지 않는다).
-- =============================================================================

create extension if not exists pgcrypto;

-- -----------------------------------------------------------------------------
-- 공통 트리거 함수
-- -----------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

comment on function public.set_updated_at() is
  '모든 테이블 공통 updated_at 자동 갱신 트리거 함수 (명세서 §3 서문).';

-- 테이블마다 동일한 트리거를 붙이기 위한 헬퍼.
-- 사용: select public.attach_set_updated_at('tasks');
create or replace function public.attach_set_updated_at(p_table text)
returns void
language plpgsql
as $$
begin
  -- 재적용 시 "trigger does not exist, skipping" NOTICE 로 로그가 묻히지 않게 한다.
  set local client_min_messages = warning;
  execute format(
    'drop trigger if exists trg_set_updated_at on public.%I', p_table);
  execute format(
    'create trigger trg_set_updated_at
       before update on public.%I
       for each row execute function public.set_updated_at()', p_table);
end;
$$;

comment on function public.attach_set_updated_at(text) is
  'public 스키마 테이블에 trg_set_updated_at 트리거를 부착한다.';

-- -----------------------------------------------------------------------------
-- 열거 타입 (명세서가 값 집합을 명시한 것만)
-- -----------------------------------------------------------------------------

-- §1.4 사용자 역할과 권한
create type public.user_role as enum (
  'guest', 'consumer', 'couple_partner', 'planner',
  'vendor_owner', 'vendor_staff', 'ops', 'admin'
);

-- §3.1 couple_members.member_role
create type public.couple_member_role as enum ('owner', 'partner', 'planner');

-- §3.1 memberships.plan
create type public.membership_plan as enum ('free', 'premium');

-- §3.2 tasks.source
create type public.task_source as enum ('auto', 'manual', 'ai');

-- §3.3 vendors.status
create type public.vendor_status as enum ('pending', 'active', 'suspended');

-- §3.3 vendor_members.vendor_role
create type public.vendor_member_role as enum ('owner', 'staff');

-- §3.3 price_rules.rule_type
create type public.price_rule_type as enum ('season', 'weekday', 'leadtime', 'occupancy');

-- §3.4 bookings.status
create type public.booking_status as enum ('hold', 'confirmed', 'cancelled', 'fulfilled');

-- §3.4 payments.purpose
create type public.payment_purpose as enum ('deposit', 'balance', 'membership');

-- §3.5 documents.doc_type
create type public.document_type as enum ('contract', 'estimate');

-- §3.5 findings.severity / detect_rules.severity_default
create type public.finding_severity as enum ('high', 'mid', 'low');

-- §3.6 ai_call_logs.feature / prompt_versions.feature
create type public.ai_feature as enum ('planner', 'report', 'estimate');

-- §3.7 content_posts.type
create type public.content_post_type as enum ('guide', 'price_report', 'glossary');
