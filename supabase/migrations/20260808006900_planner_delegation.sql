-- =============================================================================
-- 0069 · 플래너 권한 위임 (S6-04)
-- 근거: docs/07_개발명세서.md §2.1 F-C-18, §3.7 planner_engagements, §3.9 RLS,
--       D-16 · D-17 · D-23 · D-43
-- =============================================================================
-- `planner_engagements` 는 0004 가 만든 뒤 **한 번도 손대지 않은 표**다. 그동안 이
-- 표를 쓰는 앱 경로가 없었고(시드와 `db:rls` 픽스처만 서비스롤로 넣었다) 그래서
-- 아무도 그 상태를 들여다보지 않았다. 이 태스크가 처음으로 **사람이 쓰는 경로**를
-- 만들기 때문에, 먼저 표를 감사했다.
--
-- ── 감사 결과 (세 층) ───────────────────────────────────────────────────────
--
--  층 1 (정책 아래의 권한) — **CHECK 이 하나도 없었다.**
--    · `status` 어휘가 없다. 오타 한 글자면 위임은 조용히 효력을 잃고(fail-closed)
--      화면은 "위임함" 이라고 적는다.
--    · 기간 정합이 없다. `valid_to < valid_from` 인 행이 들어간다.
--    · `scope_json` 모양이 없다. **`{"tables": [...]}` 에 무엇을 적어도 통과한다** —
--      고객이 "결제" 를 골랐다고 믿게 만들 수 있고 실제로는 아무것도 열리지 않는다.
--      반대로 오탈자("cart" vs "carts")면 열릴 것이 안 열린다.
--    · **DELETE 가 커플 소유자에게 열려 있었다**(정책 + GRANT). 위임을 지우면
--      "언제부터 언제까지 이 플래너가 우리 예산·하객을 봤는가" 를 재현할 수 없다 —
--      그것이 D-23 이 말하는 증거이고, 정산·개인정보 분쟁에서 실제로 묻는 질문이다.
--    · **UPDATE 가 표 단위**라 커플 소유자가 이미 만든 위임의 `planner_id` 를
--      갈아 끼울 수 있었다. 증적은 "A 에게 위임했다" 인데 행은 B 를 가리킨다.
--
--  층 2 (정책이 다른 표의 정책에 기대는가 · FIX-41) — **위반 없음.**
--    `planner_engagements_select` 의 `exists (select 1 from planners p ...)` 는
--    안에 `p.user_id = auth.uid()` 를 들고 있다. 소유자 조건이 빠진 모양이 아니다.
--
--  층 3 (자격의 근거가 되는 표 · FIX-44 · FIX-47) — **이 표가 바로 그 표다.**
--    `has_planner_scope()`(0005)는 `planner_engagements` + `planners` 를 읽어
--    "이 플래너가 이 커플의 표를 볼 수 있는가" 를 판정한다. 그러므로 물음은
--    **"자격을 얻으려는 사람(플래너)이 이 두 표를 직접 쓸 수 있는가"** 다.
--      · `planner_engagements` — 쓰기 정책이 전부 `is_couple_owner` 다. 플래너는
--        자기 위임을 만들 수도 고칠 수도 없다. **오늘 뚫려 있지 않다.**
--      · `planners` — 본인 행을 INSERT·UPDATE 할 수 있지만(`user_id = auth.uid()`
--        가 using·with check 양쪽에 있다) 그것으로 열리는 것은 없다. `has_planner_scope`
--        는 `planners.user_id` 를 **본인 확인**에만 쓴다.
--      · 다만 **`planners` 에 DELETE GRANT 가 남아 있었다.** 정책이 없어 오늘은
--        RLS 가 막는다(latent). 그런데 `planner_engagements.planner_id` 가
--        **on delete cascade** 라, 누군가 DELETE 정책 한 줄을 더하는 순간
--        **플래너가 자기 프로필을 지워 모든 위임 기록을 함께 지울 수 있다.**
--        "cascade 가 걸린 FK 로 다른 표의 기록을 지울 수 있는가" 가 바로 이 모양이다.
--
-- ── 이 파일이 정한 것 ───────────────────────────────────────────────────────
--
--  1. **위임은 한쪽의 선언이 아니라 양쪽의 합의다**(D-165).
--     0004 는 `status` 기본값을 `pending` 으로 두고 `has_planner_scope` 는 `active`
--     만 인정한다. 그런데 **`pending` 을 `active` 로 옮기는 코드가 어디에도 없었다** —
--     시드가 서비스롤로 넣은 한 행만 활성이었다. 즉 이 칸은 **뜻이 정해지지 않은
--     채로 남아 있었다.** 여기서 정한다: 커플이 **제안**하고(pending) 플래너가
--     **수락**해야(active) 효력이 생긴다. 커플이 스스로 `active` 로 적게 하면
--     `pending` 은 죽은 값이 되고, 플래너는 **동의한 적 없는 관계**에 놓인다 —
--     계약이 성사되면 플래너는 서명 당사자가 되고(F-C-15) 수수료를 받는다(D-17).
--
--  2. **위임에는 끝이 있어야 한다**(D-166). 0004 는 `valid_to` 를 null 허용으로
--     뒀고 `has_planner_scope` 는 null 을 **무기한**으로 읽는다. 무기한 위임은
--     고객이 해제를 기억해야만 끝나고, 잊으면 **예식이 끝난 뒤에도** 플래너가
--     예산·하객 명단을 계속 본다. F-C-18 의 문언도 "범위·**기간** 지정" 이다.
--     그래서 살아 있는 위임(`pending`·`active`)에는 시작과 끝이 **둘 다 필수**다.
--
--  3. **범위 어휘를 DB 가 든다**(D-167). `scope_json.tables` 에 적을 수 있는 값은
--     **RLS 가 실제로 읽는 11개뿐**이다. 이 목록은 지어낸 것이 아니라
--     `has_planner_scope(couple_id, '<키>')` 를 부르는 정책에서 뽑았다:
--       couples · tasks · budgets · expenses · carts · wishlists ·
--       bookings · consultations · quotes · guests · seating_plans
--     (`carts` 하나가 `carts`·`cart_items` 를, `quotes` 하나가 `quotes`·`quote_items`
--      를 연다 — 키와 표가 1:1 이 아니다.)
--     **제약을 부정형으로 쓰지 않는다** — 금지 목록이 아니라 허용 값을 나열한다.
--     `db:rls` 가 이 목록과 정책에서 뽑은 목록이 같은지 매번 대조한다. 새 정책이
--     새 키를 쓰면 검사가 먼저 깨진다 — 화면이 조용히 뒤처지지 않게 하기 위해서다.
--
--  4. **해제는 삭제가 아니다**(D-23 · 0036 이 `planner_scopes` 에서 한 것과 같다).
--     DELETE 정책과 GRANT 를 함께 걷는다. **GRANT 만 걷으면 다음 사람이 되돌리는
--     순간 정책이 이미 허락하고 있다**(S5-10 이 `bookings` 에서 배운 것).
--
--  5. **범위·기간은 고쳐 쓰지 않는다.** 바꾸려면 해제하고 새로 위임한다. 그래서
--     UPDATE 컬럼 권한은 **`status` 한 칸뿐**이고, 시각·행위자는 트리거가 적는다.
--     이렇게 하면 `with check` 가 바뀐 뒤의 행만 본다는 함정(FIX-39)을 피한다 —
--     정책으로 막을 수 없는 것을 컬럼 권한으로 나열해 막는다.
--
--  6. **`status` 는 INSERT 컬럼에서도 뺀다.** 넣을 수 있으면 커플이 곧바로
--     `active` 로 만들어 수락 절차를 우회한다(함정 6 — 당사자가 직접 넣을 수 있는
--     컬럼이 심사를 우회한다).
--
--  7. **두 축을 여기서도 합치지 않는다**(D-43). 위임을 해제해도 `planner_scopes`
--     의 카테고리 선택은 그대로다. DB 가 연쇄로 끄지 않고 **화면이 두 경로를
--     함께 안내한다** — 자동으로 끄면 "왜 카테고리가 혼자 풀렸나" 를 답할 수 없고,
--     끄지 않으면서 알리지도 않으면 고객이 나중에 발견한다.
-- =============================================================================

