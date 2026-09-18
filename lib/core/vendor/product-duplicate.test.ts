import { describe, expect, it } from "vitest";

import {
  COPY_SUFFIX,
  PRODUCT_NAME_MAX,
  copyNameOf,
  copyRemainingSteps,
  draftCopyOf,
  type DuplicateSource,
} from "./product-duplicate";

const source = (overrides: Partial<DuplicateSource> = {}): DuplicateSource => ({
  name: "주말 점심 패키지",
  category: "hall",
  basePriceTotal: 10_800_000,
  includedItems: [{ label: "홀 대관 4시간", note: null }],
  capacityMin: 100,
  capacityMax: 250,
  priceIncludesVat: true,
  ...overrides,
});

describe("사본 이름", () => {
  it("꼬리를 붙인다", () => {
    expect(copyNameOf("주말 점심 패키지")).toBe(`주말 점심 패키지${COPY_SUFFIX}`);
  });

  it("앞뒤 공백을 지운다", () => {
    expect(copyNameOf("  주말 패키지  ")).toBe(`주말 패키지${COPY_SUFFIX}`);
  });

  // ── 경계값 ────────────────────────────────────────────────────────────────
  it("상한에 닿으면 **꼬리를 지키고 이름을 줄인다**", () => {
    const long = "가".repeat(PRODUCT_NAME_MAX);
    const copied = copyNameOf(long);

    expect(copied.length).toBe(PRODUCT_NAME_MAX);
    expect(copied.endsWith(COPY_SUFFIX)).toBe(true);
  });

  it("상한 바로 아래는 자르지 않는다", () => {
    const fits = "가".repeat(PRODUCT_NAME_MAX - COPY_SUFFIX.length);
    const copied = copyNameOf(fits);

    expect(copied).toBe(`${fits}${COPY_SUFFIX}`);
    expect(copied.length).toBe(PRODUCT_NAME_MAX);
  });

  it("상한을 한 글자 넘기면 한 글자를 줄인다", () => {
    const over = "가".repeat(PRODUCT_NAME_MAX - COPY_SUFFIX.length + 1);

    expect(copyNameOf(over).length).toBe(PRODUCT_NAME_MAX);
  });

  it("사본의 사본도 상한을 넘지 않는다", () => {
    let name = "가".repeat(PRODUCT_NAME_MAX);
    for (let i = 0; i < 5; i += 1) name = copyNameOf(name);

    expect(name.length).toBeLessThanOrEqual(PRODUCT_NAME_MAX);
    expect(name.endsWith(COPY_SUFFIX)).toBe(true);
  });
});

describe("초안 사본", () => {
  it("값은 그대로 옮긴다", () => {
    const copy = draftCopyOf(source());

    expect(copy.category).toBe("hall");
    expect(copy.basePriceTotal).toBe(10_800_000);
    expect(copy.capacityMin).toBe(100);
    expect(copy.capacityMax).toBe(250);
    expect(copy.priceIncludesVat).toBe(true);
    expect(copy.includedItems).toEqual([{ label: "홀 대관 4시간", note: null }]);
  });

  it("**언제나 작성 중이다** — 게시 중인 상품을 복제해도 사본은 안 보인다", () => {
    expect(draftCopyOf(source()).status).toBe("draft");
  });

  it("**추가금 확정은 따라오지 않는다**(D-06)", () => {
    expect(draftCopyOf(source()).addOnsDeclaredAt).toBeNull();
  });

  it("사본은 게시된 적이 없다", () => {
    expect(draftCopyOf(source()).publishedAt).toBeNull();
  });

  it("포함 항목 배열을 **원본과 공유하지 않는다**", () => {
    const original = source();
    const copy = draftCopyOf(original);

    copy.includedItems.push({ label: "추가", note: null });

    expect(original.includedItems).toHaveLength(1);
  });

  it("포함 항목이 없어도 복제된다 — 사본이 게시를 막는 것은 DB 와 체크리스트의 일이다", () => {
    expect(draftCopyOf(source({ includedItems: [] })).includedItems).toEqual([]);
  });
});

describe("사본에 남은 일", () => {
  it("**빈 목록을 돌려주지 않는다** — 아무 말도 없으면 이미 노출되는 줄 안다", () => {
    expect(copyRemainingSteps({ copiedOptionCount: 2 }).length).toBeGreaterThan(0);
    expect(copyRemainingSteps({ copiedOptionCount: 0 }).length).toBeGreaterThan(0);
  });

  it("옮긴 추가금이 있으면 **몇 개인지 말한다**", () => {
    expect(copyRemainingSteps({ copiedOptionCount: 3 })[0]).toContain("3개");
  });

  it("옮긴 추가금이 없으면 **'추가금 없음' 으로 확정하는 길**을 알려준다", () => {
    expect(copyRemainingSteps({ copiedOptionCount: 0 })[0]).toContain("추가금 없음");
  });

  it("두 경우 모두 **아직 작성 중이라는 사실**을 적는다", () => {
    for (const count of [0, 1, 9]) {
      expect(copyRemainingSteps({ copiedOptionCount: count }).join(" ")).toContain("작성 중");
    }
  });
});
