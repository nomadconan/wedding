"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  FINDING_REPORT_REASONS,
  FINDING_REPORT_REASON_LABEL,
  type FindingReportReason,
} from "@/lib/core/quality/review";

/**
 * 오탐 신고 (S8-07 · F-A-04 접수 면)
 *
 * **F-A-04 의 '오탐 신고 처리' 는 접수 경로가 있어야 성립한다.** 운영자 큐만 만들고
 * 여기를 잇지 않으면 그 큐는 영원히 비어 있고, 빈 큐는 "오탐이 없다" 로 읽힌다.
 *
 * **판정하지 않는다.** 신고해도 리포트는 그대로다 — 사용자가 눌렀다고 항목이 사라지면
 * 리포트를 마음대로 지울 수 있게 되고, 그 리포트는 협상 자료로 쓸 수 없다.
 * 화면이 그 사실을 미리 적는다.
 *
 * **처리 상태를 보내지 않는다** — 스키마에도 DB 컬럼 권한에도 자리가 없다(0059).
 */
export function FindingReportButton({ findingId }: { findingId: string }) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(reason: FindingReportReason) {
    setPending(true);
    setError(null);

    try {
      const response = await fetch(`/api/findings/${findingId}/report`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      });
      const payload = (await response.json()) as { ok: boolean; error?: { message: string } };

      if (!payload.ok) {
        setError(payload.error?.message ?? "접수하지 못했어요.");

        return;
      }

      setDone(true);
      setOpen(false);
    } catch {
      setError("접수하지 못했어요. 잠시 후 다시 시도해 주세요.");
    } finally {
      setPending(false);
    }
  }

  if (done) {
    return (
      <p className="text-caption text-muted-foreground" data-testid="finding-report-done">
        알려 주셔서 고맙습니다. 담당자가 확인합니다 — <strong>리포트 내용은 그대로
        유지됩니다.</strong>
      </p>
    );
  }

  return (
    <div className="space-y-1" data-testid="finding-report">
      {open ? (
        <div className="space-y-2 rounded-md border border-border p-3">
          <p className="text-caption font-medium text-foreground">무엇이 잘못됐나요?</p>
          <div className="flex flex-wrap gap-2">
            {FINDING_REPORT_REASONS.map((reason) => (
              <Button
                key={reason}
                type="button"
                variant="outline"
                size="sm"
                disabled={pending}
                onClick={() => void send(reason)}
              >
                {FINDING_REPORT_REASON_LABEL[reason]}
              </Button>
            ))}
          </div>
          <p className="text-caption text-muted-foreground">
            신고해도 <strong>이 항목은 사라지지 않습니다.</strong> 담당자가 보고 검토 규칙을
            손볼지 정합니다.
          </p>
          {error !== null ? (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          ) : null}
        </div>
      ) : (
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(true)}>
          이 항목이 잘못됐어요
        </Button>
      )}
    </div>
  );
}
