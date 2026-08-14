-- =============================================================================
-- 0037 · 플래너 등록·프로필·마켓 (S6-02)
-- 근거: docs/07_개발명세서.md §2.1 F-C-18, §3.7 planners, §3.9 RLS, §6.2 /planners,
--       D-03 · D-16 · D-18 · D-25, O-13
-- =============================================================================
-- 0004 가 `planners` 를 만들었고 0005 가 "active 프로필은 공개, 본인만 등록·수정" 정책을
-- 세웠다. 이 파일은 그 위에 **마켓이 필요로 하는 형태**를 얹는다 — 값 집합, 프로필
-- 구조 가드, 실적 집계.
--
-- 이 파일이 정한 것 — 판단이 필요했던 지점과 근거
--
--  1. **`fee_json` 을 쓰지 않는다.** 요금은 `planner_fee_rates`(0006)가 갖고 계약 확정
--     시 `bookings.applied_planner_fee_rate_bp` 로 스냅샷된다(D-16). 프로필에 숫자를
--     두면 요율의 진실이 둘이 되고 **화면과 실제 청구가 어긋난다.** 컬럼을 떨어뜨리지는
--     않는다 — 0004 의 다른 참조를 건드리지 않기 위해서이며, 대신 **비어 있어야 한다**는
--     CHECK 를 건다. 채우려는 코드가 있으면 그 자리에서 걸린다.
--
--  2. **등록 심사는 업체보다 가볍다.** 업체는 사업자등록번호·통신판매업 신고번호·서류
--     심사가 필요하지만(F-V-01) 플래너는 **프리랜서 개인**이고 명세 F-C-18 도
--     "프로필·요금·리뷰" 까지만 적었다. **서류를 받지 않는다.** 다만 등록 즉시 마켓에
--     나가지는 않는다 — 0005 의 `planners_select_public` 이 `status='active'` 만 공개하며,
--     빈 프로필이 섞이면 고객은 마켓 전체를 신뢰하지 않는다.
--
--  3. **상태를 본인이 `active` 로 올릴 수 없다.** 0005 의 `planners_update` 는 본인에게
--     UPDATE 를 열어 뒀는데, 그대로 두면 **누구나 스스로 공개 상태로 바꿀 수 있다** —
--     심사가 형해화된다. 그래서 **컬럼 수준 권한**으로 좁힌다(0028 이 `bookings` 요율에,
--     0033 이 정산 금액에 쓴 방법과 같다): 본인은 프로필·지역만 쓰고 `status` 는
--     서비스롤(운영자 경로)이 쓴다. 단 **스스로 내리는 것**(`paused`)은 열어야 하는데,
--     컬럼 권한으로는 값을 가릴 수 없으므로 **트리거가 전이를 판정**한다.
--
--  4. **`rating_avg` 를 쓰지 않는다.** `reviews` 는 `vendor_id` 대상이라 **플래너 후기
--     구조가 없다**(S8-11). 컬럼은 남기되 마켓은 읽지 않는다 — 0으로 보여주면
--     "평가가 나쁘다" 로 읽히고, 그것은 사실이 아니다.
--
--  5. **실적 집계는 뷰가 아니라 함수다.** 계약 건수는 `planner_settlements` 를 세야
--     하는데 그 표는 **플래너 본인만** 볼 수 있다(0028). 뷰로 만들면 마켓을 여는 순간
--     남의 정산 행이 조인 경로로 노출된다 — FIX-13·14 가 지적한 "소유자 필터 없는 뷰"
--     와 같은 사고다. 그래서 **`security definer` 함수가 개수만** 돌려준다.
--     금액도 기간도 나가지 않는다.
-- =============================================================================

-- =============================================================================
-- 1) planners — 값 집합과 프로필 구조
-- =============================================================================
alter table public.planners drop constraint if exists planners_status_values;
alter table public.planners
  add constraint planners_status_values
  check (status in ('pending', 'active', 'paused', 'rejected'));

-- **요금을 프로필에 담지 않는다**(위 근거 1). 채우려는 코드가 여기서 걸린다.
alter table public.planners drop constraint if exists planners_fee_json_empty;
alter table public.planners
  add constraint planners_fee_json_empty
  check (fee_json = '{}'::jsonb);

-- 마켓이 읽는 필드의 최소 형태. 공개(`active`) 상태에서는 비어 있을 수 없다 —
-- 빈 프로필이 마켓에 걸리면 고객은 목록 전체를 신뢰하지 않는다.
alter table public.planners drop constraint if exists planners_profile_shape;
alter table public.planners
  add constraint planners_profile_shape
  check (
    status <> 'active'
    or (
      nullif(btrim(coalesce(profile_json ->> 'headline', '')), '') is not null
      and jsonb_typeof(profile_json -> 'categories') = 'array'
      and jsonb_array_length(coalesce(profile_json -> 'categories', '[]'::jsonb)) >= 1
      and array_length(regions, 1) >= 1
    )
  );

comment on table public.planners is
  '플래너 마켓 프로필(F-C-18). **요금을 여기 담지 않는다** — planner_fee_rates 가 갖고 계약 확정 시 스냅샷된다(D-16). 등록 심사는 업체 입점보다 가볍고(서류 없음) 공개는 status=active 에서만이다. rating_avg 는 **쓰지 않는다** — reviews 가 업체 대상이라 플래너 후기 구조가 없고(S8-11) 0으로 보여주면 평가가 나쁜 것처럼 읽힌다.';
comment on column public.planners.fee_json is
  '**쓰지 않는다.** 요금은 planner_fee_rates(0006) 가 갖는다 — 프로필에 숫자를 두면 요율의 진실이 둘이 되고 화면과 실제 청구가 어긋난다(D-16). CHECK 가 빈 객체를 강제한다.';
