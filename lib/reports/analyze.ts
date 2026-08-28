import { analyzeWithAi } from "@/lib/ai/report";
import { recordEvent } from "@/lib/audit/record";
import { maskText } from "@/lib/core/masking";
import {
  buildRuleOnlyReport,
  mergeModelFindings,
  riskScore,
  type AnalysisStatus,
  type ReportSource,
} from "@/lib/core/report/pipeline";
import { DETECT_RULES_VERSION, DETECT_RULE_CODES } from "@/lib/core/rules/detect-rules";
import { scanDocument, verifyCitation } from "@/lib/core/rules/scan";
import { logAiCall } from "@/lib/quality/log";
import { loadDetectRuleSet, ruleSetSummary } from "@/lib/rules/detect-rule-set";
import type { Finding, Report } from "@/lib/core/schemas/report";
import { createAdminClient } from "@/lib/supabase/admin";

import { DOCUMENT_BUCKET } from "./storage";
import { extractText } from "./extract";

/**
 * 검토 파이프라인 실행 (S7-03 · 명세서 §5.2 2~8단계)
 *
 * **마스킹 실패는 여기서 끝난다.** `maskText` 가 `complete: false` 를 돌려주면
 * **모델을 부르지 않고** 분석을 실패로 닫는다(CLAUDE.md §5.2 — "일단 호출하고 나중에
 * 처리" 금지). 잔존 패턴의 **종류와 개수만** 기록하고 값은 어디에도 남기지 않는다.
 *
 * **마스킹 맵은 메모리에서만 산다.** DB·로그·이벤트 어디에도 쓰지 않으며 이 함수가
 * 끝나면 사라진다(CLAUDE.md §5.2).
 *
 * **원문은 분석이 끝나면 그 자리에서 지운다.** 명세는 "24시간 내 파기" 를 요구하지만
 * 분석이 끝난 원문은 더 필요하지 않고, **가장 안전한 파기는 가장 이른 파기**다.
 * `purge_scheduled_at` 은 그대로 두어 배치(S8-04)가 실패분을 마저 치우게 한다.
 *
 * **실패해도 원문은 지운다.** 실패는 다시 올려 받는 편이 낫지, 원문을 붙들고 있을
 * 이유가 되지 않는다.
 */

export type AnalyzeOutcome = {
  status: AnalysisStatus;
  source: ReportSource | null;
  failureReason: string | null;
};

/** 분석 실패 사유. **사람이 읽는 문장은 화면이 만든다** — 여기 있는 것은 코드다. */
export const ANALYSIS_FAILURES = [
  "document_missing",
  "extract_failed",
  "masking_incomplete",
  "rules_unavailable",
  "storage_failed",
] as const;

export type AnalysisFailure = (typeof ANALYSIS_FAILURES)[number];

type DocumentRow = {
  id: string;
  couple_id: string;
  storage_path: string;
  mime: string | null;
  purged_at: string | null;
};

/**
 * 이 분석을 지금 내가 집어도 되는가.
 *
 * `status` 를 `running` 으로 **조건부 갱신**해 중복 실행을 막는다 — 폴링이 재개를
 * 유발하므로(파이프라인은 응답 후 잘릴 수 있다) 두 요청이 같은 분석을 집을 수 있다.
 * 갱신된 행이 없으면 남이 이미 집은 것이다.
 */
async function claim(analysisId: string, from: readonly AnalysisStatus[]): Promise<boolean> {
  const { data } = await createAdminClient()
    .from("document_analyses")
    .update({ status: "running" })
    .eq("id", analysisId)
    .in("status", from as unknown as string[])
    .select("id");

  return (data ?? []).length > 0;
}

async function fail(
  analysisId: string,
  reason: AnalysisFailure,
  actorId: string,
): Promise<AnalyzeOutcome> {
  const admin = createAdminClient();

  await admin.from("document_analyses").update({ status: "failed" }).eq("id", analysisId);

  await recordEvent({
    entityType: "document_analysis",
    entityId: analysisId,
    eventType: "analysis_failed",
    actor: { id: actorId },
    afterState: "failed",
    // **사유 코드만.** 문서 내용·경로·잔존 값은 넣지 않는다(§7.3 · §5.3).
    memo: `reason:${reason}`,
  });

  return { status: "failed", source: null, failureReason: reason };
}

