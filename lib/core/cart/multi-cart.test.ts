import { describe, expect, it } from "vitest";

import { AMOUNT_UNKNOWN } from "../pricing/amount";
import {
  BUDGET_BASIS_NOTE,
  CART_NAME_MAX_LENGTH,
  basisOf,
  budgetLine,
  cartLabel,
  categoryFill,
  defaultCompareMode,
  duplicateCartName,
  isValidCartName,
  lowestCart,
  nextCartSeq,
  normalizeCartName,
  rowIsIdentical,
  sameCoverage,
} from "./multi-cart";

/**
 * 여러 장바구니 (IDEA-01)
 *
 * 여기서 고정하는 것은 **판정의 경계**다 — 이름의 빈 문자열, 순번의 빈 자리, 예산
 * 미정과 0원의 구분, 채움 기준이 없을 때의 침묵, 덮개가 다를 때의 '정하지 않음'.
 * 전부 "모르는 것을 아는 것처럼 말하지 않는다" 는 한 규칙의 다른 얼굴이다.
 */
const CORE = ["hall", "studio", "dress", "makeup"] as const;

describe("장바구니 이름", () => {
  it("공백만 적은 이름은 이름이 아니다 — null 로 접는다", () => {
    expect(normalizeCartName("   ")).toBeNull();
    expect(normalizeCartName("")).toBeNull();
    expect(normalizeCartName(null)).toBeNull();
    expect(normalizeCartName(undefined)).toBeNull();
  });

  it("앞뒤 공백을 떼고 저장한다", () => {
    expect(normalizeCartName("  가성비안 ")).toBe("가성비안");
  });

  it("상한까지는 통과하고 한 글자 넘으면 막는다", () => {
    expect(isValidCartName("가".repeat(CART_NAME_MAX_LENGTH))).toBe(true);
    expect(isValidCartName("가".repeat(CART_NAME_MAX_LENGTH + 1))).toBe(false);
    expect(isValidCartName("")).toBe(false);
    // 앞뒤 공백이 남은 이름은 저장할 수 없다 — DB CHECK 도 같은 것을 요구한다.
    expect(isValidCartName(" 가성비안")).toBe(false);
  });

  it("이름이 없으면 순번으로 부른다", () => {
    expect(cartLabel({ name: null, seq: 3 })).toBe("장바구니 3");
    expect(cartLabel({ name: "부모님추천", seq: 2 })).toBe("부모님추천");
  });

  it("중복 이름을 막지 않는다 — 구분자는 순번이다", () => {
    // 같은 이름을 두 장바구니에 붙이는 것은 정당한 쓰임이며, 화면이 순번을 함께 보인다.
    expect(isValidCartName("부모님추천")).toBe(true);
    expect(cartLabel({ name: "부모님추천", seq: 1 })).toBe(
      cartLabel({ name: "부모님추천", seq: 4 }),
    );
    // 그래서 화면은 라벨만으로 구분하지 않는다 — 순번이 함께 나가야 한다는 뜻이다.
  });
});

describe("복제 이름", () => {
  it("이름이 있으면 관계를 남긴다", () => {
    expect(duplicateCartName({ name: "가성비안" })).toBe("가성비안 복사");
  });

  it("이름이 없으면 새 순번으로 불리게 둔다 — 없는 번호를 이름으로 박지 않는다", () => {
    expect(duplicateCartName({ name: null })).toBeNull();
  });

  it("접미사까지 상한을 넘으면 앞을 자른다 — 관계를 버리지 않는다", () => {
    const long = "가".repeat(CART_NAME_MAX_LENGTH);
    const copied = duplicateCartName({ name: long });

    expect(copied).not.toBeNull();
    expect(copied!.length).toBe(CART_NAME_MAX_LENGTH);
    expect(copied!.endsWith(" 복사")).toBe(true);
    expect(isValidCartName(copied!)).toBe(true);
  });
});

describe("순번 — 빈 번호를 채운다", () => {
  it("빈 장바구니 목록에서는 1이다", () => {
    expect(nextCartSeq([], 5)).toBe(1);
  });

  it("가운데가 비면 그 자리를 쓴다 (단조 증가가 아니다)", () => {
    expect(nextCartSeq([1, 2, 4], 5)).toBe(3);
    expect(nextCartSeq([2, 3], 5)).toBe(1);
  });

  it("순서가 뒤섞여 들어와도 같은 답이다", () => {
    expect(nextCartSeq([4, 1, 2], 5)).toBe(3);
  });

  it("자리가 없으면 null 이다 — 번호를 상한 밖으로 늘리지 않는다", () => {
    expect(nextCartSeq([1, 2, 3, 4, 5], 5)).toBeNull();
  });

  it("상한을 인자로 받는다 — 코드가 5를 알지 않는다", () => {
    expect(nextCartSeq([1], 1)).toBeNull();
    expect(nextCartSeq([1], 2)).toBe(2);
  });
});

