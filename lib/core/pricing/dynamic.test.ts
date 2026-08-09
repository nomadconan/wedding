import { describe, expect, it } from "vitest";

import {
  bpToPercentText,
  comparePriceRules,
  evaluatePriceRules,
  matchRule,
  type EvaluablePriceRule,
  type PriceContext,
} from "./dynamic";

/** 여기 쓰이는 할인율은 **테스트 전용 임의값**이다. 운영 값은 업체가 정한다. */
function rule(overrides: Partial<EvaluablePriceRule> & Pick<EvaluablePriceRule, "id">): EvaluablePriceRule {
  return {
    ruleType: "weekday",
    condition: { ruleType: "weekday", weekdays: [6] },
    adjustType: "percent_bp",
    adjustValue: -1000,
    floorPrice: null,
    capPrice: null,
    priority: 100,
    isActive: true,
    createdAt: "2026-01-01T00:00:00Z",
    productId: null,
    ...overrides,
  } as EvaluablePriceRule;
}

// 2026-10-10 은 토요일이다.
const SATURDAY = "2026-10-10";
const MONDAY = "2026-10-12";

const context = (overrides: Partial<PriceContext> = {}): PriceContext => ({
  eventDate: SATURDAY,
  leadTimeDays: 30,
  occupancyRatioBp: 5000,
  productId: null,
  ...overrides,
});

describe("단일 룰", () => {
  it("비율 할인을 정수로 적용한다", () => {
    const result = evaluatePriceRules(10_000_000, [rule({ id: "a", adjustValue: -1000 })], context());

    expect(result.finalPrice).toBe(9_000_000);
    expect(result.steps[0].applied).toBe(true);
  });

  it("비율 할증도 같은 방식이다", () => {
    const result = evaluatePriceRules(10_000_000, [rule({ id: "a", adjustValue: 2000 })], context());

    expect(result.finalPrice).toBe(12_000_000);
  });

  it("정액 조정은 그대로 더한다", () => {
    const result = evaluatePriceRules(
      10_000_000,
      [rule({ id: "a", adjustType: "amount_krw", adjustValue: -500_000 })],
      context(),
    );

    expect(result.finalPrice).toBe(9_500_000);
  });

  it("조건이 맞지 않으면 금액이 그대로다", () => {
    const result = evaluatePriceRules(10_000_000, [rule({ id: "a" })], context({ eventDate: MONDAY }));

    expect(result.finalPrice).toBe(10_000_000);
    expect(result.steps[0].applied).toBe(false);
    expect(result.steps[0].reason).toContain("요일이 아닙니다");
  });

  it("꺼진 룰은 평가되지 않는다", () => {
    const result = evaluatePriceRules(10_000_000, [rule({ id: "a", isActive: false })], context());

    expect(result.finalPrice).toBe(10_000_000);
    expect(result.steps[0].reason).toContain("꺼진 룰");
  });

  it("반올림은 0.5 를 +∞ 방향으로 보낸다 (penalty.ts 와 같은 방식)", () => {
    // 1원 * -5000bp = -0.5 -> Math.round(-0.5) = -0 -> 1원 유지
    expect(evaluatePriceRules(1, [rule({ id: "a", adjustValue: -5000 })], context()).finalPrice).toBe(1);
    // 3원 * 1667bp = 0.5001 -> 1원 증가
    expect(evaluatePriceRules(3, [rule({ id: "a", adjustValue: 1667 })], context()).finalPrice).toBe(4);
  });

  it("금액이 음수로 내려가지 않는다", () => {
    const result = evaluatePriceRules(
      1_000_000,
      [rule({ id: "a", adjustType: "amount_krw", adjustValue: -5_000_000 })],
      context(),
    );

    expect(result.finalPrice).toBe(0);
  });
});

describe("복수 룰 중첩", () => {
  it("직전 결과에 순차로 적용한다", () => {
    const result = evaluatePriceRules(
      10_000_000,
      [
        rule({ id: "a", priority: 1, adjustValue: -1000 }),
        rule({ id: "b", priority: 2, adjustValue: -1000 }),
      ],
      context(),
    );

    // 10,000,000 -> 9,000,000 -> 8,100,000 (복리)
    expect(result.finalPrice).toBe(8_100_000);
    expect(result.steps[0].priceAfter).toBe(9_000_000);
    expect(result.steps[1].priceBefore).toBe(9_000_000);
  });

  it("priority 가 작은 룰이 먼저 적용된다", () => {
    const first = rule({ id: "a", priority: 1, adjustType: "amount_krw", adjustValue: -1_000_000 });
    const second = rule({ id: "b", priority: 2, adjustValue: -1000 });

    const result = evaluatePriceRules(10_000_000, [second, first], context());

    expect(result.steps[0].ruleId).toBe("a");
    // (10,000,000 - 1,000,000) * 0.9 = 8,100,000
    expect(result.finalPrice).toBe(8_100_000);
  });

  it("입력 순서가 달라도 결과가 같다 — 결정성", () => {
    const a = rule({ id: "a", priority: 1, adjustValue: -1000 });
    const b = rule({ id: "b", priority: 2, adjustType: "amount_krw", adjustValue: -500_000 });

    const forward = evaluatePriceRules(10_000_000, [a, b], context());
    const backward = evaluatePriceRules(10_000_000, [b, a], context());

    expect(forward.finalPrice).toBe(backward.finalPrice);
    expect(forward.steps.map((step) => step.ruleId)).toEqual(backward.steps.map((step) => step.ruleId));
  });

  it("적용되지 않은 룰도 단계에 남는다 — 왜 안 걸렸는지 보여야 한다", () => {
    const result = evaluatePriceRules(
      10_000_000,
      [rule({ id: "a" }), rule({ id: "b", condition: { ruleType: "weekday", weekdays: [1] } })],
      context(),
    );

    expect(result.steps).toHaveLength(2);
    expect(result.steps.filter((step) => step.applied)).toHaveLength(1);
  });
});

