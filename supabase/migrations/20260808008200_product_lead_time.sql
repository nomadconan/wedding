-- =============================================================================
-- 0082 · 상품 리드타임 (C-4b)
--   근거: 07 §2.2 F-V-03 확장 · §3.3 · §7.4 · B-1 조사 4-5
--
-- ── 왜 절대 날짜가 아닌가 ───────────────────────────────────────────────────
-- 사용자 요구는 "업체가 상품 등록 시 최종 데드라인 입력" 이었다. 날짜로 받으면
-- **첫 커플에게만 맞는다** — 상품 하나를 여러 커플이 사고 예식일이 제각각이다.
-- 상대 일수는 `SCHEDULE_TEMPLATES.offsetDays` 와 **같은 단위**라 C-4a 가 손본
-- 역산 장치가 그대로 붙는다:  주문 기한 = 예식일 − lead_time_days
--
-- ── nullable 이고 기본값을 주지 않는다 ─────────────────────────────────────
-- 기본값을 주면 **업체가 정한 적 없는 기한**으로 알림이 나간다(C-4d). `null` 은
-- "업체가 아직 안 정했다" 이며 화면이 그렇게 적는다 — **0 과 다르다.** `0` 은
-- "따로 기한이 없다" 는 **진술**이고 근거 문구가 함께 온다.
-- 기존 상품 6개(전부 published)는 두 칸이 `null` 로 들어와 **아무것도 깨지지 않는다.**
--
-- ── 값과 근거는 함께 온다 ───────────────────────────────────────────────────
-- 근거를 필수로 받는 것이 **값이 부푸는 것을 누르는 장치**다(D-224). 리드타임이
-- 길수록 알림이 일찍 가고 고객이 먼저 움직이므로, 경쟁 업체보다 길게 적는 것이
-- 유리해질 수 있다. 막는 대신 **왜 그만큼 걸리는지를 고객이 읽게** 한다.
--
-- ── 상한은 여기 적지 않는다 ─────────────────────────────────────────────────
-- 아래 CHECK 은 **상식 범위**(0~3650)일 뿐이고, **운영 상한은
-- `app_settings.products.max_lead_time_days`** 다 — 운영하며 바뀌는 값을 CHECK 에
-- 박으면 바꿀 때마다 마이그레이션이 필요하다(C-4a 의 오프셋 범위와 같은 나눔).
-- **그 파라미터에 값이 없으면 API 가 저장을 막는다.** 없는 상한을 '무제한' 으로
-- 읽지 않는다(D-49).
--
-- ── 값은 여기서 넣지 않는다 ─────────────────────────────────────────────────
-- `supabase db reset` 은 **마이그레이션을 먼저, `seed.sql` 을 나중에** 적용하므로
-- 여기에 `update` 를 적으면 **빈 표를 훑고 성공**한다(C-2a·C-2e·C-2f 가 밟았다).
-- 운영 DB 에서도 이 칸은 **업체가 화면에서 채우는 값**이라 이행할 원본이 없다.
-- 파라미터 키는 `seed.sql` 이 만들고 로컬 데모 값은 `scripts/seed-accounts.mjs` 가 넣는다.
--
-- ── 권한을 좁히지 않는다 (판단) ─────────────────────────────────────────────
-- `products` 는 **표 단위 UPDATE** 라 새 칸이 자동으로 업체 대표에게 열린다
-- (`reviews` 의 칸 목록 방식과 정반대 · C-2e 가 지적한 자리). **이번에는 그대로 둔다.**
-- 리드타임은 **업체 자신의 사실 진술**이며 `capacity_min`·`intro` 와 같은 종류다 —
-- `vendors.region_code`(C-2f)를 걷은 이유였던 *"공유 통계의 분모"* 에 해당하지 않는다.
-- 이 상품의 기한은 **이 상품을 보는 커플에게만** 영향을 주고 탐색 순위에 들어가지
-- 않는다(§2.2 — 정렬 기준에 리드타임이 없다). 대신 세 층으로 누른다:
--   ① 운영 상한(app_settings) ② 근거 필수(아래 CHECK) ③ 변경 감사 기록(API).
-- =============================================================================

