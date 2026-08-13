-- =============================================================================
-- 0029 · 표준계약 템플릿·발행 · 3자 전자서명 (S5-04 · S5-05)
-- 근거: docs/07_개발명세서.md §2.1 F-C-15, §3.4 contracts·contract_signatures,
--       §4.2, §6.2 /contracts/[id], §7.7(표준계약서 조항 — O-03 대기),
--       D-21 · D-23 · D-24 · D-28
-- =============================================================================
-- **조항 문안을 확정하지 않는다.** O-03(법무 검수)이 미결이므로 §7.7 이 정한 대로
-- **템플릿 구조·서명 플로우·당사자 정의만** 만들고 **조항 본문은 플레이스홀더**로 둔다.
-- 그 원칙을 문서가 아니라 **DB 가 지키게** 했다 — 아래 근거 1.
--
-- 이 파일이 정한 것 — 판단이 필요했던 지점과 근거
--
--  1. **조항 문안이 들어오는 것을 스키마가 막는다.** T-04 가 `detect_rules.basis_ref` 에
--     "제N조" 를 못 넣게 테스트로 막은 것과 같은 방식이며, 여기서는 층을 셋 둔다.
--       (가) CHECK `contract_templates_no_clause_numbers` — 템플릿이 `placeholder` 상태인
--            동안 `clauses_json` 어디에도 '제N조'·'N항'·'Article N' 이 들어올 수 없다.
--       (나) 트리거 `assert_contract_template_placeholder()` — `placeholder` 상태에서는
--            어떤 조항 슬롯도 `body` 를 가질 수 없다. 구조(제목·순서·근거 출처)만 채운다.
--       (다) vitest — `lib/core/contract/contract.ts` 의 기본 템플릿 상수를 같은 정규식으로
--            훑는다. 코드에 조항이 박히는 경로까지 닫는다.
--     법무 검수가 끝나면 **새 버전 행을 넣고 `clause_body_status='reviewed'` 로 발행**한다.
--     그때는 (가)·(나)가 조건에서 빠지므로 **코드 변경 없이** 조항이 들어온다.
--
--  2. **계약은 예약당 하나다**(D-21 — 가계약/본계약으로 문서를 나누지 않는다).
--     취소된 계약은 남기고 부분 유니크에서 뺀다 — 재발행이 가능해야 하고, 지워 버리면
--     "무엇을 취소했는가" 가 사라진다.
--
--  3. **`status` 에 '서명 중' 을 두지 않는다.** 몇 명이 서명했는지는 `contract_signatures`
--     행을 세면 나오는 **계산값**이다. 저장하면 두 진실이 생기고, 갱신을 빠뜨린 만큼
--     화면이 거짓을 말한다(IDEA-01 · S5-01 에서 세운 규칙 그대로).
--       `draft`(발행 전 편집) | `issued`(발행·서명 대기) | `active`(전원 서명 완료·확정)
--       | `cancelled`(사유 필수)
--
--  4. **서명은 '무엇에 서명했는가' 를 함께 남긴다.** `contracts.content_hash` 는 발행 시점
--     조항·금액의 정본 해시이고, `contract_signatures.signed_content_hash` 는 **그 서명자가
--     본 내용의 해시**다. 트리거가 둘의 일치를 강제하므로 **다른 내용에 서명할 수 없다.**
--     그리고 서명이 하나라도 있으면 조항·금액·요율·템플릿을 **바꿀 수 없다** — 나중에
--     조항이 바뀌면 "무엇에 서명했는가" 를 재현할 수 없고, 그것이 분쟁의 쟁점이다(D-23).
--
--  5. **요율 스냅샷은 '발행' 시점이다.** S5-01 이 `bookings` 에 만든 두 컬럼은 **정산이
--     읽는 자리**이고, 고객이 서명하는 대상은 계약서다. 요율이 계약 조건이므로 고객은
--     **서명 전에** 그 값을 보아야 한다 — 그래서 발행 시점에 해석해 `contracts` 에 박고
--     불변으로 잠근다. 확정(전원 서명) 시 그 값을 `bookings` 로 **복사**한다.
--     서명 시작~완료 사이에 운영이 요율을 바꿔도 고객이 서명한 값이 정산으로 간다.
--
--  6. **서명 행은 서비스롤만 만든다.** 0005 는 `contract_signatures_insert` 를 당사자에게
--     열어 뒀는데, 그러면 **본인확인 없이 `verification_method='sms'` 라고 적을 수 있다.**
--     서명은 결제보다 위험하다 — 없는 본인확인으로 계약이 성립하면 안 된다(D-28).
--     그래서 그 정책을 내리고 **정책 없음 = 기본 거부**로 둔다. 권한 판정은 API 가 하며,
--     RLS 와 같은 헬퍼(`is_couple_owner`·`is_vendor_owner`·플래너 본인)를 쓴다 —
--     §3.9 가 입점 심사·초대 수락에 쓴 "서비스롤 경유" 와 같은 모양이다.
--
--  7. **커플은 소유자 한 명만 서명한다.** §1.4 가 "결제·계약 서명 권한은 소유자와 분리"
--     라고 적었고 0005 의 정책도 `is_couple_owner` 로 쓰여 있다. 배우자에게도 서명을
--     요구하면 한쪽이 자리에 없을 때 계약이 멈추고, 그 지연의 책임은 업체·플랫폼에
--     떨어진다. 대신 **계약서에 커플 양측을 당사자로 적고**(내용) 서명은 소유자가 한다.
--
--  8. **회차는 발행 시점에 만든다**(S5-06 이 아니라 여기서). F-C-14 는 "각 회차의 지급
--     조건·기한·금액을 **결제 전 고지**" 를 요구한다. 확정 후에 만들면 고객은 금액·기한이
--     없는 계약에 서명하게 된다. S5-06 은 그 회차를 **실제로 결제**하는 일이다.
-- =============================================================================

