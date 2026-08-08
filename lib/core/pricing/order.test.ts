import { describe, expect, it } from "vitest";

import { AMOUNT_UNKNOWN } from "./amount";
import { OrderInputError, addOnAmountOf, calculateOrderTotal, type OrderLineInput } from "./order";

/** 요율 숫자는 테스트 전용 임의값이다. 운영 값은 DB 가 가진다(O-02). */
const HALL: OrderLineInput = {
  lineId: "line-hall",
  category: "hall",
  salePrice: 10_000_000,
  addOns: { kind: "none" },
  plannerSelected: false,
  feeRateBp: 500,
};

describe("calculateOrderTotal — 총액 구성", () => {
  it("업체 수수료는 고객 총액에 더하지 않는다 (D-16)", () => {
    const result = calculateOrderTotal([HALL]);

    // 판매가가 그대로 고객 노출가다. 수수료는 거기서 차감돼 업체에 정산된다.
    expect(result.total).toBe(10_000_000);
    expect(result.lines[0].total).toBe(10_000_000);
    expect(result.lines[0].settlement).toEqual({
      feeRateBp: 500,
      feeAmount: 500_000,
      netAmount: 9_500_000,
    });
  });

  it("플래너를 선택하면 총액에 가산된다 (D-17)", () => {
    const result = calculateOrderTotal([
      { ...HALL, plannerSelected: true, plannerFeeRateBp: 900 },
    ]);

    expect(result.lines[0].plannerFee).toEqual({ kind: "selected", amount: 900_000 });
    expect(result.total).toBe(10_900_000);
  });

  it("미선택이면 플래너 수수료가 0이고 총액이 그대로다", () => {
    const result = calculateOrderTotal([{ ...HALL, plannerFeeRateBp: 900 }]);

    expect(result.lines[0].plannerFee).toEqual({ kind: "not_selected" });
    expect(result.total).toBe(10_000_000);
  });

  it("추가금 상한이 있으면 총액에 더한다", () => {
    const result = calculateOrderTotal([
      { ...HALL, addOns: { kind: "listed", count: 3, total: 720_000 } },
    ]);

    expect(result.lines[0].addOnAmount).toBe(720_000);
    expect(result.total).toBe(10_720_000);
  });

  it("이미 반영된 필수 추가금(included)은 다시 더하지 않는다", () => {
    const result = calculateOrderTotal([{ ...HALL, addOns: { kind: "included" } }]);

    expect(result.lines[0].addOnAmount).toBe(0);
    expect(result.total).toBe(10_000_000);
  });
});

describe("calculateOrderTotal — 0원과 미정", () => {
  it("추가금 없음은 0원이다", () => {
    expect(addOnAmountOf({ kind: "none" })).toBe(0);
    expect(addOnAmountOf({ kind: "included" })).toBe(0);
  });

  it("추가금 미등록은 미정이다 — 0으로 접지 않는다", () => {
    expect(addOnAmountOf({ kind: "unknown" })).toBe(AMOUNT_UNKNOWN);
    expect(addOnAmountOf({ kind: "listed", count: 2 })).toBe(AMOUNT_UNKNOWN);
  });

  it("추가금이 미정이면 총액도 미정이다", () => {
    const result = calculateOrderTotal([{ ...HALL, addOns: { kind: "unknown" } }]);

    expect(result.lines[0].addOnAmount).toBe(AMOUNT_UNKNOWN);
    expect(result.lines[0].total).toBe(AMOUNT_UNKNOWN);
    expect(result.total).toBe(AMOUNT_UNKNOWN);
  });

  it("판매가 0원은 미정이 아니다", () => {
    const result = calculateOrderTotal([{ ...HALL, salePrice: 0 }]);

    expect(result.total).toBe(0);
    expect(result.lines[0].settlement.feeAmount).toBe(0);
  });

  it("플래너를 골랐는데 요율이 아직 없으면 수수료도 총액도 미정이다", () => {
    const result = calculateOrderTotal([
      { ...HALL, plannerSelected: true, plannerFeeRateBp: null },
    ]);

    expect(result.lines[0].plannerFee).toEqual({ kind: "selected", amount: AMOUNT_UNKNOWN });
    expect(result.total).toBe(AMOUNT_UNKNOWN);
  });

  it("한 줄만 미정이어도 합계가 미정이다", () => {
    const result = calculateOrderTotal([HALL, { ...HALL, addOns: { kind: "unknown" } }]);

    expect(result.basePrice).toBe(20_000_000);
    expect(result.total).toBe(AMOUNT_UNKNOWN);
  });
});

