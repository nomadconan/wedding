-- =============================================================================
-- 0046 · 만료형 공유 링크 (S7-12)
-- 근거: docs/07_개발명세서.md §2.1 F-C-20, §3.7 share_links, §3.9 RLS,
--       §4.2 POST /api/share-links · GET /api/share/[token], §6.2 /share/[token],
--       §7.4 파라미터
-- =============================================================================
-- 표는 0004 가 이미 만들었다. 이 파일이 더하는 것은 **거둠·작성자·어휘·열람 함수**다.
--
-- 판단이 필요했던 지점과 근거
--
--  1. **거둘 수 있어야 한다.** 0004 는 `expires_at` 만 뒀다. 그런데 링크를 잘못 보낸
--     순간 사용자가 할 수 있는 일이 **기한이 지나기를 기다리는 것뿐**이면, 그것은
--     계약서 검토 결과에 대해 우리가 줄 수 있는 통제가 아니다. `revoked_at` 을 더한다.
--     **행을 지우지 않는다** — 지우면 "그 링크가 있었다" 는 사실까지 사라지고(D-23),
--     같은 토큰이 다시 발급될 여지가 생긴다.
--
--  2. **누가 만들었는지 남긴다.** `created_by` 가 없으면 "내가 만든 링크" 목록을
--     만들 수 없고, 무엇보다 **누가 이 리포트를 밖으로 보냈나**를 답할 수 없다.
--     커플은 두 사람이므로(D-19) 배우자가 만든 링크도 함께 보여야 한다 —
--     그 판정은 **자원 소유로** 한다(아래 4번).
--
--  3. **어휘를 DB 가 강제한다.** `resource_type` 이 자유 텍스트면 오타 하나가
--     **영영 열리지 않는 링크**를 만든다. 지금 열린 것은 `report` 하나이고
--     `estimate_comparison` 은 **자원 자체가 아직 없다**(S7-05 · §3.5) — 어휘에는
--     넣되 코드가 로더 없는 유형을 발급하지 않는다(D-46 과 같은 처리).
--
--  4. **권한은 자원으로 판정한다.** `share_links` 에 `couple_id` 를 두지 않았다 —
--     링크는 여러 종류의 자원을 가리키고 그 소유 구조가 저마다 다르다. 대신 규칙 하나로
--     정한다: **그 자원을 읽을 수 있으면 링크를 만들고 거둘 수 있다.** 판정은 요청자의
--     세션 클라이언트가 자원을 실제로 읽어 보는 것으로 하며, 그러면 경계는 언제나 RLS 다.
--     `share_links` 자체는 **정책 없는 서비스롤 전용**으로 둔다(0005 [61] 그대로).
--
--  5. **여는 일은 SECURITY DEFINER 함수가 한다.** 링크는 **토큰을 가진 것이 곧 권한**
--     이라 RLS 로 표현할 수 없다(익명이 연다). 그래서 판정을 함수 안에 두고 —
--     만료·거둠을 확인하고 살아 있을 때만 자원을 가리킨다 — 함수 밖으로는
--     **토큰으로 조회하는 경로 자체를 열지 않는다.**
--     열람 수 증가도 같은 함수가 한다: 조회와 집계가 갈라지면 **열리지 않은 링크가
--     열린 것으로 세어지는** 경로가 생긴다.
-- =============================================================================

-- =============================================================================
-- 1) 컬럼 — 거둠 · 작성자 · 마지막 열람
-- =============================================================================
alter table public.share_links
  add column if not exists created_by uuid references auth.users (id) on delete set null,
  add column if not exists revoked_at timestamptz,
  add column if not exists last_viewed_at timestamptz;

comment on column public.share_links.revoked_at is
  '보낸 사람이 링크를 거둔 시각. **행을 지우지 않는다** — 지우면 "그 링크가 있었다"는 사실까지 사라지고(D-23) 같은 토큰이 다시 발급될 여지가 생긴다. 화면은 만료와 거둠을 **다른 문장**으로 말한다(받는 사람이 할 일이 다르다).';
comment on column public.share_links.created_by is
  '링크를 만든 사람. "누가 이 리포트를 밖으로 보냈나"를 답하는 자리다(D-23). 권한 판정에는 쓰지 않는다 — 그것은 자원을 읽을 수 있는가로 한다.';
comment on column public.share_links.last_viewed_at is
  '마지막 열람 시각. view_count 와 함께 share_link_open() 만 갱신한다.';
comment on column public.share_links.view_count is
  '**열람 요청 수**다(고유 방문자가 아니다). share_link_open() 이 살아 있는 링크에서만 올린다 — 만료·거둠 요청은 세지 않는다.';

create index if not exists idx_share_links_created_by on public.share_links (created_by);

-- =============================================================================
-- 2) 어휘 — 오타 하나가 영영 열리지 않는 링크를 만들지 않게
-- =============================================================================
create or replace function public.is_share_resource_type(p_value text)
returns boolean language sql immutable set search_path = public as $$
  select p_value in ('report', 'estimate_comparison');
$$;

