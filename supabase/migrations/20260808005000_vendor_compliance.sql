-- =============================================================================
-- 0050 · 컴플라이언스 자가 진단 (S7-13)
-- 근거: docs/07_개발명세서.md §2.3 F-V-10, §3.5 detect_rules, §3.9 RLS,
--       §4.2 POST /api/vendor/compliance/scan, §6.3 /vendor/compliance,
--       §7.4 파라미터, CLAUDE.md §2.2·§5.1
-- =============================================================================
-- **§3 에 없던 표를 하나 신설한다**(`vendor_compliance_scans`). 명세 §3 은 소비자
-- 문서(`documents`·`document_analyses`)만 갖고 있고 업체 약관 진단을 담을 자리가 없다.
-- 소비자 표에 섞지 않는 이유는 아래 2번이다. 명세 §3.5 에 행 추가를 제안한다.
--
-- 판단이 필요했던 지점과 근거
--
--  1. **원문을 저장하지 않는다.** 이 표에 `body` 컬럼이 없다. 업로드 원문은 24시간 내
--     파기가 원칙인데(CLAUDE.md §5.1) **애초에 저장하지 않으면 파기할 것도 없다.**
--     진단은 요청 본문을 메모리에서 스캔하고 **구조화 결과(findings)만** 남긴다 —
--     `documents` 를 쓰면 `purge_scheduled_at` 과 파기 배치가 따라붙는데, 업체가 자기
--     약관을 넣는 일에 그 무게를 지울 이유가 없다.
--
--  2. **소비자 문서 표에 섞지 않는다.** `documents` 는 커플 스코프이고 RLS 가
--     `is_couple_member` 로 판정한다. 업체 행을 그 표에 넣으면 **정책이 두 주체를
--     동시에 다뤄야 하고**, 그런 정책은 한쪽을 고칠 때 다른 쪽이 조용히 열린다.
--
--  3. **배지를 애플리케이션이 두 번 쓰지 않는다.** `vendors.badge_flags` 는 탐색·상세가
--     읽는 값이고 진단 결과는 이 표가 갖는다. 두 곳을 코드가 각각 갱신하면 **화면이
--     말하는 배지와 근거가 갈린다**(S7-11 이 등급에서 겪은 것과 같은 계열). 그래서
--     **스캔 행이 들어오는 순간 트리거가 배지를 맞춘다** — 판정자가 하나다.
--
--  4. **배지 기준은 파라미터다.** `compliance.badge_max_high` 이며 **값을 넣는다**(0).
--     이것은 임의 숫자가 아니라 **등급 정의에서 따라 나오는 값**이다 — T-04 가 `high` 를
--     "소비자에게 불리하고 근거가 있는 것" 으로 정의했으므로 그런 항목이 남은 약관을
--     '투명 계약' 이라 부를 수 없다. 반면 **`mid` 를 몇 개까지 봐줄지는 답이 임의**라
--     기준에 넣지 않았다. 값이 비면 코드는 **배지를 주지 않는다**(D-49·D-90).
--
--  5. **유효기간 컬럼을 두지 않는다.** 약관은 바뀌고 배지는 진단 시점의 문서에 대한
--     것이다. 만료일을 두는 대신 **진단 날짜를 배지와 함께 늘 보여준다** — 기간을
--     정하는 것은 또 하나의 임의 숫자이고, 날짜를 보이면 보는 사람이 스스로 판단한다.
--
--  6. **개수 컬럼을 두지 않는다.** high/mid/low 건수는 `findings_json` 에서 센다 —
--     계산 가능한 값을 저장하면 둘이 갈린다(D-84 와 같은 판단). 트리거는 저장이 아니라
--     **판정에** 그 값을 쓴다.
-- =============================================================================

-- =============================================================================
-- 1) 진단 이력
-- =============================================================================
create table if not exists public.vendor_compliance_scans (
  id           uuid primary key default gen_random_uuid(),
  vendor_id    uuid not null references public.vendors (id) on delete cascade,
  -- **누가 돌렸는가.** 업체는 여러 명이 쓰는 계정이라(vendor_members) 책임이 갈린다.
  scanned_by   uuid references auth.users (id) on delete set null,
  -- 구조화 결과만. **원문도 전체 인용도 아니다** — 걸린 항목과 그 문장 조각이다.
  findings_json jsonb not null default '[]'::jsonb,
  -- 검사한 룰 수. 나중에 룰이 늘면 **"그때는 몇 종으로 봤는가"** 를 답해야 한다.
  rule_count   integer not null check (rule_count > 0),
  created_at   timestamptz not null default now()
);

