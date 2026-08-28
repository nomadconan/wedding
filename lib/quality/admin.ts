import { readIntSetting } from "@/lib/app-settings";
import { recordEvent } from "@/lib/audit/record";
import {
  type CallLog,
  type QualitySummary,
  type TokenPrices,
  QUALITY_TARGETS,
  summarize,
} from "@/lib/core/quality/metrics";
import {
  type FindingReportResolveInput,
  type ReportReviewInput,
  type ReviewProgress,
  type RuleReportCount,
  FINDING_REPORT_REASON_LABEL,
  type FindingReportReason,
  countByRule,
  reviewProgress,
} from "@/lib/core/quality/review";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

/**
 * AI 품질·비용 콘솔 (S8-07 · F-A-04 · §5.8)
 *
 * **읽는 방식을 셋으로 가른다**(D-120 과 같은 갈림길).
 *
 * | 대상 | 방식 | 왜 |
 * |---|---|---|
 * | `ai_call_logs` | 세션 + **운영자 정책** | **행이 목적**이다 — 실패율이 올랐을 때 묻는 것은 "몇 퍼센트냐" 가 아니라 "어떤 호출이 왜 실패했느냐" 다(D-115) |
 * | `document_analyses` | 세션 + **운영자 정책** | 검수 큐가 행이다. 다만 **`findings` 는 열지 않았다** — 조항 인용이 들어 있고 마스킹본이라도 남의 계약을 통째로 읽을 이유가 없다 |
 * | 검수 기록·오탐 신고 처리 | **서비스롤** | `reviewer_id`·`resolved_by` 를 남의 것으로 적을 수 없어야 한다(D-62) |
 *
 * **큐를 표로 저장하지 않는다**(D-124). 무엇을 검수해야 하는지는 완료된 분석과 검수
 * 기록의 차집합이라 계산된다 — 저장하면 검수 하나가 들어올 때마다 낡는다.
 */

const WINDOW_DAYS = 30;

/** `ai_feature` enum 전체. **로그가 없어도 목록에 남는다**(함정 2). */
export const AI_FEATURES = ["report", "planner", "search", "estimate"] as const;

export const AI_FEATURE_LABEL: Record<string, string> = {
  report: "계약서 검토",
  planner: "AI 플래너",
  search: "조건 검색 파서",
  estimate: "견적 정규화",
};

/**
 * 아직 AI 를 부르지 않는 기능. **"0건" 과 "이 기능은 AI 를 안 쓴다" 를 가른다.**
 *
 * `estimate` 는 `ai_feature` enum 에 자리가 있지만 호출 코드가 없다(§5.4 의 정규화는
 * 결정적 매핑이다). 화면이 이것을 0건으로 그리면 "견적 AI 가 한 번도 안 돌았다" 로
 * 읽히는데, 실제로는 **그런 호출이 존재하지 않는다.**
 */
export const AI_FEATURES_WITHOUT_CALLS: readonly string[] = ["estimate"];

export async function readTokenPrices(): Promise<TokenPrices> {
  // **`readIntSetting` 이 `null` 을 0 으로 읽지 않는다**(S7-17 이 물린 자리).
  // 단가 0원은 "공짜로 쓴다" 는 뜻이라 미결과 정반대다.
  const [input, output] = await Promise.all([
    readIntSetting("ai.input_price_per_mtok_krw", "value"),
    readIntSetting("ai.output_price_per_mtok_krw", "value"),
  ]);

  return { inputPerMTokKrw: input, outputPerMTokKrw: output };
}

export type ReviewQueueRow = {
  analysisId: string;
  status: string;
  riskScore: number | null;
  ruleVersion: string | null;
  promptVersion: string | null;
  model: string | null;
  latencyMs: number | null;
  createdAt: string;
  /** 이미 검수됐는가. 큐는 이 값이 비어 있는 행이다. */
  reviews: { verdict: string; note: string; reviewerId: string; createdAt: string }[];
};