-- =============================================================================
-- 1) contract_templates — 버전 관리 (§7.7)
-- =============================================================================
create table if not exists public.contract_templates (
  id                 uuid primary key default gen_random_uuid(),
  version            text not null unique,
  status             text not null default 'draft',
  /**
   * 조항 슬롯 배열. `[{ code, title, order, basisNote, body? }]`
   * `placeholder` 상태에서는 `body` 를 가질 수 없다(트리거).
   */
  clauses_json       jsonb not null default '[]'::jsonb,
  clause_body_status text not null default 'placeholder',
  /** 근거 **출처 수준**만 적는다. 조항 번호를 적지 않는다(§7.7 · T-04 와 같은 규칙). */
  basis_note         text,
  effective_from     timestamptz,
  effective_to       timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  constraint contract_templates_status_values check (status in ('draft', 'active', 'retired')),
  constraint contract_templates_body_status_values
    check (clause_body_status in ('placeholder', 'reviewed')),
  constraint contract_templates_effective_range
    check (effective_to is null or effective_from is null or effective_to > effective_from),

  -- **조항 번호가 들어오는 것을 막는다**(위 근거 1-가). 법무 검수를 지난 템플릿
  -- (`reviewed`)은 실제 조항 번호를 가져야 하므로 조건에서 빠진다.
  constraint contract_templates_no_clause_numbers
    check (
      clause_body_status <> 'placeholder'
      or (
        clauses_json::text !~ '제\s*[0-9]+\s*조'
        and clauses_json::text !~ '[0-9]+\s*항'
        and clauses_json::text !~* 'article\s*[0-9]+'
      )
    )
);

comment on table public.contract_templates is
  '표준계약서 템플릿 버전(§7.7 · O-03 대기). **조항 본문은 플레이스홀더**이며 구조·제목·근거 출처만 갖는다. 법무 검수가 끝나면 새 버전 행을 넣고 clause_body_status=reviewed 로 발행한다 — **코드를 고치지 않는다.**';
comment on column public.contract_templates.clause_body_status is
  'placeholder(문안 미확정 — 본문을 담을 수 없다) | reviewed(법무 검수 완료 — 본문·조항 번호를 담는다). 이 값이 CHECK·트리거의 조건이며, 값이 바뀌는 순간 문안이 들어올 수 있게 된다.';