comment on column public.planners.status is
  'pending(검토 중) | active(공개) | paused(본인이 내림) | rejected(공개 보류). **본인이 active 로 올릴 수 없다**(트리거) — 열어 두면 심사가 형해화된다. 스스로 내리는 paused 와 다시 신청하는 pending 은 본인이 한다.';
comment on column public.planners.rating_avg is
  '**지금 쓰지 않는다.** 플래너 후기 구조가 없다(reviews 는 vendor 대상 · S8-11). 마켓은 이 값을 읽지 않으며, 0으로 노출하면 "평가가 나쁘다" 로 읽힌다.';

create index if not exists idx_planners_active on public.planners (status)
  where status = 'active';

-- =============================================================================
-- 2) 상태 전이 — 스스로 공개하지 못한다 (위 근거 3)
-- =============================================================================
create or replace function public.assert_planner_status_transition()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op <> 'UPDATE' or new.status is not distinct from old.status then
    return new;
  end if;

  -- 서비스롤(운영자 경로)은 어느 전이든 할 수 있다. 심사가 그쪽의 일이다.
  if auth.uid() is null then return new; end if;

  -- 본인이 할 수 있는 것 둘: 스스로 내리기(paused)와 다시 신청하기(pending).
  -- **active 로 올리는 것은 심사의 결과**이지 본인의 선언이 아니다.
  if new.status = 'active' then
    raise exception '공개 상태로는 직접 바꿀 수 없습니다. 공개 신청 후 검토를 거칩니다.'
      using errcode = 'check_violation', constraint = 'planners_self_activate';
  end if;

  if new.status = 'rejected' then
    raise exception '보류 상태는 운영자가 정합니다.'
      using errcode = 'check_violation', constraint = 'planners_self_reject';
  end if;

  return new;
end;
$$;

comment on function public.assert_planner_status_transition() is
  '플래너가 **스스로 마켓에 공개할 수 없게** 한다. 0005 가 본인에게 UPDATE 를 열어 뒀는데 그대로 두면 누구나 status=active 로 바꿀 수 있어 심사가 형해화된다. 본인이 할 수 있는 것은 내리기(paused)와 다시 신청(pending)뿐이며, 공개·보류는 서비스롤 경유(운영자)다. 컬럼 권한으로는 "값에 따라" 를 가릴 수 없어 트리거로 판정한다.';

drop trigger if exists trg_planners_status on public.planners;
create trigger trg_planners_status
  before update on public.planners
  for each row execute function public.assert_planner_status_transition();

-- =============================================================================
-- 3) 실적 집계 — 뷰가 아니라 함수다 (위 근거 5)
-- -----------------------------------------------------------------------------
-- **뷰로 만들지 않은 이유.** 계약 건수는 `planner_settlements` 를 세야 하는데 그 표는
-- 플래너 본인만 볼 수 있다(0028). 뷰를 마켓에 열면 남의 정산 행이 조인 경로로 노출된다
-- — FIX-13·14 가 지적한 "소유자 필터 없는 뷰" 와 같은 사고다.
--
-- 함수는 **개수만** 돌려준다. 금액도 기간도 나가지 않으므로 공개해도 남의 수입을
-- 역산할 수 없다. `void` 는 세지 않는다 — 해지로 무효가 된 건은 실적이 아니다.
-- =============================================================================
create or replace function public.planner_contract_count(p_planner_id uuid)
returns integer language sql stable security definer set search_path = public as $$
  select count(*)::int
  from public.planner_settlements s
  where s.planner_id = p_planner_id and s.status <> 'void';
$$;

comment on function public.planner_contract_count(uuid) is
  '플래너의 계약 성사 건수(D-25 랭킹 지표). **뷰가 아니라 함수인 이유** — planner_settlements 는 본인 전용이라(0028) 뷰를 마켓에 열면 남의 정산 행이 조인 경로로 새어 나간다. 이 함수는 **개수만** 돌려주므로 금액을 역산할 수 없다. 해지로 void 가 된 건은 실적이 아니라 세지 않는다.';

grant execute on function public.planner_contract_count(uuid) to anon, authenticated;

-- =============================================================================
-- 4) RLS 보완 (§3.9)
-- -----------------------------------------------------------------------------
-- 0005 가 이미 넷을 만들었다(공개 SELECT · 본인 SELECT · 본인 INSERT · 본인 UPDATE).
-- 여기서는 **운영자 열람**만 더한다 — 심사하려면 `pending` 상태를 봐야 하는데
-- 공개 정책은 `active` 만 열어 준다. 서비스롤로 우회해 읽으면 경계가 앱 코드가 된다(§5.5).
-- =============================================================================
create policy planners_select_operator on public.planners for select to authenticated
  using (public.is_operator());

-- =============================================================================
-- 5) 증적 열람 (D-23 · 0019 의 방식)
-- =============================================================================
create policy entity_events_select_planner on public.entity_events
  for select to authenticated
  using (
    entity_type = 'planner'
    and exists (
      select 1 from public.planners p
      where p.id = entity_events.entity_id
        and (p.user_id = auth.uid() or public.is_operator())
    )
  );

-- =============================================================================
-- 이 파일이 한 것
--   CHECK 3 — 상태 값 집합 · **fee_json 비움 강제** · 공개 프로필 최소 형태
--   함수/트리거 1 — **본인이 스스로 공개할 수 없다**
--   함수 1 — planner_contract_count (**뷰가 아니다** — 남의 정산이 새지 않는다)
--   정책 2 — 운영자 SELECT · entity_events 열람
--   인덱스 1
--   기존 마이그레이션 수정 없음
--   **rating_avg 를 쓰지 않는다** — 플래너 후기 구조가 아직 없다(S8-11).
-- =============================================================================