export type FindingReportRow = {
  id: string;
  ruleCode: string;
  reason: FindingReportReason;
  reasonLabel: string;
  status: string;
  resolutionNote: string | null;
  createdAt: string;
  /** 원본이 남아 있는가. `set null` 이라 재분석·문서 삭제 뒤에는 비어 있다. */
  findingId: string | null;
  analysisId: string | null;
};

export type QualityConsole = {
  summary: QualitySummary;
  progress: ReviewProgress;
  queue: ReviewQueueRow[];
  reports: FindingReportRow[];
  ruleCounts: RuleReportCount[];
  featuresWithoutCalls: readonly string[];
};

export async function loadQualityConsole(now: Date): Promise<QualityConsole> {
  const supabase = await createClient();
  const since = new Date(now.getTime() - WINDOW_DAYS * 86_400_000).toISOString();

  const [{ data: logRows, error: logError }, { data: analysisRows }, { data: reportRows }] =
    await Promise.all([
      supabase
        .from("ai_call_logs")
        .select(
          "feature, model, prompt_version, validation_result, retry_count, latency_ms, token_in, token_out, findings_generated, findings_discarded, created_at",
        )
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .limit(2_000),
      supabase
        .from("document_analyses")
        .select("id, status, risk_score, rule_version, prompt_version, model, latency_ms, created_at")
        .eq("status", "done")
        .order("created_at", { ascending: false })
        .limit(200),
      supabase
        .from("finding_reports")
        .select(
          "id, finding_id, analysis_id, rule_code, reason_code, status, resolution_note, created_at",
        )
        .order("created_at", { ascending: false })
        .limit(500),
    ]);

  if (logError) throw new Error("AI_QUALITY_LOAD_FAILED");

  const logs: CallLog[] = (
    (logRows ?? []) as {
      feature: string;
      model: string | null;
      prompt_version: string | null;
      validation_result: string | null;
      retry_count: number;
      latency_ms: number | null;
      token_in: number | null;
      token_out: number | null;
      findings_generated: number | null;
      findings_discarded: number | null;
      created_at: string;
    }[]
  ).map((row) => ({
    feature: row.feature,
    model: row.model,
    promptVersion: row.prompt_version,
    validationResult: row.validation_result,
    retryCount: row.retry_count,
    latencyMs: row.latency_ms,
    tokenIn: row.token_in,
    tokenOut: row.token_out,
    findingsGenerated: row.findings_generated,
    findingsDiscarded: row.findings_discarded,
    createdAt: row.created_at,
  }));

  const analyses = (analysisRows ?? []) as {
    id: string;
    status: string;
    risk_score: number | null;
    rule_version: string | null;
    prompt_version: string | null;
    model: string | null;
    latency_ms: number | null;
    created_at: string;
  }[];

  // 검수 기록은 **운영자 정책**으로 읽는다(0059). `document_analyses` 임베드로 끌어오면
  // 정책이 다른 두 표를 한 쿼리로 묶는 셈이라 한쪽이 조용히 비어 나온다(함정 1).
  const { data: reviewRows } = await supabase
    .from("ai_report_reviews")
    .select("analysis_id, verdict, note, reviewer_id, created_at")
    .limit(1_000);

  const reviewsByAnalysis = new Map<string, ReviewQueueRow["reviews"]>();
  for (const row of (reviewRows ?? []) as {
    analysis_id: string;
    verdict: string;
    note: string;
    reviewer_id: string;
    created_at: string;
  }[]) {
    const bucket = reviewsByAnalysis.get(row.analysis_id) ?? [];
    bucket.push({
      verdict: row.verdict,
      note: row.note,
      reviewerId: row.reviewer_id,
      createdAt: row.created_at,
    });
    reviewsByAnalysis.set(row.analysis_id, bucket);
  }

  const queue: ReviewQueueRow[] = analyses.map((row) => ({
    analysisId: row.id,
    status: row.status,
    riskScore: row.risk_score,
    ruleVersion: row.rule_version,
    promptVersion: row.prompt_version,
    model: row.model,
    latencyMs: row.latency_ms,
    createdAt: row.created_at,
    reviews: reviewsByAnalysis.get(row.id) ?? [],
  }));

  const reports: FindingReportRow[] = (
    (reportRows ?? []) as {
      id: string;
      finding_id: string | null;
      analysis_id: string | null;
      rule_code: string;
      reason_code: FindingReportReason;
      status: string;
      resolution_note: string | null;
      created_at: string;
    }[]
  ).map((row) => ({
    id: row.id,
    ruleCode: row.rule_code,
    reason: row.reason_code,
    reasonLabel: FINDING_REPORT_REASON_LABEL[row.reason_code] ?? row.reason_code,
    status: row.status,
    resolutionNote: row.resolution_note,
    createdAt: row.created_at,
    findingId: row.finding_id,
    analysisId: row.analysis_id,
  }));

  return {
    summary: summarize(logs, {
      windowDays: WINDOW_DAYS,
      features: AI_FEATURES,
      prices: await readTokenPrices(),
    }),
    progress: reviewProgress(
      queue.length,
      queue.filter((row) => row.reviews.length > 0).length,
      QUALITY_TARGETS.sampleReviewBp.value,
    ),
    queue,
    reports,
    ruleCounts: countByRule(reports),
    featuresWithoutCalls: AI_FEATURES_WITHOUT_CALLS,
  };
}