comment on column public.contract_templates.basis_note is
  '근거 **출처 수준**만(예: 표준약관 · 소비자분쟁해결기준). **조항 번호를 적지 않는다** — T-04 가 detect_rules.basis_ref 에 같은 가드를 걸어 뒀다(§7.7).';

-- 활성 템플릿은 하나뿐이다. 둘이면 어느 판본으로 발행할지 정할 수 없다.
create unique index if not exists uq_contract_templates_active
  on public.contract_templates ((status))
  where status = 'active';

select public.attach_set_updated_at('contract_templates');

-- 플레이스홀더 상태에서는 어떤 슬롯도 본문을 갖지 못한다(위 근거 1-나).
create or replace function public.assert_contract_template_placeholder()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_slot jsonb;
begin
  if new.clause_body_status <> 'placeholder' then return new; end if;

  for v_slot in select value from jsonb_array_elements(new.clauses_json) loop
    if v_slot ? 'body' and nullif(btrim(coalesce(v_slot ->> 'body', '')), '') is not null then
      raise exception '문안 미확정(placeholder) 템플릿에는 조항 본문을 담을 수 없습니다. 슬롯: %',
        coalesce(v_slot ->> 'code', '(코드 없음)')
        using errcode = 'check_violation', constraint = 'contract_templates_placeholder_body';
    end if;
  end loop;

  return new;
end;
$$;

comment on function public.assert_contract_template_placeholder() is
  '조항 본문이 법무 검수 전에 들어오는 것을 막는다(§7.7). 구조(제목·순서·근거 출처)는 채우고 본문은 비운다 — 지어낸 조항이 한 번 들어가면 그것이 기준처럼 굳는다.';

drop trigger if exists trg_contract_templates_placeholder on public.contract_templates;
create trigger trg_contract_templates_placeholder
  before insert or update on public.contract_templates
  for each row execute function public.assert_contract_template_placeholder();

-- =============================================================================
-- 2) contracts — 발행 · 확정
-- =============================================================================
alter table public.contracts add column if not exists template_id uuid
  references public.contract_templates (id) on delete restrict;
-- 견적에서 넘어온 계약이면 그 견적을 가리킨다. 어디서 온 금액인지가 분쟁의 첫 질문이다.
alter table public.contracts add column if not exists quote_id uuid
  references public.quotes (id) on delete set null;
-- 플래너가 서명 당사자인가(D-21). null 이면 2자 계약이다.
alter table public.contracts add column if not exists planner_id uuid
  references public.planners (id) on delete restrict;
alter table public.contracts add column if not exists content_hash text;
alter table public.contracts add column if not exists total_amount bigint;
alter table public.contracts add column if not exists applied_fee_rate_bp integer;
alter table public.contracts add column if not exists applied_planner_fee_rate_bp integer;
alter table public.contracts add column if not exists signing_deadline_at timestamptz;
alter table public.contracts add column if not exists activated_at timestamptz;
alter table public.contracts add column if not exists cancelled_at timestamptz;
alter table public.contracts add column if not exists cancel_reason text;

alter table public.contracts drop constraint if exists contracts_status_values;
alter table public.contracts
  add constraint contracts_status_values
  check (status in ('draft', 'issued', 'active', 'cancelled'));

alter table public.contracts drop constraint if exists contracts_issued_shape;
alter table public.contracts
  add constraint contracts_issued_shape
  check (
    status = 'draft'
    or (
      issued_at is not null
      and template_id is not null
      and content_hash is not null
      and total_amount is not null
      and applied_fee_rate_bp is not null
      and applied_planner_fee_rate_bp is not null
    )
  );

alter table public.contracts drop constraint if exists contracts_active_pair;
alter table public.contracts
  add constraint contracts_active_pair check ((status = 'active') = (activated_at is not null));

-- 취소에는 사유가 필요하다(D-24 — 되돌릴 수 없는 종결에는 근거를 남긴다).
alter table public.contracts drop constraint if exists contracts_cancel_pair;
alter table public.contracts
  add constraint contracts_cancel_pair
  check (
    (status = 'cancelled') = (cancelled_at is not null)
    and (cancelled_at is null or nullif(btrim(coalesce(cancel_reason, '')), '') is not null)
  );