-- =============================================================================
-- 1) 상태의 짝 — 언제 응답했고 언제 거뒀는가
-- =============================================================================
alter table public.planner_engagements
  add column if not exists responded_at timestamptz,
  add column if not exists revoked_at   timestamptz,
  add column if not exists revoked_by   uuid references auth.users (id) on delete set null;

comment on column public.planner_engagements.responded_at is
  '플래너가 수락(active)·거절(declined)한 시각. **트리거가 적는다** — 당사자가 직접 넣으면 "언제 동의했는가" 를 지어낼 수 있다.';
comment on column public.planner_engagements.revoked_at is
  '커플이 위임을 거둔 시각. **행을 지우지 않는다**(D-23) — "언제부터 언제까지 봤는가" 가 개인정보·정산 분쟁의 질문이다.';
comment on column public.planner_engagements.revoked_by is
  '거둔 사람. 커플 구성원이 둘이라 "누가 거뒀는가" 가 실제로 갈린다.';

comment on column public.planner_engagements.status is
  'pending(커플이 제안) | active(플래너가 수락 — 이때부터 has_planner_scope 가 연다) | declined(플래너가 거절) | revoked(커플이 거둠). **재위임은 새 행이다**(D-23). 상태를 되돌리지 않는 이유는 0069 주석 참조.';
