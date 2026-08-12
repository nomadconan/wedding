import { isUnknownAmount, type Amount } from "../pricing/amount";

/**
 * 여러 장바구니 · 예산 기준선 · 채움 판정 (IDEA-01 · F-C-25 · F-C-10, D-18)
 *
 * 프레임워크도 DB 도 모르는 순수 모듈이다. 화면·API·비교표가 같은 함수를 써야
 * "장바구니에서 본 판정" 과 "비교표의 판정" 이 갈리지 않는다.
 *
 * **여기 없는 것 — 상한 값.** 활성 장바구니 상한은 `app_settings.cart.max_active` 가
 * 갖고 DB 트리거가 강제한다(0027). 이 파일의 함수들은 상한을 **인자로 받는다** —
 * 기본값을 지어내면 코드가 운영 파라미터의 두 번째 진실이 된다.
 */

// =============================================================================
// 이름
// =============================================================================

/**
 * 이름 길이 상한. **DB CHECK(`carts_name_chk`)와 같은 값이어야 한다** — `db:rls` 가
 * 두 값의 정합을 본다(0023 이 알림 토픽에서 겪은 일을 되풀이하지 않기 위해서다).
 *
 * 20자인 이유는 화면이다. 375px 에서 최대 5개의 탭에 이름과 순번을 함께 얹으므로,
 * 읽히지 않는 이름은 이름 구실을 하지 못한다.
 */
export const CART_NAME_MAX_LENGTH = 20;

/**
 * 이름을 저장 가능한 모양으로 접는다.
 *
 * **'이름 없음' 의 표현은 null 하나다.** 빈 문자열과 null 이 둘 다 이름 없음이면
 * 화면·API 가 두 경우를 따로 다뤄야 하고 언젠가 한쪽을 빠뜨린다. 공백만 적은 이름도
 * 이름이 아니므로 null 로 접는다(DB CHECK 도 같은 값을 요구한다).
 */
export function normalizeCartName(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;

  const trimmed = raw.trim();

  return trimmed === "" ? null : trimmed;
}

/** 저장할 수 있는 이름인가. 길이만 본다 — 중복은 허용이다(구분자는 순번이다). */
export function isValidCartName(name: string): boolean {
  return name === name.trim() && name.length >= 1 && name.length <= CART_NAME_MAX_LENGTH;
}

/**
 * 화면에 부르는 이름. 이름이 없으면 순번으로 부른다.
 *
 * 순번은 **이름이 있어도 화면에 함께 노출한다**(호출부의 규칙) — 같은 이름을 두 개에
 * 붙일 수 있으므로 이름만으로는 구분이 되지 않는다.
 */
export function cartLabel(cart: { name: string | null; seq: number }): string {
  return cart.name ?? `장바구니 ${cart.seq}`;
}

/** 복제 이름 접미사. 원본과의 관계를 이름이 말해 준다. */
const DUPLICATE_SUFFIX = " 복사";

/**
 * 복제된 장바구니의 이름.
 *
 * **원본 이름 + " 복사"** 다. 이름이 없었으면 순번을 이름으로 굳히지 않고 **null 로
 * 둔다** — 새 장바구니는 자기 순번으로 불리면 되고, "장바구니 2 복사" 를 이름으로
 * 박으면 원본이 치워진 뒤에도 없는 번호를 가리킨다.
 *
 * 접미사까지 붙여 상한을 넘으면 **앞을 잘라 낸다.** 이름을 통째로 버리는 것보다
 * 원본과의 관계를 남기는 편이 낫다 — 복제는 "한 항목만 바꿔 비교하기" 동선이고,
 * 그 순간 어느 것이 어느 것의 변형인지가 가장 중요한 정보다.
 */
export function duplicateCartName(source: { name: string | null }): string | null {
  if (source.name === null) return null;

  const room = CART_NAME_MAX_LENGTH - DUPLICATE_SUFFIX.length;

  return `${source.name.slice(0, room)}${DUPLICATE_SUFFIX}`;
}

// =============================================================================
// 순번 — 빈 번호를 채운다
// =============================================================================

