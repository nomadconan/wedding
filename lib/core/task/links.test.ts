import { existsSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { PREP_TO_VENDOR, TASK_CATEGORIES } from "../category/axes";
import { VENDOR_CATEGORIES } from "../schemas/vendor";
import {
  COMMUNITY_BRIDGE_CAUTION,
  TASK_LINK_BASIS_NOTE,
  communityBridge,
  communityHref,
  exploreBridge,
  exploreHref,
  guideBridge,
  guideHref,
  taskLinks,
  vendorCategoriesForTask,
} from "./links";

const ROOT = path.resolve(__dirname, "../../..");

/** 파는 축 전부를 센 것으로 치는 맵. 세지 않은 카테고리를 0 으로 접지 않기 위함이다. */
const counted = (value = 0) => new Map(VENDOR_CATEGORIES.map((code) => [code as string, value]));

describe("어느 카테고리로 가는가", () => {
  it("파는 것이 있으면 그 카테고리들을 준다", () => {
    expect(vendorCategoriesForTask({ category: "hall" })).toEqual(["hall"]);
    expect(vendorCategoriesForTask({ category: "sdm" })).toEqual([
      "studio",
      "dress",
      "makeup",
      "video",
    ]);
  });

  it("**행마다 좁힌 지정이 매핑을 이긴다** — sdm 한 칸이 넷을 덮기 때문이다", () => {
    expect(vendorCategoriesForTask({ category: "sdm", vendorCategory: "dress" })).toEqual([
      "dress",
    ]);
  });

  it("좁힌 값이 파는 축에 없으면 무시하고 매핑으로 떨어진다", () => {
    // 어휘 밖 값이 들어와도 **없는 카테고리로 보내지 않는다.**
    expect(vendorCategoriesForTask({ category: "hall", vendorCategory: "정원" })).toEqual(["hall"]);
  });

  it("**살 것이 아닌 것과 아직 안 연 것을 다른 문장으로 말한다**", () => {
    const notPurchase = vendorCategoriesForTask({ category: "document" });
    const notListed = vendorCategoriesForTask({ category: "gift" });

    expect("kind" in notPurchase && notPurchase.title).toBe("여기서 살 수 있는 것은 없어요");
    expect("kind" in notListed && notListed.title).toBe("아직 이 카테고리의 업체가 없어요");
    expect(
      "kind" in notPurchase && "kind" in notListed && notPurchase.title === notListed.title,
    ).toBe(false);
  });

  it("모르는 카테고리는 **우리 결함**으로 말한다 — 사용자 사정처럼 적지 않는다", () => {
    const gap = vendorCategoriesForTask({ category: "없는카테고리" });

    expect("kind" in gap && gap.title).toBe("분류를 아직 정하지 못했어요");
  });

  it("준비 축 아홉 전부가 답을 받는다 — 빈 목록으로 떨어지는 칸이 없다", () => {
    expect(TASK_CATEGORIES.length).toBeGreaterThanOrEqual(9);

    for (const category of TASK_CATEGORIES) {
      const answer = vendorCategoriesForTask({ category });

      if ("kind" in answer) {
        expect(answer.title.trim().length, `${category} 의 제목이 비었다`).toBeGreaterThan(0);
        expect(answer.note.trim().length, `${category} 의 이유가 비었다`).toBeGreaterThan(0);
      } else {
        expect(answer.length, `${category} 가 빈 배열을 줬다`).toBeGreaterThan(0);
      }
    }
  });
});

describe("건수를 세되 순서를 매기지 않는다", () => {
  it("센 값을 그대로 싣는다", () => {
    const bridge = exploreBridge(["hall"], new Map([["hall", 5]]));

    expect(bridge.kind).toBe("categories");
    if (bridge.kind !== "categories") return;
    expect(bridge.categories[0]).toMatchObject({
      code: "hall",
      href: "/explore?category=hall",
      productCount: 5,
    });
  });

  it("**안 센 카테고리를 0 으로 접지 않는다** — 던진다", () => {
    expect(() => exploreBridge(["hall", "dress"], new Map([["hall", 1]]))).toThrow(/dress/);
  });

  it("0 건도 그대로 싣는다 — 화면이 '없다' 와 '0개' 를 가른다", () => {
    const bridge = exploreBridge(["dress"], counted(0));

    expect(bridge.kind === "categories" && bridge.categories[0].productCount).toBe(0);
  });

  it("갈 곳이 없으면 세지 않고 그대로 통과시킨다", () => {
    const gap = { kind: "none", title: "t", note: "n" } as const;

    expect(exploreBridge(gap, new Map())).toEqual(gap);
  });

  it("**순서를 매기는 값이 다리에 없다** — 조회수·좋아요·평점이 안 실린다", () => {
    const bridge = exploreBridge(["hall"], new Map([["hall", 2]]));
    const json = JSON.stringify(bridge);

    for (const banned of ["viewCount", "likeCount", "rating", "score", "rank"]) {
      expect(json, `${banned} 가 다리에 실렸다`).not.toContain(banned);
    }
  });
});

describe("가이드 다리", () => {
  it("글이 있으면 주소를 만든다", () => {
    const bridge = guideBridge([{ slug: "hall-contract-checklist", title: "웨딩홀" }]);

    expect(bridge.kind === "guides" && bridge.guides[0].href).toBe(
      "/guides/hall-contract-checklist",
    );
  });

  it("**없으면 0 건이 아니라 이유다**", () => {
    const bridge = guideBridge([]);

    expect(bridge.kind).toBe("none");
    if (bridge.kind !== "none") return;
    expect(bridge.title).toContain("아직 없어요");
    expect(bridge.note).not.toContain("0");
  });
});

describe("커뮤니티 다리 — 미검증 라벨을 건너뛰지 않는다", () => {
  it("주의 문구가 항상 붙는다", () => {
    expect(communityBridge("hall", 3).caution).toBe(COMMUNITY_BRIDGE_CAUTION);
    expect(communityBridge("hall", 0).caution).toBe(COMMUNITY_BRIDGE_CAUTION);
  });

  it("**경고가 실제로 경고다** — 확인하지 않았다는 말이 들어 있다", () => {
    expect(COMMUNITY_BRIDGE_CAUTION).toMatch(/확인한 내용이 아니/);
    expect(COMMUNITY_BRIDGE_CAUTION.length).toBeGreaterThan(20);
  });

  it("글이 없어도 갈 자리는 남는다 — 물어볼 곳이 사라지는 것은 아니다", () => {
    expect(communityBridge("gift", 0).href).toBe("/community?prep=gift");
  });
});

describe("추천이 아니라 대응이다 (D-03)", () => {
  it("판정 기준이 문장으로 있고 '추천하지 않는다' 를 말한다", () => {
    expect(TASK_LINK_BASIS_NOTE).toMatch(/추천하지 않/);
  });

  it("**특정 업체·상품으로 가는 주소를 만들지 않는다**", () => {
    const links = taskLinks({
      category: "hall",
      vendorCategories: ["hall"],
      productCounts: new Map([["hall", 5]]),
      guides: [{ slug: "g", title: "t" }],
      communityPostCount: 1,
    });
    const hrefs = JSON.stringify(links).match(/"href":"([^"]+)"/g) ?? [];

    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) {
      // /explore/<vendorId>/<productId> 같은 개별 주소가 있으면 그것이 곧 추천이다.
      expect(href, `개별 업체·상품 주소가 섞였다: ${href}`).not.toMatch(
        /\/explore\/[^?"]+\//,
      );
    }
  });
});

