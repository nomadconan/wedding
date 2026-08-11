import { z } from "zod";

import { STYLE_TAGS, type StyleTag } from "./onboarding";
import { VENDOR_CATEGORIES, VendorCategorySchema } from "./vendor";

/**
 * 업체 탐색 (S3-03 · 명세서 §2.1 F-C-10·F-C-11·F-C-12, §4.2 GET /api/vendors, §6.2)
 *
 * 프레임워크를 모르는 순수 모듈이다. 화면(`/explore`)과 API(`/api/vendors`)가 **같은 함수**를
 * 써야 필터 해석이 둘로 갈리지 않는다.
 *
 * **정렬 기준은 코드로 응답과 화면에 함께 나간다**(D-03 · CLAUDE.md §2.2). 유료 노출이
 * 없다는 사실은 문장이 아니라 화면으로 증명한다.
 */

// =============================================================================
// 정렬
// =============================================================================

/**
 * 이번 단계에서 **실제로 계산할 수 있는** 정렬만 연다.
 * `SortCriteriaBadge` 의 코드 집합 중 부분집합이며, 배지는 이 코드를 그대로 받는다.
 */
export const EXPLORE_SORTS = ["price_asc", "price_desc", "price_index_gap", "recent"] as const;

export type ExploreSort = (typeof EXPLORE_SORTS)[number];

export const ExploreSortSchema = z.enum(EXPLORE_SORTS);

/**
 * 기본 정렬은 **가격 낮은 순**이다.
 *
 * 이 제품의 근간은 가격 정찰제(D-03)이고, 목록의 첫 줄이 그것을 증명해야 한다.
 * '추천순' 같은 이름의 기본값은 무엇으로 줄 세웠는지 사용자가 확인할 수 없어서
 * 유료 노출과 구분되지 않는다 — 기준을 말할 수 없는 정렬은 기본값으로 쓰지 않는다.
 * '최근 등록순'도 후보였으나 늦게 들어온 업체가 계속 위에 오는 노출 비대칭이 생긴다.
 */
export const DEFAULT_EXPLORE_SORT: ExploreSort = "price_asc";

/**
 * **참가격 대비 편차 순은 S3-08 에서 열었다.** 지수가 없는 지역·카테고리의 업체는
 * 목록에서 빼지 않고 **맨 뒤에 두고 '비교 기준 없음'** 으로 적는다 — 빼면 지수가 있는
 * 지역의 업체가 유리해지는 노출 비대칭이 생기고, 그건 업체가 한 일이 아니라 아직
 * 표본이 모이지 않았다는 우리 쪽 사정이다(재고 캘린더 판단과 같은 결).
 *
 * **지금 열지 않는 정렬과 그 이유.**
 *
 * 목록에서 조용히 빼면 "그런 정렬은 없다"로 읽힌다. 데이터가 없어서 못 하는 것과
 * 하지 않기로 한 것은 다르므로 화면에 이유를 밝힌다(S2-08 에서 세운 원칙과 같다).
 */
export const EXPLORE_SORT_PENDING: { code: string; label: string; reason: string; task: string }[] = [
  {
    code: "review_score",
    label: "후기 점수 순",
    reason: "후기 데이터가 아직 없습니다.",
    task: "S8-02",
  },
  {
    code: "available_date",
    label: "예약 가능일 순",
    reason: "재고 캘린더를 등록한 업체가 일부라, 지금 정렬하면 등록 여부가 순서를 정하게 됩니다.",
    task: "S2-05",
  },
  // S4-12 가 **기록할 자리를 만들었다**(`inquiry_targets.created_at → responded_at`).
  // 그래도 아직 열지 않는다 — 이유가 "스키마가 없다" 에서 "표본이 없다" 로 바뀌었다.
  // 문의를 받아 본 적 없는 업체가 대부분인 동안 이 정렬을 켜면, 응답이 빠른 순이
  // 아니라 **문의를 받아 본 적이 있는지**가 순서를 정한다. 그건 업체가 한 일이
  // 아니라 우리 쪽 사정이고, `available_date` 와 정확히 같은 종류의 노출 비대칭이다.
  {
    code: "response_speed",
    label: "응답 속도 순",
    reason:
      "응답 기록이 쌓인 업체가 아직 일부라, 지금 정렬하면 문의를 받아 본 적이 있는지가 순서를 정하게 됩니다.",
    task: "S4-12",
  },
];