comment on column public.planner_engagements.scope_json is
  '위임 범위. {"tables": [...]} 이며 값은 **RLS 가 실제로 읽는 11개**로 제한된다(CHECK). 목록의 출처는 has_planner_scope 를 부르는 정책이고 db:rls 가 매번 대조한다.';

-- =============================================================================
-- 2) CHECK — 이 표에는 하나도 없었다 (위 감사 층 1)
-- =============================================================================

-- 상태 어휘. **허용 값을 나열한다**(부정형 금지).
alter table public.planner_engagements
  drop constraint if exists planner_engagements_status_values;
alter table public.planner_engagements
  add constraint planner_engagements_status_values
  check (status in ('pending', 'active', 'declined', 'revoked'));

-- 응답의 짝.
--
-- **동치(`=`)로 쓸 수 없다.** 수락한 뒤 거둔 위임(`revoked`)은 응답 시각을 **그대로
-- 들고 있어야** 한다 — "언제 수락했고 언제 거뒀는가" 가 둘 다 질문이기 때문이다.
-- 반면 제안 단계에서 거둔 것에는 응답 시각이 없다(지어내지 않는다). 그래서 상태별로
-- **허용 값을 나열한다**(부정형 금지).
alter table public.planner_engagements
  drop constraint if exists planner_engagements_responded_pair;
alter table public.planner_engagements
  add constraint planner_engagements_responded_pair
  check (
    case status
      when 'pending'  then responded_at is null
      when 'active'   then responded_at is not null
      when 'declined' then responded_at is not null
      -- revoked: 수락 뒤에 거뒀으면 있고, 제안 단계에서 거뒀으면 없다.
      when 'revoked'  then true
      else false
    end
  );

-- 회수의 짝.
alter table public.planner_engagements
  drop constraint if exists planner_engagements_revoked_pair;
alter table public.planner_engagements
  add constraint planner_engagements_revoked_pair
  check ((status = 'revoked') = (revoked_at is not null));

-- **살아 있는 위임에는 시작과 끝이 둘 다 있다**(위 근거 2).
-- 이미 끝난 위임(declined·revoked)에는 요구하지 않는다 — 거절된 제안까지 기간을
-- 갖출 필요는 없고, 요구하면 거절 자체가 막힌다.
alter table public.planner_engagements
  drop constraint if exists planner_engagements_period_required;
