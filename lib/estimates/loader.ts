import type { SupabaseClient } from "@supabase/supabase-js";

import {
  COMPARE_MAX,
  COMPARE_MIN,
  compareEstimates,
  normalizeEstimate,
  type EstimateComparison,
  type NormalizedEstimate,
  type QuoteLine,
} from "@/lib/core/estimate/normalize";

/**
 * 견적 정규화·비교 조회 (S7-05 · 명세서 §2.1 F-C-06 · §5.4 · §4.2)
 *
 * ── 원천은 표준 견적이다 ────────────────────────────────────────────────────
 * **자유 양식 견적이 존재하지 않는다** — 업체는 `quotes`·`quote_items` 로만 응답하고
 * (F-V-07 · S4-12) 항목의 이름·분류는 DB 트리거가 참조된 상품·추가금에서 덮어쓴다(0024).
 * 그래서 파싱 단계가 없고 이 파일은 **읽어서 표준 축으로 옮기기만** 한다.
 *
 * ── 세션 클라이언트로 읽는다 ────────────────────────────────────────────────
 * `quotes` 는 상위 `inquiry_targets`·`inquiries` 스코프이고 커플 구성원만 본다.
 * **남의 견적을 고를 수 없다** — 조회가 비면 그 견적은 없는 것이다.
 *
 * ── 임베드로 업체 이름을 읽지 않는다 ────────────────────────────────────────
 * `vendors` 는 공개 조건이 붙은 표라 **행이 안 보이면 임베드가 조용히 `null` 을 준다**
 * (S7-07 이 겪은 것 — 1,200만원짜리 계약이 '기타' 로 떨어졌다). 여기서는 업체 카테고리가
 * **분류의 근거**라 같은 사고가 나면 견적이 통째로 `unmapped` 가 된다. 그래서
 * **`estimate_quote_sources()`(SECURITY DEFINER · 0047)** 가 커플 확인을 마친 뒤
 * 업체 이름·카테고리를 함께 내려 준다.
 */

export type EstimateCandidate = {
  quoteId: string;
  vendorId: string;
  vendorName: string;
  productName: string | null;
  vendorCategory: string | null;
  declaredTotal: number;
  validUntil: string | null;
  sentAt: string | null;
};

type SourceRow = {
  quote_id: string;
  vendor_id: string;
  vendor_name: string;
  vendor_category: string | null;
  product_name: string | null;
  total_amount: number;
  valid_until: string | null;
  sent_at: string | null;
};

type LineRow = {
  id: string;
  quote_id: string;
  label: string;
  category_code: string;
  amount: number;
  is_option: boolean;
  is_mandatory: boolean;
};

/**
 * 비교할 수 있는 견적 목록.
 *
 * **보낸 견적만 센다**(`status = 'sent'`). 초안은 업체가 아직 안 보낸 것이라 고객에게
 * 있는 값이 아니다 — 그것을 비교표에 올리면 **오지 않은 제안을 견주는** 셈이 된다.
 */
export async function listEstimateCandidates(
  client: SupabaseClient,
  input: { coupleId: string },
): Promise<EstimateCandidate[]> {
  const { data } = await client.rpc("estimate_quote_sources", {
    p_couple_id: input.coupleId,
    p_quote_ids: null,
  });

  return ((data ?? []) as SourceRow[]).map(toCandidate);
}

function toCandidate(row: SourceRow): EstimateCandidate {
  return {
    quoteId: row.quote_id,
    vendorId: row.vendor_id,
    vendorName: row.vendor_name,
    productName: row.product_name,
    vendorCategory: row.vendor_category,
    declaredTotal: row.total_amount,
    validUntil: row.valid_until,
    sentAt: row.sent_at,
  };
}

export type NormalizeFailure = { status: number; code: string; message: string };

/**
 * 고른 견적들을 정규화한다.
 *
 * **하나라도 못 읽으면 만들지 않는다.** 남의 견적을 섞어 보낸 요청에 "읽힌 것만" 으로
 * 답하면 **비교표가 조용히 다른 것을 견주게** 된다(§5.1 부분 결과 비노출과 같은 판단).
 */
export async function normalizeEstimates(
  client: SupabaseClient,
  input: { coupleId: string; quoteIds: string[]; now?: Date },
): Promise<NormalizedEstimate[] | NormalizeFailure> {
  const ids = [...new Set(input.quoteIds)];

  if (ids.length < COMPARE_MIN || ids.length > COMPARE_MAX) {
    return {
      status: 422,
      code: "ESTIMATE_COUNT_OUT_OF_RANGE",
      message: `견적은 ${COMPARE_MIN}~${COMPARE_MAX}개까지 견줄 수 있어요.`,
    };
  }

  const { data } = await client.rpc("estimate_quote_sources", {
    p_couple_id: input.coupleId,
    p_quote_ids: ids,
  });

  const sources = (data ?? []) as SourceRow[];

  if (sources.length !== ids.length) {
    // **없는 것과 남의 것을 같은 답으로 돌려준다** — 코드가 다르면 견적 id 를 넣어
    // 보며 "그 견적이 존재하는가" 를 물어볼 수 있게 된다(S7-12 와 같은 규칙).
    return {
      status: 404,
      code: "ESTIMATE_NOT_FOUND",
      message: "고른 견적 중 찾을 수 없는 것이 있어요.",
    };
  }

  const { data: lineRows } = await client
    .from("quote_items")
    .select("id, quote_id, label, category_code, amount, is_option, is_mandatory")
    // **소유자 필터를 넣는다.** RLS 가 경계이지만 조건을 빼면 표 전체를 훑게 되고,
    // 그때 화면이 무엇을 걸러 줄지에 기대게 된다.
    .in("quote_id", ids);

  const linesByQuote = new Map<string, QuoteLine[]>();
  for (const row of (lineRows ?? []) as LineRow[]) {
    linesByQuote.set(row.quote_id, [
      ...(linesByQuote.get(row.quote_id) ?? []),
      {
        id: row.id,
        label: row.label,
        vendorCategory: row.category_code,
        amount: row.amount,
        isOption: row.is_option,
        isMandatory: row.is_mandatory,
      },
    ]);
  }

  // 기준 시각은 **한 번만 만들고** 모든 견적이 같은 값을 쓴다 — 목록 중간에 자정을
  // 넘기면 같은 요청 안에서 만료 판정이 갈린다.
  const now = (input.now ?? new Date()).toISOString();

  // 고른 순서를 지킨다. 서버가 순서를 바꾸면 사용자가 고른 순서와 표가 달라진다.
  const byId = new Map(sources.map((row) => [row.quote_id, row]));

  return ids.map((quoteId) => {
    const row = byId.get(quoteId) as SourceRow;
    const candidate = toCandidate(row);

    return normalizeEstimate({
      ...candidate,
      lines: linesByQuote.get(quoteId) ?? [],
      now,
    });
  });
}

export type EstimateCompareView = {
  estimates: NormalizedEstimate[];
  comparison: EstimateComparison;
};

export async function buildComparison(
  client: SupabaseClient,
  input: { coupleId: string; quoteIds: string[]; now?: Date },
): Promise<EstimateCompareView | NormalizeFailure> {
  const estimates = await normalizeEstimates(client, input);
  if ("status" in estimates) return estimates;

  return { estimates, comparison: compareEstimates(estimates) };
}
