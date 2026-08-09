import { describe, expect, it } from "vitest";

import {
  ADD_ONS_POLICY_NOTICE,
  ADD_ONS_PUBLISH_BLOCKER,
  PRODUCT_OPTION_MAX,
  ProductOptionInputSchema,
  ProductOptionPatchSchema,
  needsRedeclaration,
  summarizeAddOns,
} from "../schemas/product-option";

const mandatory = { name: "주말 할증", price: 300_000, isMandatory: true };
const conditional = {
  name: "하객 초과 식대",
  price: 45_000,
  isMandatory: false,
  conditionDescription: "하객 250명 초과 시 1인당",
};

describe("ProductOptionInputSchema (F-V-04)", () => {
  it("필수 추가금은 조건 없이 통과한다 — 항상 발생하기 때문이다", () => {
    const parsed = ProductOptionInputSchema.parse(mandatory);

    expect(parsed.isMandatory).toBe(true);
    expect(parsed.conditionDescription).toBeNull();
  });

  it("조건부 추가금은 발생 조건이 필수다", () => {
    expect(() => ProductOptionInputSchema.parse({ ...conditional, conditionDescription: null })).toThrow();
    expect(() => ProductOptionInputSchema.parse({ ...conditional, conditionDescription: "" })).toThrow();
    expect(() => ProductOptionInputSchema.parse(conditional)).not.toThrow();
  });

  it("이름이 비면 거부한다 — 무엇에 대한 돈인지 알 수 없다", () => {
    expect(() => ProductOptionInputSchema.parse({ ...mandatory, name: "" })).toThrow();
    expect(() => ProductOptionInputSchema.parse({ ...mandatory, name: "   " })).toThrow();
  });

  it("0원 항목은 허용한다 — '무료지만 항목으로 존재한다'가 사실인 경우가 있다", () => {
    expect(() => ProductOptionInputSchema.parse({ ...mandatory, price: 0 })).not.toThrow();
  });

  it("음수·소수·문자열 금액을 거부한다", () => {
    expect(() => ProductOptionInputSchema.parse({ ...mandatory, price: -1 })).toThrow();
    expect(() => ProductOptionInputSchema.parse({ ...mandatory, price: 1.5 })).toThrow();
    expect(() => ProductOptionInputSchema.parse({ ...mandatory, price: "10000" })).toThrow();
  });

  it("금액 누락을 거부한다", () => {
    expect(() => ProductOptionInputSchema.parse({ name: "원판", isMandatory: true })).toThrow();
  });

  it("이름·조건에 가격 회피 문구를 쓸 수 없다", () => {
    expect(() => ProductOptionInputSchema.parse({ ...mandatory, name: "원판 별도 문의" })).toThrow();
    expect(() =>
      ProductOptionInputSchema.parse({ ...conditional, conditionDescription: "가격 협의 후 청구" }),
    ).toThrow();
  });
});

describe("ProductOptionPatchSchema", () => {
  it("빈 수정을 거부한다", () => {
    expect(() => ProductOptionPatchSchema.parse({})).toThrow();
  });

  it("한 필드만 보내도 통과한다", () => {
    expect(() => ProductOptionPatchSchema.parse({ price: 100 })).not.toThrow();
  });
});

describe("summarizeAddOns — '없음'과 '미등록'은 다르다", () => {
  it("확정 전에는 미등록이다", () => {
    expect(summarizeAddOns(null, [])).toEqual({ kind: "unknown" });
    expect(summarizeAddOns(null, [{ price: 1000 }])).toEqual({ kind: "unknown" });
  });

  it("0건으로 확정하면 '없음'이라는 진술이 된다", () => {
    expect(summarizeAddOns("2026-08-09T00:00:00Z", [])).toEqual({ kind: "none" });
  });

  it("확정된 항목은 건수와 상한 합계를 함께 돌려준다", () => {
    expect(
      summarizeAddOns("2026-08-09T00:00:00Z", [{ price: 300_000 }, { price: 45_000 }]),
    ).toEqual({ kind: "listed", count: 2, total: 345_000 });
  });

  it("미등록과 없음은 절대 같은 값이 아니다", () => {
    expect(summarizeAddOns(null, [])).not.toEqual(summarizeAddOns("2026-08-09T00:00:00Z", []));
  });
});

describe("needsRedeclaration — 확정 후 변경되면 다시 확정한다", () => {
  const declared = "2026-08-09T00:00:00Z";

  it("확정 이후 수정된 항목이 있으면 재확정이 필요하다", () => {
    expect(needsRedeclaration(declared, [{ updatedAt: "2026-08-09T00:00:01Z" }])).toBe(true);
  });

  it("확정 이전 항목만 있으면 필요 없다", () => {
    expect(needsRedeclaration(declared, [{ updatedAt: "2026-08-08T23:59:59Z" }])).toBe(false);
  });

  it("확정 시각과 같은 순간은 재확정 대상이 아니다 (경계)", () => {
    expect(needsRedeclaration(declared, [{ updatedAt: declared }])).toBe(false);
  });

  it("아직 확정하지 않았으면 재확정 개념이 없다", () => {
    expect(needsRedeclaration(null, [{ updatedAt: "2026-08-09T00:00:01Z" }])).toBe(false);
  });
});

describe("정책 문구", () => {
  it("사전 미등록 항목을 사후 청구할 수 없음을 밝힌다 (F-V-04)", () => {
    expect(ADD_ONS_POLICY_NOTICE).toContain("등록하지 않은 항목");
    expect(ADD_ONS_POLICY_NOTICE).toContain("청구할 수 없습니다");
  });

  it("게시 차단 사유가 '없음 확정'이라는 선택지를 알려준다", () => {
    expect(ADD_ONS_PUBLISH_BLOCKER.message).toContain("추가금 없음");
  });

  it("항목 상한이 정해져 있다", () => {
    expect(PRODUCT_OPTION_MAX).toBe(40);
  });
});
