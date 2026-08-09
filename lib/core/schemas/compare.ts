import { isUnknownAmount, type Amount } from "../pricing/amount";

/**
 * 장바구니 기반 비교 (S3-07 · 명세서 §2.1 F-C-10, §6.2 `/explore/compare`)
 *
 * F-C-10 v2.0: "비교는 **장바구니에 담긴 항목을 기준으로** 한다(개수 제한 없음 —
 * 담은 만큼 비교)." 구 명세의 '최대 4개'는 폐기됐다.
 *
 * §6.2 가 요구하는 것은 **병렬 비교표 + 실총액 기준 정렬**이다. 이 모듈은 그 두 가지의
 * 규칙만 갖는다 — 프레임워크도 DB 도 모른다.
 */

// =============================================================================
// 칸의 상태 — 빈칸을 만들지 않는다
// =============================================================================

/**
 * 비교표는 상품마다 있는 항목이 달라 **빈칸이 많이 생긴다.** 빈칸은 아무 말도 하지
 * 않으므로, 왜 비었는지를 값으로 갖는다.
 *
 *  - `value`       값이 있다.
 *  - `none`        **해당 없음.** 그 항목이 구조적으로 성립하지 않는다
 *                  (예: 추가금 0건 확정 — "없다"고 업체가 말한 것).
 *  - `missing`     **미등록.** 있을 수 있는데 업체가 적지 않았다.
 *  - `unavailable` **확인 불가.** 상품이 내려가 지금은 값을 읽을 수 없다.
 *
 * `none` 과 `missing` 을 같은 빈칸으로 그리면 "추가금이 없는 업체"와 "추가금을 안 적은
 * 업체"가 화면에서 같아진다. 그 둘을 가르는 것이 이 제품의 일이다(F-V-04).
 */
export type CompareCell =
  | { kind: "value"; text: string; amount?: number }
  | { kind: "none"; text?: string }
  | { kind: "missing" }
  | { kind: "unavailable" };

export const COMPARE_CELL_TEXT: Record<Exclude<CompareCell["kind"], "value">, string> = {
  none: "해당 없음",
  missing: "업체가 적지 않음",
  unavailable: "지금은 확인 불가",
};

/** 값이 없는 칸의 표기. 셋이 서로 다른 문구여야 한다. */
export function cellText(cell: CompareCell): string {
  return cell.kind === "value" ? cell.text : COMPARE_CELL_TEXT[cell.kind];
}

// =============================================================================
// 비교 축
// =============================================================================

/**
 * 행 순서. **총액이 첫 줄**이다(D-18 — 화면의 주인공은 가격).
 * 그 다음이 총액을 이루는 값들이고, 조건(수용 인원·지역)이 뒤에 온다.
 */
export const COMPARE_AXES = [
  "total",
  "basePrice",
  "addOns",
  "plannerFee",
  "tax",
  "includedItems",
  "capacity",
  "region",
  "priceChange",
] as const;

export type CompareAxis = (typeof COMPARE_AXES)[number];

export const COMPARE_AXIS_LABEL: Record<CompareAxis, string> = {
  total: "실총액",
  basePrice: "판매가",
  addOns: "추가금",
  plannerFee: "플래너 수수료",
  tax: "부가세",
  includedItems: "포함 항목",
  capacity: "수용 인원",
  region: "지역",
  priceChange: "담을 때 대비",
};

// =============================================================================
// 플래너 기준 — 사과와 오렌지를 만들지 않는다
// =============================================================================

/**
 * 한쪽만 플래너를 켜 두면 총액 비교가 성립하지 않는다.
 *
 * **기본은 `as_selected`(담은 그대로)** 다. 비교 화면이 장바구니와 다른 금액을 말하면
 * 두 화면 중 어느 쪽이 진짜인지 알 수 없게 된다.
 *
 * 다만 항목마다 선택이 다르면 그 사실을 **감지해서 알리고**, 같은 조건으로 볼 수단을
 * 준다(`without_planner`). 이 전환은 **표시 기준만 바꾸며 장바구니를 고치지 않는다** —
 * 비교하러 들어왔다가 담아 둔 선택이 바뀌면 안 된다.
 */
export const COMPARE_PLANNER_BASES = ["as_selected", "without_planner"] as const;

export type ComparePlannerBasis = (typeof COMPARE_PLANNER_BASES)[number];