describe("동일 priority 충돌 — 전순서로 해소한다", () => {
  it("rule_type 고정 순서로 갈린다 (season -> weekday -> leadtime -> occupancy)", () => {
    const weekday = rule({ id: "b", priority: 50 });
    const season = rule({
      id: "a",
      priority: 50,
      ruleType: "season",
      condition: { ruleType: "season", from: "2026-10-01", to: "2026-10-31" },
    });

    const result = evaluatePriceRules(10_000_000, [weekday, season], context());

    expect(result.steps.map((step) => step.ruleType)).toEqual(["season", "weekday"]);
  });

  it("종류까지 같으면 먼저 만든 룰이 먼저다", () => {
    const later = rule({ id: "b", priority: 50, createdAt: "2026-02-01T00:00:00Z" });
    const earlier = rule({ id: "a", priority: 50, createdAt: "2026-01-01T00:00:00Z" });

    const result = evaluatePriceRules(10_000_000, [later, earlier], context());

    expect(result.steps.map((step) => step.ruleId)).toEqual(["a", "b"]);
  });

  it("생성 시각까지 같으면 id 로 갈린다 — 어떤 경우에도 순서가 유일하다", () => {
    const b = rule({ id: "b", priority: 50 });
    const a = rule({ id: "a", priority: 50 });

    expect(comparePriceRules(a, b)).toBeLessThan(0);
    expect(comparePriceRules(b, a)).toBeGreaterThan(0);
    expect(comparePriceRules(a, a)).toBe(0);
  });
});

describe("floor / cap 가드", () => {
  it("하한가 아래로 내려가지 않는다", () => {
    const result = evaluatePriceRules(
      10_000_000,
      [rule({ id: "a", adjustValue: -5000, floorPrice: 8_000_000 })],
      context(),
    );

    expect(result.finalPrice).toBe(8_000_000);
    expect(result.steps[0].clampedByGuard).toBe(true);
  });

  it("상한가 위로 올라가지 않는다", () => {
    const result = evaluatePriceRules(
      10_000_000,
      [rule({ id: "a", adjustValue: 5000, capPrice: 12_000_000 })],
      context(),
    );

    expect(result.finalPrice).toBe(12_000_000);
  });

  it("앞선 룰의 하한을 뒤 룰이 뚫지 못한다", () => {
    const result = evaluatePriceRules(
      10_000_000,
      [
        rule({ id: "a", priority: 1, adjustValue: -1000, floorPrice: 9_000_000 }),
        rule({ id: "b", priority: 2, adjustValue: -5000 }),
      ],
      context(),
    );

    expect(result.effectiveFloor).toBe(9_000_000);
    expect(result.finalPrice).toBe(9_000_000);
    expect(result.guardApplied).toBe(true);
  });

  it("여러 하한 중 가장 높은 값이 이긴다", () => {
    const result = evaluatePriceRules(
      10_000_000,
      [
        rule({ id: "a", priority: 1, adjustValue: -1000, floorPrice: 8_000_000 }),
        rule({ id: "b", priority: 2, adjustValue: -1000, floorPrice: 9_500_000 }),
      ],
      context(),
    );

    expect(result.effectiveFloor).toBe(9_500_000);
    expect(result.finalPrice).toBe(9_500_000);
  });

  it("여러 상한 중 가장 낮은 값이 이긴다", () => {
    const result = evaluatePriceRules(
      10_000_000,
      [
        rule({ id: "a", priority: 1, adjustValue: 2000, capPrice: 11_500_000 }),
        rule({ id: "b", priority: 2, adjustValue: 2000, capPrice: 11_000_000 }),
      ],
      context(),
    );

    expect(result.effectiveCap).toBe(11_000_000);
    expect(result.finalPrice).toBe(11_000_000);
  });

  it("하한 > 상한 모순이면 하한을 택하고 알린다", () => {
    const result = evaluatePriceRules(
      10_000_000,
      [
        rule({ id: "a", priority: 1, adjustValue: -1000, floorPrice: 9_500_000 }),
        rule({ id: "b", priority: 2, adjustValue: -1000, capPrice: 8_000_000 }),
      ],
      context(),
    );

    expect(result.guardConflict).toBe(true);
    expect(result.finalPrice).toBe(9_500_000);
  });

  it("가드가 걸리지 않으면 guardApplied 는 false 다", () => {
    const result = evaluatePriceRules(
      10_000_000,
      [rule({ id: "a", adjustValue: -1000, floorPrice: 1_000_000 })],
      context(),
    );

    expect(result.guardApplied).toBe(false);
    expect(result.finalPrice).toBe(9_000_000);
  });
});