comment on table public.vendor_compliance_scans is
  '업체 약관 자가 진단 이력(F-V-10). **원문을 저장하지 않는다** — 요청 본문을 메모리에서 스캔하고 구조화 결과만 남긴다(CLAUDE.md §5.1: 저장하지 않으면 파기할 것도 없다). 검출은 소비자 리포트와 **같은 룰 20종**(T-04)을 쓰며 AI 를 부르지 않는다(같은 문서에 같은 답이 나와야 배지가 우연이 아니다).';
comment on column public.vendor_compliance_scans.findings_json is
  '걸린 항목 배열. 각 원소는 rule_code·severity·kind·clause_excerpt 를 갖는다. **건수를 따로 저장하지 않는다** — 여기서 센다(계산 가능한 값을 저장하지 않는다).';
comment on column public.vendor_compliance_scans.rule_count is
  '진단 시점에 검사한 활성 룰 수. 룰이 늘어난 뒤에도 **그때 몇 종으로 봤는지**를 답할 수 있어야 한다.';

alter table public.vendor_compliance_scans
  drop constraint if exists vendor_compliance_scans_findings_array_chk;
alter table public.vendor_compliance_scans
  add constraint vendor_compliance_scans_findings_array_chk
  check (jsonb_typeof(findings_json) = 'array');

create index if not exists idx_vendor_compliance_scans_vendor
  on public.vendor_compliance_scans (vendor_id, created_at desc);

-- =============================================================================
-- 2) RLS — 업체 자기 것만. 소비자에게는 결과가 아니라 배지만 간다
-- =============================================================================
alter table public.vendor_compliance_scans enable row level security;

-- **읽기는 업체 멤버만.** 진단 결과에는 걸린 조항의 인용이 들어 있고, 그것은 업체가
-- 아직 고치는 중인 자기 약관의 약점이다. 소비자에게 가는 것은 **배지 하나**이며
-- 배지는 `vendors.badge_flags` 가 갖는다(공개 표).
create policy vendor_compliance_scans_select on public.vendor_compliance_scans
  for select to authenticated
  using (public.is_vendor_member(vendor_id));

-- **쓰기 정책을 두지 않는다.** 진단 실행은 서버(서비스롤)가 한다 — 클라이언트가 직접
-- 행을 넣을 수 있으면 **스캔하지 않고 통과 결과만 넣어 배지를 받을 수 있다.**
-- 배지가 걸린 표라 여기가 이 마이그레이션에서 가장 위험한 자리다.

-- =============================================================================
-- 3) 배지 동기화 — 판정자를 하나로
-- =============================================================================
-- **스캔이 들어오면 배지가 따라 움직인다.** 애플리케이션이 두 곳을 각각 쓰면 화면이
-- 말하는 배지와 그 근거가 갈린다. 회수도 같은 자리에서 한다 — 약관을 고쳐 다시
-- 진단했는데 `high` 가 생겼다면 **배지는 그 순간 떨어져야 한다.**
create or replace function public.sync_transparent_contract_badge()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_max_high integer;
  v_high     integer;
begin
  -- 기준이 없으면 **아무것도 하지 않는다.** 없는 기준을 '0건이면 통과' 로 읽으면
  -- 기준을 코드가 정한 것이 된다(D-49·D-90 · lib/core/compliance 와 같은 판단).
  select (value_json->>'value')::integer into v_max_high
    from public.app_settings where key = 'compliance.badge_max_high';

  if v_max_high is null then
    return new;
  end if;

  select count(*) into v_high
    from jsonb_array_elements(new.findings_json) f
   where f->>'severity' = 'high';

  if v_high <= v_max_high then
    update public.vendors
       set badge_flags = (
             select array_agg(distinct b)
               from unnest(badge_flags || array['transparent_contract']) b
           )
     where id = new.vendor_id;
  else
    update public.vendors
       set badge_flags = coalesce(
             (select array_agg(b) from unnest(badge_flags) b where b <> 'transparent_contract'),
             '{}'
           )
     where id = new.vendor_id;
  end if;

  return new;
end;
$$;

comment on function public.sync_transparent_contract_badge() is
  '진단 결과로 투명계약 배지를 부여·회수한다(F-V-10). **판정자를 하나로 두려고 트리거에 있다** — 애플리케이션이 스캔과 배지를 각각 쓰면 화면이 말하는 배지와 근거가 갈린다. 기준(app_settings.compliance.badge_max_high)이 비어 있으면 아무것도 하지 않는다.';

