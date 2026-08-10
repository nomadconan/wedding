import { describe, expect, it } from "vitest";

import {
  PRICE_INDEX_MIN_SAMPLE,
  PRICE_INDEX_SOURCE_LABEL,
  buildPriceIndex,
  compareByGap,
  percentileAt,
  priceGapBp,
  vendorRepresentatives,
  type PriceSample,
} from "./price-index";

const sample = (vendorId: string, price: number, productId?: string): PriceSample =>
  productId === undefined ? { vendorId, price } : { vendorId, price, productId };

/** 업체 n곳을 서로 다른 금액으로 만든다. */
const spread = (prices: number[]): PriceSample[] =>
  prices.map((price, index) => sample(`v${index}`, price));

describe("업체당 한 건", () => {
  it("한 업체가 여러 상품을 올려도 표본은 하나다", () => {
    const reps = vendorRepresentatives([
      sample("a", 30_000_000),
      sample("a", 10_000_000),
      sample("a", 20_000_000),
      sample("b", 15_000_000),
    ]);

    expect(reps).toHaveLength(2);
  });

  it("대표는 그 업체의 최저가다 — '얼마부터 시작하나'에 답한다", () => {
    const reps = vendorRepresentatives([sample("a", 30_000_000), sample("a", 10_000_000)]);

    expect(reps[0].price).toBe(10_000_000);
  });

  it("같은 금액이면 상품 id 로 갈라 결과가 흔들리지 않는다", () => {
    const forward = vendorRepresentatives([sample("a", 100, "p2"), sample("a", 100, "p1")]);
    const backward = vendorRepresentatives([sample("a", 100, "p1"), sample("a", 100, "p2")]);

    expect(forward[0].productId).toBe("p1");
    expect(backward[0].productId).toBe(forward[0].productId);
  });

  it("금액 오름차순으로 정렬해 돌려준다", () => {
    const reps = vendorRepresentatives([sample("a", 300), sample("b", 100), sample("c", 200)]);

    expect(reps.map((r) => r.price)).toEqual([100, 200, 300]);
  });

  it("정수가 아닌 금액은 던진다 — 부동소수점을 들이지 않는다", () => {
    expect(() => vendorRepresentatives([sample("a", 100.5)])).toThrow(RangeError);
    expect(() => vendorRepresentatives([sample("a", -1)])).toThrow(RangeError);
  });
});

describe("백분위 — 보간하지 않는다", () => {
  it("돌려주는 값은 언제나 실제 표본 중 하나다", () => {
    const prices = [100, 200, 300, 400];

    for (const bp of [0, 1, 2500, 5000, 7500, 9999, 10_000]) {
      expect(prices).toContain(percentileAt(prices, bp));
    }
  });

  it("짝수 개수에서도 두 값의 중간을 만들지 않는다", () => {
    // 아무도 부르지 않는 150 이 지수로 나가면 안 된다.
    expect(percentileAt([100, 200], 5000)).toBe(100);
  });

  it("홀수 개수의 중앙값은 가운데 값이다", () => {
    expect(percentileAt([100, 200, 300], 5000)).toBe(200);
  });

  it("경계: 0bp 는 최솟값, 10000bp 는 최댓값이다", () => {
    expect(percentileAt([10, 20, 30], 0)).toBe(10);
    expect(percentileAt([10, 20, 30], 10_000)).toBe(30);
  });

  it("표본 1건이면 모든 사분위가 그 값이다", () => {
    expect(percentileAt([777], 2500)).toBe(777);
    expect(percentileAt([777], 7500)).toBe(777);
  });

  it("빈 표본과 범위 밖 백분위는 던진다", () => {
    expect(() => percentileAt([], 5000)).toThrow(RangeError);
    expect(() => percentileAt([1], 10_001)).toThrow(RangeError);
    expect(() => percentileAt([1], -1)).toThrow(RangeError);
  });
});

