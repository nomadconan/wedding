import { describe, expect, it } from "vitest";

import { STYLE_TAGS } from "../schemas/onboarding";
import {
  CONCEPT_NOT_RANKING_NOTE,
  STYLE_TAG_SOURCE_NOTE,
  TASTE_OFF,
  effectiveStyleTags,
  isStyleTag,
  matchesStyleFilter,
  normalizeStyleTags,
  tasteDefault,
} from "./concept";

describe("어휘", () => {
  it("여덟 그대로다 — 늘리지 않았다", () => {
    expect(STYLE_TAGS).toHaveLength(8);
    expect([...STYLE_TAGS]).toEqual([
      "modern",
      "classic",
      "natural",
      "romantic",
      "minimal",
      "luxury",
      "outdoor",
      "small_wedding",
    ]);
  });

  it("어휘 밖은 걸러낸다 — 오타가 새 태그를 만들지 않는다", () => {
    expect(isStyleTag("romantic")).toBe(true);
    expect(isStyleTag("romatic")).toBe(false);
    expect(normalizeStyleTags(["romantic", "nope", "minimal"])).toEqual(["romantic", "minimal"]);
  });

  it("중복을 지우고 어휘 순서로 돌려준다 — 같은 입력이면 같은 출력이다", () => {
    expect(normalizeStyleTags(["minimal", "romantic", "minimal"])).toEqual(["romantic", "minimal"]);
    expect(normalizeStyleTags(["small_wedding", "modern"])).toEqual(["modern", "small_wedding"]);
  });
});

describe("상속 — 상품이 업체를 덮는다", () => {
  it("상품 태그가 있으면 그것이 답이다", () => {
    expect(
      effectiveStyleTags({ productTags: ["minimal"], vendorTags: ["romantic"] }),
    ).toEqual({ tags: ["minimal"], source: "product" });
  });

  it("상품 태그가 없으면 업체 태그를 상속한다 — 기존 상품이 필터에서 사라지지 않는다", () => {
    expect(effectiveStyleTags({ productTags: [], vendorTags: ["romantic"] })).toEqual({
      tags: ["romantic"],
      source: "vendor",
    });
    expect(effectiveStyleTags({ productTags: null, vendorTags: ["romantic"] }).source).toBe("vendor");
  });

  it("둘 다 없으면 없다고 말한다", () => {
    expect(effectiveStyleTags({ productTags: [], vendorTags: [] })).toEqual({
      tags: [],
      source: "none",
    });
  });

  it("**합집합이 아니다** — 업체의 로맨틱이 상품의 미니멀에 섞이지 않는다", () => {
    const view = effectiveStyleTags({ productTags: ["minimal"], vendorTags: ["romantic"] });

    expect(view.tags).not.toContain("romantic");
    // 완료 조건 ① — 한 업체의 두 패키지가 서로 다른 컨셉으로 걸러진다.
    const a = effectiveStyleTags({ productTags: ["romantic"], vendorTags: ["classic"] });
    const b = effectiveStyleTags({ productTags: ["minimal"], vendorTags: ["classic"] });
    expect(matchesStyleFilter(a, ["romantic"])).toBe(true);
    expect(matchesStyleFilter(b, ["romantic"])).toBe(false);
  });

  it("상속받은 태그는 화면이 출처를 밝힌다 — 업체 컨셉을 상품 컨셉처럼 적지 않는다", () => {
    expect(STYLE_TAG_SOURCE_NOTE.vendor).toContain("업체");
    expect(STYLE_TAG_SOURCE_NOTE.product).toBeNull();
    expect(STYLE_TAG_SOURCE_NOTE.none).toBeTruthy();
  });

  it("어휘 밖 값은 상속 계산에서도 걸러진다", () => {
    expect(effectiveStyleTags({ productTags: ["nope"], vendorTags: ["romantic"] })).toEqual({
      tags: ["romantic"],
      source: "vendor",
    });
  });
});

describe("필터 판정", () => {
  const romantic = effectiveStyleTags({ productTags: ["romantic"], vendorTags: [] });

  it("필터가 비면 전부 통과한다 — 태그 없는 상품을 숨기지 않는다", () => {
    expect(matchesStyleFilter(romantic, [])).toBe(true);
    expect(matchesStyleFilter(effectiveStyleTags({}), [])).toBe(true);
  });

  it("하나라도 겹치면 통과한다(&& 와 같은 규칙)", () => {
    expect(matchesStyleFilter(romantic, ["romantic", "minimal"])).toBe(true);
    expect(matchesStyleFilter(romantic, ["minimal"])).toBe(false);
  });

  it("태그가 없으면 어떤 필터에도 안 걸린다", () => {
    expect(matchesStyleFilter(effectiveStyleTags({}), ["romantic"])).toBe(false);
  });
});

describe("취향 기본 필터", () => {
  const base = { requestedTags: [] as string[], tasteParam: null, coupleTags: ["romantic"] };

  it("커플 취향이 있으면 기본값으로 넣고 무엇을 넣었는지 돌려준다", () => {
    expect(tasteDefault(base)).toEqual({ kind: "applied", tags: ["romantic"] });
  });

  it("사용자가 고른 값이 있으면 그것이 이긴다", () => {
    expect(tasteDefault({ ...base, requestedTags: ["minimal"] })).toEqual({ kind: "user-chosen" });
  });

  it("**끄면 꺼진 채로 둔다** — 지울 수 없는 기본값은 거르는 게 아니라 가리는 것이다", () => {
    expect(tasteDefault({ ...base, tasteParam: TASTE_OFF })).toEqual({ kind: "dismissed" });
  });

  it("끈 상태에서도 직접 고르면 그것이 이긴다", () => {
    expect(
      tasteDefault({ requestedTags: ["luxury"], tasteParam: TASTE_OFF, coupleTags: ["romantic"] }),
    ).toEqual({ kind: "user-chosen" });
  });

  it("커플 취향이 없으면 아무것도 하지 않는다 — 없는 취향을 지어내지 않는다", () => {
    expect(tasteDefault({ ...base, coupleTags: [] })).toEqual({ kind: "none" });
    expect(tasteDefault({ ...base, coupleTags: ["nope"] })).toEqual({ kind: "none" });
  });

  it("어휘 밖 취향은 걸러서 넣는다", () => {
    expect(tasteDefault({ ...base, coupleTags: ["romantic", "nope"] })).toEqual({
      kind: "applied",
      tags: ["romantic"],
    });
  });
});

describe("랭킹에 쓰지 않는다", () => {
  it("그 사실이 코드에 문장으로 있다 — `db:rls` 가 이 근거를 본다", () => {
    expect(CONCEPT_NOT_RANKING_NOTE).toContain("순위");
  });
});