export type QualityResult =
  | { ok: true }
  | { ok: false; status: number; code: string; message: string };

/**
 * 검수 기록 (F-A-04).
 *
 * **서비스롤로 쓴다**(D-62) — 운영자에게 INSERT 정책을 주면 `reviewer_id` 를 남의
 * 것으로 적을 수 있고, 검수 기록의 요점이 "누가 봤나" 다.
 *
 * **판정이 아니라 기록이다.** 이 기록으로 리포트가 바뀌지 않는다 — 사용자에게
 * "당신 리포트가 부정확으로 표시됐다" 를 보여 주는 것은 전혀 다른 결정이고,
 * 지금 그 결정이 없다.
 */
export async function recordReportReview(
  input: ReportReviewInput & { reviewerId: string; reviewerRole: string | null },
): Promise<QualityResult> {
  const admin = createAdminClient();

  const { data: analysis } = await admin
    .from("document_analyses")
    .select("id, status")
    .eq("id", input.analysisId)
    .maybeSingle();

  if (!analysis) {
    return { ok: false, status: 404, code: "ANALYSIS_NOT_FOUND", message: "분석을 찾을 수 없습니다." };
  }

  // 끝나지 않은 분석은 검수 대상이 아니다 — 볼 결과가 아직 없다.
  if (analysis.status !== "done") {
    return {
      ok: false,
      status: 409,
      code: "ANALYSIS_NOT_DONE",
      message: "완료된 분석만 검수할 수 있습니다.",
    };
  }

  const { error } = await admin.from("ai_report_reviews").upsert(
    {
      analysis_id: input.analysisId,
      reviewer_id: input.reviewerId,
      verdict: input.verdict,
      note: input.note,
    },
    { onConflict: "analysis_id,reviewer_id" },
  );

  if (error) {
    return {
      ok: false,
      status: 500,
      code: "REVIEW_SAVE_FAILED",
      message: "검수 기록을 저장하지 못했습니다.",
    };
  }

  await recordEvent({
    entityType: "document_analysis",
    entityId: input.analysisId,
    eventType: "analysis_reviewed",
    actor: { id: input.reviewerId, role: input.reviewerRole },
    afterState: input.verdict,
    source: "admin",
    // **메모 본문을 담지 않는다**(§7.3). 행이 이미 갖고 있다.
  });

  await writeAuditLog(admin, {
    actorId: input.reviewerId,
    actorRole: input.reviewerRole,
    action: "ai_report_reviewed",
    targetType: "document_analysis",
    targetId: input.analysisId,
    before: {},
    after: { verdict: input.verdict },
  });

  return { ok: true };
}