describe("지수 산출", () => {
  it("표본이 하한에 못 미치면 값을 만들지 않는다", () => {
    const result = buildPriceIndex(spread([10, 20, 30, 40]));

    expect(result).toEqual({ ok: false, reason: "insufficient_sample", sampleSize: 4 });
  });

  it("하한 경계(5곳)에서는 산출한다", () => {
    const result = buildPriceIndex(spread([10, 20, 30, 40, 50]));

    expect(result.ok).toBe(true);
    expect(PRICE_INDEX_MIN_SAMPLE).toBe(5);
  });

  it("상품이 많아도 업체 수로 하한을 본다", () => {
    // 한 업체가 상품 10개를 올려도 표본은 1곳이다.
    const many = Array.from({ length: 10 }, (_, i) => sample("a", 1000 + i, `p${i}`));

    expect(buildPriceIndex(many)).toMatchObject({ ok: false, sampleSize: 1 });
  });

  it("사분위가 순서를 지킨다", () => {
    const result = buildPriceIndex(spread([100, 200, 300, 400, 500, 600, 700]));

    if (!result.ok) throw new Error("산출되어야 한다");
    expect(result.p25).toBeLessThanOrEqual(result.p50);
    expect(result.p50).toBeLessThanOrEqual(result.p75);
  });

  it("홀수 개수", () => {
    const result = buildPriceIndex(spread([100, 200, 300, 400, 500]));

    expect(result).toMatchObject({ ok: true, p25: 200, p50: 300, p75: 400, sampleSize: 5 });
  });

  it("짝수 개수", () => {
    const result = buildPriceIndex(spread([100, 200, 300, 400, 500, 600]));

    expect(result).toMatchObject({ ok: true, p25: 200, p50: 300, p75: 500, sampleSize: 6 });
  });

  it("모두 같은 금액이면 사분위도 모두 같다", () => {
    const result = buildPriceIndex(spread([500, 500, 500, 500, 500, 500]));

    expect(result).toMatchObject({ ok: true, p25: 500, p50: 500, p75: 500 });
  });

  it("표본 추적용 대표 목록을 함께 돌려준다", () => {
    const result = buildPriceIndex(spread([10, 20, 30, 40, 50]));

    if (!result.ok) throw new Error("산출되어야 한다");
    expect(result.representatives).toHaveLength(5);
  });

  it("출처 이름이 서로 다르다 — 등록가와 실거래가를 화면에서 가른다", () => {
    expect(PRICE_INDEX_SOURCE_LABEL.registered_price).not.toBe(
      PRICE_INDEX_SOURCE_LABEL.transaction,
    );
  });
});

describe("지수 대비 편차", () => {
  it("지수보다 싸면 음수다", () => {
    expect(priceGapBp(9_000_000, 10_000_000)).toBe(-1000);
  });

  it("지수보다 비싸면 양수다", () => {
    expect(priceGapBp(11_000_000, 10_000_000)).toBe(1000);
  });

  it("기준이 없으면 값도 없다 — 0으로 두지 않는다", () => {
    expect(priceGapBp(10_000_000, null)).toBeNull();
    expect(priceGapBp(10_000_000, 0)).toBeNull();
  });

  it("정렬에서 기준 없는 항목은 맨 뒤다", () => {
    const rows = [
      { id: "c", gapBp: null },
      { id: "a", gapBp: 500 },
      { id: "b", gapBp: -500 },
    ];

    expect([...rows].sort(compareByGap).map((row) => row.id)).toEqual(["b", "a", "c"]);
  });

  it("기준 없는 항목끼리도 순서가 흔들리지 않는다", () => {
    const rows = [
      { id: "z", gapBp: null },
      { id: "y", gapBp: null },
    ];

    expect([...rows].sort(compareByGap).map((r) => r.id)).toEqual(["y", "z"]);
    expect([...rows].reverse().sort(compareByGap).map((r) => r.id)).toEqual(["y", "z"]);
  });

  it("편차가 같으면 id 로 갈라 순서를 정한다", () => {
    const rows = [
      { id: "b", gapBp: 100 },
      { id: "a", gapBp: 100 },
    ];

    expect([...rows].sort(compareByGap).map((r) => r.id)).toEqual(["a", "b"]);
  });
});
