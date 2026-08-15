import { STYLE_TAG_LABEL, type StyleTag } from "../schemas/onboarding";
import {
  SEARCH_FIELDS,
  SEARCH_FIELD_LABEL,
  type SearchCondition,
  type SearchField,
} from "../schemas/search";
import { VENDOR_CATEGORY_LABEL, type VendorCategory } from "../schemas/vendor";

import { sortConditions } from "./parse";
import type { RankFilter } from "./rank";

/**
 * 조건 → 필터 (S7-02 · 명세서 §5.5 2단계)
 *
 * 조회는 **탐색과 같은 함수**(`searchVendors`)를 쓴다(§5.5 2단계 · S3-03). 조건 검색이
 * 자기 쿼리를 따로 쓰면 같은 조건이 `/explore` 와 `/search` 에서 다른 결과를 낸다.
 * 그래서 이 파일이 하는 일은 조건 목록을 **그 함수가 받는 모양으로 옮기는 것**뿐이다.
 *
 * **사용자가 고친 값이 언제나 이긴다.** 파싱 결과는 되돌려 보여주고 고칠 수 있어야 하며
 * (§5.5), 고친 값이 다음 조회에서 다시 파서에게 덮이면 고칠 수 있다는 말이 거짓이 된다.
 */

/** 사용자가 지운 조건. 지운 사실을 URL 이 갖고 있어야 링크를 공유해도 같은 화면이 나온다. */
export type DroppedField = SearchField;

export function applyUserConditions(input: {
  parsed: SearchCondition[];
  /** 화면에서 직접 고른 값(`origin: "user"`). 같은 필드의 파싱 결과를 밀어낸다. */
  user: SearchCondition[];
  dropped: DroppedField[];
}): SearchCondition[] {
  const userFields = new Set(input.user.map((condition) => condition.field));
  const dropped = new Set(input.dropped);

  const kept = input.parsed.filter(
    (condition) => !userFields.has(condition.field) && !dropped.has(condition.field),
  );

  return sortConditions([...kept, ...input.user.filter((condition) => !dropped.has(condition.field))]);
}

/** 조건 목록에서 한 필드의 값을 꺼낸다. */
export function valueOf<T>(conditions: SearchCondition[], field: SearchField): T | null {
  const found = conditions.find((condition) => condition.field === field);

  return found === undefined ? null : (found.value as T);
}

/**
 * `searchVendors` 입력.
 *
 * **`onlyAvailable` 을 켜지 않는다.** 날짜를 말했다고 해서 자리 없는 곳을 목록에서 빼면
 * 캘린더를 등록한 업체만 보이게 되고, 그건 사용자가 이유를 알 수 없는 순서가 된다
 * (S3-03 의 `AVAILABILITY_FILTER_NOTICE` 와 같은 판단). 대신 자리가 확인된 곳에 **가점**하고
 * (`rank.ts`) 거르기는 사용자가 고르게 한다.
 */
export function toExploreFilterInput(conditions: SearchCondition[], page: number) {
  return {
    region: valueOf<string>(conditions, "region"),
    category: valueOf<VendorCategory>(conditions, "category"),
    budgetMin: valueOf<number>(conditions, "budgetMin"),
    budgetMax: valueOf<number>(conditions, "budgetMax"),
    guestCount: valueOf<number>(conditions, "guestCount"),
    date: valueOf<string>(conditions, "date"),
    styleTags: valueOf<StyleTag[]>(conditions, "styleTags") ?? [],
    onlyAvailable: false,
    // 부합도 정렬은 조회 뒤에 한다. DB 에게는 **안정적인 후보 순서**만 요구한다.
    sort: "price_asc" as const,
    page,
  };
}

/** 랭킹이 보는 조건. 필터와 같은 값에서 나와야 순서와 결과가 어긋나지 않는다. */
export function toRankFilter(conditions: SearchCondition[]): RankFilter {
  return {
    region: valueOf<string>(conditions, "region"),
    guestCount: valueOf<number>(conditions, "guestCount"),
    date: valueOf<string>(conditions, "date"),
    styleTags: valueOf<StyleTag[]>(conditions, "styleTags") ?? [],
  };
}

// =============================================================================
// 되돌려 보여주기 (§5.5 — 칩)
// =============================================================================

const AMOUNT_UNITS: { unit: number; suffix: string }[] = [
  { unit: 100_000_000, suffix: "억" },
  { unit: 10_000, suffix: "만" },
];

/** 금액을 사람이 읽는 단위로. 딱 떨어지지 않으면 원 단위 그대로 적는다. */
export function formatAmount(amount: number): string {
  for (const { unit, suffix } of AMOUNT_UNITS) {
    if (amount >= unit && amount % unit === 0) return `${(amount / unit).toLocaleString("ko-KR")}${suffix}원`;
  }

  return `${amount.toLocaleString("ko-KR")}원`;
}

/**
 * 칩 문구.
 *
 * **해석까지 적는다** — "3천만원" 을 상한으로 읽었다는 사실이 화면에 없으면 사용자는
 * 자기가 하한을 말했다고 생각한 채 결과를 읽는다(§5.5 — 오해석을 바로잡을 수 있어야 한다).
 */
export function conditionChipLabel(condition: SearchCondition): string {
  switch (condition.field) {
    case "region":
      return `지역 · ${condition.value}`;
    case "category":
      return `카테고리 · ${VENDOR_CATEGORY_LABEL[condition.value]}`;
    case "date":
      return `예식일 · ${condition.value}`;
    case "guestCount":
      return `하객 · ${condition.value.toLocaleString("ko-KR")}명`;
    case "budgetMin":
      return `예산 · ${formatAmount(condition.value)} 이상`;
    case "budgetMax":
      return `예산 · ${formatAmount(condition.value)} 이하`;
    case "styleTags":
      return `스타일 · ${condition.value.map((tag) => STYLE_TAG_LABEL[tag]).join("·")}`;
  }
}

/**
 * 아직 비어 있는 조건.
 *
 * 명세 §5.5 1단계의 실패 처리 — "파싱 실패 시 해당 조건을 비우고 **사용자에게 직접 선택을
 * 요청**한다". 그러려면 무엇이 비었는지 화면이 알아야 한다.
 */
export function emptyFields(conditions: SearchCondition[]): SearchField[] {
  const filled = new Set(conditions.map((condition) => condition.field));
  // 예산은 하한·상한을 한 칸으로 센다 — 둘 중 하나만 있어도 "예산을 말했다".
  const budgetFilled = filled.has("budgetMin") || filled.has("budgetMax");

  return SEARCH_FIELDS.filter((field) => {
    if (field === "budgetMin") return !budgetFilled;
    if (field === "budgetMax") return false;

    return !filled.has(field);
  });
}

export function emptyFieldLabel(field: SearchField): string {
  return field === "budgetMin" ? "예산" : SEARCH_FIELD_LABEL[field];
}
