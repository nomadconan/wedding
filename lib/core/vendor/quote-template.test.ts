import { describe, expect, it } from "vitest";

import {
  applyQuoteTemplate,
  defaultTemplateTitle,
  isQuoteTemplatePayload,
  quoteTemplatePayloadOf,
  type QuoteFormState,
  type QuotableShape,
} from "./quote-template";

const form = (overrides: Partial<QuoteFormState> = {}): QuoteFormState => ({
  productId: "p1",
  baseAmount: "9000000",
  optionIds: ["o1"],
  optionAmounts: { o1: "300000" },
  memo: "주말 기준입니다",
  ...overrides,
});

const products: QuotableShape[] = [
  { id: "p1", options: [{ id: "o1" }, { id: "o2" }] },
  { id: "p2", options: [] },
];

describe("폼 → 저장본", () => {
  it("본체와 옵션을 줄로 편다", () => {
    const payload = quoteTemplatePayloadOf(form());

    expect(payload.productId).toBe("p1");
    expect(payload.lines).toEqual([
      { itemType: "base", productOptionId: null, amount: 9_000_000 },
      { itemType: "option", productOptionId: "o1", amount: 300_000 },
    ]);
    expect(payload.vendorMemo).toBe("주말 기준입니다");
  });

  it("빈 금액은 null 이다 — **'상한 그대로' 라는 뜻이고 0 이 아니다**", () => {
    const payload = quoteTemplatePayloadOf(form({ baseAmount: "  " }));

    expect(payload.lines[0].amount).toBeNull();
  });

  it("0 은 0 으로 남는다 — 공짜와 미입력은 다르다", () => {
    expect(quoteTemplatePayloadOf(form({ baseAmount: "0" })).lines[0].amount).toBe(0);
  });

  it("**숫자가 아니면 null 이다** — 0 으로 접으면 공짜 견적이 저장된다", () => {
    for (const bad of ["abc", "1.5", "-1", "", "NaN", "1,000"]) {
      expect(quoteTemplatePayloadOf(form({ baseAmount: bad })).lines[0].amount).toBeNull();
    }
  });

  it("지수 표기는 **숫자로 받는다** — `1e5` 는 100000 이고 뜻이 갈리지 않는다", () => {
    // `<input type="number">` 가 실제로 내보낼 수 있는 값이다. 막을 이유가 없다 —
    // 막으면 업체가 친 100000 이 조용히 '상한 그대로' 가 된다.
    expect(quoteTemplatePayloadOf(form({ baseAmount: "1e5" })).lines[0].amount).toBe(100_000);
  });

  it("빈 메모는 null 이다", () => {
    expect(quoteTemplatePayloadOf(form({ memo: "   " })).vendorMemo).toBeNull();
  });

  it("**유효기간을 담지 않는다** — 다음 달에 꺼내면 지난 견적이 된다", () => {
    expect(Object.keys(quoteTemplatePayloadOf(form()))).toEqual([
      "productId",
      "lines",
      "vendorMemo",
    ]);
  });
});

describe("저장본 → 폼", () => {
  const payload = quoteTemplatePayloadOf(form());

  it("그대로 복원되면 **빠진 것이 없다**", () => {
    const result = applyQuoteTemplate(payload, products, form({ productId: "", optionIds: [] }));

    expect(result.dropped).toEqual([]);
    expect(result.form.productId).toBe("p1");
    expect(result.form.baseAmount).toBe("9000000");
    expect(result.form.optionIds).toEqual(["o1"]);
    expect(result.form.optionAmounts).toEqual({ o1: "300000" });
    expect(result.form.memo).toBe("주말 기준입니다");
  });

  // ── FK 가 없어서 생기는 경계 (0026 이 일부러 안 걸었다) ────────────────────
  it("**상품이 사라졌으면 폼을 건드리지 않는다** — 엉뚱한 상품에 금액을 붓지 않는다", () => {
    const current = form({ productId: "p2", baseAmount: "111" });
    const result = applyQuoteTemplate(payload, [{ id: "p2", options: [] }], current);

    expect(result.form).toBe(current);
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0]).toContain("상품");
  });

  it("**추가금이 사라졌으면 빼고 몇 개가 빠졌는지 말한다**", () => {
    const result = applyQuoteTemplate(payload, [{ id: "p1", options: [] }], form());

    expect(result.form.optionIds).toEqual([]);
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0]).toContain("1개");
  });

  it("남은 추가금만 담고 사라진 것만 센다", () => {
    const two = quoteTemplatePayloadOf(
      form({ optionIds: ["o1", "o2"], optionAmounts: { o1: "1", o2: "2" } }),
    );
    const result = applyQuoteTemplate(two, [{ id: "p1", options: [{ id: "o2" }] }], form());

    expect(result.form.optionIds).toEqual(["o2"]);
    expect(result.dropped[0]).toContain("1개");
  });

  it("금액이 null 인 줄은 빈 칸으로 돌아온다", () => {
    const blank = quoteTemplatePayloadOf(form({ baseAmount: "", optionAmounts: { o1: "" } }));
    const result = applyQuoteTemplate(blank, products, form());

    expect(result.form.baseAmount).toBe("");
    expect(result.form.optionAmounts).toEqual({});
  });
});

describe("낡은 저장본 방어", () => {
  it("우리가 아는 모양이면 통과한다", () => {
    expect(isQuoteTemplatePayload(quoteTemplatePayloadOf(form()))).toBe(true);
  });

  it("**모르는 모양은 막는다** — DB 는 객체인지까지만 본다(0026)", () => {
    for (const bad of [
      null,
      {},
      { productId: "" , lines: [{ itemType: "base" }] },
      { productId: "p1", lines: [] },
      { productId: "p1", lines: "nope" },
      { productId: "p1", lines: [{ itemType: "weird" }] },
      { lines: [{ itemType: "base" }] },
    ]) {
      expect(isQuoteTemplatePayload(bad)).toBe(false);
    }
  });
});

describe("저장 이름 기본값", () => {
  it("추가금이 없으면 상품명만", () => {
    expect(defaultTemplateTitle("주말 점심 패키지", 0)).toBe("주말 점심 패키지");
  });

  it("추가금 수를 붙인다", () => {
    expect(defaultTemplateTitle("주말 점심 패키지", 2)).toBe("주말 점심 패키지 +추가금 2");
  });

  it("**60자를 넘지 않는다** — `vendor_templates.title` 상한이다", () => {
    expect(defaultTemplateTitle("가".repeat(200), 3).length).toBe(60);
  });
});
