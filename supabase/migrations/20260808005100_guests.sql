-- =============================================================================
-- 0051 · 하객·좌석 (S7-09)
-- 근거: docs/07_개발명세서.md §2.1 F-C-22, §3.2 guests·seating_plans, §3.9 RLS,
--       §4.2(**하객 API 행이 없어 이번에 신설한다**), §6.2 /guests, §7.3
-- =============================================================================
-- 표는 0002 가 이미 만들었고 RLS 도 0005 [15][16] 이 걸어 두었다. 이 파일이 더하는 것은
-- **어휘·불변식·초대 토큰·공개 응답 경로**다.
--
-- 판단이 필요했던 지점과 근거
--
--  1. **이름을 암호화하지 않는다.** §3.2 가 `name text` 로 적었고 그대로 둔다.
--     · **되읽어야 하는 값**이다. 명단 화면의 목적이 이름을 보여 주는 것이므로
--       해시는 불가능하고, 암호화하면 키는 결국 서버 환경변수에 있다 — DB 에 닿는
--       공격자는 키에도 닿으므로 **위협 모델이 거의 같아진다.**
--     · `biz_no_enc`(사업자번호)·`contact_hash`(연락처)와 다르다. 앞은 **법적 식별자**라
--       유출 피해가 크고, 뒤는 **같은지만 알면 되는 값**이라 해시로 충분하다.
--     · 그래서 이름의 보호는 암호화가 아니라 **나가는 자리를 막는 것**으로 한다 —
--       RLS(커플 + 위임 플래너) · 이벤트 금지(§7.3) · 업체 경로 없음 · 공개 응답
--       경로에서 **이름을 쓰지 못하게** 하는 컬럼 권한.
--
--  2. **플래너는 읽기만 한다.** 0005 [15][16] 이 이미 `has_planner_scope` 로 읽기를,
--     쓰기는 `is_couple_member` 로 좁혀 두었다 — **S3-04(장바구니 읽기만)와 같은
--     모양**이다. 플래너 열람을 막지 않는 이유는 좌석·답례품·청첩장이 **플래너의
--     실제 업무**이기 때문이고, 그 위임은 커플이 표 단위·기간 단위로 스스로 켠다
--     (`planner_engagements.scope_json.tables`). S4-01 이 채팅을 막은 것과 다른 이유:
--     **채팅은 대화 내용**이라 위임의 대상이 아니지만 명단은 위임의 대상이다.
--
--  3. **초대 토큰을 `share_links` 에 두지 않는다.**
--     · `share_links.resource_id` 는 **행 하나**를 가리키는데 초대는 **하객마다 다른
--       링크**여야 한다(누가 답했는지 알아야 한다).
--     · **만료의 뜻이 정반대다.** S7-12 는 설정이 없으면 링크를 만들지 않는다(만료
--       없는 공유 = 영구 공개). 청첩장은 **예식일까지 살아 있어야** 하고 짧은 만료가
--       오히려 사고다. 그래서 만료를 **시간 상수가 아니라 `couples.wedding_date`** 로
--       둔다 — 임의 숫자가 끼지 않고, **예식일이 없으면 발급하지 않는다**(D-49 계열).
--
--  4. **하객이 자기 이름을 못 바꾼다.** 공개 응답은 `respond_to_invite()` 하나로만
--     들어오고 그 함수는 `rsvp_status`·`party_size`·`responded_at` 만 건드린다.
--     `anon` 에게는 `guests` 의 어떤 권한도 주지 않는다.
--
--  5. **커플도 토큰·응답시각을 직접 못 쓴다**(FIX-30 계열 · 함정 6). 토큰을 손으로
--     넣을 수 있으면 **남의 하객 토큰을 자기 행에 복사**하는 모양이 가능해지고,
--     `responded_at` 을 직접 쓰면 "언제 답했나" 가 사실이 아니게 된다.
--
--  6. **답례품 수량 컬럼이 없다.** RSVP 응답에서 계산한다 — 저장하면 응답이 바뀔
--     때마다 두 값이 갈린다(D-84 와 같은 판단).
-- =============================================================================