comment on function public.is_share_resource_type(text) is
  '공유 가능한 자원 유형(§2.1 F-C-20). 코드(lib/core/share/share.ts)와 같은 집합이며 db:rls 가 대조한다. estimate_comparison 은 어휘에 있으나 **자원 자체가 아직 없다**(S7-05) — 코드가 로더 없는 유형을 발급하지 않는다(D-46 과 같은 처리).';

-- 어휘 밖의 값이 이미 있으면 CHECK 가 서지 않는다. 있을 리 없지만(화면이 없었다)
-- **지우지 않고 거둔 것으로 표시한다** — 링크가 있었다는 사실은 남긴다.
update public.share_links
   set revoked_at = coalesce(revoked_at, now())
 where not public.is_share_resource_type(resource_type);

update public.share_links
   set resource_type = 'report'
 where not public.is_share_resource_type(resource_type);

alter table public.share_links
  drop constraint if exists share_links_resource_type_vocab;
alter table public.share_links
  add constraint share_links_resource_type_vocab
  check (public.is_share_resource_type(resource_type));

-- =============================================================================
-- 3) 운영 파라미터 — 기한 (§7.4)
-- =============================================================================
-- **값을 넣되, 없으면 발급하지 않는다.** 업체 초대(`vendor_invite.ttl_hours`)는 코드에
-- 폴백 상수를 두었지만 여기는 두지 않았다 — 그쪽은 **이미 아는 사람에게 보내는 초대**
-- 이고 이쪽은 **계약서 검토 결과를 링크 하나로 여는 일**이다. 기한 없는 공유 링크는
-- 영구 공개와 같고, 설정을 지웠을 때 그 상태로 조용히 넘어가는 경로를 만들지 않는다
-- (D-49 · D-82 와 같은 규칙 — 미설정을 무제한·0으로 읽지 않는다).
insert into public.app_settings (key, value_json, description)
values (
  'share.link_ttl_hours',
  '{"hours": 168}'::jsonb,
  '공유 링크 유효 기간(시간). 초기값 168시간(7일). **값이 없으면 링크를 발급하지 않는다** — 기한 없는 공유 링크는 영구 공개와 같다. 운영이 배포 없이 조정한다(§7.4).'
)
on conflict (key) do nothing;

-- =============================================================================
-- 4) 여는 함수 — 토큰이 곧 권한이라 RLS 로 표현할 수 없다
-- =============================================================================
create or replace function public.share_link_open(p_token text)
returns table (
  id            uuid,
  resource_type text,
  resource_id   uuid,
  expires_at    timestamptz,
  revoked_at    timestamptz,
  view_count    integer
)
language plpgsql security definer set search_path = public as $$
declare
  v_row public.share_links%rowtype;
begin
  -- 토큰은 유니크다. 없으면 **아무 행도 내지 않는다** — 호출부가 'missing' 으로 읽는다.
  select * into v_row from public.share_links s where s.token = p_token;

  if not found then
    return;
  end if;

  -- **살아 있을 때만 센다.** 만료·거둠 요청까지 세면 "몇 번 열렸나" 가 거짓이 된다.
  if v_row.revoked_at is null and v_row.expires_at > now() then
    update public.share_links
       set view_count = public.share_links.view_count + 1,
           last_viewed_at = now()
     where public.share_links.id = v_row.id
     returning * into v_row;
  end if;

  -- **상태를 여기서 문장으로 바꾸지 않는다.** 만료·거둠 판정은 코드가 하고
  -- (`shareLinkState`) 여기서는 사실만 내보낸다 — 판정이 두 곳에 있으면 갈린다.
  return query
    select v_row.id, v_row.resource_type, v_row.resource_id,
           v_row.expires_at, v_row.revoked_at, v_row.view_count;
end;
$$;

comment on function public.share_link_open(text) is
  '토큰으로 공유 링크를 연다(F-C-20). **SECURITY DEFINER 인 이유** — 링크는 토큰을 가진 것이 곧 권한이라 RLS 로 표현할 수 없다(익명이 연다). 함수 밖으로는 토큰 조회 경로를 열지 않으며, 열람 수는 **살아 있는 링크에서만** 오른다. 만료·거둠의 판정 문장은 코드(lib/core/share)가 갖는다.';

revoke all on function public.share_link_open(text) from public;
-- **서비스롤에도 명시적으로 준다.** `revoke all ... from public` 이 service_role 의
-- 상속분까지 걷어 가므로, 빠뜨리면 서버가 자기 함수를 못 부른다(흐름 점검이 잡았다).
grant execute on function public.share_link_open(text) to anon, authenticated, service_role;

-- =============================================================================
-- 0046 산출 요약
-- =============================================================================
--   테이블 0 (0004 가 이미 만들었다) · 컬럼 3 · 함수 2 · CHECK 1 · 인덱스 1
--   운영 파라미터 1 — share.link_ttl_hours (168시간 · 없으면 발급하지 않는다)
--
--   **RLS 를 새로 걸지 않았다** — 0005 [61] 이 share_links 를 정책 없는 서비스롤 전용
--   으로 두었고 그대로가 맞다. 발급·거둠의 권한은 **가리키는 자원을 읽을 수 있는가**로
--   판정하며 그 판정은 요청자의 세션 클라이언트가 한다(경계는 언제나 RLS).
-- =============================================================================
