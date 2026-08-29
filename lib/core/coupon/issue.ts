// 업체 쿠폰 발행·관리 (S5-13 · F-V-19 · §6.3 `/vendor/coupons`)
//
// ══════════════════════════════════════════════════════════════════════════
// **발행은 돈을 거는 일이다.**
// ══════════════════════════════════════════════════════════════════════════
//
// 업체 쿠폰의 할인액은 **그 업체의 정산에서 빠진다**(D-27). 그래서 이 파일이 하는
// 일은 두 가지다 — (가) 만들 수 없는 쿠폰을 **만들기 전에** 막고, (나) 이미 만든
// 쿠폰이 **얼마를 데려갈 수 있는지**를 숨기지 않고 세는 것.
//
// 판정은 전부 여기 있고 화면·API·DB CHECK 이 같은 것을 요구한다. 셋 중 하나만
// 알고 있으면 화면이 열어 준 것을 API 가 거절하거나, 더 나쁘게는 **DB 만 막고
// 화면은 통과시켜** 사용자가 왜 안 되는지 모른 채 남는다.

import {
  ISSUE_CONDITIONS,
  type CouponStatus,
  type DiscountType,
  type IssueCondition,
  VENDOR_ISSUE_CONDITIONS,
  discountAmountOf,
  exceedsRateCap,
  isReviewRewardCondition,
} from "./coupon";

// =============================================================================
// 발행 폼 검증 — 만들 수 없는 것을 만들기 전에 막는다
// =============================================================================

export const COUPON_FORM_ERRORS = [
  "name_required",
  "review_reward",
  "condition_not_allowed",
  "rate_needs_cap",
  "rate_over_platform_cap",
  "amount_needs_no_cap",
  "value_out_of_range",
  "negative_min_order",
  "quantity_not_positive",
  "period_reversed",
] as const;
export type CouponFormError = (typeof COUPON_FORM_ERRORS)[number];

export const COUPON_FORM_MESSAGE: Record<CouponFormError, string> = {
  name_required: "쿠폰 이름을 적어 주세요. 고객이 쿠폰함에서 보는 이름입니다.",
  review_reward:
    "후기·평점 작성을 조건으로 하는 쿠폰은 발행할 수 없습니다. 돈이 평가에 개입하면 검증 후기의 근거가 무너집니다.",
  condition_not_allowed: "업체가 고를 수 없는 발행 조건입니다.",
  rate_needs_cap:
    "정률 쿠폰에는 할인 상한이 필요합니다. 상한이 없으면 고액 계약에서 정산이 통째로 지워집니다.",
  rate_over_platform_cap: "플랫폼이 정한 최대 할인율을 넘습니다.",
  amount_needs_no_cap: "정액 쿠폰에는 할인 상한을 두지 않습니다. 할인액이 곧 상한입니다.",
  value_out_of_range: "할인 값이 규약을 벗어났습니다.",
  negative_min_order: "최소 주문 금액은 0 이상이어야 합니다.",
  quantity_not_positive: "발행 수량은 1 이상이어야 합니다. 제한이 없으면 비워 두세요.",
  period_reversed: "종료일이 시작일보다 앞설 수 없습니다.",
};

export type CouponForm = {
  name: string;
  discountType: DiscountType;
  /** 정액이면 원, 정률이면 bp 정수. **부동소수점을 쓰지 않는다.** */
  discountValue: number;
  maxDiscountAmount: number | null;
  minOrderAmount: number;
  issueCondition: string;
  validFrom: string | null;
  validTo: string | null;
  totalQuantity: number | null;
};

/**
 * 발행 폼을 본다.
 *
 * **막는 이유를 전부 모아 돌려준다.** 하나씩 알려 주면 고치고 저장하기를 반복하게
 * 되고, 그 사이 어떤 조합이 되는지 아무도 못 배운다.
 *
 * `platformRateCapBp` 가 `null` 이면 **상한 판정을 하지 않는다** — 설정에 값이 없는
 * 것이고, 코드가 30% 를 지어내면 그 순간 운영 파라미터의 두 번째 진실이 된다
 * (`exceedsRateCap` 이 세운 원칙 그대로).
 */
