// 상품 컨셉 태그 (C-2d · 명세서 §2.1 F-C-10 확장 · §3.3 · B-1 §1-2)
//
// 프레임워크를 모르는 순수 모듈이다(CLAUDE.md §3.1).
//
// ── 카테고리 축과 **다른 축**이다 ───────────────────────────────────────────
// C-2a 가 만든 것은 *파는 축*(hall·studio…)과 *준비 축*(sdm·honeymoon…)이며 둘은
// **매핑으로 이어져 있다**(D-206 · `lib/core/category/axes.ts`). 컨셉 태그는 그
// 둘 **어디에도 속하지 않는다** — '로맨틱' 은 *무엇을 파는가* 도 *무엇을 준비하는가* 도
// 아니고 **어떤 느낌인가** 다.
//
// 그래서 `axes.ts` 에 넣지 않고 이 파일에 뒀다. 섞으면 매핑 표가 "느낌 → 카테고리"
// 라는 **없는 대응**을 갖게 되고, 그 표를 읽는 사람은 그것이 있다고 믿게 된다.
//
// ── 어휘를 늘리지 않는다 ────────────────────────────────────────────────────
// `STYLE_TAGS` 8종 그대로다. 커플(`couples.style_tags`)·업체(`vendors.style_tags`)·
// 상품(`products.style_tags`)이 **같은 어휘**라야 매칭이 성립한다.

import { STYLE_TAGS, type StyleTag } from "../schemas/onboarding";

/** 컨셉 태그는 **카테고리 축이 아니다.** 이 상수가 그 사실을 코드로 적어 둔다. */
export const CONCEPT_AXIS_NOTE =
  "컨셉 태그는 파는 축·준비 축 어디에도 속하지 않는다 — 무엇을 파는가가 아니라 어떤 느낌인가다.";

/** 값 하나가 어휘 안인가. DB CHECK(0017·0078)과 같은 집합을 본다. */
export function isStyleTag(value: string): value is StyleTag {
  return (STYLE_TAGS as readonly string[]).includes(value);
}

/** 어휘 안의 것만 남긴다. 순서는 `STYLE_TAGS` 를 따르고 중복은 지운다. */
export function normalizeStyleTags(values: readonly string[]): StyleTag[] {
  const seen = new Set(values.filter(isStyleTag));

  return STYLE_TAGS.filter((tag) => seen.has(tag));
}

// =============================================================================
// 상속 — 상품이 업체를 덮는다
// =============================================================================

/**
 * 이 태그가 어디서 왔는가.
 *
 * **출처를 값으로 갖는다.** 화면이 "이 상품이 로맨틱" 인지 "이 업체가 로맨틱" 인지
 * 구분해 적어야 하기 때문이다 — 둘을 같은 배지로 그리면 업체 태그가 상품의 성격인
 * 것처럼 읽힌다.
 */
export type StyleTagSource = "product" | "vendor" | "none";

export type EffectiveStyleTags = {
  tags: StyleTag[];
  source: StyleTagSource;
};

/**
 * 상품에 실제로 적용되는 컨셉 태그.
 *
 * ── 왜 상속인가 (셋 중 고른 이유) ───────────────────────────────────────────
 *  · **상품만** 쓰면 → 지금 모든 상품의 태그가 비어 있으므로 **기존 상품이 컨셉
 *    필터에서 통째로 사라진다.** 업체 태그로 걸리던 것이 하루아침에 0건이 된다
 *    (C-2b 의 "기존 게시 상품이 내려가지 않는다" 와 같은 종류의 사고다).
 *  · **합집합**으로 하면 → 업체가 '로맨틱' 인데 상품이 '미니멀' 일 때 그 상품이
 *    **로맨틱으로도 걸린다.** 그러면 완료 조건 ①(한 업체의 두 패키지가 서로 다른
 *    컨셉으로 걸러진다)이 **성립하지 않는다.**
 *  · **상속 + 덮어쓰기** → 태그를 안 적은 상품은 지금처럼 업체 태그로 걸리고,
 *    적은 순간 그 상품만의 답이 된다. 둘 다 만족한다.
 *
 * **복사해 저장하지 않는다.** 저장하면 업체가 태그를 바꿔도 상품은 옛 값을 들고
 * 있고, 그때 어느 쪽이 맞는지 답할 수 없다(계산 가능한 값을 저장하지 않는다).
 */
