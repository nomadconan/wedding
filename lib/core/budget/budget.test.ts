import { describe, expect, it } from "vitest";

import { PRICE_INDEX_MIN_SAMPLE } from "../pricing/price-index";
import {
  BUDGET_CATEGORIES,
  BUDGET_CATEGORY_LABEL,
  DONUT_SEGMENT_LIMIT,
  budgetCategoryOfVendor,
  buildLine,
  donutSegments,
  isBudgetCategory,
  recommendAllocation,
  sharesBp,
  summarizeRecommendation,
  totalsOf,
  warningsOf,
  type BudgetCategory,
  type BudgetLine,
} from "./budget";

const line = (over: Partial<BudgetLine> & { category: BudgetCategory }): BudgetLine =>
  buildLine({
    planned: null,
    contracted: 0,
    paid: 0,
    manualSpent: 0,
    ...over,
  });

describe("카테고리 — 견적과 같은 말을 쓴다", () => {
  it("**`unmapped` 는 예산 카테고리가 아니다** — '확인 필요' 에 돈을 배정하게 된다", () => {
    expect(isBudgetCategory("unmapped")).toBe(false);
    expect((BUDGET_CATEGORIES as readonly string[])).not.toContain("unmapped");
  });

  it("표준 견적 카테고리를 그대로 쓴다", () => {
    expect(isBudgetCategory("hall")).toBe(true);
    expect(isBudgetCategory("meal")).toBe(true);
    expect(isBudgetCategory("helper")).toBe(true);
    expect(isBudgetCategory("없는카테고리")).toBe(false);
  });

  it("전부 라벨을 갖는다", () => {
    for (const category of BUDGET_CATEGORIES) {
      expect(BUDGET_CATEGORY_LABEL[category]).not.toBe("");
    }
  });

  it("업체 카테고리를 예산 카테고리로 옮긴다", () => {
    expect(budgetCategoryOfVendor("hall")).toBe("hall");
    expect(budgetCategoryOfVendor("makeup")).toBe("makeup");
  });

  it("**에이전시는 `etc` 다** — 견적에 대응하는 품목 칸이 없다", () => {
    expect(budgetCategoryOfVendor("agency")).toBe("etc");
  });

  it("모르는 값도 `etc` 로 간다 — 계약을 예산에서 사라지게 두지 않는다", () => {
    expect(budgetCategoryOfVendor(null)).toBe("etc");
    expect(budgetCategoryOfVendor("새로운업종")).toBe("etc");
  });
});

describe("권장 배분 — 기준이 없으면 권장하지 않는다", () => {
  const index = [
    { category: "hall", p50: 12_000_000, sampleSize: 9, sourceLabel: "업체가 등록한 판매가" },
    { category: "dress", p50: 1_500_000, sampleSize: 6, sourceLabel: "업체가 등록한 판매가" },
  ];

  it("지수가 있는 카테고리는 **중앙값 그 자체**를 권장한다", () => {
    const result = recommendAllocation({ index, categories: ["hall", "dress"] });

    expect(result).toEqual([
      { category: "hall", kind: "indexed", amount: 12_000_000, sampleSize: 9, sourceLabel: "업체가 등록한 판매가" },
      { category: "dress", kind: "indexed", amount: 1_500_000, sampleSize: 6, sourceLabel: "업체가 등록한 판매가" },
    ]);
  });

  it("**총예산을 비율로 쪼개지 않는다** — 총예산과 무관하게 같은 권장액이 나온다", () => {
    const a = recommendAllocation({ index, categories: ["hall"] });
    const b = recommendAllocation({ index, categories: ["hall"] });

    expect(a).toEqual(b);
  });

  it("지수가 없으면 `no_index` 다 — 0원이 아니다", () => {
    expect(recommendAllocation({ index, categories: ["meal"] })).toEqual([
      { category: "meal", kind: "no_index" },
    ]);
  });

  it("**표본 하한 미만이면 권장하지 않는다** — 적은 표본의 사분위는 통계가 아니라 우연이다", () => {
    const thin = [
      {
        category: "hall",
        p50: 12_000_000,
        sampleSize: PRICE_INDEX_MIN_SAMPLE - 1,
        sourceLabel: "업체가 등록한 판매가",
      },
    ];

    expect(recommendAllocation({ index: thin, categories: ["hall"] })[0].kind).toBe("no_index");
  });

  it("p50 이 없거나 0이면 권장하지 않는다", () => {
    const broken = [
      { category: "hall", p50: null, sampleSize: 9, sourceLabel: null },
      { category: "dress", p50: 0, sampleSize: 9, sourceLabel: null },
    ];

    expect(recommendAllocation({ index: broken, categories: ["hall", "dress"] }).every((r) => r.kind === "no_index")).toBe(true);
  });

  it("기본은 예산 카테고리 전부를 돈다", () => {
    expect(recommendAllocation({ index })).toHaveLength(BUDGET_CATEGORIES.length);
  });

  it("요약이 권장 있음·없음을 세고 합을 낸다", () => {
    const result = recommendAllocation({ index, categories: ["hall", "dress", "meal"] });

    expect(summarizeRecommendation(result)).toEqual({
      indexedCount: 2,
      missingCount: 1,
      total: 13_500_000,
    });
  });

  it("**권장이 하나도 없으면 합이 0이 아니라 없음이다**", () => {
    expect(summarizeRecommendation(recommendAllocation({ index: [], categories: ["hall"] })).total).toBeNull();
  });
});