drop trigger if exists trg_sync_transparent_contract_badge on public.vendor_compliance_scans;
create trigger trg_sync_transparent_contract_badge
  after insert on public.vendor_compliance_scans
  for each row execute function public.sync_transparent_contract_badge();

-- =============================================================================
-- 4) 최신 진단 — 화면·배지 근거가 같은 것을 본다
-- =============================================================================
-- **`security invoker` 다.** 임베드가 필요 없고 경계는 위 [2] 의 정책 그대로다 —
-- definer 로 두면 남의 업체 진단 결과를 볼 수 있는 경로를 스스로 만든다(S7-10 과 같은
-- 판단: 관성적으로 definer 를 쓰지 않는다).
create or replace function public.latest_compliance_scan(p_vendor_id uuid)
returns table (
  id uuid,
  findings_json jsonb,
  rule_count integer,
  created_at timestamptz
)
language sql stable security invoker set search_path = public as $$
  select s.id, s.findings_json, s.rule_count, s.created_at
    from public.vendor_compliance_scans s
   where s.vendor_id = p_vendor_id
   order by s.created_at desc
   limit 1;
$$;

comment on function public.latest_compliance_scan(uuid) is
  '업체의 최신 자가 진단(F-V-10). security invoker — 경계는 RLS 다. 화면과 배지 근거가 같은 행을 본다.';

-- **`revoke ... from public` 을 쓰지 않는다.** S7-12 에서 그 한 줄이 service_role
-- 상속분까지 걷어가 함수가 서버에서 안 돌았다. 필요한 역할에만 명시적으로 준다.
grant execute on function public.latest_compliance_scan(uuid) to authenticated, service_role;

-- =============================================================================
-- 4b) 배지에 날짜를 붙이는 좁은 창 — 소비자에게 딱 이것만 연다
-- =============================================================================
-- **배지는 날짜 없이 나가면 안 된다**(위 5번). 그런데 날짜가 있는 표는 업체 멤버만
-- 읽을 수 있다([2]) — 진단 결과에는 업체가 고치는 중인 약관의 약점이 인용까지 들어
-- 있기 때문이다. 그렇다고 `vendors` 에 날짜 컬럼을 복사하면 **같은 사실을 두 곳이**
-- **갖게 되고** 하나가 늦게 갱신되는 날이 온다(계산 가능한 값을 저장하지 않는다).
--
-- 그래서 **definer 함수로 딱 한 칸만** 연다. S7-10 이 "관성적으로 definer 를 쓰지
-- 않는다" 고 했고 그 판단은 여전히 맞다 — 여기서 쓰는 이유는 **임베드가 편해서가
-- 아니라 소비자가 볼 수 없는 표에서 볼 수 있어야 하는 값 하나를 꺼내야** 하기
-- 때문이다. 함수가 내주는 것은 **시각 하나**이며 findings 는 나가지 않는다.
--
-- **배지가 붙어 있을 때만** 답한다. 배지가 없는데 진단 날짜만 나가면 "진단은
-- 했는데 떨어졌다" 가 노출되고, 그것은 업체에 대한 평가적 사실을 우리가 흘리는 것이다
-- (CLAUDE.md §2.3 — 부정적 판단은 사실과 기준 대비 편차로만).
-- **스칼라가 아니라 한 칸짜리 표를 돌려준다.** 흐름 점검에서 스칼라 반환 함수를
-- supabase-js 로 부르면 값이 `null` 로 오는 것을 확인했다(같은 요청을 raw fetch 로
-- 보내면 값이 온다). 이 리포에서 실제로 도는 모양은 **표 반환 + maybeSingle** 이며
-- (`published_content` · `latest_compliance_scan`) 거기에 맞춘다 — 클라이언트 라이브러리
-- 하나의 특이 동작을 화면 코드가 떠안게 두지 않는다.
create or replace function public.transparent_contract_since(p_vendor_id uuid)
returns table (scanned_at timestamptz)
language sql stable security definer set search_path = public as $$
  select s.created_at
    from public.vendor_compliance_scans s
    join public.vendors v on v.id = s.vendor_id
   where s.vendor_id = p_vendor_id
     and 'transparent_contract' = any (v.badge_flags)
   order by s.created_at desc
   limit 1;
$$;

comment on function public.transparent_contract_since(uuid) is
  '투명계약 배지의 진단 시각(F-V-10). **definer 인 이유는 소비자가 vendor_compliance_scans 를 읽을 수 없기 때문**이며, 내주는 것은 시각 하나다(findings 는 나가지 않는다). 배지가 붙어 있을 때만 답한다 — 떨어진 사실이 흘러나가면 평가적 판단을 노출하는 셈이다(CLAUDE.md §2.3). 배지는 날짜 없이 나가면 안 되고(약관은 바뀐다) 날짜를 vendors 에 복사하면 같은 사실을 두 곳이 갖는다.';