describe("calculateOrderTotal — 합계 (카테고리별 부분 선택, D-17)", () => {
  const lines: OrderLineInput[] = [
    HALL,
    {
      lineId: "line-studio",
      category: "studio",
      salePrice: 2_000_000,
      addOns: { kind: "listed", count: 2, total: 300_000 },
      plannerSelected: true,
      plannerFeeRateBp: 1_000,
      feeRateBp: 800,
    },
    {
      lineId: "line-dress",
      category: "dress",
      salePrice: 1_500_000,
      addOns: { kind: "none" },
      plannerSelected: true,
      plannerFeeRateBp: 1_000,
      feeRateBp: 800,
    },
  ];

  it("플래너를 붙인 카테고리 수를 합계에 담는다", () => {
    const result = calculateOrderTotal(lines);

    expect(result.itemCount).toBe(3);
    expect(result.plannerFee).toEqual({
      kind: "selected",
      amount: 350_000, // 2,000,000*10% + 1,500,000*10%
      categoryCount: 2,
    });
  });

  it("합계 총액 = 판매가 합 + 추가금 합 + 플래너 수수료 합", () => {
    const result = calculateOrderTotal(lines);

    expect(result.basePrice).toBe(13_500_000);
    expect(result.addOnAmount).toBe(300_000);
    expect(result.total).toBe(13_500_000 + 300_000 + 350_000);
  });

  it("합계 정산은 줄별 수수료의 합이다", () => {
    const result = calculateOrderTotal(lines);

    // 10,000,000*5% + 2,000,000*8% + 1,500,000*8%
    expect(result.settlement.feeAmount).toBe(500_000 + 160_000 + 120_000);
    expect(result.settlement.netAmount).toBe(13_500_000 - result.settlement.feeAmount);
  });

  it("합계 추가금은 건수와 상한을 합산한다", () => {
    const result = calculateOrderTotal(lines);

    expect(result.addOns).toEqual({ kind: "listed", count: 2, total: 300_000 });
  });

  it("한 줄이라도 추가금이 미정이면 합계 추가금도 미정 표기다", () => {
    const result = calculateOrderTotal([...lines, { ...HALL, addOns: { kind: "unknown" } }]);

    expect(result.addOns).toEqual({ kind: "unknown" });
  });

  it("아무도 플래너를 안 고르면 합계도 '미선택' 이다 — 상태가 사라지지 않는다", () => {
    const result = calculateOrderTotal([HALL, { ...HALL, lineId: "line-2" }]);

    expect(result.plannerFee).toEqual({ kind: "not_selected" });
  });

  it("모든 줄이 플래너 대상이 아니면 합계는 '선택 불가' 다", () => {
    const result = calculateOrderTotal([
      { ...HALL, plannerAvailable: false },
      { ...HALL, lineId: "line-2", plannerAvailable: false },
    ]);

    expect(result.plannerFee).toEqual({ kind: "unavailable" });
  });

  it("일부만 선택 불가면 합계는 '미선택' 이다 — 고를 수 있는 항목이 남아 있다", () => {
    const result = calculateOrderTotal([
      { ...HALL, plannerAvailable: false },
      { ...HALL, lineId: "line-2" },
    ]);

    expect(result.plannerFee).toEqual({ kind: "not_selected" });
  });

  it("빈 주문은 0원이고 플래너는 미선택이다", () => {
    const result = calculateOrderTotal([]);

    expect(result).toMatchObject({
      itemCount: 0,
      basePrice: 0,
      total: 0,
      plannerFee: { kind: "not_selected" },
      addOns: { kind: "none" },
    });
  });
});

describe("calculateOrderTotal — 모순된 입력", () => {
  it("플래너 대상이 아닌 항목을 선택하면 던진다", () => {
    expect(() =>
      calculateOrderTotal([{ ...HALL, plannerAvailable: false, plannerSelected: true }]),
    ).toThrow(OrderInputError);
  });

  it("음수 판매가·범위 밖 요율은 스키마 단계에서 걸린다", () => {
    expect(() => calculateOrderTotal([{ ...HALL, salePrice: -1 }])).toThrow();
    expect(() => calculateOrderTotal([{ ...HALL, feeRateBp: 10_001 }])).toThrow();
    expect(() => calculateOrderTotal([{ ...HALL, salePrice: 1.5 }])).toThrow();
  });
});
