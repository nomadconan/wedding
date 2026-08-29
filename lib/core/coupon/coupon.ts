/**
 * 쿠폰 계산 (S5-11 · 명세서 §2.1 F-C-35·36, §3.4, §7.4, §7.7, D-03 · D-16 · D-27)
 *
 * 프레임워크도 DB 도 모르는 순수 모듈이다. **정률은 basis point 정수**로만 다루고
 * 부동소수점을 쓰지 않는다(CLAUDE.md §6).
 *
 * **여기 없는 것 셋.**
 *  1. **할인율 상한·중복 규칙·기본 유효기간.** `app_settings.coupon.*` 가 갖고 이
 *     파일의 함수는 인자로 받는다(§7.4). 30% 도 30일도 코드에 없다.
 *  2. **수수료 기준.** 쿠폰 할인과 수수료를 무엇에서 떼는가는 **다른 물음**이며
 *     O-15 미결이다(`feeBasisOf`). 쿠폰은 "고객이 얼마를 덜 내는가" 까지만 안다.
 *  3. **정산 차감.** 부담 주체(`borne_by`)를 정하는 것까지가 여기고, 그 금액을 업체
 *     정산에서 빼는 것은 S5-07 이다.
 */

/** 입력이 규약을 벗어날 때 던진다. */
export class CouponError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CouponError";
  }
}

// =============================================================================
// 값 집합 — DB CHECK 와 같아야 한다 (`db:rls` 가 정합을 본다)
// =============================================================================

export const COUPON_ISSUERS = ["platform", "vendor"] as const;
export type CouponIssuer = (typeof COUPON_ISSUERS)[number];

export const DISCOUNT_TYPES = ["amount", "rate"] as const;
export type DiscountType = (typeof DISCOUNT_TYPES)[number];

/**
 * 발행 조건.
 *
 * **리뷰·후기·평점 관련 값이 이 목록에 없다**(§7.7 · D-03). 자유 텍스트로 두면
 * "후기 작성 시 5천원" 이 언제든 들어오고, 그것은 (가) 표시·광고 심사지침상 경제적
 * 이해관계 공개 의무를 낳고 (나) 검증 후기(F-C-17)의 신뢰 근거를 무너뜨리며
 * (다) D-03("돈이 평가에 개입하지 않는다")과 정면 충돌한다.
 *
 * **DB CHECK 와 같은 목록이어야 한다.** 한쪽만 늘리면 화면이 보낸 값을 DB 가 거절하고,
 * 더 나쁘게는 DB 만 넓히면 금지가 조용히 풀린다.
 */
export const ISSUE_CONDITIONS = [
  "contract_completed",
  "first_purchase",
  "period_event",
  "repeat_purchase",
  "manual_grant",
] as const;

export type IssueCondition = (typeof ISSUE_CONDITIONS)[number];

export const ISSUE_CONDITION_LABEL: Record<IssueCondition, string> = {
  contract_completed: "계약 완료 고객",
  first_purchase: "첫 거래 고객",
  period_event: "기간 이벤트",
  repeat_purchase: "재구매 고객",
  manual_grant: "운영 재량 지급",
};

/** 업체가 고를 수 있는 조건. `manual_grant` 는 운영자 전용이다(사유를 남긴다). */
export const VENDOR_ISSUE_CONDITIONS: readonly IssueCondition[] = ISSUE_CONDITIONS.filter(
  (condition) => condition !== "manual_grant",
);

/**
 * 리뷰 대가를 뜻하는 조건인가.
 *
 * **집합에 없으므로 언제나 false 다.** 그래도 함수를 두는 이유는 (가) API 가 422 로
 * 거절할 때 이유를 말할 수 있어야 하고 (나) 나중에 누군가 값을 더하려 할 때
 * 테스트가 먼저 깨지기 때문이다 — 금지를 코드로 붙잡아 둔다.
 */
const REVIEW_WORDS = ["review", "리뷰", "후기", "평점", "rating"] as const;

export function isReviewRewardCondition(value: string): boolean {
  const lowered = value.toLowerCase();

  return REVIEW_WORDS.some((word) => lowered.includes(word));
}

