import type { SupabaseClient } from "@supabase/supabase-js";
import type { ZodIssue } from "zod";

import { parseSearchWithAi } from "@/lib/ai/search-parse";
import {
  SEARCH_FIELDS,
  SEARCH_VALUE_SCHEMA,
  SearchQuerySchema,
  type AiDiscardReason,
  type AiParseSkipReason,
  type RejectedCondition,
  type SearchCondition,
  type SearchField,
} from "@/lib/core/schemas/search";
import {
  applyUserConditions,
  emptyFields,
  toExploreFilterInput,
  toRankFilter,
} from "@/lib/core/search/filter";
import { parseSearchQuery } from "@/lib/core/search/parse";
import {
  FIT_RULES,
  FIT_TIE_BREAK,
  hasRankableCondition,
  rankByFit,
  rankingCodeFor,
  scoreFit,
  type FitScore,
  type SearchRankingCode,
} from "@/lib/core/search/rank";
import { searchVendors, type ExploreResult, type ExploreRow } from "@/lib/explore/query";

/**
 * 조건 검색 조회 (S7-02 · 명세서 §5.5 · §4.2 GET/POST /api/search)
 *
 * 네 단계를 그대로 옮긴다 — **파싱 → 조회 → 랭킹 → 노출**.
 *  1. 파싱은 룰이 먼저 하고 남은 조각만 모델이 본다(`lib/core/search/parse.ts`).
 *  2. 조회는 **탐색과 같은 함수**(`searchVendors`)다. 필터 해석을 두 벌 두지 않는다.
 *  3. 랭킹은 순수 함수(`rankByFit`)이며 조회 결과 위에서만 돈다.
 *  4. **랭킹 기준 코드가 없는 응답을 만들지 않는다**(§5.5 4단계 · D-03).
 *
 * **화면과 API 가 이 함수를 함께 쓴다.** `/search` 가 자기 조회를 따로 하면 API 로 확인한
 * 결과와 화면이 갈린다(S3-03 에서 세운 규칙).
 */

export type SearchParseTrace = {
  /** 조건을 만든 경로. 화면은 이걸로 AI 개입 여부를 말한다. */
  source: "rule" | "rule+ai";
  ai:
    | { used: false; reason: AiParseSkipReason }
    | { used: true; accepted: number; discarded: { field: string; reason: AiDiscardReason }[] };
  promptVersion: string;
};

export type SearchResultRow = ExploreRow & {
  /** 조건 부합도 내역. 채점할 조건이 없으면 null 이다. */
  fit: FitScore | null;
};

export type ConditionSearchResult = {
  query: string;
  /** 상대 날짜("3월 14일")를 푼 기준일. **응답에 싣는다** — 그래야 결과를 재현할 수 있다. */
  asOf: string;
  conditions: SearchCondition[];
  /** 형태는 알아봤지만 조건으로 못 쓴 것. 화면이 이유를 적는다. */
  rejected: RejectedCondition[];
  /** 아직 비어 있는 조건. 화면이 직접 고르라고 안내한다(§5.5 1단계 실패 처리). */
  emptyFields: SearchField[];
  leftover: string;
  parse: SearchParseTrace;
  ranking: {
    /** **적용된** 랭킹 기준 코드. 배지가 이 값을 그대로 받는다. */
    code: SearchRankingCode;
    rules: typeof FIT_RULES;
    tieBreak: string;
  };
  rows: SearchResultRow[];
  total: number;
  page: number;
  pageSize: number;
  truncated: boolean;
  relaxationHints: ExploreResult["relaxationHints"];
};

export type SearchInput = {
  query: string;
  /** 화면에서 직접 고친 조건. 파싱 결과를 이긴다. */
  user: SearchCondition[];
  dropped: SearchField[];
  page: number;
  asOf: string;
};

export type SearchOutcome =
  | { ok: true; result: ConditionSearchResult }
  | { ok: false; issues: ZodIssue[] };

function issue(path: string, message: string): ZodIssue {
  return { code: "custom", path: [path], message } as ZodIssue;
}

/** UTC 기준 오늘. 리포의 다른 날짜 계산과 같은 규칙을 쓴다. */
export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * 쿼리 스트링 → 검색 입력.
 *
 * **명시 파라미터가 자연어를 이긴다.** 칩을 고치면 `region=판교` 처럼 값이 URL 에 박히고,
 * 그 뒤로 같은 `q` 를 다시 파싱해도 그 필드는 덮이지 않는다 — 고칠 수 있다는 말이
 * 거짓이 되지 않으려면 URL 이 그 사실을 갖고 있어야 한다.
 */