alter table public.contracts drop constraint if exists contracts_rate_range;
alter table public.contracts
  add constraint contracts_rate_range
  check (
    (applied_fee_rate_bp is null or (applied_fee_rate_bp between 0 and 10000))
    and (applied_planner_fee_rate_bp is null or (applied_planner_fee_rate_bp between 0 and 10000))
  );

alter table public.contracts drop constraint if exists contracts_amount_nonneg;
alter table public.contracts
  add constraint contracts_amount_nonneg check (total_amount is null or total_amount >= 0);

alter table public.contracts drop constraint if exists contracts_hash_shape;
alter table public.contracts
  add constraint contracts_hash_shape
  check (content_hash is null or content_hash ~ '^[0-9a-f]{64}$');

-- 예약당 유효 계약 1건(D-21). 취소분은 제한을 받지 않으므로 재발행할 수 있다.
create unique index if not exists uq_contracts_active_per_booking
  on public.contracts (booking_id)
  where status <> 'cancelled';

create index if not exists idx_contracts_status on public.contracts (status);
create index if not exists idx_contracts_quote_id on public.contracts (quote_id);
create index if not exists idx_contracts_planner_id on public.contracts (planner_id);

comment on column public.contracts.clauses_json is
  '발행 시점 템플릿에서 **복사한 정본**이다. 템플릿이 나중에 바뀌어도 이 계약의 내용은 변하지 않는다(요율 스냅샷과 같은 이유 · D-16). 서명이 하나라도 있으면 트리거가 변경을 막는다.';
comment on column public.contracts.content_hash is
  '조항·금액·요율의 정본 해시(sha256). 서명자가 무엇에 서명했는지를 `contract_signatures.signed_content_hash` 와 대조해 증명한다(D-23). 계산은 `lib/contract/hash.ts` 이며 정규화 문자열은 `lib/core/contract` 가 만든다.';
comment on column public.contracts.planner_id is
  '플래너가 서명 당사자인가(D-21). null 이면 **2자 계약**이다. 계약이 요구하는 서명 역할 집합을 이 값이 정한다.';
comment on column public.contracts.applied_fee_rate_bp is
  '**발행 시점** 업체 수수료율 스냅샷(D-16). 요율은 계약 조건이므로 고객이 서명 전에 보아야 한다 — 그래서 확정이 아니라 발행에서 박고, 확정 시 이 값을 bookings 로 복사한다. 한 번 채워지면 트리거가 변경을 막는다.';
comment on column public.contracts.signing_deadline_at is
  '서명 기한. `app_settings.contract.signing_deadline_days` 로 계산한다 — **일수를 코드에 박지 않는다**(§7.4). 기한이 지났는지는 저장하지 않고 시계로 계산한다(signingState()).';

-- =============================================================================
-- 3) contract_signatures — 3자 서명 (§3.4 · D-23)
-- =============================================================================
alter table public.contract_signatures add column if not exists signed_content_hash text;
alter table public.contract_signatures add column if not exists verification_ref text;

alter table public.contract_signatures drop constraint if exists contract_signatures_role_values;
alter table public.contract_signatures
  add constraint contract_signatures_role_values
  check (signer_role in ('couple', 'vendor', 'planner'));

alter table public.contract_signatures drop constraint if exists contract_signatures_method_values;
alter table public.contract_signatures
  add constraint contract_signatures_method_values
  check (verification_method is null or verification_method in ('sms', 'sms_stub'));

alter table public.contract_signatures drop constraint if exists contract_signatures_signed_shape;
alter table public.contract_signatures
  add constraint contract_signatures_signed_shape
  check (
    (signed_at is null)
    or (signed_content_hash is not null and verification_method is not null and signer_id is not null)
  );

alter table public.contract_signatures drop constraint if exists contract_signatures_hash_shape;
alter table public.contract_signatures
  add constraint contract_signatures_hash_shape
  check (signed_content_hash is null or signed_content_hash ~ '^[0-9a-f]{64}$');

-- 역할당 서명은 하나다. 둘이면 어느 것이 그 당사자의 의사인지 정할 수 없다.
create unique index if not exists uq_contract_signatures_role
  on public.contract_signatures (contract_id, signer_role);

