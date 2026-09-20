import { describe, expect, it } from "vitest";

import {
  PREP_TO_VENDOR,
  TASK_CATEGORIES,
  VENDOR_CATEGORIES,
  VENDOR_TO_PREP,
  assertPrepAxisFullyMapped,
  isTaskCategory,
  isVendorCategory,
  prepCategoryLabel,
  prepLinkView,
  vendorCategoriesForPrep,
  vendorCategoriesWithoutPrep,
} from "./axes";

// 목록을 세는 검사는 **목록을 실제로 읽었는지 먼저** 본다(운영 규칙 7·8).
// 빈 배열이면 아래 `every`·`filter` 가 전부 조용히 통과한다.
describe("분모가 실재한다", () => {
  it("두 축 어휘가 비어 있지 않다", () => {
    // 준비 축은 C-4a 에서 여섯 → 아홉이 됐다(family·attire·gift).
    expect(TASK_CATEGORIES.length).toBe(9);
    expect(VENDOR_CATEGORIES.length).toBe(6);
  });

  it("매핑 표가 준비 축과 같은 수의 키를 갖는다", () => {
    expect(Object.keys(PREP_TO_VENDOR).length).toBe(TASK_CATEGORIES.length);
  });
});

describe("두 축은 다른 것을 센다 — 합칠 수 없다는 근거", () => {
  it("겹치는 값은 hall 하나뿐이다", () => {
    const shared = (TASK_CATEGORIES as readonly string[]).filter((c) =>
      (VENDOR_CATEGORIES as readonly string[]).includes(c),
    );
    expect(shared).toEqual(["hall"]);
  });

  it("스드메 한 칸이 파는 축 넷에 대응한다", () => {
    const sdm = PREP_TO_VENDOR.sdm;
    expect(sdm.kind).toBe("sold");
    if (sdm.kind !== "sold") return;
    expect([...sdm.vendorCategories].sort()).toEqual(["dress", "makeup", "studio", "video"]);
  });

  it("준비 축에만 있는 값이 여덟이다 — 그중 sdm 만 파는 곳이 있다", () => {
    const onlyPrep = (TASK_CATEGORIES as readonly string[]).filter(
      (c) => !(VENDOR_CATEGORIES as readonly string[]).includes(c),
    );
    // `sdm` 은 **이름이 파는 축에 없을 뿐** 대응하는 업체는 넷이나 있다.
    // 나머지 일곱은 이름도 없고 파는 것도 없다 — 둘을 같은 것으로 읽지 않는다.
    expect([...onlyPrep].sort()).toEqual([
      "attire",
      "document",
      "family",
      "gift",
      "honeymoon",
      "honsu",
      "sdm",
      "yedan",
    ]);
    expect(PREP_TO_VENDOR.sdm.kind).toBe("sold");
    for (const c of [
      "document",
      "honeymoon",
      "honsu",
      "yedan",
      "family",
      "attire",
      "gift",
    ] as const) {
      expect(PREP_TO_VENDOR[c].kind).toBe("not_sold");
    }
  });
});

describe("매핑이 준비 축 전부를 덮는다", () => {
  it("완전성 검사가 던지지 않는다", () => {
    expect(() => assertPrepAxisFullyMapped()).not.toThrow();
  });

  it("모든 준비 카테고리가 sold 또는 not_sold 로 답한다 — unmapped 가 나오지 않는다", () => {
    for (const category of TASK_CATEGORIES) {
      expect(vendorCategoriesForPrep(category).kind).not.toBe("unmapped");
    }
  });

  it("sold 는 파는 카테고리를 적어도 하나 갖는다 (빈 sold 는 not_sold 여야 한다)", () => {
    for (const category of TASK_CATEGORIES) {
      const m = PREP_TO_VENDOR[category];
      if (m.kind === "sold") expect(m.vendorCategories.length).toBeGreaterThan(0);
    }
  });

  it("sold 가 가리키는 값은 전부 파는 축에 실재한다", () => {
    for (const category of TASK_CATEGORIES) {
      const m = PREP_TO_VENDOR[category];
      if (m.kind !== "sold") continue;
      for (const v of m.vendorCategories) expect(isVendorCategory(v)).toBe(true);
    }
  });

  it("not_sold 는 이유 문구를 반드시 갖는다", () => {
    for (const category of TASK_CATEGORIES) {
      const m = PREP_TO_VENDOR[category];
      if (m.kind === "not_sold") expect(m.note.trim().length).toBeGreaterThan(0);
    }
  });
});

