-- =============================================================================
-- 0015 · 고객 온보딩·커플 연동 (S3-01)
-- 근거: docs/07_개발명세서.md §2.1 F-C-01·F-C-02, §3.1, §3.9, §6.1
-- =============================================================================
-- 테이블은 T-03 이 이미 만들어 뒀다(couples·couple_members·couple_invites·
-- onboarding_answers). 여기서는 **성립하지 않는 상태를 DB 가 거부하도록** 제약을 더한다.
--
--  1. **한 사람은 커플 하나에만 속한다.** `couple_members` 의 unique 는
--     (couple_id, user_id) 라 같은 사람이 **다른 커플에 또 들어가는 것**을 막지 못한다.
--     그 상태가 되면 "내 커플"이 둘이 되어 모든 조회가 어느 쪽인지 정할 수 없다.
--     단, **플래너는 여러 커플을 맡는 것이 정상**이므로(F-C-18, planner_engagements)
--     owner·partner 에만 건다.
--  2. **초대 코드는 만료가 미래여야 한다.** 이미 지난 시각으로 발급하면 즉시 죽은 코드다.
--  3. **수락은 두 컬럼이 함께 채워진다.** 한쪽만 있으면 수락 여부를 판정할 수 없다.
-- =============================================================================

-- 1) 한 사람 = 한 커플 (플래너 제외)
create unique index if not exists uq_couple_members_single_couple
  on public.couple_members (user_id)
  where member_role in ('owner', 'partner');

comment on index public.uq_couple_members_single_couple is
  '한 사람은 owner·partner 로 커플 하나에만 속한다(F-C-02). 플래너는 여러 커플을 맡을 수 있어 제외한다.';

-- 2) 만료는 미래여야 한다
alter table public.couple_invites
  add constraint couple_invites_expires_future_chk
  check (expires_at > created_at);

-- 3) 수락 기록은 짝이다
alter table public.couple_invites
  add constraint couple_invites_accept_pair_chk
  check ((accepted_by is null) = (accepted_at is null));

comment on table public.couple_invites is
  '커플 초대 코드(F-C-02). **코드로 찾는 조회는 서버(서비스롤)에서만** 한다 — 초대받은 사람은 아직 이 커플의 멤버가 아니라 RLS 로는 볼 수 없다.';

-- 코드로 찾는 경로에 인덱스를 명시한다(unique 제약이 인덱스를 만들지만 의도를 남긴다).
create index if not exists idx_couple_invites_code_open
  on public.couple_invites (code)
  where accepted_by is null;

-- 4) 진행 단계 값 집합
-- 명세가 값을 못박지 않았으므로 text + CHECK 다(0001 원칙).
-- onboarding: 6문항을 채우는 중 / active: 온보딩을 마치고 서비스를 쓰는 중
alter table public.couples
  add constraint couples_stage_chk
  check (stage in ('onboarding', 'active'));

comment on column public.couples.stage is
  'onboarding(6문항 진행 중) | active(온보딩 완료). 값 집합은 couples_stage_chk 가 강제한다.';

-- =============================================================================
-- 5) couples SELECT — 소유자 부트스트랩 (§3.9)
-- -----------------------------------------------------------------------------
-- T-03 의 `couples_select` 는 `is_couple_member(id)` 로만 열려 있다. 그런데 커플을
-- 만드는 **첫 순간에는 아직 couple_members 행이 없다.** 그래서 방금 만든 사람이
-- 자기 커플을 보지 못한다.
--
-- 이게 단순한 조회 불편이 아니라 **INSERT 자체를 막는다**: PostgreSQL 은
-- `INSERT ... RETURNING` 에 SELECT 정책까지 평가하고, 통과하지 못하면
-- 42501 "new row violates row-level security policy" 로 거절한다.
-- PostgREST·supabase-js 의 `.insert().select()` 가 정확히 이 형태다.
--
-- T-03 은 같은 부트스트랩 문제를 `couple_members_insert` 에서 이미
-- `owns_couple_record(couple_id)` 로 풀어 뒀다(0005 §커플). `couples` 에만 그
-- 처리가 빠져 있었다. **소유자는 멤버 행 유무와 무관하게 자기 커플을 본다** —
-- 권한을 넓히는 것이 아니라, owner_id 로 이미 성립한 소유 관계를 인정하는 것이다.
-- =============================================================================
drop policy if exists couples_select on public.couples;
create policy couples_select on public.couples for select to authenticated
  using (
    owner_id = auth.uid()
    or public.is_couple_member(id)
    or public.has_planner_scope(id, 'couples')
  );

