import { VENDOR_TO_BUDGET_CATEGORY } from "../budget/budget";
import {
  ESTIMATE_CATEGORIES,
  ESTIMATE_CATEGORY_LABEL,
  type EstimateCategory,
} from "../schemas/estimate";

/**
 * 견적 정규화·비교 (S7-05 · 명세서 §2.1 F-C-06 · §5.4 · §6.2 `/estimates`)
 *
 * ── 파싱 단계가 없다 ────────────────────────────────────────────────────────
 * §5.4 1단계는 "이미지·PDF·텍스트 → 항목/금액 쌍 추출(LLM)" 이다. 그런데 **이 제품에
 * 자유 양식 견적은 존재하지 않는다** — 업체는 `quotes`·`quote_items` 라는 **표준 폼으로만**
 * 응답하고(F-V-07 · S4-12), 항목의 이름·분류는 **DB 트리거가 참조된 상품·추가금에서 다시
 * 읽어 덮어쓴다**(0024). 즉 **항목/금액 쌍은 이미 구조화돼 들어온다.**
 *
 * 그래서 이 모듈이 하는 일은 §5.4 의 **2~5단계**다 — 매핑 · 실총액 환산 · 비교 · 검증.
 * 전부 **결정적 계산**이며 LLM 을 부르지 않는다.
 *
 * ── 카테고리 표를 예산과 공유한다 ───────────────────────────────────────────
 * `quote_items.category_code` 는 **업체 카테고리**(`products.category`)다. 표준 견적
 * 카테고리로 옮겨야 하는데, 그 표는 **예산(S7-07)이 이미 갖고 있다**
 * (`VENDOR_TO_BUDGET_CATEGORY`). 두 벌을 두면 **견적에서 `hall` 로 잡힌 계약이 예산에서
 * 다른 칸에 들어간다** — 같은 계약이 두 화면에서 다른 줄에 서는 것이다.
 *
 * 프레임워크를 모르는 순수 모듈이다.
 */

// =============================================================================
// 매핑 — 표는 하나다
// =============================================================================

/**
 * 업체 카테고리 → 표준 견적 카테고리.
 *
 * **예산이 쓰는 그 표다.** 이름이 `BUDGET` 인 이유는 그쪽이 먼저 필요했기 때문이고,
 * 실제로는 **표준 견적 카테고리로의 매핑**이다(예산 카테고리 = 견적 카테고리 − `unmapped`).
 * 재수출하지 않고 **그대로 참조**한다 — 사본을 만들면 사본이 어긋난다.
 */
export const VENDOR_TO_ESTIMATE_CATEGORY = VENDOR_TO_BUDGET_CATEGORY;

/**
 * **모르는 업종은 `unmapped` 다.** 예산과 갈리는 유일한 자리이며 의도한 것이다 —
 * 예산은 "돈을 배정할 칸" 이라 `etc`(기타)로 보내야 하지만(사용자가 배정할 수 있어야 한다),
 * 견적은 **"우리가 옮기지 못했다" 를 화면에 드러내야 한다**(§5.4 '확인 필요').
 * `etc` 로 조용히 넣으면 사용자는 그것이 우리가 아는 분류인 줄 안다.
 */
export function estimateCategoryOfVendor(vendorCategory: string | null): EstimateCategory {
  return VENDOR_TO_ESTIMATE_CATEGORY[vendorCategory ?? ""] ?? "unmapped";
}

// =============================================================================
// 정규화 — 실총액 환산
// =============================================================================

/** 견적 한 줄. `quote_items` 에서 계산에 쓰는 것만. */
export type QuoteLine = {
  id: string;
  label: string;
  /** `quote_items.category_code` — **업체 카테고리**다. */
  vendorCategory: string;
  amount: number;
  isOption: boolean;
  isMandatory: boolean;
};

export type NormalizedLine = QuoteLine & {
  category: EstimateCategory;
  /** 실총액에 들어가는가. 선택 옵션은 들어가지 않는다. */
  counted: boolean;
};