comment on column public.contract_signatures.signed_content_hash is
  '**이 서명자가 본 내용의 해시.** `contracts.content_hash` 와 같아야 하며 트리거가 강제한다 — 다른 내용에 서명할 수 없다. 조항이 나중에 바뀌면 "무엇에 서명했는가" 를 재현할 수 없고 그것이 분쟁의 쟁점이다(D-23).';
comment on column public.contract_signatures.verification_method is
  'sms(실연동) | sms_stub(로컬 스텁 · D-28). **스텁 여부가 증적에 남는다** — 나중에 "본인확인이 있었는가" 를 물었을 때 답할 수 있어야 한다. 프로덕션에서 스텁 자체를 거부하는 것은 어댑터의 일이다(lib/contract/verification).';
comment on column public.contract_signatures.ip_hash is
  '서명 요청의 출처 해시. 원본 IP 를 저장하지 않는다(§7.3) — 남길 사실은 "같은 곳에서 왔는가" 이고 주소 자체가 아니다.';

-- =============================================================================
-- 4) 불변식 트리거
-- =============================================================================

-- (가) 서명이 있으면 내용을 바꿀 수 없다. (나) 요율·해시 스냅샷은 불변이다.
-- (다) issued → active 는 필요한 서명이 다 있을 때만.
create or replace function public.assert_contract_immutable()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_signed integer;
  v_required integer;
begin
  select count(*) into v_signed
  from public.contract_signatures
  where contract_id = new.id and signed_at is not null;

  if v_signed > 0 then
    if new.clauses_json is distinct from old.clauses_json
       or new.content_hash is distinct from old.content_hash
       or new.total_amount is distinct from old.total_amount
       or new.template_id is distinct from old.template_id
       or new.planner_id is distinct from old.planner_id then
      raise exception '서명이 시작된 계약의 내용은 바꿀 수 없습니다.'
        using errcode = 'check_violation', constraint = 'contracts_signed_immutable';
    end if;
  end if;

  -- 스냅샷은 한 번 채워지면 고쳐지지 않는다(D-16 · S5-01 과 같은 규칙).
  if old.applied_fee_rate_bp is not null
     and new.applied_fee_rate_bp is distinct from old.applied_fee_rate_bp then
    raise exception '확정된 수수료율 스냅샷은 바꿀 수 없습니다.' using errcode = 'check_violation';
  end if;

  if old.applied_planner_fee_rate_bp is not null
     and new.applied_planner_fee_rate_bp is distinct from old.applied_planner_fee_rate_bp then
    raise exception '확정된 플래너 수수료율 스냅샷은 바꿀 수 없습니다.' using errcode = 'check_violation';
  end if;

  -- 확정은 전원 서명 뒤에만. 역할 집합은 planner_id 유무가 정한다(D-21).
  if new.status = 'active' and old.status <> 'active' then
    v_required := case when new.planner_id is null then 2 else 3 end;

    if v_signed < v_required then
      raise exception '서명이 %건 필요하지만 %건입니다. 전원 서명 전에는 확정할 수 없습니다.',
        v_required, v_signed
        using errcode = 'check_violation', constraint = 'contracts_signatures_incomplete';
    end if;
  end if;

  return new;
end;
$$;

comment on function public.assert_contract_immutable() is
  '계약 불변식. (가) 서명이 시작되면 내용을 못 바꾼다 — 무엇에 서명했는지 재현할 수 없게 되면 안 된다(D-23). (나) 요율 스냅샷 불변(D-16). (다) 확정은 전원 서명 뒤에만이며 필요한 서명 수는 planner_id 가 정한다(D-21).';

drop trigger if exists trg_contracts_immutable on public.contracts;
create trigger trg_contracts_immutable
  before update on public.contracts
  for each row execute function public.assert_contract_immutable();

-- 서명은 발행된 계약에만, 그 계약의 정본에만 할 수 있다.
create or replace function public.assert_contract_signature()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_status text;
  v_hash text;
  v_planner uuid;
