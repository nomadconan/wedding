-- 0068 플랫폼 쿠폰 관리 (S5-14 · F-A-19 · §6.4 `/admin/coupons`) · **FIX-47**
--
-- ══════════════════════════════════════════════════════════════════════════
-- 1. 표를 만지기 전에 권한부터 봤다 — **층 3 에서 최악을 찾았다**
-- ══════════════════════════════════════════════════════════════════════════
--
-- 열다섯 번째 감사다. 이 태스크가 허용하는 것은 **플랫폼 부담 쿠폰의 발행·중단**이고
-- 그 자격의 근거는 `is_operator()` 다. 그래서 그 함수가 읽는 표를 봤다.
--
--   `is_operator()` = `exists (select 1 from profiles p
--                              where p.user_id = auth.uid() and p.role in ('ops','admin'))`
--
-- ── 이미 뚫려 있었다 (FIX-47) ──────────────────────────────────────────────
--
--   `profiles`  `authenticated` 에 **표 단위 INSERT·UPDATE·DELETE**
--               + **모든 컬럼**(`role` 포함)의 INSERT·UPDATE
--   정책        `profiles_update` = `user_id = auth.uid()` (using·check 둘 다)
--
-- 즉 **아무 로그인 사용자나 한 줄로 운영자가 된다.** 로컬에서 재현했다:
--
--   update public.profiles set role = 'admin' where user_id = auth.uid();
--   -- before: role=consumer is_operator=false
--   -- after : role=admin    is_operator=true
--
-- `role` 을 지키는 트리거도 CHECK 도 없었다. 그리고 `is_operator()` 하나가
-- **운영자 콘솔 전체**를 연다 — 지표·감사 로그·개인정보 감사·분쟁 조율·CS 티켓·
-- 후기 비공개·가격 큐레이션·룰 콘솔·CMS·모니터링, 그리고 **D-15 가 지키던 미공개
-- 기능 로드맵**(`admin_feature_flags()`)까지. 이 태스크가 만들려는 **플랫폼 쿠폰
-- 발행**도 같은 문 뒤에 있다 — 스스로 운영자가 된 사람이 자기에게 무제한 할인
-- 쿠폰을 발행할 수 있다.
--
-- **FIX-44 와 같은 모양이며 걸린 것이 가장 넓다**: 자격의 근거가 되는 표를 자격을
-- 얻으려는 사람이 직접 쓸 수 있으면, 그 자격 검사는 아무것도 검사하지 않는다.
--
-- ── 층 1·2 ─────────────────────────────────────────────────────────────────
--
-- `coupons` 는 S5-12·S5-13 이 좁혀 뒀다(표 단위 쓰기 없음 · `issued_count` 제외 ·
-- DELETE 없음 · `anon` SELECT 없음 · 발급 뒤 조건 동결). 이번에 새로 걷을 것은 없다.
-- 층 2(FIX-41): `coupons_select_operator` 는 `is_operator()` 하나로 자기 조건을
-- 스스로 말한다 — 부모 표를 훑는 모양이 아니다. **위반 없음.**

-- ── `role` 을 당사자에게서 걷는다 ─────────────────────────────────────────
--
-- **컬럼 하나만 걷는 것은 아무 일도 하지 않는다**(FIX-36 · S5-12 가 이 함정에 다시
-- 빠졌다). 표 단위 INSERT·UPDATE 가 남아 있으면 그것이 모든 컬럼을 덮는다.
-- **표에서 걷고 당사자가 쓸 수 있는 칸만 다시 준다.**
revoke insert, update, delete on public.profiles from anon, authenticated;

-- 본인이 고치는 것: 표시 이름 · 아바타 · 마케팅 수신 동의 · 전화 해시.
-- (`app/api/me` 가 쓰는 넷이며 `role` 은 그중에 없다.)
grant insert (user_id, display_name, avatar_url, marketing_opt_in, phone_hash)
  on public.profiles to authenticated;
grant update (display_name, avatar_url, marketing_opt_in, phone_hash)
  on public.profiles to authenticated;

-- **DELETE 는 아무에게도 없다.** 프로필을 지우면 `entity_events.actor_id` 가 가리키던
-- 사람이 사라져 증적이 "누가 했는지 모르는 기록" 이 된다(D-23). 계정 삭제는
-- `data_deletion_requests` 절차가 서비스롤로 처리한다(§7.3).

comment on column public.profiles.role is
  'S5-14/FIX-47. **당사자가 쓸 수 없다.** is_operator() 가 이 값을 읽고, 그 하나가 운영자 콘솔 전체를 연다 — 스스로 admin 으로 바꿀 수 있으면 모든 운영자 검사가 아무것도 검사하지 않는다(로컬에서 재현 확인). 승격은 서비스롤 경유다(D-62).';

