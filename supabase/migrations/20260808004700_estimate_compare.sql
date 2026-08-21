-- =============================================================================
-- 0047 · 견적 정규화·비교 (S7-05)
-- 근거: docs/07_개발명세서.md §2.1 F-C-06, §3.5 estimate_comparisons,
--       §3.9 RLS, §4.2 POST /api/estimates/normalize · GET /api/estimates/compare,
--       §5.4 견적 정규화, §6.2 /estimates
-- =============================================================================
-- 표는 0004 가 이미 만들었고 RLS 도 0005 [48] 이 걸어 두었다. 이 파일이 더하는 것은
-- **원천 조회 함수와 저장 비교표의 불변식**이다.
--
-- 판단이 필요했던 지점과 근거
--
--  1. **업체 이름·카테고리를 임베드로 읽지 않는다.** `vendors` 는 공개 조건이 붙은
--     표라 **행이 안 보이면 임베드가 조용히 `null` 을 준다**(S7-07 이 겪은 것 —
--     1,200만원짜리 계약이 '기타' 로 떨어졌다). 견적에서는 그 값이 **분류의 근거**라
--     같은 사고가 나면 견적이 통째로 `unmapped` 가 되고, 화면은 "표준 항목으로 옮기지
--     못했다" 고 말한다 — **우리 쪽 조회 사정을 업체 탓으로 적는** 셈이다.
--     그래서 `estimate_quote_sources()`(SECURITY DEFINER)가 **커플 확인을 마친 뒤**
--     업체 이름·카테고리를 함께 내린다. 경계는 함수 안의 권한 검사다.
--
--  2. **보낸 견적만 원천이다.** `status = 'sent'` 로 좁힌다. 초안은 업체가 아직 안 보낸
--     것이라 고객에게 있는 값이 아니고, 비교표에 올리면 **오지 않은 제안을 견주는**
--     셈이 된다.
--
--  3. **비교표는 상시 저장하지 않는다.** 견적들에서 계산할 수 있는 값이므로 조회
--     시점에 만든다(공통 제약). 다만 **공유하려고 남길 때만** 행을 만들고
--     `normalized_json` 에 **그때의 환산 결과를 스냅샷**한다 — 견적이 만료·변경되면
--     지금 계산과 달라지고 **그 차이 자체가 남겨 둘 사실**이다(D-16·D-23 · S7-04 의
--     `penalty_simulations` 와 같은 규칙 · D-87).
--
--  4. **저장한 비교표는 고치지 않는다.** UPDATE 권한을 회수한다 — 스냅샷을 고칠 수
--     있으면 "그때 무엇을 견줬나" 를 답할 수 없다. 지우는 것은 0005 [48] 이 이미 열어
--     두었다(내 것은 내가 치운다).
--
--  5. **`upload_ids` 를 견적 id 로 쓴다.** 컬럼 이름은 업로드 경로(§5.4 1단계)를
--     전제하고 지어졌지만 **그 경로는 열려 있지 않다** — 자유 양식 견적이 존재하지
--     않기 때문이다(F-V-07). 이름을 바꾸지 않은 이유는 기존 마이그레이션을 고치지
--     않기 때문이고(§7.2), 무엇이 들어 있는지는 주석이 말한다.
-- =============================================================================

-- =============================================================================
-- 1) 원천 조회 — 업체 카테고리를 잃지 않는다
-- =============================================================================
create or replace function public.estimate_quote_sources(
  p_couple_id uuid,
  p_quote_ids uuid[] default null
)
returns table (
  quote_id        uuid,
  vendor_id       uuid,
  vendor_name     text,
  vendor_category text,
  product_name    text,
  total_amount    bigint,
  valid_until     timestamptz,
  sent_at         timestamptz
)
language sql stable security definer set search_path = public as $$
  select q.id,
         v.id,
         v.name,
         v.category,
         p.name,
         q.total_amount,
         q.valid_until,
         q.sent_at
    from public.quotes q
    join public.inquiry_targets t on t.id = q.inquiry_target_id
    join public.inquiries i on i.id = t.inquiry_id
    join public.vendors v on v.id = t.vendor_id
    left join public.products p on p.id = q.product_id
   where i.couple_id = p_couple_id
     -- **보낸 견적만.** 초안은 고객에게 있는 값이 아니다.
     and q.status = 'sent'
     and (p_quote_ids is null or q.id = any (p_quote_ids))
     -- **경계는 여기다.** 이 줄이 없으면 아무 커플 id 나 넣어 남의 견적을 읽을 수 있다.
     and public.is_couple_member(p_couple_id)
   order by q.sent_at desc nulls last, q.created_at desc;