// =============================================================================
// 필터 (§2.1 F-C-10 — 지역·예산·하객수·날짜·스타일)
// =============================================================================

const DateStringSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "날짜는 YYYY-MM-DD 형식으로 입력해 주세요.");

const AmountSchema = z
  .number()
  .int("금액은 원 단위 정수로 입력해 주세요.")
  .min(0, "금액은 0 이상이어야 합니다.")
  .max(10_000_000_000, "금액을 다시 확인해 주세요.");

export const EXPLORE_PAGE_SIZE = 20;

/**
 * 필터 조합.
 *
 * 전부 선택 사항이다. 비로그인 사용자도 아무것도 고르지 않고 목록을 볼 수 있어야 한다(§1.4).
 */
export const ExploreFilterSchema = z
  .object({
    region: z.string().trim().min(1).max(40).nullable().default(null),
    category: VendorCategorySchema.nullable().default(null),
    /** 예산 상한. **판매가 기준**이다(플래너 수수료 제외 — 아래 주석 참조). */
    budgetMax: AmountSchema.nullable().default(null),
    budgetMin: AmountSchema.nullable().default(null),
    guestCount: z.number().int().min(0).max(100_000).nullable().default(null),
    date: DateStringSchema.nullable().default(null),
    styleTags: z.array(z.enum(STYLE_TAGS)).max(STYLE_TAGS.length).default([]),
    /** 고른 날짜에 자리가 확인된 업체만 본다. **기본은 꺼짐**이다(아래 근거). */
    onlyAvailable: z.boolean().default(false),
    sort: ExploreSortSchema.default(DEFAULT_EXPLORE_SORT),
    page: z.number().int().min(1).max(500).default(1),
  })
  .superRefine((input, ctx) => {
    if (input.budgetMin !== null && input.budgetMax !== null && input.budgetMin > input.budgetMax) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["budgetMax"],
        message: "예산 하한이 상한보다 큽니다.",
      });
    }

    if (input.onlyAvailable && input.date === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["onlyAvailable"],
        message: "날짜를 먼저 고르면 자리 있는 곳만 볼 수 있어요.",
      });
    }
  });

export type ExploreFilter = z.output<typeof ExploreFilterSchema>;

/**
 * 예산 필터가 **판매가 기준**인 이유 (D-17 · F-C-31).
 *
 * 플래너 수수료는 **카테고리별 부분 선택**이라 탐색 시점에는 아직 고르지 않은 값이다.
 * 포함하려면 "골랐다고 가정" 해야 하는데, 그건 조회하지 않은 상태에서 수치를 만들어
 * 내는 일이다. 게다가 플래너 요율은 업체·카테고리별 차등이고 미설정일 수 있어
 * 미설정 구간에서는 금액 자체가 존재하지 않는다(S2-03 에서 세운 원칙 — 요율이 없으면
 * 금액을 날조하지 않고 '미설정'이라고 적는다).
 *
 * 대신 **감추지는 않는다.** 화면은 이 문구를 상시 노출하고, `PriceDisplay` 의 플래너
 * 행은 '선택 안 함' 으로 항상 보인다(행을 숨기지 않는다).
 */
export const BUDGET_FILTER_NOTICE =
  "예산은 업체 판매가 기준입니다. 플래너 수수료는 고른 뒤에 더해지며 여기엔 포함하지 않았습니다.";

/** 목록 가격은 정가다. 날짜에 따라 달라질 수 있다는 사실을 목록에서 미리 밝힌다(F-C-12). */
export const LIST_PRICE_NOTICE =
  "목록 가격은 업체가 등록한 판매가입니다. 날짜에 따라 달라지는 최종가는 업체 상세에서 확인할 수 있어요.";

// =============================================================================
// 예약 가능 여부 (F-C-11)
// =============================================================================

/**
 * 그 날짜의 상태.
 *
 * **'모른다'와 '자리가 없다'를 구분한다.** 재고 캘린더(S2-05)는 업체가 등록하는
 * 선택 사항이라, 슬롯이 없다는 것은 "그날 마감"이 아니라 "업체가 캘린더를 올리지
 * 않았다"는 뜻이다. 둘을 같은 화면 문구로 뭉치면 사실이 아닌 정보를 말하게 된다.
 */
