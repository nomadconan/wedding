-- 0067 업체 쿠폰 발행·관리 (S5-13 · F-V-19 · §6.3 `/vendor/coupons` · §4.3 `CRUD /api/vendor/coupons`)
--
-- ══════════════════════════════════════════════════════════════════════════
-- 1. 표를 만지기 전에 권한부터 봤다 — 층 셋을 각각
-- ══════════════════════════════════════════════════════════════════════════
--
-- 열네 번째 감사다. `coupons` 는 S5-12 가 이미 좁혀 뒀다(0066): 표 단위
-- INSERT·UPDATE 없음 · 컬럼 권한만 · `issued_count` 제외 · DELETE 없음 ·
-- `anon` SELECT 없음. 그래서 이번에 새로 걷을 것은 없다.
--
-- ── 층 1 (정책 아래의 권한) ────────────────────────────────────────────────
--
-- 남은 구멍 하나가 **컬럼이 아니라 시점**에 있었다.
--
--   `discount_value`·`max_discount_amount`·`min_order_amount`·`valid_from` 이
--   **발급이 시작된 뒤에도 바뀐다.**
--
-- `coupon_issues` 는 만료일만 스냅샷한다(D-16). 할인 조건은 스냅샷하지 않으므로
-- **이미 발급된 쿠폰의 값이 나중에 달라진다** — 5% 로 100장을 뿌린 뒤 1% 로 내리면
-- 고객이 받은 약속이 조용히 줄고, 반대로 올리면 업체가 예상하지 못한 금액을 정산에서
-- 잃는다. 어느 쪽이든 **"받을 때 본 것과 쓸 때의 것이 다르다."**
--
-- **금액을 스냅샷 컬럼으로 옮기지 않는다** — `coupon_issues` 에 할인 조건을 복사하면
-- 같은 값이 두 곳에 살고, 정의를 고칠 때마다 어느 쪽이 진실인지 물어야 한다.
-- 대신 **발급이 시작되면 돈에 관한 조건을 얼린다.** 바꾸고 싶으면 새 쿠폰을 만든다.
--
-- ── 층 2 (FIX-41 — 정책이 다른 표의 정책에 기대는가) ───────────────────────
--
-- `coupons` 의 정책 넷이 쓰는 것은 `is_vendor_owner`·`is_vendor_member`·
-- `has_coupon_issue`·`is_operator` 다. 앞의 셋을 열어 보면 전부 **자기 안에
-- `auth.uid()` 조건을 들고 있다** — `exists (select 1 from <부모>)` 에 소유자 조건이
-- 없는 모양이 아니다. **위반 없음.**
--
-- ── 층 3 (FIX-44 — 자격의 근거가 되는 표) ──────────────────────────────────
--
-- 이 태스크가 허용하는 것: **자기 업체 이름으로 쿠폰을 만들고 고치는 일.**
-- 그 자격의 근거: `is_vendor_owner(issuer_id)` → 근거 표는 **`vendor_members`** 다.
-- 그래서 그 표를 감사했다.
--
--   `vendor_members_insert`  check `is_vendor_owner(vendor_id)`
--   `vendor_members_update`  using/check 둘 다 `is_vendor_owner(vendor_id)`
--   `vendor_members_delete`  `is_vendor_owner(...) and user_id <> auth.uid()`
--
-- **자기 자신을 대표로 써 넣는 길이 없다** — 대표가 되려면 이미 대표여야 하고, 첫
-- 대표는 입점 심사(서비스롤)가 만든다. `with check` 가 **바뀐 뒤의 행**을 보므로
-- 남의 업체로 행을 옮기는 것도 막힌다. **자격 검사가 실제로 검사하고 있다.**
-- (`db:rls` 에 그 사실을 고정하는 검사를 더한다 — 이 태스크가 그것에 기대기 때문이다.)
--
-- **기록만 하는 것**: `vendor_members` 에 `anon` SELECT GRANT 가 남아 있다. 정책이
-- `authenticated` 전용이라 지금은 아무것도 안 보이지만, GRANT 가 남아 있으면 다음
-- 사람이 `to anon` 정책 한 줄로 연다. **이 태스크의 표가 아니라 고치지 않고 적는다.**