/**
 * 다음 순번. **1..limit 사이의 빈 번호 중 가장 작은 값**이고, 자리가 없으면 null 이다.
 *
 * 단조 증가로 두지 않는 이유 — seq 는 이름 없는 장바구니의 **호칭**이라 화면에 그대로
 * 나간다. 3개뿐인데 "장바구니 7" 이 뜨면 상한 5를 설명할 수 없다.
 *
 * DB 트리거(`cart_assign_slot`)가 같은 계산을 한다. 이 함수는 화면이 "다음에 몇 번이
 * 생기는가" 를 미리 말하기 위한 것이며, **진실은 DB 다.**
 */
export function nextCartSeq(used: readonly number[], limit: number): number | null {
  for (let seq = 1; seq <= limit; seq += 1) {
    if (!used.includes(seq)) return seq;
  }

  return null;
}

/**
 * 담기 대상 선택지.
 *
 * 담기 버튼(업체 목록·상세)과 찜의 '장바구니로 옮기기' 가 같은 모양을 쓴다 — 두 곳이
 * 각자 만들면 한쪽만 새 장바구니를 알게 되는 날이 온다. 서버가 만들어 내려준다.
 */
export type CartChoice = {
  cartId: string;
  seq: number;
  label: string;
  /** 이 상품이 이미 그 장바구니에 있는가. 있으면 고를 수 없다(같은 옵션 중복 금지). */
  contains?: boolean;
};

export const CART_CHOOSE_TARGET_LABEL = "어느 장바구니에 담을까요";

export const CART_LIMIT_REACHED_NOTICE =
  "장바구니를 더 만들 수 없어요. 쓰지 않는 장바구니를 치우면 자리가 생겨요.";

/** 치우기 안내. 되돌릴 수 없다는 사실을 감추지 않는다. */
export const CART_DISCARD_NOTICE =
  "치운 장바구니는 목록에서 사라져요. 담아 둔 항목도 함께 내려갑니다.";

export const CART_DUPLICATE_NOTICE =
  "그대로 복제한 뒤 한 항목만 바꿔 보면 총액 차이를 바로 볼 수 있어요.";

// =============================================================================
// 예산 기준선 (couples.total_budget)
// =============================================================================

/**
 * 예산 대비 상태.
 *
 * **`none` 은 0이 아니다.** 예산을 정하지 않은 커플에게 "예산 0원 대비 초과" 를 보이면
 * 사실이 아닌 말을 하는 것이고, 화면은 기준선을 아예 그리지 않아야 한다(브리프 결정 2).
 * `unknown` 은 총액을 계산할 수 없는 경우다 — 담은 것이 없거나 전부 내려간 상품이다.
 *
 * `basis` 는 **총액이 완성됐는가**다. 카테고리가 비어 있으면 그 총액은 아직 자랄 값이라
 * "여유 있어요" 를 단정으로 읽히게 두면 안 된다. 판정은 그대로 하고 근거를 함께 낸다.
 */
export type BudgetBasis = "complete" | "partial" | "unknown_coverage";

export type BudgetLine =
  | { kind: "none" }
  | { kind: "unknown" }
  | { kind: "under"; budget: number; total: number; remaining: number; basis: BudgetBasis }
  | { kind: "exact"; budget: number; total: number; basis: BudgetBasis }
  | { kind: "over"; budget: number; total: number; excess: number; basis: BudgetBasis };

export function budgetLine(input: {
  budget: number | null;
  total: Amount | null;
  basis: BudgetBasis;
}): BudgetLine {
  if (input.budget === null) return { kind: "none" };
  if (input.total === null || isUnknownAmount(input.total)) return { kind: "unknown" };

  const total = input.total as number;
  const { budget, basis } = input;

  if (total === budget) return { kind: "exact", budget, total, basis };

  return total < budget
    ? { kind: "under", budget, total, remaining: budget - total, basis }
    : { kind: "over", budget, total, excess: total - budget, basis };
}

