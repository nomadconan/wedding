import { describe, expect, it } from "vitest";

import { BUDGET_CATEGORIES, VENDOR_TO_BUDGET_CATEGORY } from "../budget/budget";
import { ESTIMATE_CATEGORIES } from "../schemas/estimate";
import {
  COMPARE_MAX,
  COMPARE_MIN,
  ESTIMATE_FLAG_LABEL,
  LOWEST_REASON_NOTE,
  VENDOR_TO_ESTIMATE_CATEGORY,
  compareEstimates,
  estimateCategoryOfVendor,
  normalizeEstimate,
  type QuoteLine,
} from "./normalize";

const NOW = "2027-01-10T00:00:00.000Z";

const line = (over: Partial<QuoteLine> & { id: string; amount: number }): QuoteLine => ({
  label: over.id,
  vendorCategory: "hall",
  isOption: false,
  isMandatory: false,
  ...over,
});

const estimate = (over: {
  quoteId: string;
  vendorCategory?: string;
  declaredTotal?: number;
  validUntil?: string | null;
  lines: QuoteLine[];
}) =>
  normalizeEstimate({
    quoteId: over.quoteId,
    vendorId: `v-${over.quoteId}`,
    vendorName: `업체 ${over.quoteId}`,
    productName: "상품",
    vendorCategory: over.vendorCategory ?? "hall",
    declaredTotal:
      over.declaredTotal ??
      over.lines.filter((l) => !l.isOption || l.isMandatory).reduce((a, l) => a + l.amount, 0),
    validUntil: over.validUntil ?? null,
    lines: over.lines,
    now: NOW,
  });

describe("매핑 — 표는 예산과 하나다", () => {
  it("**예산이 쓰는 그 표를 그대로 참조한다** — 사본을 만들면 사본이 어긋난다", () => {
    expect(VENDOR_TO_ESTIMATE_CATEGORY).toBe(VENDOR_TO_BUDGET_CATEGORY);
  });

  it("업체 카테고리를 표준 견적 카테고리로 옮긴다", () => {
    expect(estimateCategoryOfVendor("hall")).toBe("hall");
    expect(estimateCategoryOfVendor("makeup")).toBe("makeup");
    expect(estimateCategoryOfVendor("agency")).toBe("etc");
  });

  it("**모르는 업종은 `unmapped` 다** — 예산과 갈리는 유일한 자리이며 의도한 것이다", () => {
    // 예산은 `etc`(돈을 배정할 칸이 있어야 한다), 견적은 `unmapped`('확인 필요'로 드러낸다).
    expect(estimateCategoryOfVendor("새로운업종")).toBe("unmapped");
    expect(estimateCategoryOfVendor(null)).toBe("unmapped");
    expect(VENDOR_TO_BUDGET_CATEGORY["새로운업종"]).toBeUndefined();
  });

  it("예산 카테고리는 견적 카테고리에서 `unmapped` 만 뺀 것이다", () => {
    expect([...BUDGET_CATEGORIES].sort()).toEqual(
      ESTIMATE_CATEGORIES.filter((c) => c !== "unmapped")
        .slice()
        .sort(),
    );
  });
});

describe("실총액 환산 — 선택 옵션을 대신 고르지 않는다", () => {
  const built = estimate({
    quoteId: "a",
    lines: [
      line({ id: "base", amount: 10_000_000 }),
      line({ id: "must", amount: 1_000_000, isOption: true, isMandatory: true }),
      line({ id: "maybe", amount: 500_000, isOption: true, isMandatory: false }),
    ],
    declaredTotal: 11_000_000,
  });

  it("기본 + 필수 옵션이 실총액이다", () => {
    expect(built.baseAmount).toBe(10_000_000);
    expect(built.mandatoryOptionAmount).toBe(1_000_000);
    expect(built.realTotal).toBe(11_000_000);
  });

  it("**선택 옵션은 실총액에 들어가지 않는다** — 우리가 대신 고른 셈이 된다", () => {
    expect(built.optionalOptionAmount).toBe(500_000);
    expect(built.realTotal).not.toBe(11_500_000);
  });

  it("**남아 있다는 사실은 플래그로 올린다** — 더 오를 수 있다는 것이 비교에서 중요하다", () => {
    expect(built.flags).toContainEqual({
      kind: "optional_remaining",
      count: 1,
      amount: 500_000,
    });
  });

  it("카테고리별 금액은 **실총액에 드는 줄만** 센다", () => {
    expect(built.byCategory.hall).toBe(11_000_000);
  });
});