export const COMPARE_PLANNER_BASIS_LABEL: Record<ComparePlannerBasis, string> = {
  as_selected: "담은 그대로",
  without_planner: "플래너 빼고 같은 조건으로",
};

export const PLANNER_MISMATCH_NOTICE =
  "항목마다 플래너 선택이 달라요. 총액을 그대로 견주면 조건이 다른 값을 비교하게 됩니다.";

/** 선택이 갈렸는가. 하나라도 다르면 총액 비교가 같은 조건이 아니다. */
export function plannerSelectionMixed(selections: readonly boolean[]): boolean {
  if (selections.length < 2) return false;

  return selections.some((selected) => selected !== selections[0]);
}

// =============================================================================
// 정렬 — 실총액 기준 (§6.2)
// =============================================================================

export type ComparableItem = {
  itemId: string;
  /** 실총액. 미정이면 sentinel 이다. */
  total: Amount;
};

/**
 * 실총액 오름차순. **미정은 언제나 맨 뒤**다.
 *
 * 미정을 0으로 보고 앞에 놓으면 "가장 싸다" 는 거짓 신호가 된다. 미정은 낮은 값이
 * 아니라 **모르는 값**이다(amount.ts 의 원칙과 같다).
 * 같은 금액이면 `itemId` 로 갈라 순서를 유일하게 만든다.
 */
export function sortByTotal<T extends ComparableItem>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => {
    const aUnknown = isUnknownAmount(a.total);
    const bUnknown = isUnknownAmount(b.total);

    if (aUnknown !== bUnknown) return aUnknown ? 1 : -1;
    if (aUnknown && bUnknown) return a.itemId < b.itemId ? -1 : 1;

    const diff = (a.total as number) - (b.total as number);

    return diff !== 0 ? diff : a.itemId < b.itemId ? -1 : 1;
  });
}

/**
 * 가장 낮은 실총액의 항목 id.
 *
 * **미정이 하나라도 있으면 정하지 않는다.** 모르는 값이 더 쌀 수 있으므로
 * "이게 제일 싸다" 고 말할 수 없다. 그 사실을 화면이 그대로 적는다.
 */
export function lowestTotal<T extends ComparableItem>(
  items: readonly T[],
): { itemId: string } | { undecided: "has_unknown" } | null {
  if (items.length === 0) return null;
  if (items.some((item) => isUnknownAmount(item.total))) return { undecided: "has_unknown" };

  const sorted = sortByTotal(items);

  return { itemId: sorted[0].itemId };
}

export const LOWEST_UNDECIDED_NOTICE =
  "금액이 미정인 항목이 있어 가장 낮은 총액을 정할 수 없어요.";

// =============================================================================
// 묶기 — 웨딩홀과 드레스를 나란히 놓지 않는다
// =============================================================================

/**
 * 카테고리로 묶는다. **제한하지 않고 묶는다.**
 *
 * 같은 카테고리만 고르게 하면 사용자가 먼저 카테고리를 정해야 하고, 담아 둔 것 전체를
 * 훑어볼 수 없다. 반대로 섞어서 한 줄에 세우면 웨딩홀과 드레스의 총액을 견주게 되는데
 * 그건 비교가 아니다.
 */
export function groupByCategory<T extends { category: string | null }>(
  items: readonly T[],
): { category: string; items: T[] }[] {
  const groups = new Map<string, T[]>();

  for (const item of items) {
    const key = item.category ?? "unknown";
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }

  // 항목이 많은 묶음을 먼저 — 비교할 것이 있는 쪽이 위에 온다. 같으면 코드순으로 고정.
  return [...groups.entries()]
    .map(([category, list]) => ({ category, items: list }))
    .sort((a, b) =>
      b.items.length === a.items.length
        ? a.category.localeCompare(b.category)
        : b.items.length - a.items.length,
    );
}

export const SINGLE_ITEM_NOTICE = "이 카테고리에는 담은 것이 하나뿐이라 견줄 상대가 없어요.";

export const COMPARE_EMPTY_TITLE = "비교할 항목이 없어요";

/** 가로 스크롤 안내. 375px 에서 열이 셋을 넘어가면 다 보이지 않는다. */
export const COMPARE_SCROLL_HINT = "표를 옆으로 밀면 나머지 항목이 보여요.";

export const COMPARE_EXCLUDED_NOTICE =
  "지금은 볼 수 없는 항목은 비교에서 뺐어요. 값을 읽을 수 없어 모든 칸이 비게 됩니다.";
