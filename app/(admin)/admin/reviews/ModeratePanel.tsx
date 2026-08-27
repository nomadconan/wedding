"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  REVIEW_REPORT_STATUS_LABEL,
  type ReviewReportStatus,
} from "@/lib/core/review/report";
import {
  REVIEW_MODERATION_ACTIONS,
  type ReviewModerationAction,
} from "@/lib/core/review/write";

/**
 * 후기 조치 · 신고 처리 (S8-11 · F-A-13)
 *
 * **사유 없이 저장할 수 없다.** 화면이 막는 것은 편의이고 최종 판정은 라우트와
 * DB CHECK 다 — 세 층이 같은 말을 한다(S7-17 이 정한 규칙).
 *
 * **'복구' 에도 사유를 요구한다.** 내릴 때만 묻고 되돌릴 때는 묻지 않으면 기록에
 * "내렸다(사유 있음) → 올렸다(사유 없음)" 만 남아 왜 되돌렸는지 답할 수 없다.
 *
 * **어휘가 '참·거짓' 이 아니다**(D-24). 신고 처리 버튼은 '사실 확인'·'허위' 가 아니라
 * **'후기를 내림'·'내리지 않음'** 이다 — 우리는 후기에 적힌 일이 있었는지 판정할
 * 수단이 없고, 판정하는 척하면 조율자의 자리를 벗어난다.
 */
const ACTION_LABEL: Record<ReviewModerationAction, string> = {
  hide: "비공개로 내림",
  restore: "다시 공개",
};

const ACTION_HINT: Record<ReviewModerationAction, string> = {
  hide: "업체 화면에 사유가 그대로 보입니다. 무엇을 고쳐야 하는지 알 수 있게 적어 주세요.",
  restore: "사유는 증적에만 남습니다(행에는 남지 않습니다). 왜 되돌렸는지 적어 주세요.",
};

export type ModeratePanelProps = {
  reviewId: string;
  /** 지금 상태. 같은 상태로 가는 조치는 자리를 두지 않는다. */
  status: string;
  retracted: boolean;
  openReports: { id: string; reasonLabel: string; verifiable: boolean }[];
};

export function ModeratePanel({ reviewId, status, retracted, openReports }: ModeratePanelProps) {
  const router = useRouter();
  const [action, setAction] = useState<ReviewModerationAction | null>(null);
  const [reason, setReason] = useState("");
  const [reportId, setReportId] = useState<string | null>(null);
  const [reportStatus, setReportStatus] = useState<ReviewReportStatus | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // **거둬진 후기에는 조치를 걸지 않는다** — 이미 안 보이고, 여기에 비공개를
  // 덧씌우면 작성자가 거뒀다는 사실이 운영자 조치처럼 읽힌다. 라우트도 같은 답을
  // 하지만 누를 수 있는 버튼을 두지 않는 편이 낫다(S7-16 의 판단과 같다).
  if (retracted) {
    return (
      <p className="mt-3 text-caption text-muted-foreground" data-testid="moderate-retracted">
        작성자가 거둔 후기입니다. 이미 공개되지 않으며 운영자 조치를 걸지 않습니다.
      </p>
    );
  }

  const available = REVIEW_MODERATION_ACTIONS.filter((candidate) =>
    candidate === "hide" ? status === "published" : status === "hidden",
  );

  const trimmed = reason.trim();
  const needsReason = action !== null || reportStatus !== null;
  const problem = needsReason && trimmed.length === 0 ? "사유를 적어 주세요." : null;

  async function submit(url: string, body: Record<string, unknown>) {
    setPending(true);
    setError(null);

    try {
      const response = await fetch(url, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await response.json()) as { ok: boolean; error?: { message: string } };

      if (!payload.ok) {
        setError(payload.error?.message ?? "처리하지 못했습니다.");

        return;
      }

      setReason("");
      setAction(null);
      setReportId(null);
      setReportStatus(null);
      router.refresh();
    } catch {
      setError("처리하지 못했습니다. 잠시 후 다시 시도해 주세요.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="mt-3 space-y-3 rounded-md border border-border p-3" data-testid="moderate-panel">
      {openReports.length > 0 ? (
        <div className="space-y-2">
          <p className="text-caption font-medium text-foreground">처리 대기 신고</p>
          {openReports.map((report) => (
            <div key={report.id} className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-foreground">{report.reasonLabel}</span>
              <span className="text-caption text-muted-foreground">
                {report.verifiable
                  ? "거래 이력으로 확인 가능한 사유입니다."
                  : "내용에 대한 주장이라 플랫폼이 사실 여부를 판정하지 않습니다."}
              </span>
              {(["upheld", "rejected"] as const).map((next) => (
                <Button
                  key={next}
                  type="button"
                  size="sm"
                  variant={reportId === report.id && reportStatus === next ? "default" : "outline"}
                  onClick={() => {
                    setReportId(report.id);
                    setReportStatus(next);
                    setAction(null);
                  }}
                >
                  {REVIEW_REPORT_STATUS_LABEL[next]}
                </Button>
              ))}
            </div>
          ))}
          <p className="text-caption text-muted-foreground">
            <strong>&apos;후기를 내림&apos;은 비공개 조치와 같은 사건입니다.</strong> 신고를
            인정하면 후기도 함께 내려갑니다.
          </p>
        </div>
      ) : null}

      {available.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {available.map((candidate) => (
            <Button
              key={candidate}
              type="button"
              size="sm"
              variant={action === candidate ? "default" : "outline"}
              onClick={() => {
                setAction(candidate);
                setReportId(null);
                setReportStatus(null);
              }}
            >
              {ACTION_LABEL[candidate]}
            </Button>
          ))}
        </div>
      ) : null}

      {action !== null ? (
        <p className="text-caption text-muted-foreground">{ACTION_HINT[action]}</p>
      ) : null}

      {needsReason ? (
        <label className="block space-y-1">
          <span className="text-caption font-medium text-foreground">
            사유 (필수 — 기록에 남고 나중에 설명의 근거가 됩니다)
          </span>
          <textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            rows={2}
            maxLength={1_000}
            className="w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm"
            data-testid="moderate-reason"
          />
        </label>
      ) : null}

      {problem !== null && reason !== "" ? (
        <p role="alert" className="text-sm text-warning">
          {problem}
        </p>
      ) : null}

      {error !== null ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}

      {needsReason ? (
        <Button
          type="button"
          size="sm"
          disabled={pending || problem !== null}
          onClick={() => {
            if (reportStatus !== null && reportId !== null) {
              void submit("/api/admin/review-reports", {
                reportId,
                status: reportStatus,
                note: trimmed,
              });

              return;
            }

            if (action !== null) {
              void submit("/api/admin/reviews", { reviewId, action, reason: trimmed });
            }
          }}
        >
          {pending ? "처리 중…" : "기록하고 적용"}
        </Button>
      ) : null}
    </div>
  );
}