export const BUDGET_LINE_LABEL: Record<BudgetLine["kind"], string> = {
  none: "예산을 정하면 여유·초과를 알려드려요",
  unknown: "총액을 계산할 수 없어 예산과 견줄 수 없어요",
  under: "예산 안에 있어요",
  exact: "예산과 같아요",
  over: "예산을 넘었어요",
};

/**
 * 판정에 붙이는 단서. `partial` 이면 **아직 자랄 총액**이라는 사실을 말한다.
 * `unknown_coverage` 는 채움 기준(`cart.core_categories`)이 없어 완성 여부를 모르는
 * 경우다 — "완성" 이라고 말하지 않고 모른다고 말한다.
 */
export const BUDGET_BASIS_NOTE: Record<BudgetBasis, string> = {
  complete: "",
  partial: "아직 담지 않은 카테고리가 있어 총액이 더 늘어날 수 있어요.",
  unknown_coverage: "채움 기준이 설정되지 않아 총액이 완성됐는지 판단하지 않았어요.",
};

export const BUDGET_UNSET_HINT = "예산은 온보딩에서 정할 수 있어요.";

// =============================================================================
// 카테고리 채움 — '0원' 과 '아직 안 담음' 을 구분한다
// =============================================================================

/**
 * 채움 상태.
 *
 * `core` 는 판정 기준 카테고리이고 **`app_settings.cart.core_categories` 가 갖는다.**
 * 코드가 목록을 지어내지 않는다 — 설정이 없으면 판정 자체를 하지 않는다(`null`).
 * "완성" 이라는 말은 기준이 있을 때만 할 수 있고, 기준 없이 하는 완성 판정은 거짓말이다.
 *
 * `extra` 는 기준에 없는데 담긴 카테고리다(영상·에이전시 등). **경고가 아니다** —
 * 고객이 담은 것을 잘못이라고 말하지 않는다. 총액에는 당연히 들어간다.
 */
export type CategoryFill = {
  core: string[];
  filled: string[];
  missing: string[];
  extra: string[];
  complete: boolean;
};

export function categoryFill(input: {
  coreCategories: readonly string[] | null;
  itemCategories: readonly (string | null)[];
}): CategoryFill | null {
  if (input.coreCategories === null) return null;

  const present = new Set(
    input.itemCategories.filter((category): category is string => category !== null),
  );

  const core = [...input.coreCategories];
  const filled = core.filter((category) => present.has(category));
  const missing = core.filter((category) => !present.has(category));
  const extra = [...present].filter((category) => !core.includes(category)).sort();

  return { core, filled, missing, extra, complete: missing.length === 0 };
}

export function basisOf(fill: CategoryFill | null): BudgetBasis {
  if (fill === null) return "unknown_coverage";

  return fill.complete ? "complete" : "partial";
}

export const INCOMPLETE_TOTAL_NOTICE =
  "아직 담지 않은 카테고리가 있어 미완성 총액이에요. 다 담으면 총액이 올라갑니다.";

/** 담기지 않은 카테고리의 칸. '0원' 이 아니라 '아직 안 담음' 이다(S3-05·S2-08 원칙). */
export const CATEGORY_NOT_ADDED = "아직 안 담음";

// =============================================================================
// 장바구니끼리 비교 — 총액만 보고 오인하게 두지 않는다
// =============================================================================

export type ComparableCart = {
  cartId: string;
  total: Amount;
  /** 채움 판정. null 이면 기준이 없어 판정하지 않았다. */
  fill: CategoryFill | null;
};

/**
 * 가장 낮은 총액의 장바구니.
 *
 * **정하지 않는 경우가 둘이다.**
 *  - `has_unknown`       금액이 미정인 장바구니가 있다. 모르는 값이 더 쌀 수 있다.
 *  - `different_coverage` **담은 카테고리가 서로 다르다.** 홀만 담은 장바구니가 스드메까지
 *                        담은 장바구니보다 싼 것은 당연하고, 그것을 "가장 낮은 총액" 으로
 *                        적으면 덜 담은 쪽이 이기는 표가 된다. 비교가 아니라 오해다.
 *
 * 채움 기준이 없으면(`fill === null`) 덮개를 견줄 수 없으므로 **금액만으로 판정하지
 * 않는다** — `different_coverage` 로 둔다. 모르는 상태에서 단정하지 않는 쪽을 고른다.
 */