-- =============================================================================
-- 1) 어휘 — 오타 하나가 집계에서 빠지지 않게
-- =============================================================================
create or replace function public.is_rsvp_status(p_value text)
returns boolean language sql immutable set search_path = public as $$
  select p_value in ('pending', 'attending', 'declined');
$$;

create or replace function public.is_guest_side(p_value text)
returns boolean language sql immutable set search_path = public as $$
  select p_value in ('groom', 'bride', 'both', 'unassigned');
$$;

comment on function public.is_rsvp_status(text) is
  '참석 응답 어휘(§3.2). 코드(lib/core/guest)와 같은 집합이며 db:rls 가 대조한다. **pending 과 declined 를 합치지 않는다** — 미응답은 아직 모르는 수이고 불참은 확정된 0이라 답례품 수량 판단이 다르다.';
comment on function public.is_guest_side(text) is
  '하객 구분 어휘(§3.2). `unassigned` 를 두는 이유는 모르는 것을 한쪽으로 밀어 넣지 않기 위해서다 — 미정을 신랑 측으로 세면 좌석 수가 조용히 틀어진다.';

-- 어휘 밖의 값은 **지우지 않고 안전한 쪽으로 옮긴다.**
update public.guests set rsvp_status = 'pending' where not public.is_rsvp_status(rsvp_status);
update public.guests set side = 'unassigned' where side is null or not public.is_guest_side(side);

alter table public.guests alter column side set default 'unassigned';
alter table public.guests alter column side set not null;

alter table public.guests drop constraint if exists guests_rsvp_status_vocab;
alter table public.guests
  add constraint guests_rsvp_status_vocab check (public.is_rsvp_status(rsvp_status));

alter table public.guests drop constraint if exists guests_side_vocab;
alter table public.guests
  add constraint guests_side_vocab check (public.is_guest_side(side));

-- **이름은 비어 있을 수 없다.** 빈 줄은 명단에서 인원만 늘리고 아무도 가리키지 않는다.
alter table public.guests drop constraint if exists guests_name_not_blank_chk;
alter table public.guests
  add constraint guests_name_not_blank_chk check (length(btrim(name)) between 1 and 40);

alter table public.guests drop constraint if exists guests_party_size_chk2;
alter table public.guests
  add constraint guests_party_size_chk2 check (party_size between 1 and 20);

comment on column public.guests.name is
  '하객 이름. **평문이다**(§3.2 원문 그대로). 되읽어야 하는 값이라 해시가 불가능하고, 암호화해도 키가 서버 환경변수에 있어 위협 모델이 크게 달라지지 않는다. 보호는 **나가는 자리를 막는 것**으로 한다 — RLS(커플 + 위임 플래너) · entity_events 금지(§7.3) · 업체 경로 없음 · 공개 응답 경로에서 쓰기 불가(0051 컬럼 권한).';
comment on column public.guests.party_size is
  '동반 인원을 포함한 **그 줄의 총 인원**(본인 포함). 불참으로 답한 줄의 동반 인원은 세지 않는다 — 안 오는 사람의 동반자도 안 온다.';

-- =============================================================================
-- 2) 초대 토큰 — 하객마다 하나
-- =============================================================================
alter table public.guests add column if not exists invite_token text;
alter table public.guests add column if not exists responded_at timestamptz;

-- 토큰은 **있으면 유일하다.** 없는 줄이 대부분이므로 부분 유니크다.
create unique index if not exists uq_guests_invite_token
  on public.guests (invite_token) where invite_token is not null;

-- 짧은 토큰은 맞혀질 수 있다. 링크에 실리므로 짧을 이유가 없다(S7-12 와 같은 판단).
alter table public.guests drop constraint if exists guests_invite_token_len_chk;
alter table public.guests
  add constraint guests_invite_token_len_chk
  check (invite_token is null or length(invite_token) >= 32);