describe("예산 기준선", () => {
  it("예산이 미정이면 기준선을 만들지 않는다 — 0으로 두지 않는다", () => {
    const line = budgetLine({ budget: null, total: 30_000_000, basis: "complete" });

    expect(line.kind).toBe("none");
    // 0원 예산과 미정을 구분한다 — 0이면 초과 판정이 나와야 한다.
    expect(budgetLine({ budget: 0, total: 30_000_000, basis: "complete" }).kind).toBe("over");
  });

  it("총액을 계산할 수 없으면 견주지 않는다", () => {
    expect(budgetLine({ budget: 40_000_000, total: null, basis: "complete" }).kind).toBe("unknown");
    expect(
      budgetLine({ budget: 40_000_000, total: AMOUNT_UNKNOWN, basis: "complete" }).kind,
    ).toBe("unknown");
  });

  it("여유·초과·같음을 가른다", () => {
    const under = budgetLine({ budget: 40_000_000, total: 30_000_000, basis: "complete" });
    const over = budgetLine({ budget: 40_000_000, total: 45_000_000, basis: "complete" });
    const exact = budgetLine({ budget: 40_000_000, total: 40_000_000, basis: "complete" });

    expect(under).toMatchObject({ kind: "under", remaining: 10_000_000 });
    expect(over).toMatchObject({ kind: "over", excess: 5_000_000 });
    expect(exact.kind).toBe("exact");
  });

  it("미완성 총액이면 판정에 근거를 붙인다 — '여유 있어요'를 단정으로 두지 않는다", () => {
    const line = budgetLine({ budget: 40_000_000, total: 10_000_000, basis: "partial" });

    expect(line).toMatchObject({ kind: "under", basis: "partial" });
    expect(BUDGET_BASIS_NOTE.partial).not.toBe("");
    expect(BUDGET_BASIS_NOTE.complete).toBe("");
  });
});

describe("카테고리 채움", () => {
  it("기준이 없으면 판정하지 않는다 — 목록을 지어내지 않는다", () => {
    expect(categoryFill({ coreCategories: null, itemCategories: ["hall"] })).toBeNull();
    expect(basisOf(null)).toBe("unknown_coverage");
  });

  it("빈 카테고리를 이름으로 말한다", () => {
    const fill = categoryFill({ coreCategories: CORE, itemCategories: ["hall", "dress"] });

    expect(fill).not.toBeNull();
    expect(fill!.filled).toEqual(["hall", "dress"]);
    expect(fill!.missing).toEqual(["studio", "makeup"]);
    expect(fill!.complete).toBe(false);
    expect(basisOf(fill)).toBe("partial");
  });

  it("기준을 다 담으면 완성이다", () => {
    const fill = categoryFill({
      coreCategories: CORE,
      itemCategories: ["hall", "studio", "dress", "makeup"],
    });

    expect(fill!.missing).toEqual([]);
    expect(fill!.complete).toBe(true);
    expect(basisOf(fill)).toBe("complete");
  });

  it("기준 밖 카테고리는 경고가 아니라 별도로 센다", () => {
    const fill = categoryFill({
      coreCategories: CORE,
      itemCategories: ["hall", "studio", "dress", "makeup", "video", "agency"],
    });

    expect(fill!.complete).toBe(true);
    expect(fill!.extra).toEqual(["agency", "video"]);
  });

  it("카테고리를 모르는 항목(내려간 상품)은 채움으로 세지 않는다", () => {
    const fill = categoryFill({ coreCategories: CORE, itemCategories: [null, null] });

    expect(fill!.filled).toEqual([]);
    expect(fill!.missing).toEqual([...CORE]);
  });

  it("같은 카테고리를 여럿 담아도 한 번만 센다", () => {
    const fill = categoryFill({ coreCategories: CORE, itemCategories: ["hall", "hall"] });

    expect(fill!.filled).toEqual(["hall"]);
  });
});