export function toSearchInput(
  params: URLSearchParams,
): { ok: true; input: SearchInput } | { ok: false; issues: ZodIssue[] } {
  const issues: ZodIssue[] = [];

  const query = SearchQuerySchema.safeParse(params.get("q") ?? "");
  if (!query.success) {
    return { ok: false, issues: [issue("q", "검색어가 너무 길어요.")] };
  }

  const user: SearchCondition[] = [];

  const readValue = (field: SearchField, raw: unknown) => {
    const checked = SEARCH_VALUE_SCHEMA[field].safeParse(raw);
    if (!checked.success) {
      issues.push(issue(field, checked.error.issues[0]?.message ?? "값을 확인해 주세요."));

      return;
    }

    user.push({ field, value: checked.data, sourceText: "", origin: "user" } as SearchCondition);
  };

  for (const field of SEARCH_FIELDS) {
    if (field === "styleTags") {
      const tags = params.getAll("styleTags").filter((value) => value.trim() !== "");
      if (tags.length > 0) readValue(field, tags);
      continue;
    }

    const raw = params.get(field);
    if (raw === null || raw.trim() === "") continue;

    const numeric = field === "budgetMin" || field === "budgetMax" || field === "guestCount";
    readValue(field, numeric ? Number(raw) : raw.trim());
  }

  const dropped = params
    .getAll("drop")
    .filter((value): value is SearchField => (SEARCH_FIELDS as readonly string[]).includes(value));

  const pageRaw = Number(params.get("page") ?? 1);
  const page = Number.isInteger(pageRaw) && pageRaw >= 1 && pageRaw <= 500 ? pageRaw : 1;

  const asOfParam = params.get("asOf");
  const asOf = asOfParam !== null && /^\d{4}-\d{2}-\d{2}$/.test(asOfParam) ? asOfParam : todayIso();

  if (issues.length > 0) return { ok: false, issues };

  return { ok: true, input: { query: query.data, user, dropped, page, asOf } };
}

/** 자연어를 조건으로. 룰이 먼저, 남은 조각만 모델이 본다(§5.5 1단계). */
export async function parseConditions(input: { query: string; asOf: string }) {
  const rule = parseSearchQuery(input.query, { asOf: input.asOf });

  if (input.query.trim() === "") {
    return {
      conditions: rule.conditions,
      rejected: rule.rejected,
      leftover: rule.leftover,
      trace: {
        source: "rule",
        ai: { used: false, reason: "nothing_left" },
        promptVersion: "",
      } as SearchParseTrace,
    };
  }

  const ai = await parseSearchWithAi({ text: input.query, rule, asOf: input.asOf });

  if (!ai.used) {
    return {
      conditions: rule.conditions,
      rejected: rule.rejected,
      leftover: rule.leftover,
      trace: {
        source: "rule",
        ai: { used: false, reason: ai.reason },
        promptVersion: ai.promptVersion,
      } as SearchParseTrace,
    };
  }

  return {
    conditions: ai.outcome.conditions,
    rejected: rule.rejected,
    leftover: rule.leftover,
    trace: {
      // 모델을 불렀어도 조건이 하나도 살아남지 못했으면 결과는 룰 그대로다.
      source: ai.outcome.accepted.length > 0 ? "rule+ai" : "rule",
      ai: {
        used: true,
        accepted: ai.outcome.accepted.length,
        discarded: ai.outcome.discarded.map((item) => ({ field: item.field, reason: item.reason })),
      },
      promptVersion: ai.promptVersion,
    } as SearchParseTrace,
  };
}

export async function conditionSearch(
  client: SupabaseClient,
  input: SearchInput,
): Promise<SearchOutcome> {
  const parsed = await parseConditions({ query: input.query, asOf: input.asOf });

  const conditions = applyUserConditions({
    parsed: parsed.conditions,
    user: input.user,
    dropped: input.dropped,
  });

  const rankFilter = toRankFilter(conditions);
  const rankable = hasRankableCondition(rankFilter);

  const outcome = await searchVendors(client, toExploreFilterInput(conditions, input.page), {
    // 부합도는 슬롯·스타일을 맞춰 본 뒤에야 나온다. 후보를 넉넉히 읽고 메모리에서 세운다.
    scanAll: true,
    rank: rankable ? (candidates) => rankByFit(candidates, rankFilter) : undefined,
  });

  if (!outcome.ok) return outcome;

  const { result } = outcome;

  return {
    ok: true,
    result: {
      query: input.query,
      asOf: input.asOf,
      conditions,
      rejected: parsed.rejected,
      emptyFields: emptyFields(conditions),
      leftover: parsed.leftover,
      parse: parsed.trace,
      ranking: {
        // 채점할 조건이 없으면 순서를 정한 것은 가격이다. 있는 그대로 싣는다.
        code: rankingCodeFor(rankFilter),
        rules: FIT_RULES,
        tieBreak: FIT_TIE_BREAK,
      },
      rows: result.rows.map((row) => ({
        ...row,
        fit: rankable
          ? scoreFit(
              {
                productId: row.productId,
                basePrice: row.basePrice,
                regionCode: row.regionCode,
                styleTags: row.styleTags,
                capacityMin: row.capacityMin,
                capacityMax: row.capacityMax,
                availabilityKind: row.availability.kind,
              },
              rankFilter,
            )
          : null,
      })),
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
      truncated: result.truncated,
      relaxationHints: result.relaxationHints,
    },
  };
}

/** POST 본문 → 쿼리 스트링. `GET` 과 **같은 입력 해석**을 쓰기 위한 다리다(§4.2). */
export function bodyToParams(body: unknown): URLSearchParams {
  const params = new URLSearchParams();
  if (typeof body !== "object" || body === null) return params;

  const record = body as Record<string, unknown>;

  const put = (key: string, value: unknown) => {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) {
      value.forEach((item) => params.append(key, String(item)));

      return;
    }

    params.set(key, String(value));
  };

  put("q", record.q ?? record.query);
  for (const field of SEARCH_FIELDS) put(field, record[field]);
  put("drop", record.drop);
  put("page", record.page);
  put("asOf", record.asOf);

  return params;
}