-- **답한 줄에는 답한 시각이 있다.** 없으면 "언제 답했나" 를 답할 수 없다.
alter table public.guests drop constraint if exists guests_responded_at_chk;
alter table public.guests
  add constraint guests_responded_at_chk
  check (rsvp_status = 'pending' or responded_at is not null);

comment on column public.guests.invite_token is
  '하객별 초대(청첩) 링크 토큰. **share_links 를 쓰지 않는다**(0051 주석 3) — 그쪽은 행 하나를 가리키고 만료가 짧아야 하는 구조인데, 초대는 하객마다 다르고 예식일까지 살아 있어야 한다. **커플도 직접 쓸 수 없다**(컬럼 권한) — 손으로 넣을 수 있으면 남의 토큰을 자기 행에 복사하는 모양이 가능하다.';
comment on column public.guests.responded_at is
  '하객이 답한 시각. **직접 쓸 수 없다** — respond_to_invite() 만 채운다. 직접 쓰면 "언제 답했나" 가 사실이 아니게 된다.';

create index if not exists idx_guests_couple_rsvp on public.guests (couple_id, rsvp_status);

-- =============================================================================
-- 3) 컬럼 권한 — 당사자가 직접 못 넣게 (FIX-30 계열)
-- =============================================================================
-- 0005 [15] 의 UPDATE 정책은 컬럼을 구분하지 못한다. **토큰과 응답 시각은 서버가**
-- **정하는 값**이므로 세션에서 쓰지 못하게 좁힌다. `from public` 이 아니라
-- **`from authenticated`** 다 — S7-12 에서 `from public` 한 줄이 service_role 상속분까지
-- 걷어가 함수가 서버에서 안 돌았다.
revoke update on public.guests from authenticated;
grant update (name, side, contact_hash, rsvp_status, party_size)
  on public.guests to authenticated;

-- `anon` 에게는 아무 권한도 주지 않는다. 공개 응답은 아래 함수 하나로만 들어온다.
revoke all on public.guests from anon;

-- =============================================================================
-- 4) 공개 응답 — 함수 하나가 유일한 문이다
-- =============================================================================
-- **definer 가 꼭 필요한 자리다.** 응답하는 사람은 로그인하지 않았고 `guests` 에
-- 어떤 권한도 없다. 관성으로 쓰는 것이 아니라(S7-10·S7-13 이 세운 규칙) **비로그인이
-- 자기 줄 하나만 건드려야** 하기 때문이며, 함수가 하는 일은 **세 칸을 쓰는 것**뿐이다.
--
-- 만료를 함수 안에서 본다. **예식일 당일까지** 받으며 그 뒤에는 아무것도 바꾸지 않는다.
create or replace function public.respond_to_invite(
  p_token text,
  p_answer text,
  p_party_size integer
)
returns table (ok boolean, reason text)
language plpgsql volatile security definer set search_path = public as $$
declare
  v_guest   public.guests%rowtype;
  v_wedding date;
begin
  if p_answer not in ('attending', 'declined') then
    return query select false, 'bad_answer';
    return;
  end if;

  if p_party_size is null or p_party_size < 1 or p_party_size > 20 then
    return query select false, 'bad_party_size';
    return;
  end if;

  select * into v_guest from public.guests where invite_token = p_token;

  if not found then
    return query select false, 'not_found';
    return;
  end if;

  select c.wedding_date into v_wedding from public.couples c where c.id = v_guest.couple_id;

  -- 예식일이 없으면 애초에 발급되지 않지만, 그 사이 지워졌을 수 있다.
  if v_wedding is null then
    return query select false, 'no_wedding_date';
    return;
  end if;

  if current_date > v_wedding then
    return query select false, 'closed';
    return;
  end if;

  -- **이름을 건드리지 않는다.** 링크를 받은 사람은 답만 한다.
  update public.guests
     set rsvp_status = p_answer,
         party_size = p_party_size,
         responded_at = now()
   where id = v_guest.id;

  return query select true, 'ok';