describe("계획 대비 실지출", () => {
  it("**committed 는 계약액 + 손으로 적은 지출**이다 — 결제액을 또 더하지 않는다", () => {
    const result = buildLine({
      category: "hall",
      planned: 10_000_000,
      contracted: 9_000_000,
      // 계약금 300만을 이미 냈다. 그것은 계약액 안에 들어 있다.
      paid: 3_000_000,
      manualSpent: 500_000,
    });

    expect(result.committed).toBe(9_500_000);
    expect(result.remaining).toBe(500_000);
    expect(result.overBy).toBe(0);
  });

  it("**계획이 없으면 여유·초과가 없다** — 0으로 두지 않는다", () => {
    const result = buildLine({ category: "meal", planned: null, contracted: 1_000, paid: 0, manualSpent: 0 });

    expect(result.remaining).toBeNull();
    expect(result.overBy).toBeNull();
  });

  it("초과하면 여유가 음수가 아니라 0이다", () => {
    const result = buildLine({ category: "hall", planned: 1_000, contracted: 1_500, paid: 0, manualSpent: 0 });

    expect(result.remaining).toBe(0);
    expect(result.overBy).toBe(500);
  });

  it("합계를 낸다", () => {
    const totals = totalsOf({
      totalBudget: 30_000_000,
      lines: [
        line({ category: "hall", planned: 10_000_000, contracted: 9_000_000, paid: 3_000_000 }),
        line({ category: "dress", planned: 2_000_000, manualSpent: 1_000_000 }),
      ],
    });

    expect(totals.planned).toBe(12_000_000);
    expect(totals.contracted).toBe(9_000_000);
    expect(totals.paid).toBe(3_000_000);
    expect(totals.manualSpent).toBe(1_000_000);
    expect(totals.committed).toBe(10_000_000);
    expect(totals.remaining).toBe(20_000_000);
    expect(totals.unallocated).toBe(18_000_000);
  });

  it("**총예산이 미정이면 여유·초과·미배정이 전부 없음이다**", () => {
    const totals = totalsOf({
      totalBudget: null,
      lines: [line({ category: "hall", planned: 1_000, contracted: 5_000 })],
    });

    expect(totals.remaining).toBeNull();
    expect(totals.overBy).toBeNull();
    expect(totals.unallocated).toBeNull();
  });

  it("계획 합이 총예산을 넘으면 미배정은 0이다 — 음수로 내려가지 않는다", () => {
    const totals = totalsOf({
      totalBudget: 1_000,
      lines: [line({ category: "hall", planned: 5_000 })],
    });

    expect(totals.unallocated).toBe(0);
  });
});

