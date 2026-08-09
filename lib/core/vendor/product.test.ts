import { describe, expect, it } from "vitest";

import {
  BasePriceTotalSchema,
  PRICE_EVASION_PATTERNS,
  ProductInputSchema,
  VENDOR_PRICING_NOTICE,
  canPublishProduct,
  findPriceEvasionPhrase,
  productPublishBlockers,
} from "../schemas/product";

const base = {
  name: "단독홀 대관 패키지",
  category: "hall" as const,
  basePriceTotal: 12_500_000,
  includedItems: [{ label: "홀 대관 4시간" }, { label: "기본 생화 장식" }],
  capacityMin: 100,
  capacityMax: 300,
};

describe("총액 표기 강제 — 판매가 (F-V-03, D-16)", () => {
  it("양의 정수만 통과한다", () => {
    expect(BasePriceTotalSchema.parse(1)).toBe(1);
    expect(BasePriceTotalSchema.parse(12_500_000)).toBe(12_500_000);
  });

  it("0원을 거부한다 — '별도 문의'를 0원으로 우회할 수 없다", () => {
    expect(() => BasePriceTotalSchema.parse(0)).toThrow();
  });

  it("음수·소수를 거부한다", () => {
    expect(() => BasePriceTotalSchema.parse(-1)).toThrow();
    expect(() => BasePriceTotalSchema.parse(1_000.5)).toThrow();
  });

  it("문자열 가격을 거부한다 — 자유 텍스트 가격 필드가 없다", () => {
    expect(() => BasePriceTotalSchema.parse("별도 문의")).toThrow();
    expect(() => BasePriceTotalSchema.parse("1200000")).toThrow();
  });

  it("총액 누락을 거부한다", () => {
    expect(() => ProductInputSchema.parse({ ...base, basePriceTotal: undefined })).toThrow();
  });
});

describe("가격 회피 문구 차단", () => {
  it("공백이 있든 없든 잡는다", () => {
    expect(findPriceEvasionPhrase("별도 문의")).toBe("별도문의");
    expect(findPriceEvasionPhrase("별도문의")).toBe("별도문의");
    expect(findPriceEvasionPhrase("가격은  협의 후 안내")).toBe("협의후");
  });

  it("정상 문구는 통과시킨다", () => {
    expect(findPriceEvasionPhrase("단독홀 대관 패키지")).toBeNull();
    expect(findPriceEvasionPhrase("스드메 올인클루시브")).toBeNull();
  });

  it("상품명에 가격 문의 표현이 있으면 거부한다", () => {
    expect(() => ProductInputSchema.parse({ ...base, name: "홀 대관 (가격 문의)" })).toThrow();
    expect(() => ProductInputSchema.parse({ ...base, name: "프리미엄 패키지 별도문의" })).toThrow();
  });

  it("포함 항목에 가격 문의 표현이 있으면 거부한다", () => {
    expect(() =>
      ProductInputSchema.parse({ ...base, includedItems: [{ label: "원판 촬영 별도 협의" }] }),
    ).toThrow();
  });

  it("차단 목록에 정상 영업 표현이 섞여 있지 않다", () => {
    // '문의' 나 '협의' 단독은 막지 않는다 — 정상 문장을 반려하면 업체가 우회 표기를 만든다.
    expect(PRICE_EVASION_PATTERNS).not.toContain("문의");
    expect(PRICE_EVASION_PATTERNS).not.toContain("협의");
  });
});

describe("ProductInputSchema", () => {
  it("정상 입력을 통과시킨다", () => {
    const parsed = ProductInputSchema.parse(base);

    expect(parsed.basePriceTotal).toBe(12_500_000);
    expect(parsed.includedItems).toHaveLength(2);
    expect(parsed.includedItems[0].note).toBeNull();
  });

  it("포함 항목 없이도 저장은 된다 — 게시 조건에서 막는다", () => {
    expect(() => ProductInputSchema.parse({ ...base, includedItems: [] })).not.toThrow();
  });

  it("수용 인원 하한이 상한보다 크면 거부한다", () => {
    expect(() => ProductInputSchema.parse({ ...base, capacityMin: 400, capacityMax: 300 })).toThrow();
  });

  it("정의되지 않은 카테고리를 거부한다", () => {
    expect(() => ProductInputSchema.parse({ ...base, category: "flower" })).toThrow();
  });

  it("상품명이 2자 미만이면 거부한다", () => {
    expect(() => ProductInputSchema.parse({ ...base, name: "대관" })).not.toThrow();
    expect(() => ProductInputSchema.parse({ ...base, name: "홀" })).toThrow();
    expect(() => ProductInputSchema.parse({ ...base, name: "" })).toThrow();
  });

  it("포함 항목은 50개까지다", () => {
    const includedItems = Array.from({ length: 51 }, (_, i) => ({ label: `항목 ${i}` }));

    expect(() => ProductInputSchema.parse({ ...base, includedItems })).toThrow();
  });
});

describe("게시 체크리스트 (화면·API 공통)", () => {
  it("총액과 포함 항목이 있으면 게시할 수 있다", () => {
    expect(
      canPublishProduct({ name: base.name, basePriceTotal: 1, includedItems: [{ label: "x" }] }),
    ).toBe(true);
  });

  it("총액이 0이면 막는다", () => {
    const blockers = productPublishBlockers({
      name: base.name,
      basePriceTotal: 0,
      includedItems: [{ label: "x" }],
    });

    expect(blockers.map((b) => b.code)).toContain("PRICE_REQUIRED");
  });

  it("포함 항목이 없으면 막는다 — 총액만으로는 비교가 안 된다", () => {
    const blockers = productPublishBlockers({
      name: base.name,
      basePriceTotal: 100,
      includedItems: [],
    });

    expect(blockers.map((b) => b.code)).toEqual(["INCLUDED_ITEMS_REQUIRED"]);
  });

  it("상품명이 없으면 막는다", () => {
    const blockers = productPublishBlockers({
      name: "",
      basePriceTotal: 100,
      includedItems: [{ label: "x" }],
    });

    expect(blockers.map((b) => b.code)).toContain("NAME_REQUIRED");
  });

  it("여러 조건이 동시에 빠지면 전부 보고한다 — 하나씩 고치게 하지 않는다", () => {
    const blockers = productPublishBlockers({ name: "", basePriceTotal: 0, includedItems: [] });

    expect(blockers).toHaveLength(3);
  });

  it("값이 없는 상태(null·undefined)도 막는다", () => {
    expect(canPublishProduct({})).toBe(false);
    expect(canPublishProduct({ name: null, basePriceTotal: null, includedItems: null })).toBe(false);
  });
});

describe("등록 화면 고지 (F-V-03)", () => {
  it("판매가가 고객 노출가이며 수수료 차감 후 정산됨을 밝힌다", () => {
    expect(VENDOR_PRICING_NOTICE).toContain("고객에게 그대로 노출");
    expect(VENDOR_PRICING_NOTICE).toContain("수수료를 제한 금액이 정산");
  });

  it("고지 문구에 요율 숫자가 없다 (O-02)", () => {
    expect(VENDOR_PRICING_NOTICE).not.toMatch(/\d/);
  });
});