describe("가는 곳이 실재한다", () => {
  it("탐색·커뮤니티·가이드 화면이 디스크에 있다", () => {
    const SCREENS = [
      "app/(consumer)/explore/page.tsx",
      "app/(consumer)/community/page.tsx",
      "app/(marketing)/guides/[slug]/page.tsx",
    ];

    for (const screen of SCREENS) {
      const found = existsSync(path.join(ROOT, screen));

      expect(found, `${screen} 가 없다`).toBe(true);
    }
  });

  it("주소 조립기가 실제 파라미터 이름을 쓴다", () => {
    expect(exploreHref("hall")).toBe("/explore?category=hall");
    expect(communityHref("sdm")).toBe("/community?prep=sdm");
    expect(guideHref("a-b")).toBe("/guides/a-b");
  });

  it("파는 축 전부가 탐색 주소를 만든다 — 매핑에만 있고 화면에 없는 값이 없다", () => {
    expect(VENDOR_CATEGORIES.length).toBeGreaterThanOrEqual(6);

    for (const code of VENDOR_CATEGORIES) {
      expect(exploreHref(code)).toBe(`/explore?category=${code}`);
    }
  });
});

describe("세 다리를 묶는다", () => {
  it("한 준비 항목이 세 답을 다 받는다", () => {
    const links = taskLinks({
      category: "document",
      vendorCategories: vendorCategoriesForTask({ category: "document" }),
      productCounts: new Map(),
      guides: [],
      communityPostCount: 0,
    });

    expect(links.explore.kind).toBe("none");
    expect(links.guides.kind).toBe("none");
    expect(links.community.href).toBe("/community?prep=document");
  });

  it("**살 것이 아닌 항목에서도 읽을 것·물어볼 곳은 남는다**", () => {
    const links = taskLinks({
      category: "family",
      vendorCategories: vendorCategoriesForTask({ category: "family" }),
      productCounts: new Map(),
      guides: [{ slug: "g", title: "상견례 이야기" }],
      communityPostCount: 2,
    });

    expect(links.explore.kind).toBe("none");
    expect(links.guides.kind).toBe("guides");
    expect(links.community.postCount).toBe(2);
  });
});

describe("두 축이 어긋나지 않는다", () => {
  it("매핑이 가리키는 파는 축 값이 전부 실재한다", () => {
    const referenced = new Set<string>();

    for (const mapping of Object.values(PREP_TO_VENDOR)) {
      if (mapping.kind === "sold") for (const code of mapping.vendorCategories) referenced.add(code);
    }

    expect(referenced.size).toBeGreaterThan(0);
    for (const code of referenced) {
      expect((VENDOR_CATEGORIES as readonly string[]).includes(code), `${code}`).toBe(true);
    }
  });
});