describe("조건별 판정", () => {
  it("시즌 — 기간 양끝을 포함한다", () => {
    const seasonRule = rule({
      id: "a",
      ruleType: "season",
      condition: { ruleType: "season", from: "2026-10-10", to: "2026-10-20" },
    });

    expect(matchRule(seasonRule, context({ eventDate: "2026-10-10" })).matched).toBe(true);
    expect(matchRule(seasonRule, context({ eventDate: "2026-10-20" })).matched).toBe(true);
    expect(matchRule(seasonRule, context({ eventDate: "2026-10-09" })).matched).toBe(false);
    expect(matchRule(seasonRule, context({ eventDate: "2026-10-21" })).matched).toBe(false);
  });

  it("리드타임 0일 — 당일도 조건에 든다 (경계)", () => {
    const leadRule = rule({
      id: "a",
      ruleType: "leadtime",
      condition: { ruleType: "leadtime", minDays: null, maxDays: 7 },
    });

    expect(matchRule(leadRule, context({ leadTimeDays: 0 })).matched).toBe(true);
    expect(matchRule(leadRule, context({ leadTimeDays: 7 })).matched).toBe(true);
    expect(matchRule(leadRule, context({ leadTimeDays: 8 })).matched).toBe(false);
  });

  it("리드타임 최소 조건도 경계를 포함한다", () => {
    const leadRule = rule({
      id: "a",
      ruleType: "leadtime",
      condition: { ruleType: "leadtime", minDays: 30, maxDays: null },
    });

    expect(matchRule(leadRule, context({ leadTimeDays: 30 })).matched).toBe(true);
    expect(matchRule(leadRule, context({ leadTimeDays: 29 })).matched).toBe(false);
  });

  it("잔여율 0% — 만석도 조건에 든다 (경계)", () => {
    const occupancyRule = rule({
      id: "a",
      ruleType: "occupancy",
      condition: { ruleType: "occupancy", minRatioBp: null, maxRatioBp: 2000 },
    });

    expect(matchRule(occupancyRule, context({ occupancyRatioBp: 0 })).matched).toBe(true);
    expect(matchRule(occupancyRule, context({ occupancyRatioBp: 2000 })).matched).toBe(true);
    expect(matchRule(occupancyRule, context({ occupancyRatioBp: 2001 })).matched).toBe(false);
  });

  it("잔여율 100% — 전부 비었을 때도 조건에 든다 (경계)", () => {
    const occupancyRule = rule({
      id: "a",
      ruleType: "occupancy",
      condition: { ruleType: "occupancy", minRatioBp: 8000, maxRatioBp: null },
    });

    expect(matchRule(occupancyRule, context({ occupancyRatioBp: 10_000 })).matched).toBe(true);
    expect(matchRule(occupancyRule, context({ occupancyRatioBp: 7999 })).matched).toBe(false);
  });

  it("재고 정보가 없으면 잔여율 룰은 적용되지 않는다 — 없는 값을 만들지 않는다", () => {
    const occupancyRule = rule({
      id: "a",
      ruleType: "occupancy",
      condition: { ruleType: "occupancy", minRatioBp: null, maxRatioBp: 5000 },
    });

    const result = matchRule(occupancyRule, context({ occupancyRatioBp: null }));

    expect(result.matched).toBe(false);
    expect(result.reason).toContain("재고 정보가 없어");
  });

  it("다른 상품의 룰은 적용되지 않는다", () => {
    const productRule = rule({ id: "a", productId: "11111111-1111-4111-8111-111111111111" });

    expect(matchRule(productRule, context()).matched).toBe(false);
    expect(
      matchRule(productRule, context({ productId: "11111111-1111-4111-8111-111111111111" })).matched,
    ).toBe(true);
  });
});

describe("표시 보조", () => {
  it("bp 를 퍼센트 문구로 바꾼다", () => {
    expect(bpToPercentText(1000)).toBe("10%");
    expect(bpToPercentText(0)).toBe("0%");
    expect(bpToPercentText(10_000)).toBe("100%");
    expect(bpToPercentText(1250)).toBe("12.50%");
  });
});

describe("입력 방어", () => {
  it("기준 금액이 정수가 아니면 던진다", () => {
    expect(() => evaluatePriceRules(1000.5, [], context())).toThrow(RangeError);
    expect(() => evaluatePriceRules(-1, [], context())).toThrow(RangeError);
  });

  it("룰이 없으면 기준 금액 그대로다", () => {
    const result = evaluatePriceRules(10_000_000, [], context());

    expect(result.finalPrice).toBe(10_000_000);
    expect(result.steps).toHaveLength(0);
  });
});