alter table public.planner_engagements
  add constraint planner_engagements_period_required
  check (
    status not in ('pending', 'active')
    or (valid_from is not null and valid_to is not null)
  );

alter table public.planner_engagements
  drop constraint if exists planner_engagements_period_order;
alter table public.planner_engagements
  add constraint planner_engagements_period_order
  check (valid_from is null or valid_to is null or valid_to > valid_from);

-- **범위 어휘**(위 근거 3). `<@` 는 jsonb 포함 연산이라 배열의 모든 원소가
-- 허용 목록 안에 있어야 참이다.
--
-- **`coalesce` 를 쓰는 이유**: 0004 의 기본값은 `'{}'` 이고 `'{}' -> 'tables'` 는
-- SQL NULL 이다. CHECK 은 NULL 을 **통과**시키므로 coalesce 없이 쓰면
-- "범위 칸이 아예 없는 행" 이 모든 검사를 조용히 지나간다(함정 8 — 이미 실패
-- 상태인 것을 검사하면 검사가 통과한다). 모양·개수 검사도 같은 이유로 아래에서
-- 살아 있는 위임에 한해 **명시적으로** 배열을 요구한다.
alter table public.planner_engagements
  drop constraint if exists planner_engagements_scope_values;
alter table public.planner_engagements
  add constraint planner_engagements_scope_values
  check (
    coalesce(scope_json -> 'tables', '[]'::jsonb) <@ '[
      "couples", "tasks", "budgets", "expenses", "carts", "wishlists",
      "bookings", "consultations", "quotes", "guests", "seating_plans"
    ]'::jsonb
  );

-- **범위가 비어 있는 위임은 아무것도 열지 않는 장식**이다. 끝난 위임(declined·
-- revoked)에는 요구하지 않는다 — 이력이라 열 것이 없다.
alter table public.planner_engagements
  drop constraint if exists planner_engagements_scope_nonempty;
alter table public.planner_engagements
  add constraint planner_engagements_scope_nonempty
  check (
    status not in ('pending', 'active')
    -- **coalesce 가 없으면 이 검사는 아무것도 검사하지 않는다.** `'{}' -> 'tables'` 는
    -- SQL NULL 이고 `jsonb_typeof(NULL)` 도 NULL 이라, 그대로 두면 `false or NULL` =
    -- NULL 이 되어 CHECK 이 **통과**한다 — 범위 칸이 아예 없는 행이 조용히 들어온다
    -- (함정 8: 이미 실패 상태인 것을 검사하면 검사가 통과한다).
    or (
      coalesce(jsonb_typeof(scope_json -> 'tables'), '') = 'array'
      and jsonb_array_length(scope_json -> 'tables') >= 1
    )
  );

-- 같은 플래너에게 살아 있는 위임이 둘일 이유가 없다. 둘이면 화면이 어느 것을
-- 보여줄지 정할 수 없고 해제도 한쪽만 걸린다. **끝난 것(declined·revoked)은
-- 이력이므로 제한하지 않는다** — 재위임이 가능해야 한다(0036 의 부분 유니크와 같은 꼴).
create unique index if not exists uq_planner_engagements_live
  on public.planner_engagements (couple_id, planner_id)
  where status in ('pending', 'active');

-- 플래너 콘솔의 받은 위임함이 읽는 축.
create index if not exists idx_planner_engagements_planner_status
  on public.planner_engagements (planner_id, status);

-- =============================================================================
-- 3) cascade 로 증적이 사라지는 길을 끊는다 (위 감사 층 3)
-- -----------------------------------------------------------------------------
-- `planner_scopes.planner_id` 는 이미 restrict 다(0036). 같은 이유가 여기에도
-- 그대로 걸린다 — 오히려 이쪽이 **개인정보 열람 기록**이라 더 무겁다.
-- =============================================================================
alter table public.planner_engagements
  drop constraint if exists planner_engagements_planner_id_fkey;
alter table public.planner_engagements
  add constraint planner_engagements_planner_id_fkey
  foreign key (planner_id) references public.planners (id) on delete restrict;