export type EstimateFlag =
  /** 항목 합과 견적 총액이 다르다(§5.4 검증). */
  | { kind: "total_mismatch"; declared: number; computed: number; difference: number }
  /** 표준 카테고리로 옮기지 못한 항목이 있다. */
  | { kind: "unmapped_items"; count: number }
  /** 유효기간이 지났다. */
  | { kind: "expired"; validUntil: string }
  /** 고를 수 있는 옵션이 남아 있다 — 실총액이 더 오를 수 있다. */
  | { kind: "optional_remaining"; count: number; amount: number };

export const ESTIMATE_FLAG_LABEL: Record<EstimateFlag["kind"], string> = {
  total_mismatch: "항목 합과 견적 총액이 달라요",
  unmapped_items: "표준 항목으로 옮기지 못한 줄이 있어요",
  expired: "유효기간이 지난 견적이에요",
  optional_remaining: "고르면 더해지는 옵션이 남아 있어요",
};

export type NormalizedEstimate = {
  quoteId: string;
  vendorId: string;
  vendorName: string;
  productName: string | null;
  /** 이 견적의 대표 카테고리(업체 카테고리에서 옮긴 것). */
  category: EstimateCategory;
  lines: NormalizedLine[];
  /** 기본 항목 합. */
  baseAmount: number;
  /** 필수 옵션 합. **실총액에 들어간다.** */
  mandatoryOptionAmount: number;
  /** 선택 옵션 합. **실총액에 넣지 않는다** — 고를 수도 안 고를 수도 있다. */
  optionalOptionAmount: number;
  /** 실총액 = 기본 + 필수 옵션. §5.4 3단계. */
  realTotal: number;
  /** 업체가 적은 견적 총액(`quotes.total_amount`). */
  declaredTotal: number;
  /** 표준 카테고리별 금액. 실총액에 들어가는 줄만 센다. */
  byCategory: Partial<Record<EstimateCategory, number>>;
  flags: EstimateFlag[];
  validUntil: string | null;
};

/**
 * 견적 하나를 표준 축으로 옮기고 실총액을 낸다.
 *
 * **선택 옵션을 실총액에 더하지 않는다.** 더하면 "이 견적은 이만큼 든다" 가 되는데
 * 사용자는 아직 그 옵션을 고르지 않았다 — 우리가 대신 고른 셈이 된다. 대신 **남아
 * 있다는 사실을 플래그로** 올린다: 실총액이 더 오를 수 있다는 것이 비교에서 중요하다.
 *
 * **합계 불일치를 고치지 않는다.** 업체가 적은 총액과 항목 합이 다르면 **둘 다 보이고
 * 플래그가 붙는다**(§5.4 검증). 어느 쪽이 맞는지는 우리가 정할 일이 아니다.
 */
export function normalizeEstimate(input: {
  quoteId: string;
  vendorId: string;
  vendorName: string;
  productName: string | null;
  vendorCategory: string | null;
  declaredTotal: number;
  validUntil: string | null;
  lines: readonly QuoteLine[];
  /** 유효기간 판정 기준. **호출자가 넘긴다** — 자정을 넘기며 답이 달라지면 안 된다. */
  now: string;
}): NormalizedEstimate {
  const lines: NormalizedLine[] = input.lines.map((line) => ({
    ...line,
    category: estimateCategoryOfVendor(line.vendorCategory),
    counted: !line.isOption || line.isMandatory,
  }));

  const sum = (pick: (line: NormalizedLine) => boolean) =>
    lines.filter(pick).reduce((acc, line) => acc + line.amount, 0);

  const baseAmount = sum((line) => !line.isOption);
  const mandatoryOptionAmount = sum((line) => line.isOption && line.isMandatory);
  const optionalOptionAmount = sum((line) => line.isOption && !line.isMandatory);
  const realTotal = baseAmount + mandatoryOptionAmount;

  const byCategory: Partial<Record<EstimateCategory, number>> = {};
  for (const line of lines) {
    if (!line.counted) continue;

    byCategory[line.category] = (byCategory[line.category] ?? 0) + line.amount;
  }

  const flags: EstimateFlag[] = [];

  if (input.declaredTotal !== realTotal) {
    flags.push({
      kind: "total_mismatch",
      declared: input.declaredTotal,
      computed: realTotal,
      difference: Math.abs(input.declaredTotal - realTotal),
    });
  }

  const unmapped = lines.filter((line) => line.category === "unmapped").length;
  if (unmapped > 0) flags.push({ kind: "unmapped_items", count: unmapped });

  if (input.validUntil !== null && Date.parse(input.validUntil) <= Date.parse(input.now)) {
    flags.push({ kind: "expired", validUntil: input.validUntil });
  }

  const optionalCount = lines.filter((line) => line.isOption && !line.isMandatory).length;
  if (optionalCount > 0) {
    flags.push({
      kind: "optional_remaining",
      count: optionalCount,
      amount: optionalOptionAmount,
    });
  }

  return {
    quoteId: input.quoteId,
    vendorId: input.vendorId,
    vendorName: input.vendorName,
    productName: input.productName,
    category: estimateCategoryOfVendor(input.vendorCategory),
    lines,
    baseAmount,
    mandatoryOptionAmount,
    optionalOptionAmount,
    realTotal,
    declaredTotal: input.declaredTotal,
    byCategory,
    flags,
    validUntil: input.validUntil,
  };
}