describe("'없다' 와 '아직 안 했다' 를 가른다 — 이 구분이 C-2a 의 요점이다", () => {
  it("서류는 '살 것이 아니다' 다 — 카테고리를 늘려도 달라지지 않는다", () => {
    const m = PREP_TO_VENDOR.document;
    expect(m.kind).toBe("not_sold");
    if (m.kind !== "not_sold") return;
    expect(m.why).toBe("not_a_purchase");
  });

  it("예단·혼수·허니문은 '아직 안 열었다' 다 — 나중에 sold 가 될 자리다", () => {
    for (const category of ["yedan", "honsu", "honeymoon"] as const) {
      const m = PREP_TO_VENDOR[category];
      expect(m.kind).toBe("not_sold");
      if (m.kind !== "not_sold") continue;
      expect(m.why).toBe("not_yet_listed");
    }
  });

  it("모르는 값은 unmapped 이며 빈 sold 로 접히지 않는다", () => {
    const r = vendorCategoriesForPrep("nope");
    expect(r.kind).toBe("unmapped");
    expect(vendorCategoriesForPrep(null).kind).toBe("unmapped");
    expect(vendorCategoriesForPrep(undefined).kind).toBe("unmapped");
    expect(vendorCategoriesForPrep("").kind).toBe("unmapped");
  });

  it("unmapped 는 사용자 사정이 아니라 우리 결함으로 말한다", () => {
    const view = prepLinkView("nope");
    expect(view.kind).toBe("none");
    if (view.kind !== "none") return;
    // "파는 것이 없다" 로 말하면 사용자가 우리 결함을 자기 사정으로 읽는다.
    expect(view.title).not.toContain("파는 것은 없어요");
    expect(view.title).toContain("분류");
  });
});

describe("화면 문구는 코드가 갖는다", () => {
  it("파는 곳이 있으면 카테고리를 그대로 넘긴다", () => {
    const view = prepLinkView("hall");
    expect(view.kind).toBe("sold");
    if (view.kind !== "sold") return;
    expect(view.vendorCategories).toEqual(["hall"]);
  });

  it("살 것이 아닌 항목은 '여기서 파는 것은 없어요' 로 말한다", () => {
    const view = prepLinkView("document");
    expect(view.kind).toBe("none");
    if (view.kind !== "none") return;
    expect(view.title).toBe("여기서 파는 것은 없어요");
    expect(view.note.trim().length).toBeGreaterThan(0);
  });

  it("아직 안 연 항목은 '업체가 없어요' 로 말한다 — 둘을 같은 문구로 뭉치지 않는다", () => {
    const soldNone = prepLinkView("document");
    const notYet = prepLinkView("honsu");
    expect(notYet.kind).toBe("none");
    if (notYet.kind !== "none" || soldNone.kind !== "none") return;
    expect(notYet.title).toBe("아직 이 카테고리의 업체가 없어요");
    expect(notYet.title).not.toBe(soldNone.title);
  });

  it("모든 준비 카테고리가 빈 문구 없이 무언가를 말한다", () => {
    for (const category of TASK_CATEGORIES) {
      const view = prepLinkView(category);
      if (view.kind === "none") {
        expect(view.title.trim().length).toBeGreaterThan(0);
        expect(view.note.trim().length).toBeGreaterThan(0);
      } else {
        expect(view.vendorCategories.length).toBeGreaterThan(0);
      }
      expect(prepCategoryLabel(category).trim().length).toBeGreaterThan(0);
    }
  });
});