describe("장바구니끼리 비교", () => {
  const fillOf = (categories: string[]) =>
    categoryFill({ coreCategories: CORE, itemCategories: categories });

  it("담은 것이 같으면 총액으로 가른다", () => {
    const result = lowestCart([
      { cartId: "a", total: 50_000_000, fill: fillOf(["hall", "studio"]) },
      { cartId: "b", total: 40_000_000, fill: fillOf(["hall", "studio"]) },
    ]);

    expect(result).toEqual({ cartId: "b" });
  });

  it("금액이 미정이면 정하지 않는다", () => {
    const result = lowestCart([
      { cartId: "a", total: AMOUNT_UNKNOWN, fill: fillOf(["hall"]) },
      { cartId: "b", total: 40_000_000, fill: fillOf(["hall"]) },
    ]);

    expect(result).toEqual({ undecided: "has_unknown" });
  });

  it("담은 카테고리가 다르면 정하지 않는다 — 덜 담은 쪽이 이기는 표를 만들지 않는다", () => {
    const result = lowestCart([
      { cartId: "a", total: 10_000_000, fill: fillOf(["hall"]) },
      { cartId: "b", total: 40_000_000, fill: fillOf(["hall", "studio", "dress", "makeup"]) },
    ]);

    expect(result).toEqual({ undecided: "different_coverage" });
  });

  it("기준 밖 카테고리의 유무도 덮개 차이다", () => {
    const result = lowestCart([
      { cartId: "a", total: 10_000_000, fill: fillOf(["hall"]) },
      { cartId: "b", total: 20_000_000, fill: fillOf(["hall", "video"]) },
    ]);

    expect(result).toEqual({ undecided: "different_coverage" });
  });

  it("채움 기준이 없으면 금액만으로 단정하지 않는다", () => {
    const result = lowestCart([
      { cartId: "a", total: 10_000_000, fill: null },
      { cartId: "b", total: 40_000_000, fill: null },
    ]);

    expect(result).toEqual({ undecided: "different_coverage" });
  });

  it("하나뿐이면 그것이 가장 낮다 (덮개를 견줄 상대가 없다)", () => {
    expect(lowestCart([{ cartId: "a", total: 10_000_000, fill: null }])).toEqual({ cartId: "a" });
    expect(lowestCart([])).toBeNull();
  });

  it("같은 금액이면 id 로 갈라 순서를 유일하게 만든다", () => {
    const result = lowestCart([
      { cartId: "b", total: 10_000_000, fill: fillOf(["hall"]) },
      { cartId: "a", total: 10_000_000, fill: fillOf(["hall"]) },
    ]);

    expect(result).toEqual({ cartId: "a" });
  });

  it("덮개 판정은 담은 개수가 아니라 카테고리 집합이다", () => {
    // 같은 카테고리를 두 개 담은 쪽과 하나 담은 쪽은 **덮개가 같다.**
    expect(
      sameCoverage([
        { cartId: "a", total: 1, fill: fillOf(["hall", "hall"]) },
        { cartId: "b", total: 2, fill: fillOf(["hall"]) },
      ]),
    ).toBe(true);
  });
});

describe("비교표 줄 접기 · 층위", () => {
  it("모든 장바구니에서 값이 같은 줄만 접는다", () => {
    expect(rowIsIdentical(["포함", "포함", "포함"])).toBe(true);
    expect(rowIsIdentical(["포함", "별도", "포함"])).toBe(false);
  });

  it("열이 하나면 접지 않는다 — 접을 이유가 비교인데 상대가 없다", () => {
    expect(rowIsIdentical(["포함"])).toBe(false);
    expect(rowIsIdentical([])).toBe(false);
  });

  it("장바구니가 둘 이상이면 장바구니끼리가 기본이다", () => {
    expect(defaultCompareMode(2)).toBe("carts");
    expect(defaultCompareMode(5)).toBe("carts");
    expect(defaultCompareMode(1)).toBe("items");
    expect(defaultCompareMode(0)).toBe("items");
  });
});

describe("판정 순서 — 덮개가 먼저다", () => {
  const fillOf = (categories: string[]) =>
    categoryFill({ coreCategories: CORE, itemCategories: categories });

  it("빈 장바구니가 섞이면 '금액 미정'이 아니라 '덮개 다름'으로 말한다", () => {
    // 비어 있어서 총액이 없는 것을 "금액이 미정" 이라고 적으면 비었다는 사실이 가려진다.
    const result = lowestCart([
      { cartId: "a", total: 23_000_000, fill: fillOf(["hall", "studio"]) },
      { cartId: "empty", total: AMOUNT_UNKNOWN, fill: fillOf([]) },
    ]);

    expect(result).toEqual({ undecided: "different_coverage" });
  });

  it("덮개가 같은데 금액만 모르면 '금액 미정'이다", () => {
    const result = lowestCart([
      { cartId: "a", total: AMOUNT_UNKNOWN, fill: fillOf(["hall"]) },
      { cartId: "b", total: 10_000_000, fill: fillOf(["hall"]) },
    ]);

    expect(result).toEqual({ undecided: "has_unknown" });
  });
});