describe("초과 경고 — 셋을 가른다", () => {
  it("총예산 초과가 맨 앞이다", () => {
    const lines = [line({ category: "hall", planned: 1_000, contracted: 5_000 })];
    const totals = totalsOf({ totalBudget: 2_000, lines });

    expect(warningsOf({ totals, lines })[0]).toEqual({ kind: "total_over", amount: 3_000 });
  });

  it("계획 합이 총예산을 넘으면 따로 말한다 — 아직 쓰지는 않았다", () => {
    const lines = [line({ category: "hall", planned: 5_000 })];
    const totals = totalsOf({ totalBudget: 2_000, lines });

    expect(warningsOf({ totals, lines })).toContainEqual({
      kind: "plan_over_budget",
      amount: 3_000,
    });
  });

  it("카테고리 초과는 카테고리를 말한다", () => {
    const lines = [line({ category: "dress", planned: 1_000, manualSpent: 1_400 })];
    const totals = totalsOf({ totalBudget: 100_000, lines });

    expect(warningsOf({ totals, lines })).toEqual([
      { kind: "category_over", category: "dress", amount: 400 },
    ]);
  });

  it("**총예산이 미정이면 총액 경고를 내지 않는다** — 0 기준 초과는 설정이 빈 것이지 사실이 아니다", () => {
    const lines = [line({ category: "hall", contracted: 9_000_000 })];
    const totals = totalsOf({ totalBudget: null, lines });

    expect(warningsOf({ totals, lines })).toEqual([]);
  });

  it("넘지 않으면 아무 말도 하지 않는다", () => {
    const lines = [line({ category: "hall", planned: 10_000, contracted: 1_000 })];
    const totals = totalsOf({ totalBudget: 100_000, lines });

    expect(warningsOf({ totals, lines })).toEqual([]);
  });
});

describe("도넛 — 색을 만들지 않는다", () => {
  it("**비율 합이 정확히 10000bp** 다 — 반올림을 두면 원이 닫히지 않는다", () => {
    for (const amounts of [[1, 1, 1], [7, 11, 13, 17], [1_000_000, 3, 3], [5, 5]]) {
      expect(sharesBp(amounts).reduce((a, b) => a + b, 0)).toBe(10_000);
    }
  });

  it("총합이 0이면 전부 0bp 다 — 나눗셈을 하지 않는다", () => {
    expect(sharesBp([0, 0])).toEqual([0, 0]);
    expect(sharesBp([])).toEqual([]);
  });

  it("**부동소수점을 내보내지 않는다** — 전부 정수다", () => {
    expect(sharesBp([7, 11, 13]).every(Number.isInteger)).toBe(true);
  });

  it("큰 것부터 상위 N개를 남기고 나머지를 '기타' 로 접는다", () => {
    const lines = Array.from({ length: DONUT_SEGMENT_LIMIT + 3 }, (_, i) => ({
      category: BUDGET_CATEGORIES[i],
      planned: (i + 1) * 1_000_000,
    }));

    const segments = donutSegments({ lines, unallocated: 0 });

    expect(segments).toHaveLength(DONUT_SEGMENT_LIMIT + 1);
    expect(segments.at(-1)?.key).toBe("__rest");
    expect(segments.at(-1)?.muted).toBe(true);
    // 큰 것부터다.
    expect(segments[0].amount).toBeGreaterThan(segments[1].amount);
  });

  it("미배정을 조각으로 낸다 — 총예산이 남아 있다는 사실도 그림의 일부다", () => {
    const segments = donutSegments({
      lines: [{ category: "hall", planned: 6_000_000 }],
      unallocated: 4_000_000,
    });

    expect(segments.map((s) => s.key)).toEqual(["hall", "__unallocated"]);
    expect(segments.map((s) => s.shareBp)).toEqual([6_000, 4_000]);
  });

  it("**총예산이 미정이면 미배정 조각이 없다**", () => {
    const segments = donutSegments({
      lines: [{ category: "hall", planned: 1_000 }],
      unallocated: null,
    });

    expect(segments.map((s) => s.key)).toEqual(["hall"]);
  });

  it("계획이 0이거나 없는 카테고리는 조각이 되지 않는다", () => {
    const segments = donutSegments({
      lines: [
        { category: "hall", planned: 0 },
        { category: "dress", planned: null },
      ],
      unallocated: 0,
    });

    expect(segments).toEqual([]);
  });

  it("'기타'·'미배정' 만 무채색이다 — 카테고리 조각은 색을 갖는다", () => {
    const lines = Array.from({ length: DONUT_SEGMENT_LIMIT + 2 }, (_, i) => ({
      category: BUDGET_CATEGORIES[i],
      planned: (i + 1) * 1_000,
    }));

    const segments = donutSegments({ lines, unallocated: 500 });

    expect(segments.filter((s) => s.muted).map((s) => s.key)).toEqual(["__rest", "__unallocated"]);
  });
});
