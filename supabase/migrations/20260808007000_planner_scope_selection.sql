-- =============================================================================
-- 0070 · 카테고리별 부분 선택 과금 (S6-03)
-- 근거: docs/07_개발명세서.md §2.1 F-C-31, §3.7 planner_scopes, §3.8 요율 해석,
--       §4.2 GET/PUT /api/planner-scopes, D-16 · D-17 · D-23 · D-43
-- =============================================================================
-- 0036 이 표를 세웠고 **화면·API 는 만들지 않았다**. 이 태스크가 처음으로 사람이
-- 쓰는 경로를 만들기 때문에 먼저 감사했다.
--
-- ── 감사 결과 (세 층) ───────────────────────────────────────────────────────
--
--  층 3 (자격의 근거가 되는 표 · FIX-44 · FIX-47) — **둘이다.**
--    이 기능의 자격은 `is_couple_member(couple_id)` 이고 그 근거 표는
--    **`couple_members`** 다. 그리고 선택의 **전제**는 `assert_planner_scope` 가 읽는
--    **`planner_engagements`** 다.
--      · `couple_members` — INSERT 는 `is_couple_owner(couple_id)` 이거나
--        (`user_id = auth.uid()` **그리고** `owns_couple_record(couple_id)`)다.
--        둘째 갈래는 **자기가 만든 커플에 자기를 넣는 부트스트랩**이라 남의 커플에는
--        닿지 않는다. UPDATE·DELETE 는 소유자 전용이고 `with check` 도 소유자다 —
--        **배우자가 스스로 소유자가 되는 길이 없다.** 오늘 뚫려 있지 않다.
--      · `planner_engagements` — **S6-04(0069)가 방금 단단히 했다.** 플래너는 자기
--        위임을 만들 수도 범위를 넓힐 수도 없다.
--    **자격의 근거 표 둘 다 오늘 통하는 경로가 없다.** 그 사실을 `db:rls` 에 고정한다.
--
--  층 2 (정책이 다른 표의 정책에 기대는가 · FIX-41) — **위반 없음.**
--    `planner_scopes_select` 의 `exists (select 1 from planners p ...)` 는 안에
--    `p.user_id = auth.uid()` 를 들고 있고, 나머지는 `is_couple_member`·`is_operator`
--    가 스스로 조건을 말한다.
--
--  층 1 (정책 아래의 권한) — **여기서 셋이 나왔다.**
--    · **`selected_by` 를 당사자가 직접 적는다.** 이 칸은 "커플 둘 중 누가 골랐는가"
--      라는 **증적**인데, 쓰기가 열려 있으면 배우자 이름으로 적을 수 있다. 정산
--      분쟁에서 "나는 고른 적 없다" 를 다투는 자리다.
--    · **`selected_at`·`released_at` 도 당사자가 적는다.** "언제부터 언제까지 이
--      카테고리에 플래너를 썼는가" 가 곧 청구 근거인데(D-23) 그 시각을 지어낼 수 있다.
--    · **UPDATE 가 표 단위**라 이미 만든 행의 `category`·`planner_id` 를 갈아 끼울 수
--      있었다. 증적은 "드레스를 A 에게" 인데 행은 "홀을 B 에게" 가 된다. 그리고
--      **`released` 를 `selected` 로 되돌릴 수 있었다** — 그러면 해제 구간이 사라져
--      "그 사이에는 안 썼다" 를 증명할 수 없다(D-23 의 '재선택은 새 행' 과 어긋난다).
--
-- ── 이 파일이 정한 것 ───────────────────────────────────────────────────────
--
--  1. **고를 수 있는 것은 '무엇을' 뿐이다.** 넣을 수 있는 칸은
--     `couple_id`·`planner_id`·`category` 셋이고, 고칠 수 있는 칸은 `status` 하나다.
--     **시각과 행위자는 서버가 적는다** — 트리거는 컬럼 권한과 무관하게 값을 넣을 수
--     있으므로, 권한을 좁히고 트리거가 채우는 짝이 성립한다(0069 가 위임에서 쓴 방식).
--
--  2. **해제한 카테고리는 되살아나지 않는다**(D-23). `released → selected` 를 트리거가
--     막고, 다시 쓰려면 **새 행**을 만든다. 부분 유니크(0036)가 "동시에 선택된 것은
--     하나" 를 지키므로 두 규칙이 함께 서면 구간이 겹치지 않는다.
--
--  3. **요율을 여기 저장하지 않는다**(0036 이 이미 정했고 이 파일도 지킨다).
--     이 표는 **어느 카테고리를 누구에게 맡겼는가**만 들고, 금액은 계약 확정 시
--     `bookings.applied_planner_fee_rate_bp` 로 스냅샷된다(D-16).
--
--  4. **두 축을 여기서도 합치지 않는다**(D-43). 위임을 거둬도 이 표는 그대로다.
--     다만 **새로 고르는 것**은 활성 위임을 전제로 한다(0036 트리거) — 보지도 못하는
--     플래너에게 수수료가 붙는 상태를 만들지 않기 위해서다.
-- =============================================================================