begin
  select status, content_hash, planner_id into v_status, v_hash, v_planner
  from public.contracts where id = new.contract_id;

  if v_status is null then
    raise exception '계약을 찾을 수 없습니다.' using errcode = 'foreign_key_violation';
  end if;

  if new.signed_at is not null then
    if v_status <> 'issued' then
      raise exception '발행된 계약에만 서명할 수 있습니다. 현재 상태: %', v_status
        using errcode = 'check_violation', constraint = 'contract_signatures_not_issued';
    end if;

    -- **다른 내용에 서명할 수 없다.** 이 한 줄이 D-23 의 "무엇에 서명했는가" 를 지킨다.
    if new.signed_content_hash is distinct from v_hash then
      raise exception '서명 대상 내용이 계약 정본과 다릅니다. 화면을 새로 불러 주세요.'
        using errcode = 'check_violation', constraint = 'contract_signatures_hash_mismatch';
    end if;

    -- 플래너가 당사자가 아닌 계약에 플래너 서명이 붙을 수 없다(2자 계약).
    if new.signer_role = 'planner' and v_planner is null then
      raise exception '이 계약은 플래너가 당사자가 아닙니다.'
        using errcode = 'check_violation', constraint = 'contract_signatures_no_planner_party';
    end if;
  end if;

  return new;
end;
$$;

comment on function public.assert_contract_signature() is
  '서명 불변식. 발행 상태에서만, 계약 정본 해시와 일치하는 내용에만 서명할 수 있다. 2자 계약에 플래너 서명이 붙는 것도 막는다(D-21).';

drop trigger if exists trg_contract_signatures_guard on public.contract_signatures;
create trigger trg_contract_signatures_guard
  before insert or update on public.contract_signatures
  for each row execute function public.assert_contract_signature();

-- =============================================================================
-- 5) RLS (§3.9)
-- -----------------------------------------------------------------------------
-- **쓰기 정책을 주지 않는다.** 계약 발행·확정·서명은 서버(서비스롤)의 일이다.
--   · 발행은 요율 해석·회차 생성·해시 계산이 한 트랜잭션에서 맞아야 하고, 클라이언트가
--     행을 만들 수 있으면 **금액을 스스로 적을 수 있다.**
--   · 서명은 본인확인 결과를 담는다. 클라이언트가 넣을 수 있으면 **확인 없이
--     `verification_method='sms'` 라고 적을 수 있다**(위 근거 6).
-- 그래서 0005 의 `contract_signatures_insert` 정책을 **내린다.** 권한 판정은 API 가
-- 같은 헬퍼로 하며, §3.9 가 입점 심사·초대 수락에 쓴 "서비스롤 경유" 와 같은 모양이다.
-- =============================================================================
drop policy if exists contract_signatures_insert on public.contract_signatures;

-- 템플릿은 로그인 사용자가 읽는다 — 계약 화면이 조항 구조를 그려야 한다.
-- 쓰기는 정책 없음(운영자·서비스롤).
alter table public.contract_templates enable row level security;

create policy contract_templates_select on public.contract_templates for select to authenticated
  using (true);

comment on policy contract_templates_select on public.contract_templates is
  '템플릿 구조는 계약 당사자가 읽어야 한다(조항 뷰어). 문안이 미확정인 동안 담긴 것은 제목·순서·근거 출처뿐이므로 숨길 이유가 없다.';

-- 플래너도 자기가 당사자인 계약을 읽어야 서명할 수 있다. 0005 의 정책은 커플·업체만
-- 보므로 플래너 경로를 더한다(정책을 다시 쓴다 — 조건을 넓히는 것이지 좁히지 않는다).
drop policy if exists contracts_select on public.contracts;
create policy contracts_select on public.contracts for select to authenticated
  using (
    public.is_couple_member(public.booking_couple_id(booking_id))
    or public.is_vendor_member(public.booking_vendor_id(booking_id))
    or exists (
      select 1 from public.planners p
      where p.id = contracts.planner_id and p.user_id = auth.uid()
    )
  );

drop policy if exists contract_signatures_select on public.contract_signatures;
create policy contract_signatures_select on public.contract_signatures for select to authenticated
  using (exists (
    select 1 from public.contracts c
    where c.id = contract_signatures.contract_id
      and (
        public.is_couple_member(public.booking_couple_id(c.booking_id))
        or public.is_vendor_member(public.booking_vendor_id(c.booking_id))
        or exists (
          select 1 from public.planners p where p.id = c.planner_id and p.user_id = auth.uid()
        )
      )
  ));

