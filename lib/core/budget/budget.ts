import { ESTIMATE_CATEGORIES, ESTIMATE_CATEGORY_LABEL } from "../schemas/estimate";
import { PRICE_INDEX_MIN_SAMPLE } from "../pricing/price-index";

/**
 * 예산 배분·추적 (S7-07 · 명세서 §2.1 F-C-05 · §3.2 budgets·budget_items·expenses · §6.2 `/budget`)
 *
 * ── 이 파일이 지키는 것 ─────────────────────────────────────────────────────
 *  1. **미정은 0이 아니다.** 총예산을 정하지 않은 커플에게 "예산 0원 대비 초과" 를
 *     보이면 사실이 아닌 말을 하는 것이다(장바구니 `budgetLine` 의 `none` 과 같은 판단).
 *  2. **기준이 없으면 권장하지 않는다.** 참가격 지수가 없는 카테고리에는 금액을
 *     만들지 않는다 — 지어낸 권장액은 우리가 없애려는 종류의 가격 신호다.
 *  3. **비율은 basis point 정수**다. 부동소수점을 쓰지 않으며 합이 10000 이 되도록
 *     잔여를 나눈다(§6 · 최대잉여법).
 *
 * 프레임워크를 모르는 순수 모듈이다.
 */

// =============================================================================
// 카테고리
// =============================================================================

/**
 * 예산 카테고리.
 *
 * **표준 견적 카테고리(§3)를 그대로 쓴다** — 예산은 "견적·계약 확정 시 자동 반영"
 * 되므로(§2.1 F-C-05) 견적이 쓰는 말과 달라지면 옮길 때마다 매핑이 필요하고 그
 * 매핑이 곧 어긋남의 자리가 된다.
 *
 * **`unmapped` 만 뺀다.** 그것은 카테고리가 아니라 "표준 카테고리로 옮기지 못했다"
 * 는 표시이며(§5.4), 예산 줄로 세우면 사용자가 **'확인 필요' 라는 항목에 돈을
 * 배정하게** 된다.
 */
export const BUDGET_CATEGORIES = ESTIMATE_CATEGORIES.filter(
  (category) => category !== "unmapped",
) as readonly Exclude<(typeof ESTIMATE_CATEGORIES)[number], "unmapped">[];

export type BudgetCategory = (typeof BUDGET_CATEGORIES)[number];

export const BUDGET_CATEGORY_LABEL: Record<BudgetCategory, string> = Object.fromEntries(
  BUDGET_CATEGORIES.map((category) => [category, ESTIMATE_CATEGORY_LABEL[category]]),
) as Record<BudgetCategory, string>;

export function isBudgetCategory(value: string): value is BudgetCategory {
  return (BUDGET_CATEGORIES as readonly string[]).includes(value);
}

/**
 * 업체 카테고리 → 예산 카테고리.
 *
 * 계약(예약)은 업체에 붙고 업체는 `vendors.category`(§3.3 여섯 값)를 갖는다.
 * 예산은 견적 카테고리로 말하므로 옮겨야 한다.
 *
 * **`agency`(웨딩 에이전시)를 `etc` 로 보낸다.** 에이전시는 특정 품목이 아니라
 * 대행이며, 견적 카테고리에 대응하는 칸이 없다. `unmapped` 로 보내지 않는 이유는
 * 그것이 **예산 카테고리가 아니기** 때문이고(위 참조), `etc`(기타)는 §3 이 정의한
 * 실재하는 칸이다 — 없는 칸을 만드는 것보다 있는 칸에 넣고 **화면이 그 사실을
 * 적는 편**이 낫다.
 */
export const VENDOR_TO_BUDGET_CATEGORY: Record<string, BudgetCategory> = {
  hall: "hall",
  studio: "studio",
  dress: "dress",
  makeup: "makeup",
  video: "video",
  agency: "etc",
};

export function budgetCategoryOfVendor(vendorCategory: string | null): BudgetCategory {
  return VENDOR_TO_BUDGET_CATEGORY[vendorCategory ?? ""] ?? "etc";
}

// =============================================================================
// 권장 배분 — 지수가 없으면 권장하지 않는다
// =============================================================================

/** 참가격 지수 한 칸에서 권장에 필요한 것만. */
export type IndexPoint = {
  category: string;
  p50: number | null;
  sampleSize: number;
  /** 어떤 표본으로 만든 지수인가. 화면이 그대로 적는다(S3-08). */
  sourceLabel: string | null;
};