// =============================================================================
// 비교 — 사과와 오렌지를 나란히 두지 않는다
// =============================================================================

export const COMPARE_MIN = 2;
export const COMPARE_MAX = 5;

export type ComparisonRow = {
  category: EstimateCategory;
  label: string;
  /** 열 순서대로. 그 견적에 그 카테고리가 없으면 `null` — **0이 아니다.** */
  amounts: (number | null)[];
  /** 이 줄을 가진 견적이 하나뿐인가. §5.4 '과다 항목' 이다. */
  onlyOne: boolean;
};

export type ComparisonColumn = {
  quoteId: string;
  vendorName: string;
  productName: string | null;
  realTotal: number;
  /** 다른 견적에는 있는데 이 견적에는 없는 카테고리. §5.4 '항목 누락'. */
  missing: EstimateCategory[];
  flags: EstimateFlag[];
};

export type LowestVerdict =
  | { kind: "lowest"; quoteId: string; amount: number }
  /** 우열을 정하지 않는다. 사유를 함께 낸다. */
  | { kind: "not_comparable"; reason: "mixed_category" | "tie" | "not_enough" };

export type EstimateComparison = {
  columns: ComparisonColumn[];
  rows: ComparisonRow[];
  lowest: LowestVerdict;
  /** 모든 견적이 같은 카테고리인가. 아니면 총액 우열을 정하지 않는다. */
  sameCategory: boolean;
  /** 플래너 수수료가 따로 붙는다는 사실. 값을 더하지는 않는다. */
  plannerNote: string;
};

export const COMPARE_MIXED_CATEGORY_NOTE =
  "카테고리가 서로 다른 견적이라 총액 우열을 정하지 않았어요. 웨딩홀과 드레스를 나란히 두고 '더 싸다' 고 말할 수는 없습니다.";

/**
 * **플래너 수수료를 견적에 더하지 않는다.**
 *
 * 견적은 **업체와 고객 사이의 값**이고 플래너 수수료는 **다른 축**이다(D-43 —
 * 위임은 표 단위, 과금은 카테고리 단위). 무엇보다 같은 카테고리의 후보들에는
 * **같은 비율로 붙으므로 우열이 바뀌지 않는다.** 그래서 값을 섞지 않고 **사실만 적는다** —
 * 총액을 부풀려 보여 주면 사용자는 그것을 업체가 부른 값으로 읽는다.
 */
export const PLANNER_FEE_NOTE =
  "플래너를 쓰는 카테고리라면 여기에 플래너 수수료가 따로 붙어요. 후보 모두에 같은 비율로 붙으므로 순서는 바뀌지 않습니다.";