export function effectiveStyleTags(input: {
  productTags?: readonly string[] | null;
  vendorTags?: readonly string[] | null;
}): EffectiveStyleTags {
  const own = normalizeStyleTags(input.productTags ?? []);
  if (own.length > 0) return { tags: own, source: "product" };

  const inherited = normalizeStyleTags(input.vendorTags ?? []);
  if (inherited.length > 0) return { tags: inherited, source: "vendor" };

  return { tags: [], source: "none" };
}

/** 화면이 출처를 말하는 문구. **"업체 컨셉" 을 상품 컨셉처럼 적지 않는다.** */
export const STYLE_TAG_SOURCE_NOTE: Record<StyleTagSource, string | null> = {
  product: null, // 상품 자신의 태그다 — 덧붙일 말이 없다.
  vendor: "업체가 적은 컨셉이에요. 이 상품만의 컨셉은 아직 없어요.",
  none: "아직 등록된 컨셉이 없어요.",
};

/** 필터에 걸리는가. 탐색 질의와 **같은 규칙**을 화면·테스트가 확인할 수 있게 둔다. */
export function matchesStyleFilter(
  effective: EffectiveStyleTags,
  filter: readonly string[],
): boolean {
  if (filter.length === 0) return true;

  return effective.tags.some((tag) => filter.includes(tag));
}

// =============================================================================
// 취향 → 탐색 기본 필터
// =============================================================================

/**
 * 온보딩 취향을 기본 필터로 쓸 것인가.
 *
 * ── 규칙 ────────────────────────────────────────────────────────────────────
 *  1. 사용자가 **직접 고른 값이 있으면** 그것이 답이다(URL 에 `styleTags` 가 있다).
 *  2. 사용자가 **끄면 끈 채로 둔다**(`taste=off`). 끄는 수단이 없으면 기본값은
 *     **치울 수 없는 필터**가 되고, 그건 걸러 주는 것이 아니라 가리는 것이다.
 *  3. 그 외에 커플 취향이 있으면 **그것을 기본값으로** 넣고 **어디서 왔는지 말한다.**
 *
 * **조용히 걸러 두지 않는다.** 화면이 "온보딩에서 고른 취향으로 미리 걸렀어요" 를
 * 적고 지우는 링크를 함께 준다 — 말 없이 걸러 두면 사용자는 **결과가 원래 그것뿐**
 * 이라고 믿는다.
 */
export type TasteDefault =
  | { kind: "applied"; tags: StyleTag[] }
  | { kind: "user-chosen" }
  | { kind: "dismissed" }
  | { kind: "none" };

export function tasteDefault(input: {
  /** URL 의 `styleTags`. 하나라도 있으면 사용자가 고른 것이다. */
  requestedTags: readonly string[];
  /** URL 의 `taste` 파라미터. `"off"` 면 끈 것이다. */
  tasteParam: string | null;
  /** 커플 온보딩에서 고른 취향. 로그인·커플이 없으면 빈 배열이다. */
  coupleTags: readonly string[];
}): TasteDefault {
  if (input.requestedTags.length > 0) return { kind: "user-chosen" };
  if (input.tasteParam === TASTE_OFF) return { kind: "dismissed" };

  const tags = normalizeStyleTags(input.coupleTags);

  return tags.length > 0 ? { kind: "applied", tags } : { kind: "none" };
}

/** `?taste=off` — 기본값을 끄는 표시. **빈 `styleTags` 와 구분하려고 따로 둔다.** */
export const TASTE_OFF = "off";

export const TASTE_DEFAULT_NOTE = "온보딩에서 고른 취향으로 미리 걸렀어요.";
export const TASTE_DEFAULT_CLEAR_LABEL = "취향 필터 지우기";

// =============================================================================
// 랭킹에 쓰지 않는다
// =============================================================================

/**
 * **컨셉 태그는 정렬·순위에 쓰지 않는다.**
 *
 * 태그가 많을수록 위로 올라가면 **태그 남발이 이득**이 된다. 그건 우리가 없애려는
 * 종류의 신호를 우리가 만드는 일이고, 광고·유료 노출을 받지 않는다는 원칙(D-03)과
 * 같은 자리에 있다 — 노출 순서는 **말할 수 있는 기준**으로만 정한다.
 *
 * 태그는 **거르는 데만** 쓴다. `db:rls` 가 정렬 코드에 태그가 등장하지 않는 것을
 * 확인하고, 이 상수가 그 검사의 근거 문장이다.
 */
export const CONCEPT_NOT_RANKING_NOTE =
  "컨셉 태그는 거르는 데만 쓰고 순위에는 쓰지 않는다 — 태그가 많다고 위로 올라가면 태그 남발이 이득이 된다.";