end;
$$;

comment on function public.respond_to_invite(text, text, integer) is
  '하객 참석 응답(F-C-22). **비로그인이 들어오는 유일한 문**이며 rsvp_status·party_size·responded_at 세 칸만 쓴다 — 이름은 건드리지 않는다. definer 인 이유는 응답자가 guests 에 어떤 권한도 없기 때문이고, 만료는 couples.wedding_date 가 정한다(예식일 당일까지).';

-- **`revoke ... from public` 을 쓰지 않는다**(S7-12 사고). 필요한 역할에만 명시적으로.
grant execute on function public.respond_to_invite(text, text, integer)
  to anon, authenticated, service_role;

-- 응답 화면이 **누구의 예식인지**만 알면 되는 조회. 이름·연락처는 나가지 않는다.
create or replace function public.invite_context(p_token text)
returns table (guest_name text, wedding_date date, rsvp_status text, party_size integer, closed boolean)
language sql stable security definer set search_path = public as $$
  select g.name, c.wedding_date, g.rsvp_status, g.party_size,
         (c.wedding_date is null or current_date > c.wedding_date)
    from public.guests g
    join public.couples c on c.id = g.couple_id
   where g.invite_token = p_token;
$$;

comment on function public.invite_context(text) is
  '초대 링크가 여는 화면의 컨텍스트(F-C-22). **본인 이름만** 나간다 — 같은 커플의 다른 하객 이름·연락처는 나가지 않는다. 링크를 가진 사람이 자기 이름을 보는 것은 "내 초대가 맞는가" 를 확인하는 데 필요하다.';

grant execute on function public.invite_context(text) to anon, authenticated, service_role;

-- =============================================================================
-- 5) 좌석 배치 — 커플당 하나
-- =============================================================================
-- 배치가 여럿이면 "지금 쓰는 배치가 어느 것인가" 를 화면이 답할 수 없다. `version` 은
-- 0002 가 이미 갖고 있으므로 **행을 늘리지 않고 같은 행을 올린다.**
delete from public.seating_plans p
 where exists (
   select 1 from public.seating_plans o
    where o.couple_id = p.couple_id
      and (o.updated_at > p.updated_at
           or (o.updated_at = p.updated_at and o.id::text > p.id::text))
 );

create unique index if not exists uq_seating_plans_couple on public.seating_plans (couple_id);

alter table public.seating_plans drop constraint if exists seating_plans_layout_object_chk;
alter table public.seating_plans
  add constraint seating_plans_layout_object_chk check (jsonb_typeof(layout_json) = 'object');

comment on table public.seating_plans is
  '좌석 배치 초안(F-C-22). **커플당 한 행**이며 고칠 때 version 을 올린다. layout_json 은 {"tables":[{id,name,capacity,guestIds}]} 이고 **이름을 담지 않는다**(id 만) — 배치가 이름을 갖고 있으면 명단에서 지운 사람의 이름이 배치에 남는다. **좌표를 두지 않는다**: §2.1 이 요구한 것은 "초안" 이고, 도면 편집기는 375px 에서 쓸 수 없으며 예식장 도면 없이는 배치가 사실도 아니다(D-78 과 같은 판단).';

-- =============================================================================
-- 0051 산출 요약
-- =============================================================================
--   테이블 0 (0002 가 이미 만들었다) · 컬럼 2 · 함수 4 · CHECK 6 · 유니크 2 ·
--   인덱스 1 · 컬럼 권한 회수 2
--
--   **RLS 를 새로 걸지 않았다** — 0005 [15][16] 이 커플 + 위임 플래너(읽기만)를
--   이미 걸어 두었다. 이 파일은 그 위에 **컬럼 권한**과 **공개 응답 함수**를 얹는다.
--   **답례품 수량 컬럼이 없다** — 계산값이다(lib/core/guest).
--   **이름을 암호화하지 않았다** — 위 1번.
-- =============================================================================