comment on policy couples_select on public.couples is
  '소유자 · 커플 멤버 · 위임받은 플래너만 본다. owner_id 조건은 멤버 행이 생기기 전(생성 직후)에도 소유자가 자기 커플을 보게 하기 위한 것이다 — INSERT ... RETURNING 이 SELECT 정책을 평가하기 때문이다.';

-- =============================================================================
-- 6) couples UPDATE — 배우자도 당사자다 (§2.1 F-C-02)
-- -----------------------------------------------------------------------------
-- T-03 은 `couples_update` 를 `is_couple_owner(id)` 로 잠가 뒀다. 그러면 **배우자가
-- 온보딩 답을 고쳐도 커플 정보에 반영되지 않는다** — 게다가 UPDATE 는 RLS 에 막혀도
-- 에러가 아니라 0 행으로 끝나므로 조용히 사라진다(S3-01 에서 실제로 겪었다).
--
-- 명세서 §3.9 는 커플 데이터를 이렇게 정한다 — "couple_members 에 소속된 user_id 만
-- SELECT/INSERT/UPDATE. **결제·계약 서명은 member_role='owner' 추가 조건**".
-- 즉 owner 한정은 돈·서명에 붙는 조건이지 커플 정보 수정에 붙는 조건이 아니다.
-- T-03 이 명세보다 좁게 잠갔던 것이고, 여기서 명세대로 되돌린다.
--
-- F-C-02 의 취지도 같다. 예식일·예산·하객 수는 둘 중 누구의 것도 아니다.
--
-- 다만 `is_couple_member` 로 넓히지는 않는다 — 그 함수는 **플래너 멤버 행도 참으로**
-- 본다. 플래너의 접근은 위임(`planner_engagements` · `has_planner_scope`)으로
-- 판정해야지 멤버십으로 뭉뚱그리면 안 된다(F-C-18).
--
-- 소유자에게만 남는 것: 초대 발급, 커플 삭제(`couples_delete` 는 그대로 둔다).
-- =============================================================================
create or replace function public.is_couple_principal(p_couple_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.couple_members m
    where m.couple_id = p_couple_id
      and m.user_id = auth.uid()
      and m.member_role in ('owner', 'partner')
  );
$$;

comment on function public.is_couple_principal(uuid) is
  '커플 당사자(owner·partner) 여부. 플래너는 제외한다 — 플래너 접근은 has_planner_scope 로 판정한다.';

drop policy if exists couples_update on public.couples;
create policy couples_update on public.couples for update to authenticated
  using (public.is_couple_principal(id)) with check (public.is_couple_principal(id));

comment on policy couples_update on public.couples is
  '커플 당사자(owner·partner) 가 함께 고친다(F-C-02). 삭제·초대 발급은 소유자 전용으로 남는다.';

-- 나머지 RLS 는 손대지 않는다. 초대 수락 경로가 서비스롤을 쓰는 것은 정책의 구멍이
-- 아니라 **설계**다 — 초대받은 사람은 수락 전까지 그 커플의 멤버가 아니므로 RLS 로는
-- 코드를 조회할 수 없고, 조회하게 만들면 남의 커플 정보가 열린다. 서버가 코드를
-- 검증한 뒤 멤버로 넣어 주는 것이 유일하게 안전한 경로다.

-- =============================================================================
-- 이 파일이 한 것
--   UNIQUE 인덱스 1 — 한 사람 한 커플(플래너 제외)
--   부분 인덱스 1 — 미수락 코드 조회 경로
--   CHECK 3 — 만료 미래 / 수락 컬럼 짝 / 진행 단계 값
--   정책 교체 2 — couples_select 에 소유자 조건 추가(생성 직후 부트스트랩)
--                 couples_update 를 당사자(owner·partner) 로 확장
--   함수 1 — is_couple_principal(uuid)
--   신규 테이블 없음
-- =============================================================================
