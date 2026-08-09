import { describe, expect, it } from "vitest";

import { AMOUNT_UNKNOWN } from "../pricing/amount";
import { calculateOrderTotal } from "../pricing/order";
import {
  ADDED_BY_TEXT,
  CartMutationSchema,
  PRICE_CHANGE_LABEL,
  WishlistMutationSchema,
  addedByLabelOf,
  priceChangeOf,
} from "../schemas/cart";

const UUID_A = "00000000-0000-0000-0000-0000000000a1";
const UUID_B = "00000000-0000-0000-0000-0000000000b2";

describe("장바구니 쓰기 입력", () => {
  it("담기는 상품 id 를 요구한다", () => {
    expect(CartMutationSchema.parse({ action: "add", productId: UUID_A }).options).toEqual({});
    expect(() => CartMutationSchema.parse({ action: "add", productId: "x" })).toThrow();
  });

  it("플래너 토글은 항목 id 와 불리언을 요구한다", () => {
    const parsed = CartMutationSchema.parse({
      action: "set_planner",
      itemId: UUID_A,
      selected: true,
    });

    expect(parsed).toEqual({ action: "set_planner", itemId: UUID_A, selected: true });
    expect(() => CartMutationSchema.parse({ action: "set_planner", itemId: UUID_A })).toThrow();
  });

  it("정의되지 않은 동작은 거부한다", () => {
    expect(() => CartMutationSchema.parse({ action: "empty_all" })).toThrow();
  });

  it("찜은 상품 없이도 담을 수 있다 — 업체 찜이다", () => {
    expect(WishlistMutationSchema.parse({ action: "add", vendorId: UUID_A }).productId).toBeNull();
  });
});

describe("담은 시점 대비 가격 변동", () => {
  it("같으면 same 이다", () => {
    expect(priceChangeOf(10_000_000, 10_000_000)).toEqual({ kind: "same", price: 10_000_000 });
  });

  it("오르면 차액과 비율을 함께 준다", () => {
    expect(priceChangeOf(10_000_000, 11_000_000)).toEqual({
      kind: "up",
      from: 10_000_000,
      to: 11_000_000,
      diff: 1_000_000,
      rateBp: 1000,
    });
  });

  it("내리면 down 이다", () => {
    expect(priceChangeOf(10_000_000, 9_000_000)).toMatchObject({ kind: "down", diff: 1_000_000 });
  });

  it("담은 시점 가격이 없으면 '변동 없음'이 아니라 unknown 이다", () => {
    expect(priceChangeOf(null, 10_000_000)).toEqual({ kind: "unknown" });
  });

  it("현재가가 없으면 unavailable 이다. 담은 시점 값은 남긴다", () => {
    expect(priceChangeOf(10_000_000, null)).toEqual({ kind: "unavailable", from: 10_000_000 });
  });

  it("현재가가 미정이어도 '변동 없음'으로 뭉개지 않는다", () => {
    expect(priceChangeOf(10_000_000, AMOUNT_UNKNOWN)).toEqual({
      kind: "unavailable",
      from: 10_000_000,
    });
  });

  it("네 상태의 문구가 서로 다르다", () => {
    const texts = Object.values(PRICE_CHANGE_LABEL);

    expect(new Set(texts).size).toBe(texts.length);
  });

  it("기준이 0이면 나눗셈을 하지 않는다", () => {
    expect(priceChangeOf(0, 1_000_000)).toMatchObject({ kind: "up", rateBp: 0 });
  });
});

describe("작성자 표기", () => {
  it("본인·배우자·그 외를 구분한다", () => {
    expect(addedByLabelOf(UUID_A, UUID_A, [UUID_A, UUID_B])).toBe("me");
    expect(addedByLabelOf(UUID_B, UUID_A, [UUID_A, UUID_B])).toBe("partner");
    expect(addedByLabelOf("00000000-0000-0000-0000-0000000000c3", UUID_A, [UUID_A, UUID_B])).toBe(
      "other",
    );
  });

  it("문구가 서로 다르다 — 누가 담았는지 화면에서 갈라 보인다", () => {
    const texts = Object.values(ADDED_BY_TEXT);

    expect(new Set(texts).size).toBe(texts.length);
  });
});

describe("합계 — 장바구니는 현재가를 따라간다", () => {
  const line = (salePrice: number, plannerSelected = false) => ({
    salePrice,
    addOns: { kind: "none" } as const,
    plannerSelected,
    feeRateBp: 500,
    plannerFeeRateBp: 1000,
  });

  it("담은 시점 가격이 아니라 현재가로 합산한다", () => {
    // price_at_add 는 계산에 아예 들어가지 않는다 — 입력에 그 자리가 없다.
    const total = calculateOrderTotal([line(10_000_000), line(20_000_000)]);

    expect(total.basePrice).toBe(30_000_000);
    expect(total.total).toBe(30_000_000);
  });

  it("플래너를 고른 항목만 수수료가 붙는다", () => {
    const total = calculateOrderTotal([line(10_000_000, true), line(20_000_000)]);

    expect(total.total).toBe(31_000_000);
    expect(total.plannerFee).toMatchObject({ kind: "selected", amount: 1_000_000 });
  });

  it("요율이 없으면 금액을 지어내지 않고 미정으로 남긴다", () => {
    const total = calculateOrderTotal([
      { ...line(10_000_000, true), plannerFeeRateBp: null },
    ]);

    expect(total.plannerFee).toMatchObject({ kind: "selected", amount: AMOUNT_UNKNOWN });
    expect(total.total).toBe(AMOUNT_UNKNOWN);
  });

  it("추가금이 미등록이면 합계도 미정이다", () => {
    const total = calculateOrderTotal([
      { ...line(10_000_000), addOns: { kind: "unknown" } },
      line(20_000_000),
    ]);

    expect(total.total).toBe(AMOUNT_UNKNOWN);
  });
});
