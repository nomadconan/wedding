import { describe, expect, it } from "vitest";

import {
  COUPON_ISSUE_STATUSES,
  COUPON_STATUSES,
  CouponError,
  DISCOUNT_TYPES,
  ISSUE_CONDITIONS,
  VENDOR_ISSUE_CONDITIONS,
  borneBy,
  couponEligibility,
  discountAmountOf,
  exceedsRateCap,
  isReviewRewardCondition,
  issueExpiresAt,
  vendorBorneTotal,
  type CouponDefinition,
} from "./coupon";

const NOW = new Date("2026-08-14T00:00:00.000Z");

function rateCoupon(over: Partial<CouponDefinition> = {}): CouponDefinition {
  return {
    discountType: "rate",
    discountValue: 1_000, // 10%
    maxDiscountAmount: 500_000,
    minOrderAmount: 0,
    ...over,
  };
}

function amountCoupon(over: Partial<CouponDefinition> = {}): CouponDefinition {
  return {
    discountType: "amount",
    discountValue: 50_000,
    maxDiscountAmount: null,
    minOrderAmount: 0,
    ...over,
  };
}

describe("리뷰 대가 쿠폰 — 스키마가 막고 코드가 붙잡는다", () => {
  it("허용 조건 집합에 리뷰·후기·평점이 없다", () => {
    for (const condition of ISSUE_CONDITIONS) {
      expect(isReviewRewardCondition(condition)).toBe(false);
    }
  });

  it("리뷰를 뜻하는 값을 잡아낸다 — 한글·영문", () => {
    for (const value of ["review_written", "후기작성", "리뷰 5천원", "RATING_BONUS", "평점"]) {
      expect(isReviewRewardCondition(value)).toBe(true);
    }
  });

  it("업체는 운영 재량 지급을 고를 수 없다", () => {
    expect(VENDOR_ISSUE_CONDITIONS).not.toContain("manual_grant");
    expect(ISSUE_CONDITIONS).toContain("manual_grant");
  });
});

describe("할인액 — 정률은 bp, 세 번 잘린다", () => {
  it("정률은 내림으로 계산한다", () => {
    // 1,234,567 × 10% = 123,456.7 → 123,456
    expect(discountAmountOf(rateCoupon({ maxDiscountAmount: 999_999 }), 1_234_567)).toBe(123_456);
  });

  it("상한을 넘으면 상한으로 자른다", () => {
    expect(discountAmountOf(rateCoupon({ maxDiscountAmount: 500_000 }), 10_000_000)).toBe(500_000);
  });

  it("주문 금액을 넘을 수 없다 — 거스름돈을 주지 않는다", () => {
    expect(discountAmountOf(amountCoupon({ discountValue: 100_000 }), 30_000)).toBe(30_000);
  });

  it("정액은 그대로 깎는다", () => {
    expect(discountAmountOf(amountCoupon(), 1_000_000)).toBe(50_000);
  });

  it("100% 쿠폰도 주문 금액까지만 깎는다", () => {
    expect(
      discountAmountOf(rateCoupon({ discountValue: 10_000, maxDiscountAmount: 99_999_999 }), 1_000),
    ).toBe(1_000);
  });

  it("상한 없는 정률은 거절한다 — 업체 정산을 통째로 지운다", () => {
    expect(() => discountAmountOf(rateCoupon({ maxDiscountAmount: null }), 1_000)).toThrow(
      CouponError,
    );
  });

  it("0bp·10001bp 는 거절한다", () => {
    for (const value of [0, 10_001, -100]) {
      expect(() => discountAmountOf(rateCoupon({ discountValue: value }), 1_000)).toThrow(
        CouponError,
      );
    }
  });

  it("소수 할인율은 거절한다 — bp 정수만 쓴다", () => {
    expect(() => discountAmountOf(rateCoupon({ discountValue: 10.5 }), 1_000)).toThrow(CouponError);
  });

  it("음수 주문 금액은 거절한다", () => {
    expect(() => discountAmountOf(amountCoupon(), -1)).toThrow(CouponError);
  });

  it("0원 주문에는 0원이 깎인다", () => {
    expect(discountAmountOf(amountCoupon(), 0)).toBe(0);
  });
});

describe("할인율 상한 — 값은 설정이 갖는다", () => {
  it("상한을 넘으면 참이다", () => {
    expect(exceedsRateCap({ discountType: "rate", discountValue: 4_000 }, 3_000)).toBe(true);
  });

  it("상한과 같으면 넘지 않은 것이다", () => {
    expect(exceedsRateCap({ discountType: "rate", discountValue: 3_000 }, 3_000)).toBe(false);
  });

  it("설정이 없으면 판정하지 않는다 — 코드가 상한을 지어내지 않는다", () => {
    expect(exceedsRateCap({ discountType: "rate", discountValue: 9_000 }, null)).toBe(false);
  });

  it("정액 쿠폰은 이 상한과 무관하다", () => {
    expect(exceedsRateCap({ discountType: "amount", discountValue: 9_999_999 }, 3_000)).toBe(false);
  });
});