alter table public.products
  add column if not exists lead_time_days integer;

alter table public.products
  add column if not exists lead_time_note text;

comment on column public.products.lead_time_days is
  '주문 기한(C-4b). 예식일 기준 **상대 일수**이며 주문 기한 = 예식일 − 이 값이다. null 은 "업체가 아직 안 정했다", 0 은 "따로 기한이 없다" 는 진술이다 — 둘은 다르고 화면이 다르게 적는다. 운영 상한은 app_settings.products.max_lead_time_days 이며 값이 없으면 저장이 막힌다.';

comment on column public.products.lead_time_note is
  '리드타임의 근거(C-4b · D-224). **값과 함께 온다** — 근거 없는 숫자는 고객이 확인할 방법이 없고, 알림이 일찍 가는 쪽으로 값이 부풀 수 있다. 화면이 숫자와 같이 보여 준다.';

-- ── 상식 범위 ───────────────────────────────────────────────────────────────
-- `not valid` → `validate` 두 단계로 건다. 기존 행은 전부 null 이라 통과하지만,
-- 실데이터에서 막히면 `not valid` 상태로 **새 행만** 막으면서 이행을 따로 할 수 있다
-- (0076·0080·0081 과 같은 방식).
alter table public.products
  drop constraint if exists products_lead_time_range_chk;
alter table public.products
  add constraint products_lead_time_range_chk
  check (
    lead_time_days is null
    or (lead_time_days >= 0 and lead_time_days <= 3650)
  ) not valid;
alter table public.products validate constraint products_lead_time_range_chk;

-- ── 값과 근거는 함께 온다 ───────────────────────────────────────────────────
-- 한쪽만 있는 상태를 허용하면 화면이 "30일" 만 보여 주거나 근거만 떠 있는 자리가
-- 생긴다. 둘 다 없거나 둘 다 있거나다.
alter table public.products
  drop constraint if exists products_lead_time_pair_chk;
alter table public.products
  add constraint products_lead_time_pair_chk
  check (
    (lead_time_days is null and lead_time_note is null)
    or (
      lead_time_days is not null
      and lead_time_note is not null
      and length(btrim(lead_time_note)) between 1 and 200
    )
  ) not valid;
alter table public.products validate constraint products_lead_time_pair_chk;

-- ── 운영 파라미터 자리 ──────────────────────────────────────────────────────
-- **값을 넣지 않는다.** 업체가 며칠까지 주장할 수 있는지는 **운영 정책 결정**이고,
-- 코드가 고르면 그 순간 상한이 사라진다(D-49 · §7.4). 키만 만들고 값은 비운다 —
-- 로컬 데모 값은 `scripts/seed-accounts.mjs` 가 넣는다(AI 상한·요율과 같은 방식).
--
-- `seed.sql` 이 아니라 여기에 두는 이유: `seed.sql` 의 app_settings 블록은
-- `on conflict (key) do nothing` 이라 **이미 있는 DB 에는 새 키가 안 들어간다.**
-- 마이그레이션은 운영 DB 에서도 한 번 돈다.
insert into public.app_settings (key, value_json, description) values
  (
    'products.max_lead_time_days',
    '{"value": null, "unit": "days", "status": "undecided"}'::jsonb,
    'TODO: 운영 정책 확정 후 입력 — 업체가 상품에 적을 수 있는 주문 기한 상한(일). **값이 없으면 리드타임 저장이 막힌다**(C-4b) — 없는 상한을 무제한으로 읽으면 값이 부풀어도 걸리는 데가 없다.'
  )
on conflict (key) do nothing;

-- =============================================================================
-- 이 파일이 한 것
--   칸 2 — products.lead_time_days · lead_time_note (**둘 다 nullable · 기본값 없음**)
--   CHECK 2 — 상식 범위(0~3650) · 값과 근거 짝 (둘 다 not valid → validate)
--   파라미터 키 1 — products.max_lead_time_days (**값은 비운다**)
--   권한 변경 없음 — 표 단위 UPDATE 를 그대로 두었다(위 판단 참조)
--   새 표·새 정책 없음
-- =============================================================================
