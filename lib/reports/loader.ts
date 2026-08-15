import type { SupabaseClient } from "@supabase/supabase-js";

import {
  purgeState,
  severityCounts,
  sortBySeverity,
  type AnalysisStatus,
  type PurgeState,
} from "@/lib/core/report/pipeline";
import type { RuleSeverity } from "@/lib/core/rules/types";

/**
 * 리포트 조회 (S7-03 · 명세서 §6.2 `/reports`·`/reports/[id]`)
 *
 * **세션 클라이언트로 읽는다.** `documents`·`document_analyses`·`findings` 는 커플
 * 스코프 RLS 가 걸려 있고(0005 [40]~[42]), 그것이 인가의 최종 경계다. 여기서
 * 서비스롤을 쓰면 경계가 이 파일의 `eq("couple_id", …)` 한 줄이 된다.
 *
 * **`storage_path` 를 조회하지 않는다.** 화면이 쓸 일이 없고, 고르지 않으면 응답에
 * 실릴 일도 없다(0004 주석: "로그 금지 대상"). 파기 이후 제외해야 한다는 §3.9 의
 * 요구는 **애초에 읽지 않는 것**으로 만족시킨다.
 */

export type ReportListRow = {
  documentId: string;
  analysisId: string | null;
  status: AnalysisStatus | null;
  riskScore: number | null;
  createdAt: string;
  purge: PurgeState;
  purgeScheduledAt: string;
};

export type ReportFinding = {
  id: string;
  rule_code: string;
  severity: RuleSeverity;
  clauseExcerpt: string | null;
  basisRef: string | null;
  explanation: string | null;
  negotiationScript: string | null;
};

export type ReportDetail = {
  documentId: string;
  analysisId: string;
  status: AnalysisStatus;
  riskScore: number | null;
  createdAt: string;
  /** **분석 행**의 갱신 시각. 끊긴 실행을 되살릴지 판정하는 근거다(문서 시각이 아니다). */
  updatedAt: string;
  purge: PurgeState;
  purgeScheduledAt: string;
  findings: ReportFinding[];
  counts: Record<RuleSeverity, number>;
  /** 근거 출처 모음. 화면이 고지 아래 함께 적는다. */
  basisRefs: string[];
};

type DocumentRow = {
  id: string;
  created_at: string;
  purged_at: string | null;
  purge_scheduled_at: string;
};

type AnalysisRow = {
  id: string;
  document_id: string;
  status: string;
  risk_score: number | null;
  updated_at: string;
};

const DOCUMENT_COLUMNS = "id, created_at, purged_at, purge_scheduled_at";

export async function listReports(client: SupabaseClient): Promise<ReportListRow[]> {
  const { data: documents } = await client
    .from("documents")
    .select(DOCUMENT_COLUMNS)
    .eq("doc_type", "contract")
    .order("created_at", { ascending: false })
    .limit(50);

  const rows = (documents ?? []) as unknown as DocumentRow[];
  if (rows.length === 0) return [];

  const { data: analyses } = await client
    .from("document_analyses")
    .select("id, document_id, status, risk_score, updated_at")
    .in(
      "document_id",
      rows.map((row) => row.id),
    );

  // 문서당 가장 최근 분석 하나. 재분석이 생겨도 목록은 마지막 것을 말한다.
  const latest = new Map<string, AnalysisRow>();
  for (const analysis of (analyses ?? []) as unknown as AnalysisRow[]) {
    const current = latest.get(analysis.document_id);

    if (current === undefined || current.updated_at < analysis.updated_at) {
      latest.set(analysis.document_id, analysis);
    }
  }

  return rows.map((row) => {
    const analysis = latest.get(row.id) ?? null;

    return {
      documentId: row.id,
      analysisId: analysis?.id ?? null,
      status: (analysis?.status ?? null) as AnalysisStatus | null,
      riskScore: analysis?.risk_score ?? null,
      createdAt: row.created_at,
      purge: purgeState(row.purged_at),
      purgeScheduledAt: row.purge_scheduled_at,
    };
  });
}

export async function loadReport(
  client: SupabaseClient,
  analysisId: string,
): Promise<ReportDetail | null> {
  const { data: analysisRow } = await client
    .from("document_analyses")
    .select("id, document_id, status, risk_score, updated_at")
    .eq("id", analysisId)
    .maybeSingle();

  const analysis = analysisRow as unknown as AnalysisRow | null;
  if (analysis === null) return null;

  const { data: documentRow } = await client
    .from("documents")
    .select(DOCUMENT_COLUMNS)
    .eq("id", analysis.document_id)
    .maybeSingle();

  const document = documentRow as unknown as DocumentRow | null;
  // RLS 가 문서를 막으면 분석도 남의 것이다. **둘 다 보여야 보여준다.**
  if (document === null) return null;

  const { data: findingRows } = await client
    .from("findings")
    .select("id, rule_code, severity, clause_excerpt_masked, basis_ref, explanation, negotiation_script")
    .eq("analysis_id", analysisId);

  const findings = ((findingRows ?? []) as unknown as {
    id: string;
    rule_code: string;
    severity: RuleSeverity;
    clause_excerpt_masked: string | null;
    basis_ref: string | null;
    explanation: string | null;
    negotiation_script: string | null;
  }[]).map((row) => ({
    id: row.id,
    rule_code: row.rule_code,
    severity: row.severity,
    clauseExcerpt: row.clause_excerpt_masked,
    basisRef: row.basis_ref,
    explanation: row.explanation,
    negotiationScript: row.negotiation_script,
  }));

  return {
    documentId: document.id,
    analysisId: analysis.id,
    status: analysis.status as AnalysisStatus,
    riskScore: analysis.risk_score,
    createdAt: document.created_at,
    updatedAt: analysis.updated_at,
    purge: purgeState(document.purged_at),
    purgeScheduledAt: document.purge_scheduled_at,
    findings: sortBySeverity(findings),
    counts: severityCounts(findings),
    basisRefs: [...new Set(findings.map((row) => row.basisRef).filter((ref): ref is string => ref !== null))],
  };
}

/** 홈이 쓰는 최근 리포트 한 건(§6.2 `/home`). 없으면 null 이다. */
export async function latestReport(client: SupabaseClient): Promise<ReportListRow | null> {
  const rows = await listReports(client);

  return rows[0] ?? null;
}