export const REVIEW_REWARD_REJECTED =
  "후기·평점 작성을 조건으로 하는 쿠폰은 만들 수 없어요. 대가를 받고 쓴 후기는 평가의 근거가 되지 못합니다.";

export const COUPON_ISSUE_STATUSES = ["issued", "used", "expired", "revoked"] as const;
export type CouponIssueStatus = (typeof COUPON_ISSUE_STATUSES)[number];

export const COUPON_STATUSES = ["active", "paused", "ended"] as const;
export type CouponStatus = (typeof COUPON_STATUSES)[number];

// =============================================================================
// 할인액 — 정률은 bp, 상한은 반드시 붙는다
// =============================================================================

export type CouponDefinition = {
  discountType: DiscountType;
  /** 정액이면 원, 정률이면 bp 정수. */
  discountValue: number;
  /** 정률 쿠폰의 할인 상한. 정액이면 null. */
  maxDiscountAmount: number | null;
  minOrderAmount: number;
};

const TOTAL_BP = 10_000;

/**
 * 할인액을 계산한다.
 *
 * **세 번 잘린다.**
 *  1. 정률이면 `floor(주문액 × bp / 10000)` — **내림**이다. 올리면 1원이라도 더
 *     깎이고, 그 1원은 업체 정산에서 나간다.
 *  2. 상한(`maxDiscountAmount`)으로 자른다. 상한 없는 정률 쿠폰은 고액 계약에서
 *     업체 정산을 통째로 지운다 — 그래서 DB CHECK 가 정률에 상한을 요구한다.
 *  3. **주문 금액으로 자른다.** 할인액이 결제액을 넘으면 거스름돈을 주는 셈이 된다.
 */
export function discountAmountOf(coupon: CouponDefinition, orderAmount: number): number {
  assertAmount(orderAmount, "주문 금액");

  if (coupon.discountType === "rate") {
    if (!Number.isInteger(coupon.discountValue) || coupon.discountValue < 1 || coupon.discountValue > TOTAL_BP) {
      throw new CouponError(`정률 쿠폰의 할인율이 규약을 벗어났습니다: ${coupon.discountValue}bp`);
    }

    if (coupon.maxDiscountAmount === null) {
      // 상한 없는 정률은 만들 수 없다. 여기까지 왔다면 스키마 밖에서 들어온 값이다.
      throw new CouponError("정률 쿠폰에는 할인 상한이 필요합니다.");
    }

    const raw = Math.floor((orderAmount * coupon.discountValue) / TOTAL_BP);

    return Math.min(raw, coupon.maxDiscountAmount, orderAmount);
  }

  if (!Number.isInteger(coupon.discountValue) || coupon.discountValue < 1) {
    throw new CouponError(`정액 쿠폰의 할인액이 규약을 벗어났습니다: ${coupon.discountValue}`);
  }

  return Math.min(coupon.discountValue, orderAmount);
}

function assertAmount(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new CouponError(`${label}은 0 이상 정수여야 합니다: ${value}`);
  }
}

/**
 * 발행 시 할인율이 운영 상한을 넘는가.
 *
 * **상한 값은 설정이 갖는다**(`app_settings.coupon.max_discount_rate_bp`). 값이
 * 없으면 판정하지 않는다 — 코드가 상한을 지어내면 그 순간 운영 파라미터의 두 번째
 * 진실이 된다(`resolveSplitPlans`·`feeBasisOf` 와 같은 원칙).
 */
export function exceedsRateCap(
  coupon: Pick<CouponDefinition, "discountType" | "discountValue">,
  capBp: number | null,
): boolean {
  if (capBp === null || coupon.discountType !== "rate") return false;

  return coupon.discountValue > capBp;
}

// =============================================================================
// 적용 가능 판정 — 못 쓰는 쿠폰도 사유와 함께 보인다 (F-C-36)
// =============================================================================

export type CouponBlockReason =
  | "not_active"
  | "not_started"
  | "expired"
  | "already_used"
  | "revoked"
  | "min_order"
  | "sold_out"
  | "stacking"
  | "other_vendor";

