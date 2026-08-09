-- =============================================================================
-- 0012 · 업체 멤버·권한 (S2-07)
-- 근거: docs/07_개발명세서.md §2.2 F-V-13, §3.3 vendor_members, §3.9 RLS, §6.3
-- =============================================================================
-- S2-01~S2-04 가 `vendor_role='owner'` 조건으로 가격·정산 쓰기를 막아 뒀지만
-- **staff 를 만들 화면이 없어** psql 로만 검증할 수 있었다. 이 파일과 S2-07 이 그 간극을 닫는다.
--
-- 이 파일이 DB 층에서 지키는 것은 둘이다. 둘 다 화면·API 가 우회해도 통과하지 못한다.
--   1. **업체에는 owner 가 최소 1명 남아야 한다.** 마지막 owner 를 강등·삭제하면
--      아무도 가격을 못 고치는 잠긴 업체가 된다. 되돌리려면 운영자가 개입해야 한다.
--   2. **자기 자신을 제거할 수 없다.** 실수로 접근 권한을 스스로 없애는 사고를 막는다.
--      (역할 변경은 막지 않는다 — owner 가 둘 이상이면 스스로 staff 로 내려오는 것은 정상이다.)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) 마지막 owner 보호 (트리거)
-- -----------------------------------------------------------------------------
-- CHECK 로는 표현할 수 없다. 같은 테이블의 **다른 행**을 세어야 하기 때문이다.
create or replace function public.assert_vendor_keeps_owner()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  remaining integer;
begin
  -- owner 였던 행이 owner 가 아니게 되는 경우만 검사한다.
  if tg_op = 'UPDATE' and (old.vendor_role <> 'owner' or new.vendor_role = 'owner') then
    return new;
  end if;

  if tg_op = 'DELETE' and old.vendor_role <> 'owner' then
    return old;
  end if;

  select count(*) into remaining
  from public.vendor_members m
  where m.vendor_id = old.vendor_id
    and m.vendor_role = 'owner'
    and m.id <> old.id;

  if remaining = 0 then
    raise exception '업체에는 대표(owner)가 최소 1명 있어야 합니다.'
      using errcode = 'check_violation';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;

  return new;
end;
$$;

comment on function public.assert_vendor_keeps_owner() is
  '마지막 owner 의 강등·삭제를 막는다(F-V-13). owner 가 0명이면 아무도 가격을 고칠 수 없는 잠긴 업체가 된다.';

drop trigger if exists trg_vendor_members_keep_owner on public.vendor_members;
create trigger trg_vendor_members_keep_owner
  before update or delete on public.vendor_members
  for each row execute function public.assert_vendor_keeps_owner();

-- -----------------------------------------------------------------------------
-- 2) 자기 자신 제거 금지 (RLS)
-- -----------------------------------------------------------------------------
-- 앱에서 막는 것으로 끝내지 않는다. 정책에 넣으면 어떤 경로로 들어와도 같은 규칙이 걸린다.
-- (서비스롤은 RLS 를 우회하므로 운영자가 개입할 여지는 남는다 — 의도한 여지다.)
drop policy if exists vendor_members_delete on public.vendor_members;
create policy vendor_members_delete on public.vendor_members
  for delete to authenticated
  using (public.is_vendor_owner(vendor_id) and user_id <> auth.uid());

comment on table public.vendor_members is
  '업체 멤버·권한(F-V-13). 가격·정산 쓰기는 owner 전용이며(§3.9) staff 는 조회·운영 업무만 한다.';

-- 조회 경로: 멤버 목록이 업체 기준으로 역할·가입순으로 읽는다.
create index if not exists idx_vendor_members_vendor_role
  on public.vendor_members (vendor_id, vendor_role, created_at);

-- =============================================================================
-- `permissions_json` 은 이번 범위에서 쓰지 않는다.
--   §2.2 F-V-13 의 "기능별 권한 설정"은 괄호로 그 내용을 못박고 있다 —
--   "(판매가·정산은 owner 전용)". 그 규칙은 이미 RLS 가 강제하므로 별도 권한 맵이 필요 없다.
--   더 세분화된 권한이 필요해지면 그때 이 컬럼을 쓰고, 그전까지 빈 객체로 둔다.
-- =============================================================================

-- =============================================================================
-- 이 파일이 한 것
--   함수 1 · 트리거 1 — 마지막 owner 보호
--   정책 교체 1 — 자기 자신 삭제 금지
--   인덱스 1, 신규 테이블·컬럼 없음
-- =============================================================================
