import {
  AiSearchConditionListSchema,
  SEARCH_VALUE_SCHEMA,
  type AiDiscarded,
  type SearchCondition,
  type SearchField,
} from "../schemas/search";

import { sortConditions, type RuleParseResult } from "./parse";

/**
 * AI 보조 파서 결과 병합 (S7-02 · 명세서 §5.5 · CLAUDE.md §8)
 *
 * 모델이 낸 조건을 **그대로 믿지 않는다.** 세 관문을 통과한 것만 조건이 된다.
 *
 *  1. **스키마** — zod 로 모양을 검증한다. 실패하면 조건 하나가 아니라 응답 전체를
 *     되돌리고 호출자가 1회 재시도한다(재실패 시 룰 결과만 쓴다).
 *  2. **인용 대조** — `sourceText` 가 입력에 **문자열로 실재**해야 한다. 이것이 계약서
 *     검토(§5.2)의 인용 대조와 같은 장치다: 근거가 원문에 없으면 모델이 지어낸 것이므로
 *     **그 조건만 개별 폐기**한다. 조건 검색에서 이 장치가 특히 중요한 이유는, 지어낸
 *     조건이 그대로 **DB 필터**가 되어 사용자가 말한 적 없는 이유로 결과를 좁히기 때문이다.
 *  3. **값 검증** — 필드별 스키마(`SEARCH_VALUE_SCHEMA`)를 통과해야 한다. 카테고리·스타일은
 *     열거값이라 모델이 없는 코드를 만들면 여기서 걸린다.
 *
 * **룰이 이긴다.** 룰이 이미 읽은 필드는 모델 결과로 덮지 않는다 — 결정적인 해석을
 * 비결정적인 해석으로 바꾸면 같은 입력이 매번 다른 결과를 낼 수 있다.
 */

export type MergeOutcome = {
  /** 세 관문을 통과한 AI 조건. 룰 조건과 합쳐진 최종 목록은 `conditions` 다. */
  conditions: SearchCondition[];
  accepted: SearchCondition[];
  discarded: AiDiscarded[];
  /** 스키마 검증 자체가 실패했다면 그 요약. 호출자는 이걸 붙여 1회 재시도한다. */
  schemaError: string | null;
};

/** 대조용 정규화. 공백·대소문자 차이로 근거를 버리지는 않는다. */
function normalize(value: string): string {
  return value.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();
}

/** 입력에 그 문구가 실재하는가(인용 대조). */
export function quoteExists(text: string, quote: string): boolean {
  const haystack = normalize(text);
  const needle = normalize(quote);

  return needle.length > 0 && haystack.includes(needle);
}

/** 필드별 값 검증. 모델은 숫자를 문자열로 내기도 하므로 **그 정도만** 받아 준다. */
function coerce(field: SearchField, value: unknown): unknown {
  if (field === "styleTags") return Array.isArray(value) ? value : [value];

  if (field === "budgetMin" || field === "budgetMax" || field === "guestCount") {
    if (typeof value === "number") return value;
    if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value.trim());

    return value;
  }

  return value;
}

export function mergeAiConditions(input: {
  text: string;
  rule: RuleParseResult;
  /** 모델 응답을 JSON 으로 읽은 값. 파싱조차 못 했으면 `null` 을 넘긴다. */
  raw: unknown;
}): MergeOutcome {
  const ruleFields = new Set(input.rule.conditions.map((condition) => condition.field));

  const parsed = AiSearchConditionListSchema.safeParse(input.raw);
  if (!parsed.success) {
    return {
      conditions: input.rule.conditions,
      accepted: [],
      discarded: [],
      schemaError: parsed.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join(" / "),
    };
  }

  const accepted: SearchCondition[] = [];
  const discarded: AiDiscarded[] = [];
  const seen = new Set<SearchField>();

  for (const candidate of parsed.data.conditions) {
    const { field, sourceText } = candidate;

    if (ruleFields.has(field) || seen.has(field)) {
      // 룰이 이미 읽었거나 모델이 같은 필드를 두 번 냈다. 먼저 온 것이 남는다.
      discarded.push({ field, sourceText, reason: "rule_wins" });
      continue;
    }

    if (!quoteExists(input.text, sourceText)) {
      // 근거가 입력에 없다 = 지어낸 조건이다. 개별 폐기한다(§5.2 인용 대조와 같은 규칙).
      discarded.push({ field, sourceText, reason: "quote_mismatch" });
      continue;
    }

    const checked = SEARCH_VALUE_SCHEMA[field].safeParse(coerce(field, candidate.value));
    if (!checked.success) {
      discarded.push({ field, sourceText, reason: "invalid_value" });
      continue;
    }

    /**
     * 지역은 자유 텍스트라 열거값이 지켜 주지 못한다. 그래서 **값 자체도 입력에 있어야**
     * 한다고 요구한다 — 모델이 "강남" 이라 적힌 문장을 근거로 "서초" 를 내는 것을 막는
     * 유일한 장치다.
     */
    if (field === "region" && !quoteExists(input.text, String(checked.data))) {
      discarded.push({ field, sourceText, reason: "invalid_value" });
      continue;
    }

    seen.add(field);
    accepted.push({ field, value: checked.data, sourceText, origin: "ai" } as SearchCondition);
  }

  const merged = dropInvertedBudget([...input.rule.conditions, ...accepted], discarded);

  return {
    conditions: sortConditions(merged),
    accepted: accepted.filter((condition) => merged.includes(condition)),
    discarded,
    schemaError: null,
  };
}

/**
 * 예산 하한이 상한보다 큰 조합은 조회 스키마에서 422 가 된다.
 * 그 실패를 사용자에게 넘기지 않고 **AI 가 만든 쪽을 버린다** — 룰 조건이 살아남아야
 * 검색이 서고, 버린 사실은 기록에 남는다.
 */
function dropInvertedBudget(conditions: SearchCondition[], discarded: AiDiscarded[]): SearchCondition[] {
  const min = conditions.find((condition) => condition.field === "budgetMin");
  const max = conditions.find((condition) => condition.field === "budgetMax");

  if (min === undefined || max === undefined) return conditions;
  if ((min.value as number) <= (max.value as number)) return conditions;

  const victim = min.origin === "ai" ? min : max.origin === "ai" ? max : null;
  if (victim === null) return conditions;

  discarded.push({ field: victim.field, sourceText: victim.sourceText, reason: "invalid_value" });

  return conditions.filter((condition) => condition !== victim);
}