describe("적용 가능 판정 — 못 쓰는 쿠폰도 사유와 함께", () => {
  const base = {
    coupon: { ...rateCoupon(), status: "active" as const, validFrom: null, totalQuantity: null, issuedCount: 0 },
    issue: { status: "issued" as const, expiresAt: null },
    orderAmount: 1_000_000,
    now: NOW,
  };

  it("조건을 만족하면 할인액을 함께 돌려준다", () => {
    const result = couponEligibility(base);

    expect(result.ok).toBe(true);
    expect(result.ok === true && result.discountAmount).toBe(100_000);
  });

  it("이미 쓴 쿠폰은 막힌다", () => {
    const result = couponEligibility({ ...base, issue: { status: "used", expiresAt: null } });

    expect(result.ok === false && result.reason).toBe("already_used");
  });

  it("회수된 쿠폰은 막힌다", () => {
    const result = couponEligibility({ ...base, issue: { status: "revoked", expiresAt: null } });

    expect(result.ok === false && result.reason).toBe("revoked");
  });

  it("발행이 중단되면 막힌다", () => {
    const result = couponEligibility({ ...base, coupon: { ...base.coupon, status: "paused" } });

    expect(result.ok === false && result.reason).toBe("not_active");
  });

  it("시작 전이면 막힌다", () => {
    const result = couponEligibility({
      ...base,
      coupon: { ...base.coupon, validFrom: "2026-09-01T00:00:00.000Z" },
    });

    expect(result.ok === false && result.reason).toBe("not_started");
  });

  it("만료 시각 그 순간부터 못 쓴다 — 경계는 '지났다' 쪽이다", () => {
    const result = couponEligibility({
      ...base,
      issue: { status: "issued", expiresAt: NOW.toISOString() },
    });

    expect(result.ok === false && result.reason).toBe("expired");
  });

  it("만료 전이면 쓸 수 있다", () => {
    const result = couponEligibility({
      ...base,
      issue: { status: "issued", expiresAt: "2026-08-15T00:00:00.000Z" },
    });

    expect(result.ok).toBe(true);
  });

  it("최소 주문 금액에 못 미치면 사유에 금액을 적어 준다", () => {
    const result = couponEligibility({
      ...base,
      coupon: { ...base.coupon, minOrderAmount: 2_000_000 },
    });

    expect(result.ok === false && result.reason).toBe("min_order");
    expect(result.ok === false && result.detail).toContain("2,000,000원");
  });

  it("최소 주문 금액과 같으면 쓸 수 있다 — 경계 포함", () => {
    const result = couponEligibility({
      ...base,
      coupon: { ...base.coupon, minOrderAmount: 1_000_000 },
    });

    expect(result.ok).toBe(true);
  });

  it("수량이 소진되면 막힌다", () => {
    const result = couponEligibility({
      ...base,
      coupon: { ...base.coupon, totalQuantity: 10, issuedCount: 11 },
    });

    expect(result.ok === false && result.reason).toBe("sold_out");
  });

  it("중복은 기본으로 막힌다 — 부담 주체가 둘이 되면 정산이 답할 수 없다", () => {
    const result = couponEligibility({ ...base, appliedCount: 1 });

    expect(result.ok === false && result.reason).toBe("stacking");
  });

  it("중복 허용 설정이면 통과한다", () => {
    const result = couponEligibility({ ...base, appliedCount: 1, stackingMode: "multiple" });

    expect(result.ok).toBe(true);
  });
});

describe("부담 주체 — 사용 시점에 박는다", () => {
  it("발행 주체가 그대로 부담 주체다", () => {
    expect(borneBy("vendor")).toBe("vendor");
    expect(borneBy("platform")).toBe("platform");
  });

  it("업체 부담분만 합산한다 — 플랫폼 쿠폰은 정산에서 차감되지 않는다", () => {
    expect(
      vendorBorneTotal([
        { borneBy: "vendor", discountAmount: 100_000 },
        { borneBy: "platform", discountAmount: 500_000 },
        { borneBy: "vendor", discountAmount: 50_000 },
      ]),
    ).toBe(150_000);
  });

  it("업체 부담분이 없으면 0이다", () => {
    expect(vendorBorneTotal([{ borneBy: "platform", discountAmount: 1 }])).toBe(0);
  });
});

describe("만료일 — 발급 시점에 확정한다", () => {
  it("정의에 기한이 있으면 그것을 쓴다", () => {
    expect(
      issueExpiresAt({ validTo: "2026-12-31T00:00:00.000Z", defaultValidDays: 30, issuedAt: NOW }),
    ).toBe("2026-12-31T00:00:00.000Z");
  });

  it("기한이 없으면 기본 유효기간을 더한다", () => {
    expect(issueExpiresAt({ validTo: null, defaultValidDays: 30, issuedAt: NOW })).toBe(
      "2026-09-13T00:00:00.000Z",
    );
  });

  it("기본 유효기간 설정이 없으면 기한 없는 발급이다 — 날짜를 지어내지 않는다", () => {
    expect(issueExpiresAt({ validTo: null, defaultValidDays: null, issuedAt: NOW })).toBeNull();
  });

  it("음수 유효기간은 거절한다", () => {
    expect(() => issueExpiresAt({ validTo: null, defaultValidDays: -1, issuedAt: NOW })).toThrow(
      CouponError,
    );
  });
});

describe("값 집합", () => {
  it("목록에 중복이 없다", () => {
    for (const list of [ISSUE_CONDITIONS, DISCOUNT_TYPES, COUPON_STATUSES, COUPON_ISSUE_STATUSES]) {
      expect(new Set(list).size).toBe(list.length);
    }
  });

  it("발행 상태에 '소진'·'만료'가 없다 — 계산값을 저장하지 않는다", () => {
    expect(COUPON_STATUSES).toEqual(["active", "paused", "ended"]);
  });
});