$$;

comment on function public.estimate_quote_sources(uuid, uuid[]) is
  '비교할 수 있는 견적과 그 업체 이름·카테고리(F-C-06). **SECURITY DEFINER 인 이유** — vendors 는 공개 조건이 붙은 표라 임베드로 읽으면 행이 안 보일 때 조용히 null 이 오고, 견적에서는 그 값이 분류의 근거라 견적이 통째로 unmapped 가 된다(S7-07 이 겪은 것과 같은 계열). **경계는 함수 안의 is_couple_member 다.** 보낸 견적(sent)만 낸다.';

revoke all on function public.estimate_quote_sources(uuid, uuid[]) from public;
-- `revoke all ... from public` 은 service_role 의 상속분까지 걷어 간다(S7-12 가 겪었다).
grant execute on function public.estimate_quote_sources(uuid, uuid[]) to authenticated, service_role;

-- =============================================================================
-- 2) 저장한 비교표 — 스냅샷이라 고치지 않는다
-- =============================================================================
comment on column public.estimate_comparisons.upload_ids is
  '견줬던 **견적 id**(quotes.id). 컬럼 이름은 업로드 경로(§5.4 1단계)를 전제하고 지어졌으나 **그 경로는 열려 있지 않다** — 자유 양식 견적이 존재하지 않기 때문이다(F-V-07). 이름은 §7.2 때문에 그대로 둔다.';
comment on column public.estimate_comparisons.normalized_json is
  '**그때의 환산 결과 스냅샷.** 견적이 만료·변경되면 지금 계산과 달라지고 그 차이 자체가 남겨 둘 사실이다(D-16·D-23). 조회 시점에 다시 계산하지 않는다.';
comment on table public.estimate_comparisons is
  '2~5개 병렬 비교표(F-C-06). **상시 저장하지 않는다** — 견적에서 계산할 수 있는 값이므로 조회 시점에 만들고, **공유하려고 남길 때만** 행이 생긴다(S7-12 의 공유 대상이 되려면 행이 있어야 한다).';

-- **고칠 수 없다.** 스냅샷을 고칠 수 있으면 "그때 무엇을 견줬나" 를 답할 수 없다.
revoke update on public.estimate_comparisons from authenticated, anon;

-- 최소 2개·최대 5개(§2.1). 화면·API 도 같은 것을 검사하지만 **마지막 문은 DB 다.**
alter table public.estimate_comparisons
  drop constraint if exists estimate_comparisons_count_chk;
alter table public.estimate_comparisons
  add constraint estimate_comparisons_count_chk
  check (array_length(upload_ids, 1) between 2 and 5);

create index if not exists idx_estimate_comparisons_created_at
  on public.estimate_comparisons (couple_id, created_at desc);

-- =============================================================================
-- 0047 산출 요약
-- =============================================================================
--   테이블 0 (0004 가 이미 만들었다) · 함수 1 · CHECK 1 · 권한 회수 1 · 인덱스 1
--
--   **RLS 를 새로 걸지 않았다** — 0005 [48] 이 estimate_comparisons 에 커플 스코프를
--   이미 걸어 두었다. 견적 원천의 경계는 함수 안의 `is_couple_member` 다.
--   `estimate_uploads`·`estimate_items` 는 **쓰지 않는다** — 업로드·파싱 경로용이고
--   PDF 파서·OCR 이 새 의존성이라 열려 있지 않다(D-56 · S7-03 과 같은 이유).
-- =============================================================================
