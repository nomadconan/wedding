import { describe, expect, it } from "vitest";

import { AMOUNT_UNKNOWN } from "../pricing/amount";
import {
  COMPARE_AXES,
  COMPARE_CELL_TEXT,
  cellText,
  groupByCategory,
  lowestTotal,
  plannerSelectionMixed,
  sortByTotal,
} from "../schemas/compare";

describe("칸 상태 — 빈칸을 만들지 않는다", () => {
  it("'해당 없음'과 '미등록'과 '확인 불가'가 서로 다른 문구다", () => {
    const texts = Object.values(COMPARE_CELL_TEXT);

    expect(new Set(texts).size).toBe(texts.length);
  });

  it("값이 있으면 그 문구를 쓴다", () => {
    expect(cellText({ kind: "value", text: "200명" })).toBe("200명");
  });

  it("추가금 0건 확정은 '해당 없음'이고 미등록과 다르다", () => {
    expect(cellText({ kind: "none" })).not.toBe(cellText({ kind: "missing" }));
  });
});

describe("비교 축", () => {
  it("총액이 첫 줄이다 — 화면의 주인공은 가격이다", () => {
    expect(COMPARE_AXES[0]).toBe("total");
  });

  it("판매가·추가금·플래너가 총액 바로 뒤에 온다", () => {
    expect(COMPARE_AXES.slice(1, 4)).toEqual(["basePrice", "addOns", "plannerFee"]);
  });
});

describe("플래너 기준", () => {
  it("항목이 하나면 갈릴 것이 없다", () => {
    expect(plannerSelectionMixed([true])).toBe(false);
    expect(plannerSelectionMixed([])).toBe(false);
  });

  it("모두 같으면 갈리지 않았다", () => {
    expect(plannerSelectionMixed([true, true, true])).toBe(false);
    expect(plannerSelectionMixed([false, false])).toBe(false);
  });

  it("하나라도 다르면 갈렸다 — 총액 비교가 같은 조건이 아니다", () => {
    expect(plannerSelectionMixed([true, false])).toBe(true);
    expect(plannerSelectionMixed([false, false, true])).toBe(true);
  });
});

describe("실총액 정렬 (§6.2)", () => {
  const item = (itemId: string, total: number | typeof AMOUNT_UNKNOWN) => ({ itemId, total });

  it("낮은 총액이 앞에 온다", () => {
    const sorted = sortByTotal([item("b", 30), item("a", 10), item("c", 20)]);

    expect(sorted.map((row) => row.itemId)).toEqual(["a", "c", "b"]);
  });

  it("미정은 맨 뒤다 — 모르는 값은 낮은 값이 아니다", () => {
    const sorted = sortByTotal([item("u", AMOUNT_UNKNOWN), item("a", 10)]);

    expect(sorted.map((row) => row.itemId)).toEqual(["a", "u"]);
  });

  it("금액이 같아도 순서가 유일하게 정해진다", () => {
    const forward = sortByTotal([item("b", 10), item("a", 10)]);
    const backward = sortByTotal([item("a", 10), item("b", 10)]);

    expect(forward.map((row) => row.itemId)).toEqual(["a", "b"]);
    expect(backward.map((row) => row.itemId)).toEqual(forward.map((row) => row.itemId));
  });

  it("미정끼리도 순서가 흔들리지 않는다", () => {
    const sorted = sortByTotal([item("z", AMOUNT_UNKNOWN), item("y", AMOUNT_UNKNOWN)]);

    expect(sorted.map((row) => row.itemId)).toEqual(["y", "z"]);
  });
});

describe("가장 낮은 총액", () => {
  it("전부 확정이면 가장 낮은 것을 집는다", () => {
    expect(lowestTotal([{ itemId: "a", total: 20 }, { itemId: "b", total: 10 }])).toEqual({
      itemId: "b",
    });
  });

  it("미정이 하나라도 있으면 정하지 않는다 — 모르는 값이 더 쌀 수 있다", () => {
    expect(
      lowestTotal([{ itemId: "a", total: 10 }, { itemId: "b", total: AMOUNT_UNKNOWN }]),
    ).toEqual({ undecided: "has_unknown" });
  });

  it("비어 있으면 null 이다", () => {
    expect(lowestTotal([])).toBeNull();
  });
});

describe("카테고리 묶기", () => {
  it("카테고리별로 나눈다 — 웨딩홀과 드레스를 한 줄에 세우지 않는다", () => {
    const groups = groupByCategory([
      { category: "hall", itemId: "1" },
      { category: "dress", itemId: "2" },
      { category: "hall", itemId: "3" },
    ]);

    expect(groups.map((group) => group.category)).toEqual(["hall", "dress"]);
    expect(groups[0].items).toHaveLength(2);
  });

  it("비교할 것이 있는 묶음이 먼저 온다", () => {
    const groups = groupByCategory([
      { category: "dress", itemId: "1" },
      { category: "hall", itemId: "2" },
      { category: "hall", itemId: "3" },
    ]);

    expect(groups[0].category).toBe("hall");
  });

  it("카테고리를 모르는 항목도 버리지 않는다", () => {
    const groups = groupByCategory([{ category: null, itemId: "1" }]);

    expect(groups[0].category).toBe("unknown");
  });

  it("같은 크기면 순서가 항상 같다", () => {
    const input = [
      { category: "studio", itemId: "1" },
      { category: "hall", itemId: "2" },
    ];

    expect(groupByCategory(input).map((g) => g.category)).toEqual(
      groupByCategory([...input].reverse()).map((g) => g.category),
    );
  });
});