export type AvailabilityState =
  | { kind: "available"; remaining: number; slotCount: number }
  | { kind: "full" }
  | { kind: "blocked" }
  | { kind: "unknown" };

export type AvailabilitySlot = {
  status: string;
  capacity: number;
  remaining: number;
};

export function availabilityOf(slots: AvailabilitySlot[]): AvailabilityState {
  if (slots.length === 0) return { kind: "unknown" };

  const open = slots.filter((slot) => slot.status === "open");
  if (open.length === 0) return { kind: "blocked" };

  const remaining = open.reduce((sum, slot) => sum + slot.remaining, 0);
  if (remaining <= 0) return { kind: "full" };

  return { kind: "available", remaining, slotCount: open.length };
}

export const AVAILABILITY_LABEL: Record<AvailabilityState["kind"], string> = {
  available: "예약 가능",
  full: "그날은 마감",
  blocked: "그날은 휴무",
  unknown: "예약 가능 여부 미확인",
};

export const AVAILABILITY_NOTE: Record<AvailabilityState["kind"], string> = {
  available: "업체가 등록한 잔여 자리입니다.",
  full: "업체가 등록한 자리가 모두 찼습니다.",
  blocked: "업체가 그날을 쉬는 날로 등록했습니다.",
  unknown: "업체가 캘린더를 등록하지 않아 확인할 수 없습니다. 문의로 확인해 주세요.",
};

/**
 * **자리 없는 업체를 목록에서 빼지 않는 이유.**
 *
 * 재고 캘린더는 업체 선택 사항이다. 등록하지 않은 업체를 날짜 필터로 걸러 내면
 * "캘린더를 올린 업체가 위에 오는" 노출 비대칭이 생긴다. 그건 유료 노출은 아니지만
 * 사용자가 이유를 알 수 없는 순서라는 점에서 우리가 없애려는 것과 같은 종류다.
 * 그래서 **상태를 표시하고 거르기는 사용자가 고르게** 한다(`onlyAvailable`).
 */
export const AVAILABILITY_FILTER_NOTICE =
  "캘린더를 등록하지 않은 업체도 목록에 남겨 뒀습니다. 자리 있는 곳만 보려면 아래를 켜 주세요.";

/** 잔여율(bp). 재고 정보가 없으면 null 이고, 그러면 잔여율 룰은 적용되지 않는다(S2-06). */
export function occupancyRatioBp(slots: AvailabilitySlot[]): number | null {
  const open = slots.filter((slot) => slot.status === "open");
  if (open.length === 0) return null;

  const capacity = open.reduce((sum, slot) => sum + slot.capacity, 0);
  if (capacity <= 0) return null;

  const remaining = open.reduce((sum, slot) => sum + slot.remaining, 0);

  return Math.round((remaining * 10_000) / capacity);
}

// =============================================================================
// 다이내믹 가격 (F-C-12)
// =============================================================================

/**
 * 남은 일수. **두 날짜를 모두 호출자가 넘긴다.**
 *
 * S2-06 에서 세운 규칙 — 서버가 '오늘'을 마음대로 정하면 같은 입력으로 같은 결과가
 * 안 나온다. 그래서 기준일도 인자이고, API 는 계산에 쓴 기준일(`asOf`)을 응답에
 * 함께 돌려준다. 그래야 고객이 본 금액을 나중에 재현할 수 있다.
 */
export function leadTimeDays(asOf: string, eventDate: string): number {
  const from = Date.parse(`${asOf}T00:00:00Z`);
  const to = Date.parse(`${eventDate}T00:00:00Z`);

  if (Number.isNaN(from) || Number.isNaN(to)) {
    throw new RangeError("날짜는 YYYY-MM-DD 형식이어야 합니다.");
  }

  return Math.round((to - from) / 86_400_000);
}

/**
 * 정가 대비 할인율(bp). 할증이면 음수다.
 * 화면은 이 값을 그대로 쓰고 자기 계산을 하지 않는다.
 */
