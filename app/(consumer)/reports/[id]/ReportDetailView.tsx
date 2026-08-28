"use client";

import { Copy } from "lucide-react";
import { useEffect, useState } from "react";

import { AiDisclaimer } from "@/components/domain/AiDisclaimer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  ANALYSIS_STATUS_LABEL,
  NO_SCRIPT_NOTE,
  PURGE_STATE_LABEL,
  SEVERITY_LABEL,
  isTerminal,
} from "@/lib/core/report/pipeline";
import type { ReportDetail } from "@/lib/reports/loader";
import { cn } from "@/lib/utils";

import { FindingReportButton } from "./FindingReportButton";

/**
 * /reports/[id] — 리포트 상세 (F-C-07 · 명세서 §6.2)
 *
 * **분석이 끝날 때까지 폴링한다**(§4.2 — 202 + job id). 폴링은 서버에서 끊긴 실행을
 * 되살리는 계기이기도 하다(`GET /api/reports/[id]` 주석).
 *
 * **법적 고지를 상시 고정 노출한다**(CLAUDE.md §2.3). 접기·닫기·툴팁이 없다.
 * 근거 출처는 고지에 함께 싣는다 — 조항 번호는 적지 않는다(법무 검수 대기 · 부록 D ②).
 */
const POLL_MS = 3_000;

export function ReportDetailView({ initial }: { initial: ReportDetail & { sourceNotice?: Record<string, string> } }) {
  const [report, setReport] = useState(initial);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    if (isTerminal(report.status)) return;

    const timer = setInterval(async () => {
      try {
        const response = await fetch(`/api/reports/${report.analysisId}`);
        const payload = await response.json();

        if (response.ok && payload.ok) setReport(payload.data);
      } catch {
        // 다음 주기에 다시 시도한다. 화면은 이미 그려져 있다.
      }
    }, POLL_MS);

    return () => clearInterval(timer);
  }, [report.status, report.analysisId]);

  async function copyScript(id: string, script: string) {
    try {
      await navigator.clipboard.writeText(script);
      setCopied(id);
    } catch {
      setCopied(null);
    }
  }

  return (
    <div className="space-y-4" data-testid="report-detail" data-status={report.status}>
      <AiDisclaimer basisRef={report.basisRefs} />

      <section className="rounded-lg border border-border p-4">
        <div className="flex items-baseline justify-between gap-2">
          <p className="text-sm font-medium text-foreground">
            {ANALYSIS_STATUS_LABEL[report.status]}
          </p>
          {report.riskScore === null ? null : (
            <p className="flex items-baseline gap-1">
              <span data-amount="" className="text-amount text-foreground">
                {report.riskScore}
              </span>
              <span className="text-caption text-muted-foreground">위험 점수</span>
            </p>
          )}
        </div>

        <p className="mt-1 text-caption text-muted-foreground">
          {PURGE_STATE_LABEL[report.purge]}
          {report.purge === "scheduled"
            ? ` · ${new Date(report.purgeScheduledAt).toLocaleString("ko-KR")}까지`
            : ""}
        </p>

        {report.status === "failed" ? (
          <p className="mt-2 text-sm text-warning">
            분석을 마치지 못했어요. 다른 파일로 다시 시도해 주세요.
          </p>
        ) : null}

        {isTerminal(report.status) ? null : (
          <p className="mt-2 text-caption text-muted-foreground">
            분석이 끝나면 자동으로 결과가 나타나요.
          </p>
        )}
      </section>

      {report.findings.length > 0 ? (
        <div className="flex gap-2" data-testid="report-counts">
          {(["high", "mid", "low"] as const).map((severity) =>
            report.counts[severity] === 0 ? null : (
              <Badge
                key={severity}
                variant={severity === "high" ? "destructive" : "secondary"}
              >
                {SEVERITY_LABEL[severity]} {report.counts[severity]}건
              </Badge>
            ),
          )}
        </div>
      ) : null}

      {report.status === "done" && report.findings.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          검출 룰에 걸린 조항이 없어요. 룰이 찾지 못한 위험이 있을 수 있으니 계약 전에 조항을 한 번 더
          확인해 주세요.
        </p>
      ) : null}

      <ul className="space-y-3" data-testid="report-findings">
        {report.findings.map((finding) => (
          <li
            key={finding.id}
            className={cn(
              "space-y-2 rounded-lg border p-4",
              finding.severity === "high" ? "border-danger/40" : "border-border",
            )}
            data-testid="report-finding"
            data-severity={finding.severity}
          >
            <div className="flex items-center gap-2">
              <Badge variant={finding.severity === "high" ? "destructive" : "secondary"}>
                {SEVERITY_LABEL[finding.severity]}
              </Badge>
              <span className="text-caption text-muted-foreground">{finding.rule_code}</span>
            </div>

            {finding.explanation ? (
              <p className="text-sm text-foreground">{finding.explanation}</p>
            ) : null}

            {finding.clauseExcerpt ? (
              // 저장된 인용은 **마스킹본**이다(0004 주석 · §5.1).
              <blockquote className="rounded-md bg-muted px-3 py-2 text-caption text-muted-foreground">
                {finding.clauseExcerpt}
              </blockquote>
            ) : null}

            {finding.basisRef ? (
              <p className="text-caption text-neutral-500">근거 · {finding.basisRef}</p>
            ) : null}

            {finding.negotiationScript && finding.negotiationScript !== NO_SCRIPT_NOTE ? (
              <div className="space-y-1">
                <p className="whitespace-pre-wrap rounded-md border border-border px-3 py-2 text-caption text-foreground">
                  {finding.negotiationScript}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void copyScript(finding.id, finding.negotiationScript ?? "")}
                >
                  <Copy aria-hidden="true" className="mr-1 h-3 w-3" />
                  {copied === finding.id ? "복사했어요" : "요청 문구 복사"}
                </Button>
              </div>
            ) : (
              <p className="text-caption text-muted-foreground">{NO_SCRIPT_NOTE}</p>
            )}

            {/* 오탐 신고(F-A-04 접수 면 · S8-07). 운영자 큐만 만들고 여기를 잉지
                않으면 그 큐는 영원히 비어 있고, **빈 큐는 '오탐이 없다' 로 읽힌다.** */}
            <FindingReportButton findingId={finding.id} />
          </li>
        ))}
      </ul>
    </div>
  );
}

export default ReportDetailView;
