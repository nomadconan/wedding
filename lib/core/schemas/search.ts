import { z } from "zod";

import { STYLE_TAGS, type StyleTag } from "./onboarding";
import { VENDOR_CATEGORIES, type VendorCategory } from "./vendor";

/**
 * 조건 검색 (S7-02 · 명세서 §2.1 F-C-30, §4.2 GET/POST /api/search, §5.5, §6.2 `/search`)
 *
 * "3월 14일 강남 300인" 같은 **자연어와 조건이 섞인 입력**을 구조화 조건으로 바꾼다.
 * 이 파일은 그 조건의 **모양**만 갖는다 — 읽는 규칙은 `lib/core/search/parse.ts`,
 * 줄 세우는 규칙은 `lib/core/search/rank.ts` 다.
 *
 * **조건은 언제나 출처를 달고 다닌다**(`origin` · `sourceText`).
 *  · 화면이 칩으로 되돌려 보여주려면 "입력의 어느 부분을 그렇게 읽었는지" 가 필요하고,
 *  · AI 가 만든 조건은 **그 부분이 입력에 실재하는지 대조해서 버리기** 때문이다(§5.5 · CLAUDE.md §8).
 * 출처 없는 조건은 사용자가 오해석을 바로잡을 수 없고, 대조할 수도 없다.
 */

// =============================================================================
// 조건
// =============================================================================

export const SEARCH_FIELDS = [
  "region",
  "category",
  "budgetMin",
  "budgetMax",
  "guestCount",
  "date",
  "styleTags",
] as const;

export type SearchField = (typeof SEARCH_FIELDS)[number];

export const SEARCH_FIELD_LABEL: Record<SearchField, string> = {
  region: "지역",
  category: "카테고리",
  budgetMin: "예산 하한",
  budgetMax: "예산 상한",
  guestCount: "하객 수",
  date: "예식일",
  styleTags: "스타일",
};

/**
 * 이 조건을 누가 만들었는가.
 *
 * · `rule` — 코드가 읽었다. **결정적**이며 같은 입력이면 항상 같은 결과다.
 * · `ai` — 룰이 못 읽은 부분을 모델이 읽었다. **인용 대조를 통과한 것만** 여기까지 온다.
 * · `user` — 사용자가 칩을 고치거나 직접 골랐다. **다른 둘을 언제나 이긴다.**
 */
export type ConditionOrigin = "rule" | "ai" | "user";

export const CONDITION_ORIGIN_LABEL: Record<ConditionOrigin, string> = {
  rule: "입력에서 읽음",
  ai: "AI 가 읽음",
  user: "직접 고름",
};

export type SearchCondition =
  | { field: "region"; value: string; sourceText: string; origin: ConditionOrigin }
  | { field: "category"; value: VendorCategory; sourceText: string; origin: ConditionOrigin }
  | { field: "budgetMin"; value: number; sourceText: string; origin: ConditionOrigin }
  | { field: "budgetMax"; value: number; sourceText: string; origin: ConditionOrigin }
  | { field: "guestCount"; value: number; sourceText: string; origin: ConditionOrigin }
  | { field: "date"; value: string; sourceText: string; origin: ConditionOrigin }
  | { field: "styleTags"; value: StyleTag[]; sourceText: string; origin: ConditionOrigin };

/**
 * 형태는 알아봤지만 조건으로 만들지 못한 조각.
 *
 * **조용히 버리지 않는다.** "2월 30일" 을 말없이 무시하면 사용자는 날짜가 걸린 줄 알고
 * 결과를 읽는다. 무엇을 왜 못 썼는지 화면에 적고, 대신 직접 고르라고 안내한다(§5.5 1단계).
 */
export type RejectedCondition = {
  sourceText: string;
  reason: string;
};

/** 자유 입력 상한. 조건 검색은 **한 번의 입력**이지 대화가 아니다(대화는 F-C-03). */
export const SEARCH_QUERY_MAX = 200;

export const SearchQuerySchema = z.string().trim().max(SEARCH_QUERY_MAX);

// =============================================================================
// AI 보조 파서의 출력 (§5.5 1단계 · CLAUDE.md §8)
// =============================================================================

/**
 * 모델이 돌려줘야 하는 모양.
 *
 * **`sourceText` 를 반드시 받는다.** 이것이 인용 대조의 재료다 — 입력에 없는 문구를
 * 근거로 든 조건은 모델이 지어낸 것이므로 개별 폐기한다(CLAUDE.md §8 · §5.5).
 * `value` 는 여기서 느슨하게 받고 필드별 검증은 병합 단계가 한다 — 모델이 타입을 틀리는 것과
 * 값을 지어내는 것은 다른 실패이고, 섞으면 어느 쪽인지 알 수 없다.
 */
export const AiSearchConditionSchema = z.object({
  field: z.enum(SEARCH_FIELDS),
  value: z.union([z.string(), z.number(), z.array(z.string())]),
  sourceText: z.string().min(1).max(SEARCH_QUERY_MAX),
});

export type AiSearchCondition = z.infer<typeof AiSearchConditionSchema>;

export const AiSearchConditionListSchema = z.object({
  conditions: z.array(AiSearchConditionSchema).max(SEARCH_FIELDS.length),
});

/** 병합 단계가 조건을 버린 이유. 화면에는 나가지 않고 **분석 기록**에 남는다(§5.8). */
export const AI_DISCARD_REASONS = [
  "quote_mismatch",
  "rule_wins",
  "invalid_value",
  "unknown_field",
] as const;

export type AiDiscardReason = (typeof AI_DISCARD_REASONS)[number];

export type AiDiscarded = {
  field: string;
  sourceText: string;
  reason: AiDiscardReason;
};

/**
 * AI 보조를 쓰지 못한 이유.
 *
 * **'안 썼다' 와 '실패했다' 를 구분한다.** 키가 없어서 룰만 돈 것과 모델이 스키마를 두 번
 * 틀려서 룰만 남은 것은 운영자가 봐야 할 사건의 종류가 다르다(D-28 계열 판단).
 */
export const AI_PARSE_SKIP_REASONS = [
  "no_key",
  "nothing_left",
  "invalid_output",
  "call_failed",
] as const;

export type AiParseSkipReason = (typeof AI_PARSE_SKIP_REASONS)[number];

// =============================================================================
// 값 검증 — 필드별
// =============================================================================

const DateStringSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** 필드별 값 스키마. 룰·AI·사용자 입력이 **같은 자를 통과**해야 한다. */
export const SEARCH_VALUE_SCHEMA = {
  region: z.string().trim().min(1).max(40),
  category: z.enum(VENDOR_CATEGORIES),
  budgetMin: z.number().int().min(0).max(10_000_000_000),
  budgetMax: z.number().int().min(0).max(10_000_000_000),
  guestCount: z.number().int().min(1).max(100_000),
  date: DateStringSchema,
  styleTags: z.array(z.enum(STYLE_TAGS)).min(1).max(STYLE_TAGS.length),
} as const;

export type { StyleTag, VendorCategory };
