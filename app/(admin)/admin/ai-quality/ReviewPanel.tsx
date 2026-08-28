"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  FINDING_REPORT_STATUS_LABEL,
  REVIEW_VERDICTS,
  REVIEW_VERDICT_HINT,
  REVIEW_VERDICT_LABEL,
  type ReviewVerdict,
} from "@/lib/core/quality/review";

/**
 * 샘플 검수 · 오탐 신고 처리 (S8-07 · F-A-04)
 *
 * **사유 없이 저장할 수 없다** — '근거와 맞음' 도 예외가 아니다. 화면이 막는 것은
 * 편의이고 최종 판정은 라우트와 DB CHECK 다(S7-17 이 정한 규칙 · 세 층이 같은 말).
 *
 * **어휘가 사용자를 가리키지 않는다.** 신고 처리 버튼은 '허위·사실' 이 아니라
 * **'룰을 손볼 자리로 받음'·'지금 룰대로 나온 결과'** 다 — 판정 대상은 우리 룰이다.
 */
export type ReviewPanelProps =
  | {
      kind: "analysis";
      analysisId: string;
      /** 이미 내가 검수했는가. 있으면 그 값을 미리 채운다. */
      current: { verdict: string; note: string } | null;
    }
  | { kind: "report"; reportId: string };

export function ReviewPanel(props: ReviewPanelProps) {
  const router = useRouter();
  const [verdict, setVerdict] = useState<ReviewVerdict | null>(
    props.kind === "analysis" && props.current
      ? (props.current.verdict as ReviewVerdict)
      : null,
  );
  const [reportStatus, setReportStatus] = useState<"upheld" | "rejected" | null>(null);
  const [note, setNote] = useState(props.kind === "analysis" ? (props.current?.note ?? "") : "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = note.trim();
  const chosen = props.kind === "analysis" ? verdict !== null : reportStatus !== null;
  const problem = chosen && trimmed.length === 0 ? "사유를 적어 주세요." : null;

  async function submit() {
    if (!chosen || problem !== null) return;

    setPending(true);
    setError(null);

    try {
      const response =
        props.kind === "analysis"
          ? await fetch("/api/admin/ai-reviews", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ analysisId: props.analysisId, verdict, note: trimmed }),
            })
          : await fetch("/api/admin/finding-reports", {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ reportId: props.reportId, status: reportStatus, note: trimmed }),
            });

      const payload = (await response.json()) as { ok: boolean; error?: { message: string } };

      if (!payload.ok) {
        setError(payload.error?.message ?? "처리하지 못했습니다.");

        return;
      }

      if (props.kind === "report") {
        setNote("");
        setReportStatus(null);
      }
      router.refresh();
    } catch {
      setError("처리하지 못했습니다. 잠시 후 다시 시도해 주세요.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="mt-3 space-y-2 rounded-md border border-border p-3" data-testid="quality-panel">
      <div className="flex flex-wrap gap-2">
        {props.kind === "analysis"
          ? REVIEW_VERDICTS.map((candidate) => (
              <Button
                key={candidate}
                type="button"
                size="sm"
                variant={verdict === candidate ? "default" : "outline"}
                onClick={() => setVerdict(candidate)}
              >
                {REVIEW_VERDICT_LABEL[candidate]}
              </Button>
            ))
          : (["upheld", "rejected"] as const).map((candidate) => (
              <Button
                key={candidate}
                type="button"
                size="sm"
                variant={reportStatus === candidate ? "default" : "outline"}
                onClick={() => setReportStatus(candidate)}
              >
                {FINDING_REPORT_STATUS_LABEL[candidate]}
              </Button>
            ))}
      </div>

      {props.kind === "analysis" && verdict !== null ? (
        <p className="text-caption text-muted-foreground">{REVIEW_VERDICT_HINT[verdict]}</p>
      ) : null}

      {chosen ? (
        <label className="block space-y-1">
          <span className="text-caption font-medium text-foreground">
            {props.kind === "analysis"
              ? "무엇을 보았는지 (필수 — '근거와 맞음' 도 적습니다)"
              : "처리 사유 (필수 — 룰을 어떻게 볼 것인지 적습니다)"}
          </span>
          <textarea
            value={note}
            onChange={(event) => setNote(event.target.value)}
            rows={2}
            maxLength={1_000}
            className="w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm"
            data-testid="quality-note"
          />
        </label>
      ) : null}

      {problem !== null && note !== "" ? (
        <p role="alert" className="text-sm text-warning">
          {problem}
        </p>
      ) : null}

      {error !== null ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}

      {chosen ? (
        <Button type="button" size="sm" disabled={pending || problem !== null} onClick={() => void submit()}>
          {pending ? "저장 중…" : "기록"}
        </Button>
      ) : null}
    </div>
  );
}