export function validateCouponForm(
  form: CouponForm,
  platformRateCapBp: number | null,
): CouponFormError[] {
  const errors: CouponFormError[] = [];

  if (form.name.trim().length === 0) errors.push("name_required");

  // **리뷰 대가를 가장 먼저 본다**(§7.7 · D-03). 다른 이유로 먼저 막히면 발행자는
  // 값만 고쳐 다시 시도하고, 왜 안 되는지는 끝내 모른다.
  if (isReviewRewardCondition(form.issueCondition)) {
    errors.push("review_reward");
  } else if (!(VENDOR_ISSUE_CONDITIONS as readonly string[]).includes(form.issueCondition)) {
    errors.push("condition_not_allowed");
  }

  if (!Number.isInteger(form.discountValue) || form.discountValue < 1) {
    errors.push("value_out_of_range");
  }

  if (form.discountType === "rate") {
    if (form.discountValue > 10_000) errors.push("value_out_of_range");
    if (form.maxDiscountAmount === null || form.maxDiscountAmount < 1) {
      errors.push("rate_needs_cap");
    }
    if (exceedsRateCap({ discountType: "rate", discountValue: form.discountValue }, platformRateCapBp)) {
      errors.push("rate_over_platform_cap");
    }
  } else if (form.maxDiscountAmount !== null) {
    errors.push("amount_needs_no_cap");
  }

  if (!Number.isInteger(form.minOrderAmount) || form.minOrderAmount < 0) {
    errors.push("negative_min_order");
  }

  if (form.totalQuantity !== null && (!Number.isInteger(form.totalQuantity) || form.totalQuantity < 1)) {
    errors.push("quantity_not_positive");
  }

  if (form.validFrom !== null && form.validTo !== null) {
    if (Date.parse(form.validTo) < Date.parse(form.validFrom)) errors.push("period_reversed");
  }

  return [...new Set(errors)];
}

/**
 * 발행 조건 선택지.
 *
 * **리뷰 관련 값이 목록에 없다** — 화면이 고를 수 없게 하는 것이 첫 층이고, API 가
 * 422 로 거절하는 것이 둘째, DB CHECK 이 최종 경계다(§7.7). 세 층이 같은 목록을 본다.
 */
export const VENDOR_CONDITION_CHOICES: readonly IssueCondition[] = VENDOR_ISSUE_CONDITIONS;

/** 전체 어휘와 업체 선택지의 차이. **왜 빠졌는지**를 화면이 적을 수 있게 한다. */
export function conditionsWithheldFromVendor(): IssueCondition[] {
  return ISSUE_CONDITIONS.filter((value) => !VENDOR_ISSUE_CONDITIONS.includes(value));
}

// =============================================================================
// 고칠 수 있는가 — 발급이 시작되면 돈은 얼어붙는다
// =============================================================================

export const FROZEN_FIELDS = [
  "discountType",
  "discountValue",
  "maxDiscountAmount",
  "minOrderAmount",
  "validFrom",
  "issueCondition",
] as const;
export type FrozenField = (typeof FROZEN_FIELDS)[number];

export const EDITABLE_AFTER_ISSUE = ["name", "status", "totalQuantity", "validTo"] as const;

export const FROZEN_NOTICE =
  "이미 발급된 쿠폰입니다. 할인 조건은 바꿀 수 없고 이름·수량·종료일·중단만 고칠 수 있습니다 — 받은 사람이 본 약속과 달라지면 안 되기 때문입니다. 조건을 바꾸려면 새 쿠폰을 만드세요.";

/** 이 쿠폰의 돈에 관한 조건이 얼었는가. **세는 값이지 저장하는 값이 아니다.** */
export function termsFrozen(coupon: { issuedCount: number }): boolean {
  return coupon.issuedCount > 0;
}

/** 얼어 있는데 돈에 관한 칸을 바꾸려 했는가. 바꾸려 한 칸 이름을 돌려준다. */
export function frozenViolations(input: {
  before: CouponForm;
  after: CouponForm;
  issuedCount: number;
}): FrozenField[] {
  if (!termsFrozen({ issuedCount: input.issuedCount })) return [];

  return FROZEN_FIELDS.filter((field) => input.before[field] !== input.after[field]);
}

// =============================================================================
// 현황 — 세어서 만든다 (D-124)
// =============================================================================

