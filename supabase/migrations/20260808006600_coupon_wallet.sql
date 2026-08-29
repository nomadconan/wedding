-- 0066 쿠폰함·결제 적용 (S5-12 · F-C-35·36 · §6.2 `/coupons` · §4.2 · **FIX-13**)
--
-- ══════════════════════════════════════════════════════════════════════════
-- 1. 표를 만지기 전에 권한부터 봤다 — 세 표 모두 넓게 열려 있었다
-- ══════════════════════════════════════════════════════════════════════════
--
-- 열세 번째 감사다. 0032 가 정책은 촘촘히 썼는데 **그 아래 권한은 기본값 그대로**였다.
--
--   `coupons`            `authenticated` 에 표 단위 INSERT·UPDATE·**DELETE**
--                        + 모든 컬럼 INSERT·UPDATE. `anon` 에 SELECT.
--   `coupon_issues`      `authenticated` 에 표 단위 INSERT·UPDATE·**DELETE**
--                        + 모든 컬럼. `anon` 에 SELECT.
--   `coupon_redemptions` `authenticated` 에 표 단위 INSERT + 모든 컬럼 INSERT.
--                        `anon` 에 SELECT.
--
-- ── 지금 이미 뚫린 것과 정책이 막고 있는 것을 가른다 ───────────────────────
--
-- **이미 뚫린 것**: `coupons` 의 INSERT·UPDATE 는 정책(`coupons_write_vendor`·
-- `coupons_update_vendor`)이 있어 **업체 대표에게 오늘 열려 있다.** 그 자체는 S5-13 의
-- 기능이므로 막지 않는다. 다만 **컬럼이 너무 넓다** — `issued_count` 는 발급 때마다
-- 시스템이 올리는 **계수기**인데 대표가 직접 쓸 수 있어서, 0 으로 되돌리면
-- `couponEligibility` 의 `sold_out` 판정이 무력해진다(수량 제한이 사라진다).
--
-- **정책이 없어 막히는 것**: `coupon_issues` 의 쓰기 셋과 `coupon_redemptions` 의
-- INSERT 는 **정책이 없어 지금은 RLS 가 막는다.** 오늘 통하지는 않는다. 그러나
-- 남겨 두면 다음 사람이 정책 한 줄을 더하는 순간 **자기 쿠폰을 발급하고 할인액과
-- 부담 주체를 스스로 적는 길**이 열린다 — `discount_amount` 와 `borne_by` 가 전부
-- 컬럼 INSERT 로 열려 있다. `borne_by='vendor'` 로 적으면 **업체 정산에서 그 돈이
-- 나간다.** FIX-44 와 정확히 같은 모양이며 이번에는 돈이 직접 걸린다.
--
-- ── 층 2 (FIX-41) ──────────────────────────────────────────────────────────
--
-- `coupons_select_issued`(`has_coupon_issue`)와 `coupon_redemptions_select_own`
-- (`owns_coupon_issue`)이 다른 표를 훑는 모양이지만, **두 함수 모두 자기 안에
-- 소유자 조건을 들고 있다**(`i.user_id = auth.uid() or is_couple_member(i.couple_id)`).
-- `coupon_issues_select_issuer`·`coupon_redemptions_select_vendor` 도 각각
-- `is_vendor_member(...)` 로 스스로 말한다. **이번 감사에서 층 2 위반은 없었다.**

-- ── 쓰기를 걷는다. **표에서 걷고 필요한 것만 다시 준다**(FIX-36) ────────────

-- `coupon_issues` — 발급은 조건 판정이 붙는 사건이라 당사자가 직접 쓸 수 없다.
-- 자기 이름으로 쿠폰을 발급할 수 있으면 발행 조건(`issue_condition`)은 장식이 된다.
revoke all privileges on public.coupon_issues from anon, authenticated;
grant select on public.coupon_issues to authenticated;

-- `coupon_redemptions` — **사용은 결제와 같은 사건**이다. 결제가 성공한 뒤 서버가
-- 적는다(D-62). 당사자가 적을 수 있으면 `discount_amount` 를 스스로 정하는 것이고,
-- 그것은 남의 정산에서 돈을 빼는 일이다.
revoke all privileges on public.coupon_redemptions from anon, authenticated;
grant select on public.coupon_redemptions to authenticated;

-- `coupons` — **업체 발행은 그대로 둔다**(S5-13 의 기능이고 정책이 이미 가른다).
-- 걷는 것은 둘: `anon` 의 열람과, **계수기 컬럼**이다.
revoke select on public.coupons from anon;