export const COUPON_BLOCK_MESSAGE: Record<CouponBlockReason, string> = {
  not_active: "지금은 사용할 수 없는 쿠폰이에요.",
  not_started: "아직 사용 기간이 시작되지 않았어요.",
  expired: "사용 기간이 지났어요.",
  already_used: "이미 사용한 쿠폰이에요.",
  revoked: "회수된 쿠폰이에요.",
  min_order: "최소 주문 금액에 못 미쳐요.",
  sold_out: "수량이 모두 소진됐어요.",
  stacking: "이 결제에는 이미 다른 쿠폰이 적용돼 있어요.",
  other_vendor: "발행한 업체와의 거래에만 쓸 수 있는 쿠폰이에요.",
};

export type CouponEligibility =
  | { ok: true; discountAmount: number }
  | { ok: false; reason: CouponBlockReason; detail: string };

/**
 * 이 쿠폰을 이 결제에 쓸 수 있는가.
 *
 * **적용 불가 쿠폰을 감추지 않는다**(F-C-36). 사유를 함께 돌려주는 이유는, 감추면
 * 고객이 "쿠폰이 없다" 고 이해하고 최소 주문 금액을 조금 넘기면 쓸 수 있다는 사실을
 * 영영 모르기 때문이다.
 *
 * **소진·만료를 저장된 상태로 판정하지 않는다.** 수량은 `issuedCount`/`totalQuantity`,
 * 기간은 `expiresAt` 과 시계로 계산한다 — 저장하면 배치가 늦은 만큼 화면이 거짓을
 * 말한다(0032 근거 2).
 */
export function couponEligibility(input: {
  coupon: CouponDefinition & {
    status: CouponStatus;
    validFrom: string | null;
    totalQuantity: number | null;
    issuedCount: number;
    /** 발행 주체와 그 업체. 업체 발행이면 `issuerId` 가 그 업체다. */
    issuerType?: CouponIssuer;
    issuerId?: string | null;
  };
  issue: { status: CouponIssueStatus; expiresAt: string | null };
  orderAmount: number;
  /**
   * 이 결제가 속한 예약의 업체. 모르면 `null`.
   *
   * **업체 발행 쿠폰은 그 업체와의 거래에만 쓴다**(S5-12 · D-27). 이 조건이 없으면
   * A 업체가 발행한 쿠폰을 B 업체 결제에 쓸 수 있고, 정산은 **할인액을 예약의 업체
   * 에서 뺀다** — B 가 A 의 판촉비를 대신 내는 셈이 된다.
   */
  bookingVendorId?: string | null;
  /** 이미 적용된 쿠폰 수. 중복 규칙이 `single` 이면 1 이상일 때 막힌다. */
  appliedCount?: number;
  stackingMode?: "single" | "multiple" | null;
  now: Date;
}): CouponEligibility {
  const { coupon, issue } = input;

  if (issue.status === "used") return block("already_used");
  if (issue.status === "revoked") return block("revoked");
  if (issue.status === "expired") return block("expired");

  if (coupon.status !== "active") return block("not_active");

  if (coupon.validFrom !== null) {
    const from = Date.parse(coupon.validFrom);

    if (!Number.isNaN(from) && input.now.getTime() < from) return block("not_started");
  }

  if (issue.expiresAt !== null) {
    const until = Date.parse(issue.expiresAt);

    // 경계는 '지났다' 쪽이다 — 만료 시각 그 순간부터 못 쓴다. 하루 더 쓰게 하면
    // 그만큼의 할인이 업체 정산에서 예정에 없이 나간다.
    if (!Number.isNaN(until) && input.now.getTime() >= until) return block("expired");
  }

  if (coupon.totalQuantity !== null && coupon.issuedCount > coupon.totalQuantity) {
    return block("sold_out");
  }

  // **업체 발행은 그 업체와의 거래에만.** 발행 업체를 모르면 판정하지 않는다 —
  // 모르는 것을 '안 맞는다' 로 적으면 쓸 수 있는 쿠폰이 사라진다.
  if (
    coupon.issuerType === "vendor" &&
    typeof coupon.issuerId === "string" &&
    typeof input.bookingVendorId === "string" &&
    coupon.issuerId !== input.bookingVendorId
  ) {
    return block("other_vendor");
  }

  if (input.orderAmount < coupon.minOrderAmount) {
    return {
      ok: false,
      reason: "min_order",
      detail: `${coupon.minOrderAmount.toLocaleString("ko-KR")}원 이상 결제에 쓸 수 있어요.`,
    };
  }

  // **중복은 기본으로 열지 않는다**(§7.4). 두 장이 겹치면 할인액 합이 결제액을 넘을 수
  // 있고, 그때 누가 부담하는지(borne_by 가 둘이 된다) 정산이 답할 수 없다.
  if ((input.stackingMode ?? "single") === "single" && (input.appliedCount ?? 0) > 0) {
    return block("stacking");
  }

  return { ok: true, discountAmount: discountAmountOf(coupon, input.orderAmount) };
}

