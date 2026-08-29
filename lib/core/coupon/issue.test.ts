import { describe, expect, it } from "vitest";

import {
  COUPON_FORM_MESSAGE,
  type CouponForm,
  FROZEN_FIELDS,
  VENDOR_CONDITION_CHOICES,
  buildStatusRow,
  conditionsWithheldFromVendor,
  discountAtMinOrder,
  frozenViolations,
  maxExposure,
  summarize,
  termsFrozen,
  validateCouponForm,
} from "./issue";

const NOW = new Date("2026-08-29T00:00:00.000Z");
const CAP = 3_000; // app_settings.coupon.max_discount_rate_bp

const form = (over: Partial<CouponForm> = {}): CouponForm => ({
  name: "가을 이벤트",
  discountType: "amount",
  discountValue: 50_000,
  maxDiscountAmount: null,
  minOrderAmount: 1_000_000,
  issueCondition: "contract_completed",
  validFrom: null,
  validTo: null,
  totalQuantity: 100,
  ...over,
});

// ══════════════════════════════════════════════════════════════════════════
// 만들 수 없는 것을 만들기 전에 막는다
// ══════════════════════════════════════════════════════════════════════════

describe("validateCouponForm", () => {
  it("멀쩡한 정액 쿠폰은 통과한다", () => {
    expect(validateCouponForm(form(), CAP)).toEqual([]);
  });

  it("**후기 대가 쿠폰을 막는다**(§7.7 · D-03) — 돈이 평가에 개입하면 검증 후기가 무너진다", () => {
    const errors = validateCouponForm(form({ issueCondition: "review_written" }), CAP);

    expect(errors).toContain("review_reward");
  });

  it("**리뷰 사유를 다른 사유보다 먼저 말한다** — 값만 고쳐 다시 시도하게 두지 않는다", () => {
    const errors = validateCouponForm(
      form({ issueCondition: "review_written", discountValue: 0 }),
      CAP,
    );

    expect(errors.indexOf("review_reward")).toBeLessThan(errors.indexOf("value_out_of_range"));
  });

  it("**업체가 고를 수 없는 조건을 막는다** — `manual_grant` 는 운영 재량이다", () => {
    expect(validateCouponForm(form({ issueCondition: "manual_grant" }), CAP)).toContain(
      "condition_not_allowed",
    );
  });

  it("업체 선택지에 `manual_grant` 가 없고 리뷰 값도 없다", () => {
    expect(VENDOR_CONDITION_CHOICES).not.toContain("manual_grant");
    expect(VENDOR_CONDITION_CHOICES.some((value) => /review/i.test(value))).toBe(false);
    expect(conditionsWithheldFromVendor()).toEqual(["manual_grant"]);
  });

  it("**상한 없는 정률을 막는다** — 고액 계약에서 정산을 통째로 지운다", () => {
    const errors = validateCouponForm(
      form({ discountType: "rate", discountValue: 1_000, maxDiscountAmount: null }),
      CAP,
    );

    expect(errors).toContain("rate_needs_cap");
  });

  it("**플랫폼 상한을 넘는 정률을 막는다**", () => {
    const errors = validateCouponForm(
      form({ discountType: "rate", discountValue: 4_000, maxDiscountAmount: 500_000 }),
      CAP,
    );

    expect(errors).toContain("rate_over_platform_cap");
  });

  it("**상한 값이 없으면 상한 판정을 하지 않는다** — 코드가 30% 를 지어내지 않는다", () => {
    const errors = validateCouponForm(
      form({ discountType: "rate", discountValue: 9_000, maxDiscountAmount: 500_000 }),
      null,
    );

    expect(errors).not.toContain("rate_over_platform_cap");
  });

  it("정액에 상한을 붙이면 막는다 — 할인액이 곧 상한이다", () => {
    expect(validateCouponForm(form({ maxDiscountAmount: 10_000 }), CAP)).toContain(
      "amount_needs_no_cap",
    );
  });

  it("이름 없는 쿠폰을 막는다 — 고객이 쿠폰함에서 보는 이름이다", () => {
    expect(validateCouponForm(form({ name: "   " }), CAP)).toContain("name_required");
  });

  it("수량 0 과 음수 최소 주문 금액을 막는다", () => {
    expect(validateCouponForm(form({ totalQuantity: 0 }), CAP)).toContain("quantity_not_positive");
    expect(validateCouponForm(form({ minOrderAmount: -1 }), CAP)).toContain("negative_min_order");
  });

  it("**수량 제한 없음(null)은 막지 않는다** — 0 과 다른 뜻이다", () => {
    expect(validateCouponForm(form({ totalQuantity: null }), CAP)).toEqual([]);
  });

  it("기간이 뒤집히면 막는다", () => {
    const errors = validateCouponForm(
      form({ validFrom: "2026-10-01T00:00:00.000Z", validTo: "2026-09-01T00:00:00.000Z" }),
      CAP,
    );

    expect(errors).toContain("period_reversed");
  });

  it("**막는 이유를 한 번에 모아 준다** — 하나씩 알려 주면 고치고 저장하기를 반복한다", () => {
    const errors = validateCouponForm(
      form({ name: "", discountType: "rate", discountValue: 0, maxDiscountAmount: null }),
      CAP,
    );

    expect(errors.length).toBeGreaterThanOrEqual(3);
    expect(new Set(errors).size).toBe(errors.length);
  });

  it("막는 이유마다 사람이 읽을 문장이 있다", () => {
    for (const message of Object.values(COUPON_FORM_MESSAGE)) {
      expect(message.length).toBeGreaterThan(10);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 발급이 시작되면 돈은 얼어붙는다
// ══════════════════════════════════════════════════════════════════════════

describe("termsFrozen · frozenViolations", () => {
  it("아무에게도 안 나갔으면 얼지 않는다", () => {
    expect(termsFrozen({ issuedCount: 0 })).toBe(false);
    expect(frozenViolations({ before: form(), after: form({ discountValue: 1 }), issuedCount: 0 })).toEqual([]);
  });

  it("**한 장이라도 나갔으면 얼어붙는다**", () => {
    expect(termsFrozen({ issuedCount: 1 })).toBe(true);
  });

  it("**할인액을 바꾸려 하면 그 칸을 짚어 준다** — 받은 사람이 본 약속이 달라진다", () => {
    const violations = frozenViolations({
      before: form(),
      after: form({ discountValue: 10_000 }),
      issuedCount: 5,
    });

    expect(violations).toEqual(["discountValue"]);
  });

  it("**최소 주문 금액도 얼어 있다** — 올리면 이미 받은 쿠폰이 조용히 못 쓰게 된다", () => {
    expect(
      frozenViolations({ before: form(), after: form({ minOrderAmount: 9_000_000 }), issuedCount: 5 }),
    ).toEqual(["minOrderAmount"]);
  });

  it("**이름·수량·종료일·중단은 고칠 수 있다** — 받은 약속을 줄이지 않는다", () => {
    const violations = frozenViolations({
      before: form(),
      after: form({ name: "새 이름", totalQuantity: 500, validTo: "2026-12-31T00:00:00.000Z" }),
      issuedCount: 5,
    });

    expect(violations).toEqual([]);
  });

  it("얼어붙는 칸 여섯이 전부 돈이나 조건에 관한 것이다", () => {
    expect([...FROZEN_FIELDS]).toEqual([
      "discountType",
      "discountValue",
      "maxDiscountAmount",
      "minOrderAmount",
      "validFrom",
      "issueCondition",
    ]);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 현황 — 세어서 만든다
// ══════════════════════════════════════════════════════════════════════════

const row = (over = {}) =>
  buildStatusRow({
    coupon: {
      id: "c1",
      name: "가을 이벤트",
      status: "active",
      discountType: "amount",
      discountValue: 50_000,
      maxDiscountAmount: null,
      minOrderAmount: 1_000_000,
      issueCondition: "contract_completed",
      validFrom: null,
      validTo: null,
      totalQuantity: 100,
      issuedCount: 10,
    },
    usedCount: 3,
    deductedAmount: 150_000,
    now: NOW,
    ...over,
  });

describe("buildStatusRow", () => {
  it("남은 수량을 센다 — 저장하지 않는다", () => {
    expect(row().remaining).toBe(90);
  });

  it("**수량 제한이 없으면 남은 수량이 null 이다** — 무제한을 0 으로 적지 않는다", () => {
    const built = buildStatusRow({
      coupon: { ...row(), totalQuantity: null },
      usedCount: 0,
      deductedAmount: 0,
      now: NOW,
    });

    expect(built.remaining).toBeNull();
    expect(built.soldOut).toBe(false);
  });

  it("**소진을 status 에서 읽지 않는다** — 수량으로 센다", () => {
    const built = buildStatusRow({
      coupon: { ...row(), totalQuantity: 10, issuedCount: 10 },
      usedCount: 0,
      deductedAmount: 0,
      now: NOW,
    });

    expect(built.soldOut).toBe(true);
    expect(built.status).toBe("active");
  });

  it("**만료도 시계로 센다**", () => {
    const built = buildStatusRow({
      coupon: { ...row(), validTo: "2026-08-01T00:00:00.000Z" },
      usedCount: 0,
      deductedAmount: 0,
      now: NOW,
    });

    expect(built.expired).toBe(true);
  });

  it("**못 보는 차감액은 null 이다** — 0 과 겹쳐 읽히면 '안 빠졌다' 가 된다(함정 2)", () => {
    const built = buildStatusRow({ coupon: row(), usedCount: 3, deductedAmount: null, now: NOW });

    expect(built.deductedAmount).toBeNull();
  });
});

describe("summarize", () => {
  it("**소진·만료된 것은 '살아 있다' 로 세지 않는다** — 상태만 보면 틀린다", () => {
    const rows = [
      row(),
      buildStatusRow({
        coupon: { ...row(), id: "c2", totalQuantity: 5, issuedCount: 5 },
        usedCount: 0,
        deductedAmount: 0,
        now: NOW,
      }),
    ];

    expect(summarize(rows, true).total).toBe(2);
    expect(summarize(rows, true).active).toBe(1);
  });

  it("대표가 아니면 **차감액 합계가 null 이다**", () => {
    expect(summarize([row()], false).deducted).toBeNull();
    expect(summarize([row()], true).deducted).toBe(150_000);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 얼마를 데려갈 수 있는가 — 발행 전에 보여 준다
// ══════════════════════════════════════════════════════════════════════════

describe("maxExposure", () => {
  it("정액 × 남은 수량이 최악의 금액이다", () => {
    expect(
      maxExposure({
        discountType: "amount",
        discountValue: 50_000,
        maxDiscountAmount: null,
        totalQuantity: 100,
        issuedCount: 10,
      }),
    ).toBe(4_500_000);
  });

  it("정률은 **상한** × 남은 수량이다 — 상한이 있어야 답할 수 있다", () => {
    expect(
      maxExposure({
        discountType: "rate",
        discountValue: 1_000,
        maxDiscountAmount: 300_000,
        totalQuantity: 10,
        issuedCount: 0,
      }),
    ).toBe(3_000_000);
  });

  it("**수량 제한이 없으면 답할 수 없다**(null) — 무한을 큰 수로 적으면 사실처럼 읽힌다", () => {
    expect(
      maxExposure({
        discountType: "amount",
        discountValue: 50_000,
        maxDiscountAmount: null,
        totalQuantity: null,
        issuedCount: 0,
      }),
    ).toBeNull();
  });

  it("다 나갔으면 더 나갈 것이 없다", () => {
    expect(
      maxExposure({
        discountType: "amount",
        discountValue: 50_000,
        maxDiscountAmount: null,
        totalQuantity: 10,
        issuedCount: 10,
      }),
    ).toBe(0);
  });
});

describe("discountAtMinOrder", () => {
  it("**최소 주문에서 실제로 깎이는 금액을 소비자 쪽과 같은 함수로 센다**", () => {
    expect(
      discountAtMinOrder({
        discountType: "rate",
        discountValue: 1_000,
        maxDiscountAmount: 300_000,
        minOrderAmount: 1_000_000,
      }),
    ).toBe(100_000);
  });

  it("상한에 걸리면 상한까지만 깎인다", () => {
    expect(
      discountAtMinOrder({
        discountType: "rate",
        discountValue: 1_000,
        maxDiscountAmount: 50_000,
        minOrderAmount: 1_000_000,
      }),
    ).toBe(50_000);
  });

  it("최소 주문 금액이 없으면 **답하지 않는다** — 0 원 주문에서 재면 뜻이 없다", () => {
    expect(
      discountAtMinOrder({
        discountType: "amount",
        discountValue: 50_000,
        maxDiscountAmount: null,
        minOrderAmount: 0,
      }),
    ).toBeNull();
  });
});