-- =============================================================================
-- 4) 트리거 — 전이와 시각을 서버가 적는다
-- -----------------------------------------------------------------------------
-- **서비스롤(`auth.uid()` 가 null)은 지나간다.** 시드와 운영 경로가 그 길로 넣으며,
-- 0037 이 플래너 자가 공개를 막을 때 쓴 것과 같은 처리다.
-- =============================================================================
create or replace function public.assert_planner_engagement()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_actor  uuid := auth.uid();
  v_status text;
begin
  if tg_op = 'INSERT' then
    -- **제안은 언제나 pending 에서 시작한다.** 컬럼 권한이 이미 막지만 서비스롤도
    -- 같은 규칙을 따르게 하려면 여기서 한 번 더 본다 — 다만 시드가 활성 픽스처를
    -- 만들 수 있어야 하므로 서비스롤은 예외다.
    if v_actor is not null and new.status <> 'pending' then
      raise exception '위임은 제안(pending) 상태로만 만들 수 있습니다. 수락은 플래너의 몫입니다.'
        using errcode = 'check_violation', constraint = 'planner_engagements_insert_pending';
    end if;

    -- **공개 중인 플래너에게만 위임한다.** 반려(rejected)·미심사(pending) 플래너에게
    -- 데이터를 열면 심사가 무의미해진다. 0036 이 카테고리 선택에서 "활성 위임이 있는
    -- 플래너만" 을 강제한 것과 같은 층의 전제다.
    select p.status into v_status from public.planners p where p.id = new.planner_id;

    if v_status is distinct from 'active' then
      raise exception '공개 중인 플래너에게만 위임할 수 있습니다.'
        using errcode = 'check_violation', constraint = 'planner_engagements_planner_not_active';
    end if;

    -- 서비스롤이 이미 성사된 위임을 그대로 넣는 경우(시드·운영 이관)에도 응답 시각의
    -- 짝은 맞아야 한다. **시각을 픽스처가 적지 않고 서버가 적는다.**
    if new.status in ('active', 'declined') and new.responded_at is null then
      new.responded_at := now();
    end if;

    return new;
  end if;

  -- ── UPDATE ────────────────────────────────────────────────────────────────
  if new.status = old.status then return new; end if;

  -- **허용 전이를 나열한다**(부정형 금지). 끝난 위임은 되살아나지 않는다 —
  -- 다시 맡기려면 새로 제안한다(D-23 · 0036 의 '재선택은 새 행' 과 같다).
  if not (
       (old.status = 'pending' and new.status in ('active', 'declined', 'revoked'))
    or (old.status = 'active'  and new.status = 'revoked')
  ) then
    raise exception '위임 상태를 % 에서 % 로 바꿀 수 없습니다.', old.status, new.status
      using errcode = 'check_violation', constraint = 'planner_engagements_transition';
  end if;

  -- 시각·행위자는 **서버가 적는다.** 컬럼 권한이 없어 당사자는 이 칸을 쓰지 못하고,
  -- before 트리거는 권한과 무관하게 값을 넣을 수 있다.
  if new.status in ('active', 'declined') then
    new.responded_at := now();
    new.revoked_at   := null;
    new.revoked_by   := null;
  elsif new.status = 'revoked' then
    new.revoked_at := now();
    -- 로그인 세션이 직접 두드린 경우 **행위자를 위조할 수 없다**(auth.uid() 가 이긴다).
    -- 서비스롤(앱 경로)일 때만 호출자가 넘긴 값을 그대로 쓴다.
    new.revoked_by := coalesce(v_actor, new.revoked_by);
    -- 제안 단계에서 거둔 것이라면 응답 시각은 없는 채로 둔다(지어내지 않는다).
    new.responded_at := old.responded_at;
  end if;

  return new;
end;
$$;