/**
 * 오탐 신고 처리 (F-A-04).
 *
 * **어휘가 사용자가 아니라 룰을 가리킨다** — `upheld` 는 "사용자 말이 옳다" 가 아니라
 * "룰을 손볼 자리로 받아들였다" 이고, `rejected` 는 "사용자가 틀렸다" 가 아니라
 * "지금 룰대로 나온 결과다" 이다. 우리가 판정하는 것은 우리 룰이다(D-24 의 결).
 *
 * **룰을 여기서 고치지 않는다** — 룰 수정은 배포로 하고(S7-01 이 정한 규칙) 그 콘솔은
 * F-A-03(S8-06) 소관이다. 여기서 하는 일은 **신호를 남기는 것**까지다.
 */
export async function resolveFindingReport(
  input: FindingReportResolveInput & { operatorId: string; operatorRole: string | null },
): Promise<QualityResult> {
  const admin = createAdminClient();

  const { data: report } = await admin
    .from("finding_reports")
    .select("id, status, rule_code, reason_code")
    .eq("id", input.reportId)
    .maybeSingle();

  if (!report) {
    return { ok: false, status: 404, code: "REPORT_NOT_FOUND", message: "신고를 찾을 수 없습니다." };
  }

  if (report.status !== "open") {
    return {
      ok: false,
      status: 409,
      code: "REPORT_ALREADY_RESOLVED",
      message: "이미 처리된 신고입니다.",
    };
  }

  const { error } = await admin
    .from("finding_reports")
    .update({
      status: input.status,
      resolved_by: input.operatorId,
      resolved_at: new Date().toISOString(),
      resolution_note: input.note,
    })
    .eq("id", input.reportId);

  if (error) {
    return {
      ok: false,
      status: 500,
      code: "REPORT_RESOLVE_FAILED",
      message: "신고 처리를 저장하지 못했습니다.",
    };
  }

  await recordEvent({
    entityType: "finding_report",
    entityId: input.reportId,
    eventType: `finding_report_${input.status}`,
    actor: { id: input.operatorId, role: input.operatorRole },
    beforeState: "open",
    afterState: input.status,
    source: "admin",
    // **룰 코드와 사유 코드만.** 조항도 처리 문안도 넣지 않는다(§7.3).
    memo: `rule:${report.rule_code} reason:${report.reason_code}`,
  });

  await writeAuditLog(admin, {
    actorId: input.operatorId,
    actorRole: input.operatorRole,
    action: `finding_report_${input.status}`,
    targetType: "finding_report",
    targetId: input.reportId,
    before: { status: "open", rule: report.rule_code },
    after: { status: input.status },
  });

  return { ok: true };
}

/** 운영자 액션은 `audit_logs` 에도 남기고 **근거 이벤트 id 를 함께** 남긴다(§7.2). */
async function writeAuditLog(
  admin: ReturnType<typeof createAdminClient>,
  input: {
    actorId: string;
    actorRole: string | null;
    action: string;
    targetType: string;
    targetId: string;
    before: Record<string, unknown>;
    after: Record<string, unknown>;
  },
): Promise<void> {
  const { data: basisRows } = await admin
    .from("entity_events")
    .select("id")
    .eq("actor_id", input.actorId)
    .order("occurred_at", { ascending: false })
    .limit(5);

  const basis = ((basisRows ?? []) as { id: string }[]).map((row) => row.id);

  await admin.from("audit_logs").insert({
    actor_id: input.actorId,
    actor_role: input.actorRole,
    action: input.action,
    target_type: input.targetType,
    target_id: input.targetId,
    before_json: input.before,
    after_json: input.after,
    // 빈 배열은 CHECK 이 막는다.
    resolution_basis: basis.length > 0 ? basis : null,
  });
}