grant execute on function public.transparent_contract_since(uuid) to anon, authenticated, service_role;

-- =============================================================================
-- 4c) 배지를 손으로 달 수 없게 한다 (FIX-30)
-- =============================================================================
-- **`db:rls` 가 잡았다.** 0005 [19] 의 `vendors_update` 는 `is_vendor_member(id)` 로만
-- 판정하므로 업체 멤버가 **`vendors` 의 아무 컬럼이나** 고칠 수 있었다. 그중 둘이
-- 위험하다 —
--
--   · **`badge_flags`** — 진단 없이 `array['transparent_contract']` 를 직접 넣으면
--     **스캔하지 않고 배지를 받는다.** 이 태스크가 세운 트리거([3])가 판정자를 하나로
--     만들었는데, 옆문이 열려 있으면 그 판정이 아무 의미가 없다.
--   · **`status`** — 업체가 스스로 `active` 로 바꾸면 **운영자 심사를 건너뛴다**
--     (F-A-01). 배지보다 더 큰 구멍이며 같은 정책에서 나온다.
--
-- **정책이 아니라 컬럼 권한으로 좁힌다.** 정책에 컬럼 조건을 넣을 수 없고, S5-07 이
-- 정산에서 `vendor_note` 만 열어 둔 것과 같은 방법이다. 세션 클라이언트로 `vendors` 를
-- 갱신하는 곳은 **`PUT /api/vendor/profile` 하나**이며 그 여덟 칸만 연다(입점 신청·
-- 운영자 심사는 서비스롤이라 이 회수의 영향을 받지 않는다).
--
-- **`from public` 이 아니라 `from authenticated` 다.** S7-12 에서 `revoke ... from public`
-- 한 줄이 service_role 상속분까지 걷어가 함수가 서버에서 안 돌았다.
revoke update on public.vendors from authenticated;
grant update (region_code, address, address_detail, capacity_min, capacity_max,
             facilities, style_tags, intro)
  on public.vendors to authenticated;

comment on column public.vendors.badge_flags is
  '사실 기반 배지(투명계약·응답우수)만. 유료 노출 배지 금지(CLAUDE.md §2.2). **업체가 직접 쓸 수 없다**(0050 — 컬럼 권한 회수): 투명계약 배지는 진단 결과로만 붙고 떨어진다(sync_transparent_contract_badge). 손으로 달 수 있으면 진단 없이 배지를 받는다.';

-- =============================================================================
-- 5) 운영 파라미터 (§7.4)
-- =============================================================================
-- **값을 넣는다(0).** 임의 숫자가 아니라 등급 정의에서 따라 나오는 값이다(위 4번).
-- `mid` 허용 개수는 만들지 않았다 — 몇 개까지 봐줄지는 답이 임의다.
insert into public.app_settings (key, value_json, description)
values (
  'compliance.badge_max_high',
  '{"value": 0, "unit": "count"}'::jsonb,
  '투명계약 배지를 주는 high 항목 허용 개수. **0 은 미설정이 아니라 정한 값이다** — high 는 "소비자에게 불리하고 근거가 있는 것"(T-04)이라 그런 항목이 남은 약관을 투명 계약이라 부를 수 없다. 값을 비우면 배지를 부여하지 않는다(코드가 기준을 정하지 않는다 · D-49). mid 허용 개수는 두지 않았다 — 답이 임의다.'
)
on conflict (key) do nothing;

-- =============================================================================
-- 0050 산출 요약
-- =============================================================================
--   테이블 1(**§3 신설 — 명세 반영 제안**) · 함수 3 · 트리거 1 · CHECK 1 ·
--   **컬럼 권한 회수 1(FIX-30 — badge_flags·status 를 업체가 직접 못 쓰게)** ·
--   인덱스 1 · RLS 정책 1(읽기만) · 운영 파라미터 1
--
--   **쓰기 정책을 두지 않았다** — 클라이언트가 행을 넣을 수 있으면 스캔 없이
--   통과 결과만 넣어 배지를 받는다. 진단 실행은 서버가 한다.
--   **원문 컬럼이 없다** — 저장하지 않으므로 파기 배치가 필요 없다.
--   **건수 컬럼이 없다** — findings_json 에서 센다.
-- =============================================================================