-- ══════════════════════════════════════════════════════════════════════════
-- 2. 승격을 되돌릴 수 없게 만들지는 않는다 — 다만 흔적을 남긴다
-- ══════════════════════════════════════════════════════════════════════════
--
-- 서비스롤은 RLS 를 비켜 가므로 마지막 경계는 트리거다. 다만 **역할 변경을 막지는
-- 않는다** — 운영자 승격·해제는 실제로 필요한 일이고, 그것을 트리거로 얼리면
-- 사람을 못 바꾼다. 대신 **바뀌었다는 사실이 반드시 남게** 한다.
--
-- **새 표를 만들지 않는다.** 전이는 `entity_events` 가 갖는다(D-23) — 여기서는
-- 트리거가 그 행을 직접 넣어, **어느 경로로 바꾸든**(서비스롤·psql·마이그레이션)
-- 기록이 빠지지 않게 한다. 앱 코드에만 기대면 다른 경로가 조용히 지나간다.
create or replace function public.log_profile_role_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.role is distinct from old.role then
    insert into public.entity_events
      (entity_type, entity_id, event_type, actor_id, actor_role, before_state, after_state, source, memo)
    values
      ('profile', new.user_id, 'profile_role_changed',
       -- 세션이 없으면(서비스롤·psql) 바뀐 당사자를 행위자로 적는다. **비워 두지
       -- 않는다** — 누가 했는지 모르는 것과 기록이 없는 것은 다르다.
       coalesce(auth.uid(), new.user_id), null,
       old.role::text, new.role::text, 'system',
       -- 이름·이메일을 담지 않는다(§7.3). 남길 사실은 전이뿐이다.
       'role_change');
  end if;

  return new;
end;
$$;

drop trigger if exists trg_profiles_role_change on public.profiles;
create trigger trg_profiles_role_change
  after update on public.profiles
  for each row execute function public.log_profile_role_change();

comment on function public.log_profile_role_change() is
  'S5-14/FIX-47. 역할 변경을 entity_events 에 남긴다. 트리거인 이유 — 승격 경로가 앱 하나가 아니라서(서비스롤·psql·마이그레이션) 앱 코드에만 기대면 다른 경로가 조용히 지나간다.';

-- ══════════════════════════════════════════════════════════════════════════
-- 3. 플랫폼 쿠폰은 운영자가 만든다 — 그러나 **업체 쿠폰은 만들지 못한다** (T-00e)
-- ══════════════════════════════════════════════════════════════════════════
--
-- `coupons_write_vendor` 는 `issuer_type='vendor' and is_vendor_owner(issuer_id)` 라
-- 운영자에게는 애초에 INSERT 정책이 없었다 — **플랫폼 쿠폰을 만들 길이 없다.**
--
-- 여는 방법이 둘인데 갈린다.
--   (가) `to authenticated` INSERT 정책을 `is_operator() and issuer_type='platform'`
--        로 추가한다.
--   (나) 쓰기를 서비스롤로 보낸다(D-62).
--
-- **(가)를 고른다.** 이유는 `coupons` 의 쓰기가 **이미 정책으로 서 있기 때문**이다 —
-- 업체는 정책으로, 운영자는 서비스롤로 가르면 같은 표에 두 규약이 생기고 다음 사람이
-- 어느 쪽을 따라야 할지 알 수 없다. 그리고 **정책이 조건을 스스로 말하면
-- `db:rls` 가 그것을 읽어 검사할 수 있다**(서비스롤 경로는 코드를 읽어야 안다).
--
-- **`issuer_type='platform' and issuer_id is null` 을 정책이 못 박는다** — 운영자가
-- **업체 이름으로** 쿠폰을 만들면 **남의 정산에서 깎는 쿠폰**이 되고, 부담 주체가
-- 만든 사람과 갈린다(T-00e 가 금지한 바로 그것 · FIX-45 와 같은 자리다).
create policy coupons_write_platform on public.coupons
  for insert to authenticated
  with check (issuer_type = 'platform' and issuer_id is null and public.is_operator());

create policy coupons_update_platform on public.coupons
  for update to authenticated
  using (issuer_type = 'platform' and public.is_operator())
  with check (issuer_type = 'platform' and issuer_id is null and public.is_operator());

comment on table public.coupons is
  'S5-13/S5-14. 업체 쿠폰은 대표가(coupons_write_vendor), 플랫폼 쿠폰은 운영자가(coupons_write_platform) 만든다. **두 정책 모두 issuer_type 을 못 박는다** — 운영자가 업체 이름으로 만들면 남의 정산에서 깎는 쿠폰이 되고 부담 주체가 만든 사람과 갈린다(T-00e). 발급이 시작되면 돈에 관한 조건은 얼어붙는다(D-159).';

-- TRUNCATE 는 0053 이 전역으로 걷었다. 매번 다시 센다(함정 7).
revoke truncate on public.profiles, public.coupons from anon, authenticated;