export type Recommendation =
  | { category: BudgetCategory; kind: "indexed"; amount: number; sampleSize: number; sourceLabel: string | null }
  | { category: BudgetCategory; kind: "no_index" };

export const NO_INDEX_RECOMMENDATION_NOTE =
  "이 카테고리는 아직 참가격 기준이 없어 권장액을 만들지 않았어요. 직접 정해 주세요.";

/**
 * **총예산을 비율로 쪼개지 않는다.**
 *
 * 비율 배분은 "지수가 있는 카테고리들이 총예산을 100% 나눠 갖는" 결과를 낳는데,
 * 지수가 있는 것은 지금 **홀·스튜디오·드레스·메이크업·영상 정도**뿐이다. 그렇게 하면
 * 식대·예단·청첩장·헬퍼비에 **0원이 배정되고**, 0원은 "쓰지 마라" 로 읽힌다 — 우리가
 * 알지 못하는 것을 단정으로 말하는 셈이다.
 *
 * 그래서 권장액은 **그 카테고리의 시세 중앙값 그 자체**다. 총예산은 나누는 대상이
 * 아니라 **견주는 기준**이며, 화면은 "지수가 있는 N개의 중앙값 합" 과 총예산을
 * 나란히 보인다. 지수가 없는 카테고리는 **빈칸으로 남긴다**(지시 그대로 —
 * 지수가 없으면 권장하지 않는다).
 *
 * 표본 하한은 `PRICE_INDEX_MIN_SAMPLE` 과 **같은 값**을 쓴다. 화면마다 "몇 곳부터
 * 통계로 말하는가" 가 다르면 같은 제품이 두 가지 기준을 갖게 된다.
 */
export function recommendAllocation(input: {
  index: readonly IndexPoint[];
  categories?: readonly BudgetCategory[];
}): Recommendation[] {
  const byCategory = new Map(input.index.map((point) => [point.category, point]));
  const categories = input.categories ?? BUDGET_CATEGORIES;

  return categories.map((category): Recommendation => {
    const point = byCategory.get(category);

    if (
      point === undefined ||
      point.p50 === null ||
      point.p50 <= 0 ||
      point.sampleSize < PRICE_INDEX_MIN_SAMPLE
    ) {
      return { category, kind: "no_index" };
    }

    return {
      category,
      kind: "indexed",
      amount: point.p50,
      sampleSize: point.sampleSize,
      sourceLabel: point.sourceLabel,
    };
  });
}

export type RecommendationSummary = {
  /** 권장액이 있는 카테고리 수. */
  indexedCount: number;
  /** 기준이 없어 권장하지 못한 카테고리 수. */
  missingCount: number;
  /** 권장액 합. 권장이 하나도 없으면 `null` — 0이 아니다. */
  total: number | null;
};

export function summarizeRecommendation(
  recommendations: readonly Recommendation[],
): RecommendationSummary {
  const indexed = recommendations.filter(
    (item): item is Extract<Recommendation, { kind: "indexed" }> => item.kind === "indexed",
  );

  return {
    indexedCount: indexed.length,
    missingCount: recommendations.length - indexed.length,
    // **하나도 없으면 0이 아니라 없음이다.** 0을 내면 "합이 0원" 이라는 없는 사실을 말한다.
    total: indexed.length === 0 ? null : indexed.reduce((sum, item) => sum + item.amount, 0),
  };
}

// =============================================================================
// 계획 대비 실지출
// =============================================================================

/**
 * 카테고리 한 줄.
 *
 * · `planned` — 사용자가 정한 계획(`budget_items.planned_amount`)
 * · `contracted` — **확정된 예약의 총액.** 조회 시점에 센다
 * · `paid` — 그중 결제가 끝난 금액. 계약 안에서의 진행이다
 * · `manualSpent` — 사용자가 손으로 적은 지출(`expenses`)
 *
 * **`committed` 가 예산에서 빠져나갈 총액**이다 — 계약액 + 손으로 적은 지출.
 * `paid` 를 더하지 않는 이유는 **그것이 계약액 안에 이미 들어 있기** 때문이다.
 * 두 번 더하면 계약금을 낸 순간 예산이 두 배로 줄어드는 것처럼 보인다.
 */
export type BudgetLine = {
  category: BudgetCategory;
  planned: number | null;
  contracted: number;
  paid: number;
  manualSpent: number;
  committed: number;
  /** 계획 대비. 계획이 없으면 `null` — 0으로 두지 않는다. */
  remaining: number | null;
  overBy: number | null;
};

