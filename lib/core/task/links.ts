// 준비 항목 → 정보·상품으로 가는 다리 (C-4c · 명세서 §2.1 F-C-39 · §3.2)
//
// 프레임워크를 모르는 순수 모듈이다(CLAUDE.md §3.1).
//
// ── 무엇이 문제였나 ─────────────────────────────────────────────────────────
// 체크리스트가 **"무엇을 할지" 는 말하는데 "어디서 할지" 를 안 알려 준다**
// (B-1 조사 4-3·4-4 · 태스크 카드에서 나가는 링크가 **0개**였다). "청첩장 주문할 때가
// 됐어요" 를 읽고 나서 어디로 가야 하는지는 사용자가 스스로 찾아야 했다.
//
// C-4d·C-4e 가 **알림**에서 나가는 길을 이었다. 여기는 **체크리스트 카드**에서
// 나가는 길이다 — 알림을 안 읽어도, 알림이 꺼져 있어도 닿아야 한다.
//
// ── 추천이 아니라 대응이다 (D-03) ───────────────────────────────────────────
// 이 다리는 **"이 준비에는 이 카테고리가 대응한다"** 이지 **"이 업체를 추천한다"** 가
// 아니다. 업체·상품을 고르는 자리를 만들지 않는다 — 고르는 순간 그 기준이 곧 노출
// 우대가 되고, 그것이 D-03 이 떼어 낸 것이다. 도착지는 **카테고리 목록**이며
// 그 화면이 자기 정렬 기준을 배지로 말한다(§2.2).
//
// **건수는 센다. 순서는 매기지 않는다.** 몇 개가 있는지는 사실이고, 어느 것이
// 위인지는 판단이다.
//
// ── 계산한다, 저장하지 않는다 ───────────────────────────────────────────────
// `tasks` 에 `product_id`·`content_slug` 같은 연결 칸을 **더하지 않았다.** 링크는
// `tasks.category`(+ 행마다 좁히는 `vendor_category`)에서 **전부 유도된다** — 저장하면
// 상품이 내려가거나 글이 비공개가 돼도 낡은 연결이 남고, 그것은 **누른 사람만 아는
// 고장**이다(§공통 — 계산 가능한 값을 저장하지 않는다 · D-124).
//
// **`tasks.vendor_category` 는 예외가 아니다.** C-2a 가 이미 적었듯 그 칸은 매핑에서
// **유도할 수 없는** '이 태스크만의 더 좁은 지정' 이고(준비 축 `sdm` 한 칸이 파는 축
// 넷을 덮으므로 행마다 좁힐 자리가 필요하다), 없으면 매핑으로 떨어진다.

import { VENDOR_CATEGORY_LABEL, type VendorCategory } from "../schemas/vendor";
import { isVendorCategory, vendorCategoriesForPrep } from "../category/axes";

/** 갈 곳이 없을 때. **빈 목록이 아니라 이유다**(C-2a·C-4b 와 같은 결). */
export type BridgeGap = { readonly kind: "none"; readonly title: string; readonly note: string };

/**
 * 파는 축 한 칸. **건수를 함께 갖는다.**
 *
 * `productCount` 가 0 이면 *"카테고리는 있는데 아직 등록된 상품이 없다"* 이고,
 * 이것은 *"파는 카테고리 자체가 없다"*(`not_yet_listed`)와 **다른 상태**다.
 * 둘을 뭉치면 고객이 **기다리면 되는지 딴 데를 알아봐야 하는지** 모른다.
 */
export type ExploreCategoryLink = {
  readonly code: VendorCategory;
  readonly label: string;
  readonly href: string;
  readonly productCount: number;
};

export type ExploreBridge =
  | { readonly kind: "categories"; readonly categories: readonly ExploreCategoryLink[] }
  | BridgeGap;

export type GuideLink = {
  readonly slug: string;
  readonly title: string;
  readonly href: string;
};

export type GuideBridge =
  | { readonly kind: "guides"; readonly guides: readonly GuideLink[] }
  | BridgeGap;

/**
 * 커뮤니티 다리.
 *
 * **경고를 링크와 떼어 놓지 않는다**(D-26). 커뮤니티 글은 **미검증 경험담**이고,
 * 체크리스트에서 곧장 들어가면 그 사실을 못 보고 읽을 수 있다 — 라벨은 목적지
 * 화면에도 있지만 **다리에도 붙여** 누르기 전에 읽게 한다.
 *
 * 글이 없어도 `href` 는 남는다 — 물어볼 자리가 사라지는 것은 아니다.
 */
export type CommunityBridge = {
  readonly href: string;
  readonly label: string;
  readonly caution: string;
  /** 0 이면 화면이 "아직 올라온 글이 없어요" 라고 적는다. 0 을 건수로 적지 않는다. */
  readonly postCount: number;
};

export type TaskLinks = {
  readonly category: string;
  readonly explore: ExploreBridge;
  readonly guides: GuideBridge;
  readonly community: CommunityBridge;
};

/** 커뮤니티 다리가 붙이는 주의 문구. 화면이 다시 쓰지 않는다. */
export const COMMUNITY_BRIDGE_CAUTION =
  "커뮤니티 글은 다른 예비부부의 경험담이고 저희가 확인한 내용이 아니에요.";