comment on column public.planner_scopes.selected_by is
  '커플 구성원 중 누가 골랐는가. **트리거가 적는다**(0070) — 당사자가 직접 넣으면 배우자 이름으로 적을 수 있고, 그 칸은 정산 분쟁에서 "나는 고른 적 없다" 를 다투는 자리다.';
comment on column public.planner_scopes.selected_at is
  '선택 시각. **트리거가 적는다**(0070) — "언제부터 이 카테고리에 플래너를 썼는가" 가 곧 청구 근거다(D-23).';
comment on column public.planner_scopes.released_at is
  '해제 시각. **트리거가 적는다**(0070). 해제는 행 삭제가 아니며 재선택은 새 행이다.';

-- =============================================================================
-- 1) 트리거 — 전제 · 전이 · 시각을 서버가 든다
-- -----------------------------------------------------------------------------
-- 0036 의 함수를 **갈아 끼운다**(create or replace). 기존 불변식(활성 위임이 있는
-- 플래너만)은 그대로 두고 위 근거 1·2 를 더한다.
--
-- **서비스롤(`auth.uid()` 가 null)은 지나간다** — 시드와 운영 경로가 그 길로 넣으며
-- 0037·0069 가 쓴 것과 같은 처리다.
-- =============================================================================
create or replace function public.assert_planner_scope()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_actor  uuid := auth.uid();
  v_active integer;
begin
  if tg_op = 'UPDATE' then
    -- **바꿀 수 없는 칸.** 컬럼 권한이 이미 막지만 서비스롤도 같은 규칙을 따라야 한다 —
    -- 여기서 갈아 끼우면 증적과 행이 서로 다른 말을 하게 된다.
    if new.couple_id is distinct from old.couple_id
       or new.planner_id is distinct from old.planner_id
       or new.category is distinct from old.category then
      raise exception '선택한 카테고리·플래너는 바꿀 수 없습니다. 해제하고 새로 고르세요.'
        using errcode = 'check_violation', constraint = 'planner_scopes_immutable_target';
    end if;

    if new.status <> old.status then
      -- **허용 전이를 나열한다**(부정형 금지). 해제한 카테고리는 되살아나지 않는다 —
      -- 되살리면 해제 구간이 사라져 "그 사이에는 안 썼다" 를 증명할 수 없다(D-23).
      if not (old.status = 'selected' and new.status = 'released') then
        raise exception '카테고리 선택 상태를 % 에서 % 로 바꿀 수 없습니다. 다시 쓰려면 새로 고르세요.',
          old.status, new.status
          using errcode = 'check_violation', constraint = 'planner_scopes_transition';
      end if;

      -- 시각은 **서버가 적는다.** before 트리거는 컬럼 권한과 무관하게 값을 넣는다.
      new.released_at := now();
    end if;

    new.selected_at := old.selected_at;
    new.selected_by := old.selected_by;

    return new;
  end if;

  -- ── INSERT ────────────────────────────────────────────────────────────────
  -- 새 행은 언제나 선택에서 시작한다. `released` 로 시작하는 행은 **일어난 적 없는
  -- 해제**를 적는 것이다.
  if v_actor is not null and new.status <> 'selected' then
    raise exception '카테고리 선택은 selected 상태로만 만들 수 있습니다.'
      using errcode = 'check_violation', constraint = 'planner_scopes_insert_selected';
  end if;

  new.selected_at := now();
  new.released_at := null;
  -- 로그인 세션이 직접 두드린 경우 **행위자를 위조할 수 없다**(auth.uid() 가 이긴다).
  -- 서비스롤(앱 경로)일 때만 호출자가 넘긴 값을 그대로 쓴다.
  new.selected_by := coalesce(v_actor, new.selected_by);

  if new.status <> 'selected' then return new; end if;

  -- **위임이 없는 플래너를 카테고리에 붙일 수 없다**(0036 의 불변식 · 그대로 유지).
  -- 붙이면 보지도 못하는 플래너에게 수수료가 붙는 상태가 된다.
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
  '카테고리 선택의 전제·전이·시각을 강제한다. **활성 위임이 있는 플래너만** 지정할 수 있고(0036), 대상(커플·플래너·카테고리)은 만든 뒤 바꿀 수 없으며, 해제는 selected→released 한 방향뿐이다(재선택은 새 행 · D-23). 선택·해제 시각과 고른 사람은 당사자가 아니라 서버가 적는다. 서비스롤은 지나간다 — 시드와 운영 경로가 그 길을 쓴다.';