export function buildLine(input: {
  category: BudgetCategory;
  planned: number | null;
  contracted: number;
  paid: number;
  manualSpent: number;
}): BudgetLine {
  const committed = input.contracted + input.manualSpent;
  const planned = input.planned;

  return {
    category: input.category,
    planned,
    contracted: input.contracted,
    paid: input.paid,
    manualSpent: input.manualSpent,
    committed,
    remaining: planned === null ? null : Math.max(0, planned - committed),
    overBy: planned === null ? null : Math.max(0, committed - planned),
  };
}

export type BudgetTotals = {
  /** `couples.total_budget`. **미정이면 null** 이다. */
  totalBudget: number | null;
  planned: number;
  contracted: number;
  paid: number;
  manualSpent: number;
  committed: number;
  /** 총예산이 미정이면 `null`. */
  remaining: number | null;
  overBy: number | null;
  /** 계획했지만 아직 어느 카테고리에도 배정되지 않은 금액. 총예산이 없으면 `null`. */
  unallocated: number | null;
};

export function totalsOf(input: {
  totalBudget: number | null;
  lines: readonly BudgetLine[];
}): BudgetTotals {
  const sum = (pick: (line: BudgetLine) => number) =>
    input.lines.reduce((acc, line) => acc + pick(line), 0);

  const planned = sum((line) => line.planned ?? 0);
  const committed = sum((line) => line.committed);
  const totalBudget = input.totalBudget;

  return {
    totalBudget,
    planned,
    contracted: sum((line) => line.contracted),
    paid: sum((line) => line.paid),
    manualSpent: sum((line) => line.manualSpent),
    committed,
    remaining: totalBudget === null ? null : Math.max(0, totalBudget - committed),
    overBy: totalBudget === null ? null : Math.max(0, committed - totalBudget),
    // 계획 합이 총예산을 넘으면 미배정은 0이다 — 음수로 내려가지 않는다.
    unallocated: totalBudget === null ? null : Math.max(0, totalBudget - planned),
  };
}

// =============================================================================
// 초과 경고
// =============================================================================

export type BudgetWarning =
  | { kind: "total_over"; amount: number }
  | { kind: "plan_over_budget"; amount: number }
  | { kind: "category_over"; category: BudgetCategory; amount: number };

/**
 * 초과 경고.
 *
 * **셋을 가른다.** 셋 다 "넘었다" 이지만 사용자가 할 일이 다르다 —
 *  · `total_over` 는 **총예산을 넘었다**(가장 큰 사실이라 맨 앞이다)
 *  · `plan_over_budget` 은 **계획의 합이 총예산을 넘었다**(아직 쓰지는 않았다)
 *  · `category_over` 는 **그 카테고리 계획을 넘었다**(다른 데서 당겨오면 된다)
 *
 * **총예산이 미정이면 총액 경고를 내지 않는다.** 0을 기준으로 삼으면 담는 즉시
 * "초과" 가 뜨고, 그 경고는 사실이 아니라 설정이 비었다는 뜻이다.
 */
export function warningsOf(input: {
  totals: BudgetTotals;
  lines: readonly BudgetLine[];
}): BudgetWarning[] {
  const warnings: BudgetWarning[] = [];

  if (input.totals.overBy !== null && input.totals.overBy > 0) {
    warnings.push({ kind: "total_over", amount: input.totals.overBy });
  }

  if (input.totals.totalBudget !== null && input.totals.planned > input.totals.totalBudget) {
    warnings.push({
      kind: "plan_over_budget",
      amount: input.totals.planned - input.totals.totalBudget,
    });
  }

  for (const line of input.lines) {
    if (line.overBy !== null && line.overBy > 0) {
      warnings.push({ kind: "category_over", category: line.category, amount: line.overBy });
    }
  }

  return warnings;
}

// =============================================================================
// 도넛 — 색을 만들지 않는다
// =============================================================================