-- ══════════════════════════════════════════════════════════════════════════
-- 2. 발급이 시작되면 돈에 관한 조건을 얼린다
-- ══════════════════════════════════════════════════════════════════════════
--
-- 계약(`assert_contract_immutable`)·예약 결정(`assert_booking_decision_immutable`)과
-- 같은 자리다 — **되돌릴 수 있는 약속은 약속이 아니다**(D-23).
--
-- **얼지 않는 것**을 고른 기준: 고객이 이미 받은 약속을 **줄이지 않는** 변경만 남긴다.
--   · `status`         — 중단(`paused`·`ended`). 새 발급을 멈출 뿐 이미 받은 것은 그대로다.
--   · `total_quantity` — 늘리는 쪽만 뜻이 있다(줄여도 이미 나간 발급은 회수되지 않는다).
--   · `valid_to`       — 정의의 종료일. 발급분의 만료는 이미 스냅샷돼 있다(D-16).
--   · `name`           — 표기. 돈이 아니다.
create or replace function public.assert_coupon_terms_frozen()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- 아직 아무에게도 안 나갔으면 얼마든지 고친다. 만들다 만 쿠폰까지 묶을 이유는 없다.
  if old.issued_count = 0 then
    return new;
  end if;

  if new.discount_type is distinct from old.discount_type
     or new.discount_value is distinct from old.discount_value
     or new.max_discount_amount is distinct from old.max_discount_amount
     or new.min_order_amount is distinct from old.min_order_amount
     or new.valid_from is distinct from old.valid_from
     or new.issue_condition is distinct from old.issue_condition
     or new.issuer_type is distinct from old.issuer_type
     or new.issuer_id is distinct from old.issuer_id then
    raise exception '이미 발급된 쿠폰의 할인 조건은 바꿀 수 없습니다. 새 쿠폰을 만드세요.'
      using errcode = 'check_violation', constraint = 'coupons_terms_frozen';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_coupons_terms_frozen on public.coupons;
create trigger trg_coupons_terms_frozen
  before update on public.coupons
  for each row execute function public.assert_coupon_terms_frozen();

comment on function public.assert_coupon_terms_frozen() is
  'S5-13. 발급이 시작되면 돈에 관한 조건을 얼린다 — coupon_issues 는 만료일만 스냅샷하므로(D-16), 정의를 고치면 이미 받은 쿠폰의 값이 조용히 달라진다. 중단·증량·기간 연장·표기만 남긴다.';

-- ══════════════════════════════════════════════════════════════════════════
-- 3. 정산 차감액은 **대표 전용**이다 (§3.9 · F-V-19)
-- ══════════════════════════════════════════════════════════════════════════
--
-- 명세가 "정산 차감액은 대표(owner) 전용" 이라고 적는데 `coupon_redemptions` 의
-- 업체 열람 정책은 **`is_vendor_member`**(스태프 포함)였다. 그 표의 행은 곧 금액이라
-- **행이 보이면 금액이 보인다** — 화면에서 가리는 것으로는 지켜지지 않는다(함정 3).
--
-- **컬럼 권한으로 가를 수 없다.** 정책은 행을 가르고 컬럼을 가르지 않으며,
-- 컬럼 GRANT 는 역할별 조건을 갖지 못한다. 그래서 **행 자체를 대표에게만** 연다.
--
-- 스태프가 잃는 것: "이 쿠폰이 실제로 쓰였나". 그것은 `coupon_issues.status` 로
-- 답할 수 있고(그 표는 그대로 멤버에게 열려 있다) 금액은 안 붙는다.
drop policy if exists coupon_redemptions_select_vendor on public.coupon_redemptions;
create policy coupon_redemptions_select_vendor on public.coupon_redemptions
  for select to authenticated
  using (booking_id is not null and public.is_vendor_owner(public.booking_vendor_id(booking_id)));

comment on table public.coupon_redemptions is
  'S5-12/S5-13. 사용 기록. 결제 성공 뒤 서비스롤이 적는다(D-62). **업체 열람은 대표 전용**이다(§3.9 · F-V-19) — 이 표의 행은 곧 정산에서 빠지는 금액이고, 행이 보이면 금액이 보인다. 스태프는 coupon_issues 로 사용 여부만 본다.';

-- ══════════════════════════════════════════════════════════════════════════
-- 4. 새 표를 만들지 않았다
-- ══════════════════════════════════════════════════════════════════════════
--
-- **발급·사용 현황을 표로 만들지 않는다.** 발급 수는 `coupon_issues` 를, 사용 수와
-- 차감액은 `coupon_redemptions` 를 세면 나온다(D-124). 저장하면 배치가 늦은 만큼
-- 화면이 거짓을 말한다 — 0032 가 `status` 에 소진·만료를 적지 않기로 한 것과 같다.
--
-- **`issued_count` 는 예외다.** 그것은 세는 값이 아니라 **수량 제한의 근거**이며
-- (`total_quantity` 와 비교한다) 발급 트랜잭션 안에서 올라가야 경쟁 조건이 없다.
-- 대신 **아무도 손으로 못 쓴다**(0066 이 컬럼 권한을 걷었다).

-- TRUNCATE 는 0053 이 전역으로 걷었다. 매번 다시 센다(함정 7).
revoke truncate on public.coupons, public.coupon_issues, public.coupon_redemptions
  from anon, authenticated;
