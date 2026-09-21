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
import { mustWrite, tryWrite } from "@/lib/db/write";
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

  /**
   * **`tryWrite` 다 — 던지면 더 잃는다**(D-237).
   *
   * `runAnalysis` 는 `void runAnalysis(...).catch(() => {})` 로 불린다
   * (`app/api/reports/route.ts` · `app/api/reports/[id]/route.ts`). 여기서 던지면
   * 예외는 **그 빈 catch 가 통째로 삼키고**, 바로 아래 증적까지 건너뛴다 — 상태도
   * 안 적히고 **왜 실패했는지가 어디에도 안 남는다.** 못 적었으면 그 사실을
   * 증적 메모에 적는다. 그래야 F-A-08 이 "상태는 running 인데 실패로 끝났다" 를 본다.
   */
  const marked = await tryWrite(
    "document_analyses.update:mark-failed",
    admin.from("document_analyses").update({ status: "failed" }).eq("id", analysisId),
  );

  await recordEvent({
    entityType: "document_analysis",
    entityId: analysisId,
    eventType: "analysis_failed",
    actor: { id: actorId },
    afterState: "failed",
    // **사유 코드만.** 문서 내용·경로·잔존 값은 넣지 않는다(§7.3 · §5.3).
    memo: `reason:${reason}${marked ? "" : " status_write_failed"}`,
  });

  return { status: "failed", source: null, failureReason: reason };
}

/**
 * 원문을 지운다.
 *
 * Storage 객체를 먼저 지우고 `purged_at` 을 찍는다. 순서가 반대면 "지웠다고
 * 기록했는데 파일이 남은" 상태가 생기고, 그건 개인정보 감사(F-A-08)가 찾아내야 할
 * 것을 못 찾게 만든다.
 *
 * ── 순서만으로는 부족했다 (FIX-87) ──────────────────────────────────────────
 * 순서는 맞는데 **삭제 결과를 안 봤다.** `remove()` 가 실패해도 `purged_at` 을 찍었고,
 * 찍히는 순간 배치의 `is('purged_at', null)` 에서 **영영 빠진다** — 파기 배치라는
 * 안전망이 스스로 눈을 감는 셈이다. 지웠을 때만 찍는다.
 *
 * **`remove()` 는 없는 객체에도 오류를 안 낸다**(로컬 실측: `error:null data:[]`).
 * 그래서 오류만 보면 안 되고 **지워진 개수**를 본다. 여기서 0 이면 방금 내려받은
 * 파일이 사라졌다는 뜻이므로 `purged_at` 을 찍지 않고 배치에 넘긴다.
 */