-- **컬럼 하나만 걷는 것은 아무 일도 하지 않는다**(FIX-36 이 가르친 것).
-- 표 단위 INSERT·UPDATE 가 남아 있으면 그것이 모든 컬럼을 덮는다 — 실제로
-- `revoke ... (issued_count)` 만 적었다가 `db:rls` 가 잡았다. **표에서 걷고
-- 필요한 컬럼만 다시 준다.**
revoke insert, update on public.coupons from anon, authenticated;
grant insert (
  id, issuer_type, issuer_id, name, discount_type, discount_value,
  max_discount_amount, min_order_amount, issue_condition,
  valid_from, valid_to, total_quantity, status
) on public.coupons to authenticated;
grant update (
  name, discount_value, max_discount_amount, min_order_amount,
  valid_from, valid_to, total_quantity, status
) on public.coupons to authenticated;

-- **DELETE 는 아무에게도 없다.** 사용 이력이 달린 쿠폰이 사라지면 정산 근거가
-- 사라진다 — `coupon_redemptions` 는 `coupon_issues` 를 거쳐 이 표를 가리킨다(D-23).
revoke delete on public.coupons from anon, authenticated;

-- TRUNCATE 는 0053 이 전역으로 걷었다. 매번 다시 센다(함정 7).
revoke truncate on public.coupons, public.coupon_issues, public.coupon_redemptions
  from anon, authenticated;

comment on table public.coupon_redemptions is
  'S5-12/FIX-13. 사용 기록. **결제가 성공한 뒤 서비스롤이 적는다**(D-62) — 당사자가 적을 수 있으면 discount_amount 와 borne_by 를 스스로 정하는 것이고, borne_by=vendor 는 남의 정산에서 돈을 빼는 일이다. insert-only 이며 되돌리기는 환불이 한다.';
comment on column public.coupons.issued_count is
  'S5-12. 발급 계수기 — **시스템이 올린다.** 대표가 직접 쓸 수 있으면 0 으로 되돌려 수량 제한(sold_out)을 무력화할 수 있다. 컬럼 권한으로 닫았다.';

-- ══════════════════════════════════════════════════════════════════════════
-- 2. "한 번만 쓴다" 를 표가 강제한다
-- ══════════════════════════════════════════════════════════════════════════
--
-- `couponEligibility` 가 `issue.status = 'used'` 를 보고 막지만, 그것은 **읽은
-- 시점의 값**이다. 같은 발급분으로 두 결제를 동시에 누르면 둘 다 통과한 뒤 둘 다
-- 기록된다(TOCTOU). **경계는 유니크 인덱스**여야 한다.
--
-- **그리고 그것도 이미 있었다.** 0032 가 두 층을 세워 두었다 — 트리거
-- (`mark_coupon_issue_used`)가 첫 사용에서 발급분을 `used` 로 옮기며 두 번째를 거절하고,
-- 그 뒤에 UNIQUE 가 backstop 으로 선다. — 0032 가 `coupon_issue_id` 에 UNIQUE 를 걸었고
-- (`coupon_redemptions_coupon_issue_id_key`), 여기서 같은 것을 한 번 더 만들면
-- 인덱스가 둘이 되고 거절 사유만 헷갈린다. **만들지 않고 `db:rls` 가 그 보장이
-- 살아 있는지를 확인한다** — 있는 것을 다시 만드는 대신 있는지 본다.

-- **결제 1건에 쿠폰 한 장**(§7.4 · `stacking=single`). 중복이 열리면 할인액 합이
-- 결제액을 넘을 수 있고, 그때 부담 주체가 둘이 되어 정산이 답할 수 없다.
create unique index if not exists uq_coupon_redemptions_payment
  on public.coupon_redemptions (payment_id)
  where payment_id is not null;

-- 결제에 붙은 사용은 예약도 함께 가리켜야 한다 — 업체 열람 정책
-- (`coupon_redemptions_select_vendor`)이 `booking_id` 로 판정하므로, 비어 있으면
-- **업체가 자기 정산에서 나간 돈을 못 본다.** 허용 조합을 나열한다.
alter table public.coupon_redemptions drop constraint if exists coupon_redemptions_target_shape;
alter table public.coupon_redemptions
  add constraint coupon_redemptions_target_shape
  check (
    (payment_id is null     and booking_id is null)      -- 결제 밖 사용(지금은 없다)
    or (payment_id is null     and booking_id is not null) -- 예약에만 붙은 사용
    or (payment_id is not null and booking_id is not null) -- 회차 결제에 붙은 사용
  );

create index if not exists idx_coupon_issues_owner
  on public.coupon_issues (couple_id, status, expires_at);

-- ══════════════════════════════════════════════════════════════════════════
-- 3. 새 표를 만들지 않았다
-- ══════════════════════════════════════════════════════════════════════════
--
-- **'쓸 수 있는 쿠폰' 목록을 표로 만들지 않는다.** 적격성은 발급분·쿠폰 정의·주문
-- 금액·시계로 **계산되는 값**이고(D-124), 저장하면 기한이 지난 뒤에도 목록에 남는다.
--
-- **소진·만료를 `status` 에 적지 않는다.** 0032 가 이미 정한 것이며(근거 2) 여기서도
-- 같다 — 저장하면 배치가 늦은 만큼 화면이 거짓을 말한다.