describe("검증 플래그 — 고치지 않고 드러낸다", () => {
  it("**합계 불일치를 고치지 않는다** — 어느 쪽이 맞는지 우리가 정할 일이 아니다", () => {
    const built = estimate({
      quoteId: "a",
      lines: [line({ id: "base", amount: 10_000_000 })],
      declaredTotal: 9_000_000,
    });

    expect(built.flags).toContainEqual({
      kind: "total_mismatch",
      declared: 9_000_000,
      computed: 10_000_000,
      difference: 1_000_000,
    });
    // 둘 다 남는다.
    expect(built.declaredTotal).toBe(9_000_000);
    expect(built.realTotal).toBe(10_000_000);
  });

  it("맞으면 플래그를 붙이지 않는다", () => {
    const built = estimate({ quoteId: "a", lines: [line({ id: "base", amount: 100 })] });

    expect(built.flags.some((f) => f.kind === "total_mismatch")).toBe(false);
  });

  it("옮기지 못한 줄을 센다 ('확인 필요')", () => {
    const built = estimate({
      quoteId: "a",
      lines: [line({ id: "x", amount: 100, vendorCategory: "모르는것" })],
    });

    expect(built.flags).toContainEqual({ kind: "unmapped_items", count: 1 });
  });

  it("유효기간이 지나면 플래그다", () => {
    const built = estimate({
      quoteId: "a",
      lines: [line({ id: "base", amount: 100 })],
      validUntil: "2027-01-01T00:00:00.000Z",
    });

    expect(built.flags.some((f) => f.kind === "expired")).toBe(true);
  });

  it("**기준 시각을 호출자가 넘긴다** — 자정을 넘기며 답이 달라지면 안 된다", () => {
    const built = estimate({
      quoteId: "a",
      lines: [line({ id: "base", amount: 100 })],
      validUntil: "2027-02-01T00:00:00.000Z",
    });

    expect(built.flags.some((f) => f.kind === "expired")).toBe(false);
  });

  it("유효기간이 없으면 만료를 말하지 않는다", () => {
    const built = estimate({ quoteId: "a", lines: [line({ id: "b", amount: 1 })], validUntil: null });

    expect(built.flags.some((f) => f.kind === "expired")).toBe(false);
  });

  it("네 플래그 모두 문구를 갖는다", () => {
    for (const kind of ["total_mismatch", "unmapped_items", "expired", "optional_remaining"] as const) {
      expect(ESTIMATE_FLAG_LABEL[kind]).not.toBe("");
    }
  });
});