export function discountRateBp(basePrice: number, finalPrice: number): number {
  if (basePrice <= 0) return 0;

  return Math.round(((basePrice - finalPrice) * 10_000) / basePrice);
}

/** 날짜를 고르지 않았을 때. 없는 할인을 지어내지 않고 이유를 적는다. */
export const DYNAMIC_PRICE_NEEDS_DATE =
  "날짜를 고르면 그날 기준 최종가와 할인 사유를 보여드려요. 지금은 업체가 등록한 판매가입니다.";

// =============================================================================
// 결과 0건 — 어느 조건을 풀면 나오는가
// =============================================================================

export const EXPLORE_FILTER_KEYS = [
  "region",
  "category",
  "budget",
  "guestCount",
  "date",
  "styleTags",
  "onlyAvailable",
] as const;

export type ExploreFilterKey = (typeof EXPLORE_FILTER_KEYS)[number];

export const EXPLORE_FILTER_LABEL: Record<ExploreFilterKey, string> = {
  region: "지역",
  category: "카테고리",
  budget: "예산",
  guestCount: "하객 수",
  date: "날짜",
  styleTags: "스타일",
  onlyAvailable: "자리 있는 곳만",
};

/** 지금 걸려 있는 조건. 0건 안내와 칩 표시가 같은 목록을 쓴다. */
export function activeFilterKeys(filter: ExploreFilter): ExploreFilterKey[] {
  const keys: ExploreFilterKey[] = [];

  if (filter.region !== null) keys.push("region");
  if (filter.category !== null) keys.push("category");
  if (filter.budgetMin !== null || filter.budgetMax !== null) keys.push("budget");
  if (filter.guestCount !== null) keys.push("guestCount");
  if (filter.date !== null) keys.push("date");
  if (filter.styleTags.length > 0) keys.push("styleTags");
  if (filter.onlyAvailable) keys.push("onlyAvailable");

  return keys;
}

/** 조건 하나를 뺀 필터. 0건일 때 "이걸 풀면 몇 건" 을 세기 위한 것이다. */
export function withoutFilter(filter: ExploreFilter, key: ExploreFilterKey): ExploreFilter {
  switch (key) {
    case "region":
      return { ...filter, region: null };
    case "category":
      return { ...filter, category: null };
    case "budget":
      return { ...filter, budgetMin: null, budgetMax: null };
    case "guestCount":
      return { ...filter, guestCount: null };
    case "date":
      // 날짜를 풀면 '자리 있는 곳만'도 함께 풀린다. 날짜 없이는 성립하지 않는 조건이다.
      return { ...filter, date: null, onlyAvailable: false };
    case "styleTags":
      return { ...filter, styleTags: [] };
    case "onlyAvailable":
      return { ...filter, onlyAvailable: false };
  }
}

export type RelaxationHint = { key: ExploreFilterKey; label: string; count: number };

/**
 * 결과가 나오는 조건만 남기고, **효과가 큰 순서**로 정렬한다.
 * 풀어도 0건인 조건은 힌트가 아니라 소음이라 버린다.
 */
export function rankRelaxationHints(hints: RelaxationHint[]): RelaxationHint[] {
  return hints
    .filter((hint) => hint.count > 0)
    .sort((a, b) => (b.count === a.count ? a.key.localeCompare(b.key) : b.count - a.count));
}

// =============================================================================
// 게시 조건 — 목록에 나올 수 있는 상품
// =============================================================================

/**
 * 조회 조건으로 다시 확인하는 게시 요건.
 *
 * DB CHECK(`products_publish_requirements_chk`)와 RLS(`products_select_public`)가
 * 이미 막고 있지만, **조회 쪽에서도 명시한다.** 층이 하나뿐이면 그 층을 고치는 순간
 * 미확정 상품이 고객 화면에 새어 나가고, 그건 "고객이 본 총액이 나중에 늘어날 수
 * 있다"는 뜻이다(F-V-04 정책의 정면 위반).
 */
export const PUBLISHED_PRODUCT_CONDITIONS = {
  status: "published",
  vendorStatus: "active",
  /** 추가금 사전 등록이 확정된 것만. null 이면 미등록이다. */
  addOnsDeclared: true,
} as const;

export const CATEGORY_VALUES = VENDOR_CATEGORIES;
export type { StyleTag };