comment on function public.assert_planner_engagement() is
  '위임의 전이와 시각을 강제한다. 제안은 pending 으로만 생기고(수락은 플래너의 몫), 끝난 위임은 되살아나지 않으며(재위임은 새 행 · D-23), 응답·회수 시각은 당사자가 아니라 서버가 적는다. 서비스롤은 지나간다 — 시드와 운영 경로가 그 길을 쓴다.';

drop trigger if exists trg_planner_engagements_guard on public.planner_engagements;
create trigger trg_planner_engagements_guard
  before insert or update on public.planner_engagements
  for each row execute function public.assert_planner_engagement();

-- 표를 **직접 두드린 쓰기**를 증적으로 남긴다.
--
-- **앱 경로와 겹치지 않게 한다.** 앱은 서비스롤로 쓰고 `recordEvent()` 로 스스로
-- 기록한다(그쪽이 진짜 행위자 id 를 안다 — 서비스롤 세션에는 `auth.uid()` 가 없다).
-- 그러니 여기서는 **`auth.uid()` 가 있는 쓰기**, 즉 PostgREST 로 표를 직접 두드린
-- 경우만 남긴다. 그렇게 갈라야 같은 사건이 두 줄로 남지 않고, 어느 쪽 경로로도
-- 기록이 비지 않는다.
create or replace function public.log_planner_engagement_change()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return new; end if;
  if tg_op = 'UPDATE' and new.status = old.status then return new; end if;

  insert into public.entity_events
    (entity_type, entity_id, event_type, actor_id, actor_role,
     before_state, after_state, source, memo)
  values (
    'planner_engagement', new.id,
    case tg_op when 'INSERT' then 'planner_engagement_offered'
               else 'planner_engagement_' || new.status end,
    auth.uid(), 'direct',
    case tg_op when 'INSERT' then null else old.status end,
    new.status, 'system',
    -- **범위 목록을 그대로 적지 않는다.** 개수면 재현에 충분하고, 무엇을 열었는지는
    -- 행이 이미 갖고 있다(§7.3 증적 최소화).
    'scopes=' || jsonb_array_length(coalesce(new.scope_json -> 'tables', '[]'::jsonb))
  );

  return new;
end;
$$;

drop trigger if exists trg_planner_engagements_audit on public.planner_engagements;
create trigger trg_planner_engagements_audit
  after insert or update on public.planner_engagements
  for each row execute function public.log_planner_engagement_change();

-- =============================================================================
-- 5) 정책 — 누가 무엇을 하는가
-- =============================================================================

-- **해제는 삭제가 아니다.** 정책과 GRANT 를 함께 걷는다(위 근거 4).
drop policy if exists planner_engagements_delete on public.planner_engagements;
revoke delete on public.planner_engagements from authenticated, anon;

-- 커플 소유자는 제안하고 거둔다. (INSERT 정책은 0005 것을 그대로 쓴다.)
drop policy if exists planner_engagements_update on public.planner_engagements;
create policy planner_engagements_update on public.planner_engagements
  for update to authenticated
  using (public.is_couple_owner(couple_id))
  with check (public.is_couple_owner(couple_id));

-- **플래너는 자기에게 온 제안에만 답한다.**
-- `using` 이 `pending` 을 요구하고 `with check` 가 `active`·`declined` 만 받으므로
-- 이 정책으로 갈 수 있는 곳은 수락과 거절뿐이다. 범위·기간을 함께 바꾸는 길은
-- **컬럼 권한**이 막는다 — 정책의 `with check` 는 바뀐 뒤의 행만 보기 때문에
-- "무엇이 바뀌었는가" 를 물을 수 없다(FIX-39 가 후기에서 겪은 자리).
create policy planner_engagements_respond on public.planner_engagements
  for update to authenticated
  using (
    status = 'pending'
    and exists (
      select 1 from public.planners p
      where p.id = planner_engagements.planner_id and p.user_id = auth.uid()
    )
  )
  with check (
    status in ('active', 'declined')
    and exists (
      select 1 from public.planners p
      where p.id = planner_engagements.planner_id and p.user_id = auth.uid()
    )
  );