describe("역방향은 정방향에서 만든다 — 두 벌로 적지 않는다", () => {
  it("역방향이 파는 축 전부를 키로 갖는다", () => {
    expect(Object.keys(VENDOR_TO_PREP).length).toBe(VENDOR_CATEGORIES.length);
  });

  it("정방향과 역방향이 같은 사실을 말한다", () => {
    for (const prep of TASK_CATEGORIES) {
      const m = PREP_TO_VENDOR[prep];
      if (m.kind !== "sold") continue;
      for (const vendor of m.vendorCategories) {
        expect(VENDOR_TO_PREP[vendor]).toContain(prep);
      }
    }
    for (const vendor of VENDOR_CATEGORIES) {
      for (const prep of VENDOR_TO_PREP[vendor]) {
        const m = PREP_TO_VENDOR[prep];
        expect(m.kind).toBe("sold");
        if (m.kind !== "sold") continue;
        expect(m.vendorCategories).toContain(vendor);
      }
    }
  });

  it("어느 준비 항목도 가리키지 않는 파는 카테고리를 센다 — 지금은 agency 하나다", () => {
    // `agency`(웨딩 에이전시)는 특정 품목이 아니라 대행이라 준비 항목 한 칸에
    // 대응하지 않는다. 예산 축에서도 같은 이유로 `etc` 로 간다
    // (`lib/core/budget/budget.ts` 의 VENDOR_TO_BUDGET_CATEGORY).
    expect([...vendorCategoriesWithoutPrep()]).toEqual(["agency"]);
  });
});

describe("판정 함수", () => {
  it("낱말 경계를 지킨다 — 접두어가 같은 값이 통과하지 않는다", () => {
    expect(isTaskCategory("hall")).toBe(true);
    expect(isTaskCategory("hallway")).toBe(false);
    expect(isVendorCategory("dress")).toBe(true);
    expect(isVendorCategory("dresses")).toBe(false);
    expect(isVendorCategory("dres")).toBe(false);
  });

  it("null·undefined·빈 문자열을 통과시키지 않는다", () => {
    for (const bad of [null, undefined, ""]) {
      expect(isTaskCategory(bad)).toBe(false);
      expect(isVendorCategory(bad)).toBe(false);
    }
  });
});
describe("C-4a 가 더한 셋 — 왜 다른 칸에 두었나", () => {
  /**
   * **넷을 기존 여섯에 우겨 넣지 않은 것이 판단이다.** 우겨 넣으면 매핑이 거짓말을
   * 한다 — 예복·한복을 `sdm` 에 넣으면 그 칸은 `sold` 라서 화면이 "여기서 살 수
   * 있어요" 라고 말하는데, 정작 한복을 파는 곳은 우리에게 없다.
   */
  it("셋 다 파는 곳이 없다 — 있다고 말하지 않는다", () => {
    for (const c of ["family", "attire", "gift"] as const) {
      expect(PREP_TO_VENDOR[c].kind).toBe("not_sold");
    }
  });

  it("**양가는 '살 것이 아니다' 이고 예복·답례는 '아직 안 열었다' 다**", () => {
    // 하나로 묶어 적으면 상견례·축의금까지 "언젠가 열리겠지" 로 읽힌다 —
    // `document` 를 나머지와 갈라 둔 것과 같은 이유다.
    const family = PREP_TO_VENDOR.family;
    const attire = PREP_TO_VENDOR.attire;
    const gift = PREP_TO_VENDOR.gift;

    expect(family.kind === "not_sold" && family.why).toBe("not_a_purchase");
    expect(attire.kind === "not_sold" && attire.why).toBe("not_yet_listed");
    expect(gift.kind === "not_sold" && gift.why).toBe("not_yet_listed");
  });

  it("**예복·한복을 `dress` 로 보내지 않는다** — 그쪽은 신부 웨딩드레스다", () => {
    const attire = PREP_TO_VENDOR.attire;
    expect(attire.kind).toBe("not_sold");
    // `sold` 였다면 화면이 드레스 업체 목록을 신랑 예복 자리에 그린다.
    expect(VENDOR_TO_PREP.dress).not.toContain("attire");
  });

  it("셋 다 화면에 적을 문구가 있다 — 빈 칸으로 두지 않는다", () => {
    for (const c of ["family", "attire", "gift"] as const) {
      const view = prepLinkView(c);
      expect(view.kind).toBe("none");
      if (view.kind !== "none") return;
      expect(view.title.trim().length).toBeGreaterThan(0);
      expect(view.note.trim().length).toBeGreaterThan(0);
    }
  });
});