function block(reason: CouponBlockReason): CouponEligibility {
  return { ok: false, reason, detail: COUPON_BLOCK_MESSAGE[reason] };
}

// =============================================================================
// 부담 주체 — 사용 시점에 박는다
// =============================================================================

/**
 * 이 사용의 비용을 누가 지는가.
 *
 * **발행 주체와 같다**(D-27). 다만 사용 시점에 **복사해 박는다** — 발행자가 바뀌거나
 * 정의가 고쳐져도 이미 쓴 쿠폰의 부담 주체가 바뀌면 안 되고, 바뀌면 과거 정산 금액이
 * 소급 변경된다(요율 스냅샷과 같은 이유 · D-16).
 *
 *  - `vendor`   할인액을 **그 업체의 정산에서 차감**한다. 고객이 덜 낸 만큼 업체가 덜 받는다.
 *  - `platform` 정산에서 **차감하지 않는다.** 업체는 정가대로 받고 차액은 플랫폼 손익이다 —
 *    그래야 업체가 모르는 사이에 자기 수입이 깎이지 않는다.
 */
export function borneBy(issuerType: CouponIssuer): CouponIssuer {
  return issuerType;
}

export function vendorBorneTotal(
  redemptions: readonly { borneBy: CouponIssuer; discountAmount: number }[],
): number {
  return redemptions
    .filter((row) => row.borneBy === "vendor")
    .reduce((sum, row) => sum + row.discountAmount, 0);
}

// =============================================================================
// 만료일 — 발급 시점에 확정한다 (D-16)
// =============================================================================

/**
 * 발급분의 만료 시각.
 *
 * `coupons.valid_to` 가 있으면 그것을, 없으면 기본 유효기간을 더한다. **기본 일수는
 * 설정이 갖고**(`app_settings.coupon.default_valid_days`) 값이 없으면 기한 없는
 * 발급이다 — 코드가 날짜를 지어내지 않는다.
 */
export function issueExpiresAt(input: {
  validTo: string | null;
  defaultValidDays: number | null;
  issuedAt: Date;
}): string | null {
  if (input.validTo !== null) return input.validTo;
  if (input.defaultValidDays === null) return null;

  if (!Number.isInteger(input.defaultValidDays) || input.defaultValidDays < 0) {
    throw new CouponError(`기본 유효기간이 규약을 벗어났습니다: ${input.defaultValidDays}`);
  }

  return new Date(input.issuedAt.getTime() + input.defaultValidDays * 86_400_000).toISOString();
}

// =============================================================================
// 화면 문구
// =============================================================================

export const COUPON_EMPTY_TITLE = "받은 쿠폰이 없어요";

export const COUPON_VENDOR_COST_NOTICE =
  "업체 쿠폰의 할인액은 그 업체의 정산에서 차감됩니다. 플랫폼 쿠폰은 차감되지 않아요.";

export const COUPON_STACKING_NOTICE = "결제 1건에는 쿠폰 한 장만 쓸 수 있어요.";