-- =============================================================================
-- 6) 증적 열람 (D-23 · 0019 의 방식)
-- =============================================================================
create policy entity_events_select_contract on public.entity_events
  for select to authenticated
  using (
    entity_type = 'contract'
    and exists (
      select 1 from public.contracts c
      where c.id = entity_events.entity_id
        and (
          public.is_couple_member(public.booking_couple_id(c.booking_id))
          or public.is_vendor_member(public.booking_vendor_id(c.booking_id))
        )
    )
  );

create policy entity_events_select_contract_signature on public.entity_events
  for select to authenticated
  using (
    entity_type = 'contract_signature'
    and exists (
      select 1 from public.contract_signatures s
      join public.contracts c on c.id = s.contract_id
      where s.id = entity_events.entity_id
        and (
          public.is_couple_member(public.booking_couple_id(c.booking_id))
          or public.is_vendor_member(public.booking_vendor_id(c.booking_id))
        )
    )
  );

-- =============================================================================
-- 7) 운영 파라미터 · 기본 템플릿 (§7.4 · §7.7)
-- =============================================================================
insert into public.app_settings (key, value_json, description)
values
  (
    'contract.signing_deadline_days',
    '{"days": 7, "unit": "days"}'::jsonb,
    '발행 후 서명 기한(일). 기한이 지난 계약은 서명을 받지 않는다 — 금액·요율이 그 시점 조건이므로 무한정 열어 두면 옛 조건으로 계약이 성립한다. 기한 경과는 저장하지 않고 계산한다. 초기 운영값 7일.'
  )
on conflict (key) do update
  set value_json = excluded.value_json, description = excluded.description
  where public.app_settings.value_json ->> 'status' = 'undecided';

-- **문안 미확정 기본 템플릿.** 구조·제목·순서·근거 출처만 담는다. 본문은 없다 —
-- 트리거가 담지 못하게 막고, 화면은 '문안 미확정' 을 그대로 적는다(§7.7).
insert into public.contract_templates (version, status, clause_body_status, basis_note, clauses_json)
values (
  'v0-placeholder',
  'active',
  'placeholder',
  '표준약관 · 소비자분쟁해결기준 (출처 수준 · O-03 검수 대기)',
  '[
    {"code": "parties",   "order": 1, "title": "계약 당사자",           "basisNote": "표준약관"},
    {"code": "scope",     "order": 2, "title": "계약 대상과 범위",       "basisNote": "표준약관"},
    {"code": "amount",    "order": 3, "title": "총액과 포함 항목",       "basisNote": "표준약관"},
    {"code": "payment",   "order": 4, "title": "결제 회차와 기한",       "basisNote": "표준약관"},
    {"code": "change",    "order": 5, "title": "변경과 추가금",          "basisNote": "표준약관"},
    {"code": "cancel",    "order": 6, "title": "취소와 위약",            "basisNote": "소비자분쟁해결기준"},
    {"code": "dispute",   "order": 7, "title": "분쟁 처리",              "basisNote": "소비자분쟁해결기준"},
    {"code": "privacy",   "order": 8, "title": "개인정보 처리",          "basisNote": "개인정보보호법(출처 수준)"},
    {"code": "etc",       "order": 9, "title": "그 밖의 약정",           "basisNote": "표준약관"}
  ]'::jsonb
)
on conflict (version) do nothing;

-- =============================================================================
-- 이 파일이 한 것
--   테이블 1 — contract_templates (+ 기본 판본 1행: 문안 미확정)
--   컬럼 — contracts +11 · contract_signatures +2
--   CHECK 11 (조항 번호 금지 CHECK 포함) · UNIQUE 3
--   함수 3 — 템플릿 플레이스홀더 · 계약 불변식 · 서명 불변식
--   트리거 3
--   정책 — contract_templates SELECT 신설 / contracts·contract_signatures SELECT 를
--          플래너 경로까지 넓혀 재작성 / **contract_signatures_insert 정책 내림**
--          (서명은 서비스롤 경유) / entity_events 열람 2
--   app_settings 1 — contract.signing_deadline_days
--   기존 마이그레이션 수정 없음
-- =============================================================================