/**
 * 도넛 조각.
 *
 * **§6.2 는 "카테고리 배분 도넛" 을 적었지만 팔레트에는 브랜드 한 색과 무채색
 * 스케일뿐이다**(DESIGN.md — 새 색 금지). 예산 카테고리는 14종이라 색으로 가르려면
 * 색을 새로 만들어야 하고, 만들어도 **375px 에서 14조각은 범례 없이 못 읽는다.**
 *
 * 그래서 조각을 **상위 N개 + '기타' + '미배정'** 으로 접는다. 접힌 것은 사라지지
 * 않는다 — 아래 카테고리 목록이 **전부를 금액과 함께** 보인다. 도넛은 큰 그림이고
 * 목록이 사실이다.
 *
 * **합이 정확히 10000bp** 가 되도록 잔여를 나눈다(최대잉여법) — 반올림을 그냥 두면
 * 조각 합이 99.9% 가 되어 원이 닫히지 않는다.
 */
export const DONUT_SEGMENT_LIMIT = 5;

export type DonutSegment = {
  key: string;
  label: string;
  amount: number;
  shareBp: number;
  /** 무채색으로 그릴 조각인가. '기타'·'미배정' 이 그렇다. */
  muted: boolean;
};

/** 비율(bp). **합이 정확히 10000** 이 되도록 잔여를 큰 소수부터 나눈다. */
export function sharesBp(amounts: readonly number[]): number[] {
  const total = amounts.reduce((sum, amount) => sum + amount, 0);
  if (total <= 0) return amounts.map(() => 0);

  const exact = amounts.map((amount) => (amount * 10_000) / total);
  const floored = exact.map((value) => Math.floor(value));
  let remainder = 10_000 - floored.reduce((sum, value) => sum + value, 0);

  const order = exact
    .map((value, index) => ({ index, frac: value - Math.floor(value) }))
    // 소수부가 큰 것부터. 같으면 앞 항목이 먼저다 — 순서가 흔들리면 같은 값이
    // 볼 때마다 다른 비율로 보인다.
    .sort((a, b) => b.frac - a.frac || a.index - b.index);

  const result = [...floored];
  for (const { index } of order) {
    if (remainder <= 0) break;

    result[index] += 1;
    remainder -= 1;
  }

  return result;
}

export function donutSegments(input: {
  lines: readonly { category: BudgetCategory; planned: number | null }[];
  unallocated: number | null;
  limit?: number;
}): DonutSegment[] {
  const limit = input.limit ?? DONUT_SEGMENT_LIMIT;

  const planned = input.lines
    .filter((line) => (line.planned ?? 0) > 0)
    .map((line) => ({ key: line.category, label: BUDGET_CATEGORY_LABEL[line.category], amount: line.planned as number }))
    .sort((a, b) => b.amount - a.amount || a.key.localeCompare(b.key));

  const top = planned.slice(0, limit);
  const rest = planned.slice(limit);
  const restTotal = rest.reduce((sum, item) => sum + item.amount, 0);

  const raw: { key: string; label: string; amount: number; muted: boolean }[] = [
    ...top.map((item) => ({ ...item, muted: false })),
  ];

  if (restTotal > 0) {
    raw.push({ key: "__rest", label: `기타 ${rest.length}개`, amount: restTotal, muted: true });
  }

  if (input.unallocated !== null && input.unallocated > 0) {
    raw.push({ key: "__unallocated", label: "아직 배정 안 함", amount: input.unallocated, muted: true });
  }

  const shares = sharesBp(raw.map((item) => item.amount));

  return raw.map((item, index) => ({ ...item, shareBp: shares[index] }));
}

// =============================================================================
// 화면 문구 — 한 곳에 둔다
// =============================================================================

export const BUDGET_NO_TOTAL_NOTE =
  "총예산을 정하면 카테고리별 여유와 초과를 알려드려요. 정하기 전에는 기준선을 그리지 않아요.";

/**
 * **장바구니와 같은 총예산을 쓴다는 사실**을 화면이 적는다(IDEA-01 · D-77).
 * 두 화면이 다른 숫자를 말하면 사용자는 어느 쪽이 맞는지 묻게 된다.
 */
export const BUDGET_SHARED_TOTAL_NOTE =
  "여기서 정한 총예산은 장바구니의 예산 기준선과 같은 값이에요.";

export const BUDGET_AUTO_CONTRACT_NOTE =
  "확정된 예약 금액은 자동으로 잡혀요. 같은 금액을 실지출로 다시 적으면 두 번 세어집니다.";

export const BUDGET_WARNING_LABEL: Record<BudgetWarning["kind"], string> = {
  total_over: "총예산을 넘었어요",
  plan_over_budget: "계획의 합이 총예산을 넘었어요",
  category_over: "이 카테고리 계획을 넘었어요",
};