export function lowestCart(
  carts: readonly ComparableCart[],
): { cartId: string } | { undecided: "has_unknown" | "different_coverage" } | null {
  if (carts.length === 0) return null;
  // **덮개를 먼저 본다.** 덮개가 다르면 금액을 알든 모르든 순위가 성립하지 않고, 그쪽이
  // 고객에게 더 쓸모 있는 설명이다("덜 담은 쪽이 싸 보이는 것은 당연해요"). 비어 있는
  // 장바구니도 여기서 걸린다 — 금액이 '미정' 이라고 말하면 비었다는 사실이 가려진다.
  if (!sameCoverage(carts)) return { undecided: "different_coverage" };
  if (carts.some((cart) => isUnknownAmount(cart.total))) return { undecided: "has_unknown" };

  const sorted = [...carts].sort((a, b) => {
    const diff = (a.total as number) - (b.total as number);

    return diff !== 0 ? diff : a.cartId < b.cartId ? -1 : 1;
  });

  return { cartId: sorted[0].cartId };
}

/** 담은 카테고리 집합이 모두 같은가. 하나라도 기준이 없으면 판단하지 않는다(false). */
export function sameCoverage(carts: readonly ComparableCart[]): boolean {
  if (carts.length < 2) return true;
  if (carts.some((cart) => cart.fill === null)) return false;

  const keyOf = (cart: ComparableCart) =>
    [...cart.fill!.filled, ...cart.fill!.extra].sort().join("|");
  const first = keyOf(carts[0]);

  return carts.every((cart) => keyOf(cart) === first);
}

export const LOWEST_CART_UNDECIDED_NOTICE: Record<"has_unknown" | "different_coverage", string> = {
  has_unknown: "금액이 미정인 장바구니가 있어 가장 낮은 총액을 정할 수 없어요.",
  different_coverage:
    "담은 카테고리가 서로 달라 총액을 그대로 견줄 수 없어요. 덜 담은 쪽이 싸 보이는 것은 당연해요.",
};

/**
 * 모든 장바구니에서 값이 같은 줄인가. 같으면 **접는다**(화면 규칙).
 *
 * 차이를 보러 온 화면에서 같은 줄이 자리를 먹으면 정작 다른 줄이 밀린다. 다만 감추지
 * 않고 접는다 — 접힌 개수를 적고 펼 수 있게 둔다.
 */
export function rowIsIdentical(values: readonly string[]): boolean {
  if (values.length < 2) return false;

  return values.every((value) => value === values[0]);
}

export const CART_COMPARE_COLLAPSED_LABEL = "모든 장바구니에서 같은 줄";

export const CART_COMPARE_MODES = ["carts", "items"] as const;
export type CartCompareMode = (typeof CART_COMPARE_MODES)[number];

export const CART_COMPARE_MODE_LABEL: Record<CartCompareMode, string> = {
  carts: "장바구니끼리",
  items: "담은 항목끼리",
};

export const CART_COMPARE_MODE_HINT: Record<CartCompareMode, string> = {
  carts: "조합 전체의 총액을 견줍니다. 어느 구성이 예산에 맞는지 볼 때 쓰세요.",
  items: "같은 카테고리의 상품을 견줍니다. 어느 상품이 조건에 맞는지 볼 때 쓰세요.",
};

/**
 * 어느 층위를 기본으로 보일까.
 *
 * **활성 장바구니가 둘 이상이면 장바구니끼리**다 — 여러 개를 만든 사람은 조합을 견주려고
 * 만든 것이다. 하나뿐이면 견줄 상대가 없으므로 항목끼리로 떨어진다.
 */
export function defaultCompareMode(activeCartCount: number): CartCompareMode {
  return activeCartCount >= 2 ? "carts" : "items";
}

export const SINGLE_CART_NOTICE =
  "장바구니가 하나예요. 복제해서 한 항목만 바꾸면 조합끼리 견줄 수 있어요.";