export type CouponStatusRow = {
  id: string;
  name: string;
  status: CouponStatus;
  discountType: DiscountType;
  discountValue: number;
  maxDiscountAmount: number | null;
  minOrderAmount: number;
  issueCondition: string;
  validFrom: string | null;
  validTo: string | null;
  totalQuantity: number | null;
  issuedCount: number;
  /** 실제로 쓰인 수. `coupon_redemptions` 를 세서 만든다. */
  usedCount: number;
  /**
   * 정산에서 빠진 금액. **대표만 볼 수 있다**(§3.9) — 대표가 아니면 `null` 이며
   * **0 이 아니다.** 둘을 같게 적으면 "안 빠졌다" 와 "못 본다" 가 겹쳐 읽힌다(함정 2).
   */
  deductedAmount: number | null;
  /** 남은 수량. 제한이 없으면 `null` — **무제한을 0 으로 적지 않는다.** */
  remaining: number | null;
  soldOut: boolean;
  expired: boolean;
  frozen: boolean;
};

export function buildStatusRow(input: {
  coupon: Omit<CouponStatusRow, "usedCount" | "deductedAmount" | "remaining" | "soldOut" | "expired" | "frozen">;
  usedCount: number;
  deductedAmount: number | null;
  now: Date;
}): CouponStatusRow {
  const { coupon } = input;

  // **소진·만료를 `status` 에서 읽지 않는다**(0032 근거 2). 수량과 시계로 센다.
  const remaining =
    coupon.totalQuantity === null ? null : Math.max(0, coupon.totalQuantity - coupon.issuedCount);
  const soldOut = coupon.totalQuantity !== null && coupon.issuedCount >= coupon.totalQuantity;
  const expired = coupon.validTo !== null && Date.parse(coupon.validTo) <= input.now.getTime();

  return {
    ...coupon,
    usedCount: input.usedCount,
    deductedAmount: input.deductedAmount,
    remaining,
    soldOut,
    expired,
    frozen: termsFrozen({ issuedCount: coupon.issuedCount }),
  };
}

export type CouponSummary = {
  total: number;
  active: number;
  issued: number;
  used: number;
  /** 대표가 아니면 `null`. **0 으로 접지 않는다.** */
  deducted: number | null;
};

export function summarize(rows: readonly CouponStatusRow[], canSeeMoney: boolean): CouponSummary {
  return {
    total: rows.length,
    // '살아 있다' 는 상태만으로 정해지지 않는다 — 소진·만료도 함께 본다.
    active: rows.filter((row) => row.status === "active" && !row.soldOut && !row.expired).length,
    issued: rows.reduce((sum, row) => sum + row.issuedCount, 0),
    used: rows.reduce((sum, row) => sum + row.usedCount, 0),
    deducted: canSeeMoney
      ? rows.reduce((sum, row) => sum + (row.deductedAmount ?? 0), 0)
      : null,
  };
}

/**
 * 이 쿠폰이 앞으로 최대 얼마를 더 데려갈 수 있는가.
 *
 * **발행 전에 보여 준다.** 정률 쿠폰은 상한이 있어야 하고(그것이 CHECK 이다), 남은
 * 수량이 있으면 그 수량만큼 상한이 곱해진다 — 그 곱이 업체가 최악의 경우 정산에서
 * 잃는 금액이다. **수량 제한이 없으면 답할 수 없다**(`null`) — 무한을 큰 수로 적으면
 * 그 수가 사실처럼 읽힌다.
 */
export function maxExposure(coupon: {
  discountType: DiscountType;
  discountValue: number;
  maxDiscountAmount: number | null;
  totalQuantity: number | null;
  issuedCount: number;
}): number | null {
  if (coupon.totalQuantity === null) return null;

  const perCoupon =
    coupon.discountType === "amount" ? coupon.discountValue : (coupon.maxDiscountAmount ?? 0);
  const remaining = Math.max(0, coupon.totalQuantity - coupon.issuedCount);

  return perCoupon * remaining;
}

/**
 * 최소 주문 금액에서 이 쿠폰이 실제로 깎는 금액.
 *
 * 화면이 "10% 할인" 만 적으면 업체는 얼마가 나가는지 모른다. **가장 작은 주문에서도
 * 얼마가 깎이는지**를 함께 적어 감을 준다 — 계산은 소비자 쪽과 **같은 함수**가 한다.
 */
export function discountAtMinOrder(coupon: {
  discountType: DiscountType;
  discountValue: number;
  maxDiscountAmount: number | null;
  minOrderAmount: number;
}): number | null {
  if (coupon.minOrderAmount <= 0) return null;

  return discountAmountOf(
    {
      discountType: coupon.discountType,
      discountValue: coupon.discountValue,
      maxDiscountAmount: coupon.maxDiscountAmount,
      minOrderAmount: coupon.minOrderAmount,
    },
    coupon.minOrderAmount,
  );
}