async function purge(document: DocumentRow, actorId: string): Promise<void> {
  const admin = createAdminClient();

  const removed = await admin.storage.from(DOCUMENT_BUCKET).remove([document.storage_path]);
  const gone = removed.error === null && (removed.data ?? []).length > 0;

  if (!gone) {
    // **못 지웠으면 아무것도 찍지 않는다.** `purge_scheduled_at` 이 그대로 남아
    // 매시간 배치가 다시 집는다(§5.1 — 24시간 안에 지우면 된다). 경로·오류 문구는
    // 남기지 않는다(§5.3).
    await recordEvent({
      entityType: "document",
      entityId: document.id,
      eventType: "document_purge_failed",
      actor: { id: actorId },
      beforeState: "stored",
      afterState: "stored",
      memo: "reason:storage_remove_failed",
    });

    return;
  }

  /**
   * **`tryWrite` 다 — 던지면 더 잃는다**(D-237).
   *
   * `purge()` 는 실패 경로에서 `return fail(...)` **직전**에 불린다. 여기서 던지면
   * `fail()` 이 아예 안 돌아 상태도 증적도 안 남고, 부르는 쪽은 빈 catch 라
   * 예외마저 사라진다. 반대로 못 찍는 것은 **배치가 되돌린다** — 객체는 이미
   * 없으므로 배치가 `already_gone` 으로 찍어 마무리한다.
   */
  const marked = await tryWrite(
    "documents.update:purged-at",
    admin.from("documents").update({ purged_at: new Date().toISOString() }).eq("id", document.id),
  );

  await recordEvent({
    entityType: "document",
    entityId: document.id,
    eventType: "document_purged",
    actor: { id: actorId },
    beforeState: "stored",
    // **원문은 실제로 없어졌다.** 다만 표시를 못 찍었으면 그렇게 적는다 —
    // 배치가 마저 찍을 때까지 감사 화면에는 '파기 예정' 으로 보인다.
    afterState: marked ? "purged" : "purge_unmarked",
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
  //
  // **여기 셋은 전부 `mustWrite` 다** — 이 쓰기가 곧 본 작업이고, 실패한 채로
  // 다음 줄이 돌면 **틀린 리포트가 화면에 뜬다.**
  //
  // 던져서 잃는 것은 **즉시 파기**뿐이다(맨 아래 `purge`). 그건 잃어도 된다 —
  // `purge_scheduled_at` 이 살아 있어 배치가 §5.1 의 24시간 안에 지우고, 오히려
  // 원문이 남아 있어야 폴링이 **재개해서 다시 분석**할 수 있다.

  // 재개하면 앞선 실행이 넣은 것이 남아 있다. 못 지우고 넣으면 **같은 지적이 두 번**
  // 뜨고, 그 수로 계산한 위험도와 화면이 어긋난다.
  await mustWrite(
    "findings.delete:before-reinsert",
    admin.from("findings").delete().eq("analysis_id", input.analysisId),
  );

  if (report.findings.length > 0) {
    // **가장 위험한 줄이다.** 못 넣었는데 아래에서 `done` 으로 닫으면 화면은
    // 지적 0건짜리 완료 리포트를 그린다 — 사용자는 그것을 **"위험 없음"** 으로 읽는다
    // (§8 "부분 결과를 노출하지 않는다").
    await mustWrite(
      "findings.insert:report",
      admin.from("findings").insert(
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
      ),
    );
  }

  // 지적은 들어갔는데 `done` 을 못 찍으면 상태는 `running` 에 머물고, 폴링이 재개해
  // **다시 분석**한다 — 그때 원문은 이미 없으므로 `document_missing` 으로 끝나
  // **끝난 분석을 통째로 잃는다.**
  await mustWrite(
    "document_analyses.update:mark-done",
    admin
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
      .eq("id", input.analysisId),
  );

  // 품질·비용 원천(F-A-04 · §5.8). **문서 내용은 담기지 않는다.**
  //
  // S8-07 이 래퍼로 옮기고 **셀 수 있는 값 다섯을 더했다** — 지연·토큰 둘·생성/폐기
  // finding 수. 폐기 수는 그 호출이 끝나면 **다시 셀 수 없다**(폐기된 행은 저장되지
  // 않는다). 그전까지 유일한 흔적이 `entity_events.memo` 의 문자열이었고, 그것으로
  // 지표를 만들면 memo 형식을 바꾸는 날 폐기율이 조용히 0이 된다.
  //
  // **못 남긴 것을 세어 둔다**(FIX-88). 이 줄이 조용히 실패하면 품질 화면의 분모가
  // 그만큼 작아지고, 실패한 호출만 못 들어가는 날에는 **실패율이 0% 로 보인다** —
  // 그것이 S8-07 이 막으려던 "측정하지 않은 것이 0 으로 보인다" 그대로다.
  const logged = await logAiCall({
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
    memo: `source:${source} findings:${report.findings.length} discarded:${discardedCount} rules:${summary.source}${summary.drift ? " drift" : ""}${logged ? "" : " ai_log_failed"}`,
  });

  // ── 8단계. 파기 — 분석이 끝났으니 원문은 더 필요하지 않다 ─────────────────
  await purge(document, input.actorId);

  return { status: "done", source, failureReason: null };
}