comment on policy planner_engagements_respond on public.planner_engagements is
  '플래너의 수락·거절. **자격의 근거가 되는 표를 자격을 얻으려는 사람이 쓰는 유일한 자리**라 가장 좁게 연다 — 이미 자기 앞으로 온 제안(pending)의 status 만 움직일 수 있고, 범위·기간·상대는 컬럼 권한이 막는다. 제안을 스스로 만들 수는 없다(INSERT 는 커플 소유자 전용).';

-- =============================================================================
-- 6) 컬럼 권한 — 표 단위로 걷고 다시 준다 (FIX-36 의 교훈)
-- -----------------------------------------------------------------------------
-- **컬럼만 회수하면 표 단위 권한이 남아 무효가 된다.** 표에서 걷고 필요한 칸만
-- 다시 준다.
-- =============================================================================
revoke insert, update on public.planner_engagements from authenticated;

-- 제안이 담는 것: 누구에게 · 어느 커플로 · 무엇을 · 언제까지.
-- **`status` 가 없다**(위 근거 6) — 있으면 수락 절차를 우회한다.
grant insert (planner_id, couple_id, scope_json, valid_from, valid_to)
  on public.planner_engagements to authenticated;

-- 고칠 수 있는 것은 상태 한 칸뿐이다(위 근거 5). 시각·행위자는 트리거가 적는다.
grant update (status) on public.planner_engagements to authenticated;

-- anon 은 이 표를 읽을 이유가 없다. 정책이 `authenticated` 전용이라 오늘은 아무것도
-- 보이지 않지만, GRANT 가 남아 있으면 다음 사람이 `to anon` 정책 한 줄로 연다.
revoke select on public.planner_engagements from anon;

-- **`planners` 의 DELETE GRANT 를 걷는다**(위 감사 층 3). 정책이 없어 오늘은 RLS 가
-- 막지만, 정책 한 줄이 더해지는 순간 cascade 로 위임 기록이 함께 사라진다.
-- 프로필을 지우는 일은 운영(서비스롤)의 판단이지 본인의 버튼이 아니다.
revoke delete on public.planners from authenticated, anon;

-- =============================================================================
-- 7) 증적 열람 (0036 이 planner_scope 에서 한 방식)
-- =============================================================================
create policy entity_events_select_planner_engagement on public.entity_events
  for select to authenticated
  using (
    entity_type = 'planner_engagement'
    and exists (
      select 1 from public.planner_engagements e
      where e.id = entity_events.entity_id
        and (
          public.is_couple_member(e.couple_id)
          or exists (
            select 1 from public.planners p
            where p.id = e.planner_id and p.user_id = auth.uid()
          )
        )
    )
  );

-- =============================================================================
-- 이 파일이 한 것
--   컬럼 3 — responded_at · revoked_at · revoked_by (전부 트리거가 적는다)
--   CHECK 7 — 상태 어휘 · 응답/회수 짝 · 기간 필수·순서 · 범위 어휘·비어 있지 않음
--   UNIQUE 1 — 살아 있는 위임은 커플·플래너당 하나
--   FK 1 교체 — planner_id cascade → restrict (증적이 cascade 로 사라지던 길)
--   트리거 2 — 전이·시각 강제 · 상태 변경 증적
--   정책 3 — DELETE 삭제 · UPDATE 재작성 · **플래너 응답 정책 신설**
--   GRANT  — 표 단위 INSERT·UPDATE 회수 후 컬럼 단위 재부여 · DELETE 회수
--            (`planner_engagements`·`planners`) · anon SELECT 회수
--   entity_events 열람 정책 1
--   **기존 마이그레이션 파일 수정 없음** — 전부 이 파일에서 덧붙이거나 갈아 끼웠다.
--
--   `has_planner_scope`(0005)를 **고치지 않았다.** 위임의 판정 규칙은 그대로이며
--   이 파일이 한 것은 그 규칙이 서는 표를 단단하게 만든 것뿐이다.
--   `planner_scopes`(0036)도 **건드리지 않았다** — 다른 축이다(D-43).
-- =============================================================================