describe("비교 — 사과와 오렌지를 나란히 두지 않는다", () => {
  const hallA = estimate({
    quoteId: "a",
    vendorCategory: "hall",
    lines: [line({ id: "a1", amount: 10_000_000, vendorCategory: "hall" })],
  });
  const hallB = estimate({
    quoteId: "b",
    vendorCategory: "hall",
    lines: [line({ id: "b1", amount: 12_000_000, vendorCategory: "hall" })],
  });

  it("같은 카테고리면 가장 낮은 실총액을 고른다", () => {
    const compared = compareEstimates([hallA, hallB]);

    expect(compared.sameCategory).toBe(true);
    expect(compared.lowest).toEqual({ kind: "lowest", quoteId: "a", amount: 10_000_000 });
  });

  it("**카테고리가 섞이면 우열을 정하지 않는다**(D-77 과 같은 규칙)", () => {
    const dress = estimate({
      quoteId: "c",
      vendorCategory: "dress",
      lines: [line({ id: "c1", amount: 1_500_000, vendorCategory: "dress" })],
    });

    const compared = compareEstimates([hallA, dress]);

    expect(compared.sameCategory).toBe(false);
    expect(compared.lowest).toEqual({ kind: "not_comparable", reason: "mixed_category" });
    expect(LOWEST_REASON_NOTE.mixed_category).toContain("총액 우열을 정하지 않았어요");
  });

  it("**동률도 정하지 않는다** — 하나를 고르면 순서가 우연히 정해진 것이 된다", () => {
    const tie = estimate({
      quoteId: "t",
      vendorCategory: "hall",
      lines: [line({ id: "t1", amount: 10_000_000, vendorCategory: "hall" })],
    });

    expect(compareEstimates([hallA, tie]).lowest).toEqual({
      kind: "not_comparable",
      reason: "tie",
    });
  });

  it("하나뿐이면 비교하지 않는다", () => {
    expect(compareEstimates([hallA]).lowest).toEqual({
      kind: "not_comparable",
      reason: "not_enough",
    });
  });

  it("**없는 칸은 null 이다** — 0으로 두면 '0원에 해 준다' 로 읽힌다", () => {
    const withMeal = estimate({
      quoteId: "m",
      vendorCategory: "hall",
      lines: [
        line({ id: "m1", amount: 8_000_000, vendorCategory: "hall" }),
        // 식대는 업체 카테고리에 없으므로 unmapped 로 간다 — 그 자체가 확인 필요다.
        line({ id: "m2", amount: 2_000_000, vendorCategory: "meal" }),
      ],
    });

    const compared = compareEstimates([hallA, withMeal]);
    const unmappedRow = compared.rows.find((row) => row.category === "unmapped");

    expect(unmappedRow?.amounts).toEqual([null, 2_000_000]);
    expect(unmappedRow?.onlyOne).toBe(true);
  });

  it("**빠진 항목을 열마다 짚는다**(§5.4 항목 누락)", () => {
    const withMeal = estimate({
      quoteId: "m",
      vendorCategory: "hall",
      lines: [
        line({ id: "m1", amount: 8_000_000, vendorCategory: "hall" }),
        line({ id: "m2", amount: 2_000_000, vendorCategory: "meal" }),
      ],
    });

    const compared = compareEstimates([hallA, withMeal]);

    expect(compared.columns[0].missing).toEqual(["unmapped"]);
    expect(compared.columns[1].missing).toEqual([]);
  });

  it("줄 순서는 **표준 카테고리 순서**로 고정한다 — 금액 순이면 볼 때마다 달라진다", () => {
    const mixed = estimate({
      quoteId: "x",
      vendorCategory: "hall",
      lines: [
        line({ id: "x1", amount: 100, vendorCategory: "dress" }),
        line({ id: "x2", amount: 900, vendorCategory: "hall" }),
      ],
    });

    expect(compareEstimates([mixed, mixed]).rows.map((row) => row.category)).toEqual([
      "hall",
      "dress",
    ]);
  });

  it("열마다 플래그를 실어 화면이 '확인 필요' 를 짚는다", () => {
    const flagged = estimate({
      quoteId: "f",
      vendorCategory: "hall",
      lines: [line({ id: "f1", amount: 100, vendorCategory: "hall" })],
      declaredTotal: 200,
    });

    expect(compareEstimates([hallA, flagged]).columns[1].flags.some((f) => f.kind === "total_mismatch")).toBe(true);
  });

  it("**플래너 수수료를 총액에 더하지 않는다** — 사실만 적는다", () => {
    const compared = compareEstimates([hallA, hallB]);

    expect(compared.columns[0].realTotal).toBe(hallA.realTotal);
    expect(compared.plannerNote).toContain("따로 붙어요");
    expect(compared.plannerNote).toContain("순서는 바뀌지 않습니다");
  });

  it("비교 개수 상한은 2~5 다 (§2.1)", () => {
    expect(COMPARE_MIN).toBe(2);
    expect(COMPARE_MAX).toBe(5);
  });
});