export function compareEstimates(estimates: readonly NormalizedEstimate[]): EstimateComparison {
  const columns: ComparisonColumn[] = [];
  const present = estimates.map((estimate) => new Set(Object.keys(estimate.byCategory)));

  // 줄 순서는 **표준 카테고리 순서**로 고정한다. 금액 순으로 두면 같은 견적이
  // 볼 때마다 다른 순서로 보인다(장바구니 비교·위상 정렬과 같은 규칙).
  const categories = ESTIMATE_CATEGORIES.filter((category) =>
    present.some((set) => set.has(category)),
  );

  for (const [index, estimate] of estimates.entries()) {
    columns.push({
      quoteId: estimate.quoteId,
      vendorName: estimate.vendorName,
      productName: estimate.productName,
      realTotal: estimate.realTotal,
      // **다른 견적에는 있는데 여기엔 없는 것.** 빠뜨린 항목을 화면이 짚는다.
      missing: categories.filter(
        (category) =>
          !present[index].has(category) && present.some((set) => set.has(category)),
      ),
      flags: estimate.flags,
    });
  }

  const rows: ComparisonRow[] = categories.map((category) => ({
    category,
    label: ESTIMATE_CATEGORY_LABEL[category],
    // **없는 칸은 `null` 이다.** 0으로 두면 "0원에 해 준다" 로 읽힌다.
    amounts: estimates.map((estimate) => estimate.byCategory[category] ?? null),
    onlyOne: present.filter((set) => set.has(category)).length === 1,
  }));

  const sameCategory = new Set(estimates.map((estimate) => estimate.category)).size <= 1;

  return {
    columns,
    rows,
    sameCategory,
    lowest: lowestOf(estimates, sameCategory),
    plannerNote: PLANNER_FEE_NOTE,
  };
}

/**
 * 가장 낮은 실총액.
 *
 * **카테고리가 섞이면 정하지 않는다** — 웨딩홀 1,200만과 드레스 150만을 나란히 두고
 * "드레스가 싸다" 고 적으면 표가 거짓말을 한다(D-77 이 장바구니에서 세운 규칙 그대로).
 * **동률도 정하지 않는다** — 하나를 고르면 그 순서가 우연히 정해진 것이 된다.
 */
function lowestOf(
  estimates: readonly NormalizedEstimate[],
  sameCategory: boolean,
): LowestVerdict {
  if (estimates.length < COMPARE_MIN) return { kind: "not_comparable", reason: "not_enough" };
  if (!sameCategory) return { kind: "not_comparable", reason: "mixed_category" };

  const min = Math.min(...estimates.map((estimate) => estimate.realTotal));
  const winners = estimates.filter((estimate) => estimate.realTotal === min);

  if (winners.length > 1) return { kind: "not_comparable", reason: "tie" };

  return { kind: "lowest", quoteId: winners[0].quoteId, amount: min };
}

export const LOWEST_REASON_NOTE: Record<
  Extract<LowestVerdict, { kind: "not_comparable" }>["reason"],
  string
> = {
  mixed_category: COMPARE_MIXED_CATEGORY_NOTE,
  tie: "실총액이 같아요. 금액만으로는 고를 수 없습니다.",
  not_enough: `견적을 ${COMPARE_MIN}개 이상 고르면 비교표를 만들어요.`,
};

// =============================================================================
// 화면 문구
// =============================================================================

/**
 * **업로드 슬롯이 없는 이유를 화면이 적는다.**
 *
 * §6.2 는 `/estimates` 에 "업로드 슬롯" 을 적었지만, 이 제품에는 **자유 양식 견적이
 * 존재하지 않는다** — 업체는 표준 폼으로만 응답한다(F-V-07). 업로드 경로는 §5.4 1단계의
 * LLM 파싱을 전제하는데 **PDF 파서·OCR 은 새 의존성**이라 열려 있지 않다(D-56 — S7-03 이
 * 같은 이유로 `text/plain` 만 읽는다). **빈 슬롯을 그려 두지 않는다** — 누를 수 있는데
 * 아무 일도 안 일어나는 자리가 가장 나쁘다.
 */
export const NO_UPLOAD_NOTE =
  "견적은 업체가 표준 양식으로 보내 주는 것만 비교해요. 종이·PDF 견적을 올리는 기능은 아직 없습니다.";

export const COMPARE_INTRO =
  "받은 견적을 표준 항목으로 맞춰 나란히 놓아요. 선택 옵션은 실총액에 넣지 않고 따로 알려드립니다.";