/**
 * 원문을 지운다.
 *
 * Storage 객체를 먼저 지우고 `purged_at` 을 찍는다. 순서가 반대면 "지웠다고
 * 기록했는데 파일이 남은" 상태가 생기고, 그건 개인정보 감사(F-A-08)가 찾아내야 할
 * 것을 못 찾게 만든다.
 */
async function purge(document: DocumentRow, actorId: string): Promise<void> {
  const admin = createAdminClient();

  await admin.storage.from(DOCUMENT_BUCKET).remove([document.storage_path]);

  await admin
    .from("documents")
    .update({ purged_at: new Date().toISOString() })
    .eq("id", document.id);

  await recordEvent({
    entityType: "document",
    entityId: document.id,
    eventType: "document_purged",
    actor: { id: actorId },
    beforeState: "stored",
    afterState: "purged",
  });
}

export async function runAnalysis(input: {
  analysisId: string;
  actorId: string;
  /** 재개인가. 처음 실행은 `queued` 만, 재개는 `running` 도 집는다. */
  resume?: boolean;
}): Promise<AnalyzeOutcome> {
  const admin = createAdminClient();

  const claimed = await claim(
    input.analysisId,
    input.resume === true ? ["queued", "running"] : ["queued"],
  );

  if (!claimed) return { status: "running", source: null, failureReason: null };

  const { data: analysisRow } = await admin
    .from("document_analyses")
    .select("id, document_id")
    .eq("id", input.analysisId)
    .maybeSingle();

  const documentId = (analysisRow as { document_id: string } | null)?.document_id ?? null;
  if (documentId === null) return fail(input.analysisId, "document_missing", input.actorId);

  const { data: documentRow } = await admin
    .from("documents")
    .select("id, couple_id, storage_path, mime, purged_at")
    .eq("id", documentId)
    .maybeSingle();

  const document = documentRow as DocumentRow | null;

  // 이미 파기된 원문은 다시 분석할 수 없다. **그것이 정상 동작이다.**
  if (document === null || document.purged_at !== null) {
    return fail(input.analysisId, "document_missing", input.actorId);
  }

  const startedAt = Date.now();

  // ── 2단계. 텍스트 추출 ────────────────────────────────────────────────────
  const { data: file, error: downloadError } = await admin.storage
    .from(DOCUMENT_BUCKET)
    .download(document.storage_path);

  if (downloadError || !file) {
    await purge(document, input.actorId);

    return fail(input.analysisId, "storage_failed", input.actorId);
  }

  const extracted = extractText({
    bytes: new Uint8Array(await file.arrayBuffer()),
    mime: document.mime ?? "application/octet-stream",
  });

  if (!extracted.ok) {
    await purge(document, input.actorId);

    return fail(input.analysisId, "extract_failed", input.actorId);
  }

  // ── 3단계. 마스킹 — 실패하면 **모델을 부르지 않는다** ─────────────────────
  const masked = maskText(extracted.text);

  if (!masked.complete) {
    await recordEvent({
      entityType: "document",
      entityId: document.id,
      eventType: "masking_incomplete",
      actor: { id: input.actorId },
      afterState: "blocked",
      // 종류와 건수만. 잔존 문자열은 담지 않는다(§5.3).
      memo: `residual:${[...new Set(masked.residual.map((risk) => risk.kind))].join(",")}:${masked.residual.length}`,
    });

    await purge(document, input.actorId);

    return fail(input.analysisId, "masking_incomplete", input.actorId);
  }

  // ── 4단계. 룰 스캔 ────────────────────────────────────────────────────────
  const ruleSet = await loadDetectRuleSet();

  // **룰 0건이면 분석을 시작하지 않는다**(S7-01) — "위험 없음" 과 "아무것도 보지
  // 않았다" 는 화면에서 구분되지 않는다.
  if (ruleSet.rules.length === 0) {
    await purge(document, input.actorId);

    return fail(input.analysisId, "rules_unavailable", input.actorId);
  }

  const matches = scanDocument(masked.masked, ruleSet.rules);

  // ── 5·6단계. LLM 분석 + 스키마 검증 ───────────────────────────────────────
  const ai = await analyzeWithAi({
    maskedText: masked.masked,
    matches,
    fragments: Object.fromEntries(ruleSet.rules.map((rule) => [rule.code, rule.prompt_fragment])),
  });

  // ── 7단계. 인용 대조 ──────────────────────────────────────────────────────
  let report: Report;
  let source: ReportSource;
  let discardedCount = 0;
  // 폐기율의 **분모**다(§5.8). 모델이 낸 건수이며 살아남은 건수가 아니다.
  let generatedCount = 0;

  if (ai.used) {
    const merged = mergeModelFindings({
      findings: ai.report.findings,
      maskedText: masked.masked,
      verifyCitation,
      knownRuleCodes: DETECT_RULE_CODES,
    });

    discardedCount = merged.discarded.length;
    generatedCount = ai.report.findings.length;

    // 모델이 낸 것이 전부 폐기됐다면 남은 것은 룰 결과뿐이다 — 그렇다고 말한다.
    const findings: Finding[] =
      merged.findings.length > 0 ? merged.findings : buildRuleOnlyReport(matches).findings;

    source = merged.findings.length > 0 ? "rules_and_model" : "rules_only";

    report = {
      ...ai.report,
      findings,
      // 점수는 **코드가 계산한다**. 같은 findings 에 매번 다른 점수가 붙으면 안 된다.
      risk_score: riskScore(findings),
    };
  } else {
    report = buildRuleOnlyReport(matches);
    source = "rules_only";
  }

  // ── 8단계. 저장 ───────────────────────────────────────────────────────────
  await admin.from("findings").delete().eq("analysis_id", input.analysisId);

  if (report.findings.length > 0) {
    await admin.from("findings").insert(
      report.findings.map((finding) => ({
        analysis_id: input.analysisId,
        rule_code: finding.rule_code,
        severity: finding.severity,
        // **마스킹된 인용만 저장한다**(0004 주석 · §5.1).
        clause_excerpt_masked: finding.clause_excerpt,
        basis_ref: finding.basis_ref,
        explanation: finding.issue,
        negotiation_script: finding.negotiation_script,
        // 여기까지 온 finding 은 전부 인용 대조를 통과했다.
        citation_verified: true,
      })),
    );
  }

  await admin
    .from("document_analyses")
    .update({
      status: "done",
      risk_score: report.risk_score,
      // 판본은 **코드가 진실**이다(S7-01) — DB 는 사본이고 어긋나면 `drift` 가 알린다.
      rule_version: DETECT_RULES_VERSION,
      prompt_version: ai.promptVersion,
      model: ai.used ? ai.model : null,
      latency_ms: Date.now() - startedAt,
      token_in: ai.used ? ai.tokenIn : null,
      token_out: ai.used ? ai.tokenOut : null,
    })
    .eq("id", input.analysisId);

  // 품질·비용 원천(F-A-04 · §5.8). **문서 내용은 담기지 않는다.**
  //
  // S8-07 이 래퍼로 옮기고 **셀 수 있는 값 다섯을 더했다** — 지연·토큰 둘·생성/폐기
  // finding 수. 폐기 수는 그 호출이 끝나면 **다시 셀 수 없다**(폐기된 행은 저장되지
  // 않는다). 그전까지 유일한 흔적이 `entity_events.memo` 의 문자열이었고, 그것으로
  // 지표를 만들면 memo 형식을 바꾸는 날 폐기율이 조용히 0이 된다.
  await logAiCall({
    feature: "report",
    model: ai.used ? ai.model : null,
    promptVersion: ai.promptVersion,
    validationResult: ai.used ? "ok" : ai.reason,
    retryCount: ai.used ? ai.attempts - 1 : 1,
    latencyMs: Date.now() - startedAt,
    tokenIn: ai.used ? ai.tokenIn : null,
    tokenOut: ai.used ? ai.tokenOut : null,
    analysisId: input.analysisId,
    findingsGenerated: generatedCount,
    findingsDiscarded: discardedCount,
  });

  const summary = ruleSetSummary(ruleSet);

  await recordEvent({
    entityType: "document_analysis",
    entityId: input.analysisId,
    eventType: "analysis_completed",
    actor: { id: input.actorId },
    afterState: "done",
    // 셀 수 있는 값과 코드만. 조항·인용은 넣지 않는다(§7.3).
    memo: `source:${source} findings:${report.findings.length} discarded:${discardedCount} rules:${summary.source}${summary.drift ? " drift" : ""}`,
  });

  // ── 8단계. 파기 — 분석이 끝났으니 원문은 더 필요하지 않다 ─────────────────
  await purge(document, input.actorId);

  return { status: "done", source, failureReason: null };
}