-- 표를 **직접 두드린 쓰기**를 증적으로 남긴다.
-- **앱 경로와 겹치지 않게 한다**(0069 가 위임에서 쓴 것과 같은 방식) — 앱은 서비스롤로
-- 쓰고 `recordEvent()` 가 진짜 행위자 id 를 남긴다. 여기서는 `auth.uid()` 가 있는
-- 쓰기, 즉 PostgREST 로 표를 직접 두드린 경우만 남긴다.
create or replace function public.log_planner_scope_change()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return new; end if;
  if tg_op = 'UPDATE' and new.status = old.status then return new; end if;

  insert into public.entity_events
    (entity_type, entity_id, event_type, actor_id, actor_role,
     before_state, after_state, source, memo)
  values (
    'planner_scope', new.id,
    'planner_scope_' || new.status,
    auth.uid(), 'direct',
    case tg_op when 'INSERT' then null else old.status end,
    new.status, 'system',
    -- **금액을 적지 않는다**(§7.3) — 계약이 갖는다. 남길 사실은 어느 카테고리인가다.
    'category=' || new.category
  );

  return new;
end;
$$;

drop trigger if exists trg_planner_scopes_audit on public.planner_scopes;
create trigger trg_planner_scopes_audit
  after insert or update on public.planner_scopes
  for each row execute function public.log_planner_scope_change();

-- =============================================================================
-- 2) 컬럼 권한 — 표 단위로 걷고 다시 준다 (FIX-36 의 교훈)
-- -----------------------------------------------------------------------------
-- **컬럼만 회수하면 표 단위 권한이 남아 무효가 된다.**
-- =============================================================================
revoke insert, update on public.planner_scopes from authenticated;

-- 고를 때 담는 것: 어느 커플이 · 누구에게 · 어느 카테고리를.
-- **`status`·시각·행위자가 없다** — 있으면 "고른 적 없는 선택" 과 "지어낸 시각" 이
-- 들어온다(함정 6 — 당사자가 직접 넣을 수 있는 컬럼이 심사를 우회한다).
grant insert (couple_id, planner_id, category) on public.planner_scopes to authenticated;

-- 고칠 수 있는 것은 상태 한 칸뿐이다. 해제 시각은 트리거가 적는다.
grant update (status) on public.planner_scopes to authenticated;

-- anon 은 이 표를 읽을 이유가 없다. 정책이 `authenticated` 전용이라 오늘은 아무것도
-- 보이지 않지만, GRANT 가 남아 있으면 다음 사람이 `to anon` 정책 한 줄로 연다.
revoke select on public.planner_scopes from anon;

-- =============================================================================
-- 이 파일이 한 것
--   함수 2 — assert_planner_scope 교체(전제 유지 + 전이·시각·불변 대상) ·
--            log_planner_scope_change 신설(표를 직접 두드린 쓰기만)
--   트리거 1 신설 — 증적
--   GRANT  — 표 단위 INSERT·UPDATE 회수 후 컬럼 단위 재부여 · anon SELECT 회수
--   **기존 마이그레이션 파일 수정 없음** — 0036 의 함수는 create or replace 로 갈았다.
--   **정책을 늘리지 않았다** — 0036 의 넷이 그대로 맞다(커플 구성원이 고르고,
--   플래너와 운영자는 읽기만 한다).
--   **`planner_engagements`(0069)를 건드리지 않았다** — 다른 축이다(D-43).
-- =============================================================================