/** 다리가 무엇을 근거로 목적지를 정했는지. **화면이 상시 노출한다**(§2.2 정렬 기준). */
export const TASK_LINK_BASIS_NOTE =
  "준비 항목의 카테고리에 대응하는 목록으로 갑니다. 특정 업체를 추천하지 않아요.";

// =============================================================================
// 탐색 — 어느 카테고리로 가는가
// =============================================================================

/**
 * 이 태스크가 가리키는 파는 축 카테고리들.
 *
 * `vendorCategory` 가 있으면 **그 한 칸**이다(행마다 좁히는 지정 · C-2a).
 * 없으면 준비 축 매핑이 답한다. 매핑이 `not_sold`·`unmapped` 면 갈 곳이 없고,
 * **셋을 서로 다른 문장으로** 말한다.
 */
export function vendorCategoriesForTask(input: {
  category: string | null | undefined;
  vendorCategory?: string | null;
}): readonly VendorCategory[] | BridgeGap {
  if (isVendorCategory(input.vendorCategory)) return [input.vendorCategory];

  const resolved = vendorCategoriesForPrep(input.category);

  if (resolved.kind === "sold") return resolved.vendorCategories;

  if (resolved.kind === "not_sold") {
    return {
      kind: "none",
      title:
        resolved.why === "not_a_purchase"
          ? "여기서 살 수 있는 것은 없어요"
          : "아직 이 카테고리의 업체가 없어요",
      note: resolved.note,
    };
  }

  // unmapped — **우리 결함이다.** 사용자에게 자기 사정처럼 말하지 않는다.
  return { kind: "none", title: "분류를 아직 정하지 못했어요", note: resolved.note };
}

/** 파는 축 한 칸의 탐색 주소. 레지스트리 밖에서 문자열을 조립하지 않도록 여기 둔다. */
export function exploreHref(category: VendorCategory): string {
  return `/explore?category=${category}`;
}

/** 준비 축 한 칸의 커뮤니티 주소. */
export function communityHref(category: string): string {
  return `/community?prep=${encodeURIComponent(category)}`;
}

/** 가이드 한 편의 주소. */
export function guideHref(slug: string): string {
  return `/guides/${slug}`;
}

/**
 * 센 건수를 붙여 탐색 다리를 만든다.
 *
 * `counts` 는 **실제로 센 값**이다. 안 센 카테고리를 0 으로 적지 않으려고 `Map` 을
 * 받고, 빠진 키는 **던진다** — 0 으로 접으면 "상품이 없다" 와 "안 셌다" 가 같아진다
 * (§공통 — 측정하지 않은 것을 0 으로 표시하지 않는다).
 */
export function exploreBridge(
  categories: readonly VendorCategory[] | BridgeGap,
  counts: ReadonlyMap<string, number>,
): ExploreBridge {
  if ("kind" in categories) return categories;

  const list = categories;
  const missing = list.filter((code) => !counts.has(code));

  if (missing.length > 0) {
    throw new Error(`상품 수를 세지 않은 카테고리: ${missing.join(", ")}`);
  }

  return {
    kind: "categories",
    categories: list.map((code) => ({
      code,
      label: VENDOR_CATEGORY_LABEL[code],
      href: exploreHref(code),
      productCount: counts.get(code) as number,
    })),
  };
}

/** 가이드 다리. 발행된 글만 넘어온다(공개 판정은 부르는 쪽 질의가 한다). */
export function guideBridge(
  rows: readonly { slug: string; title: string }[],
): GuideBridge {
  if (rows.length === 0) {
    return {
      kind: "none",
      title: "이 준비에 맞는 가이드가 아직 없어요",
      // **0 건이라고 적지 않는다.** 없는 것을 세어 보여 주면 "찾아봤는데 없다" 가
      // 아니라 "우리가 안 썼다" 라는 사실이 가려진다(S7-10 과 같은 결).
      note: "지금은 이 항목을 다루는 글을 준비하지 못했어요. 다른 카테고리의 가이드는 가이드 목록에서 볼 수 있어요.",
    };
  }

  return {
    kind: "guides",
    guides: rows.map((row) => ({ slug: row.slug, title: row.title, href: guideHref(row.slug) })),
  };
}

/** 커뮤니티 다리. 글이 없어도 자리는 남는다 — 물어볼 곳이 사라지는 것은 아니다. */
export function communityBridge(category: string, postCount: number): CommunityBridge {
  return {
    href: communityHref(category),
    label: "같은 준비를 한 사람들의 글 보기",
    caution: COMMUNITY_BRIDGE_CAUTION,
    postCount,
  };
}

/** 세 다리를 한 묶음으로. */
export function taskLinks(input: {
  category: string;
  vendorCategories: readonly VendorCategory[] | BridgeGap;
  productCounts: ReadonlyMap<string, number>;
  guides: readonly { slug: string; title: string }[];
  communityPostCount: number;
}): TaskLinks {
  return {
    category: input.category,
    explore: exploreBridge(input.vendorCategories, input.productCounts),
    guides: guideBridge(input.guides),
    community: communityBridge(input.category, input.communityPostCount),
  };
}
