"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  REVIEW_REPORT_REASONS,
  REVIEW_REPORT_REASON_LABEL,
  type ReviewReportReason,
  isVerifiableReason,
} from "@/lib/core/review/report";

/**
 * 후기 답변·신고 (S8-11 · F-V-11)
 *
 * **답변과 신고를 같은 자리에 둔다.** 업체가 후기를 읽고 할 수 있는 일이 그 둘이고,
 * 나누면 신고가 눈에 띄지 않는 곳으로 밀린다.
 *
 * **답변을 지우는 경로를 두지 않았다.** 답변은 공개된 말이고, 지울 수 있으면 후기
 * 옆의 대화가 한쪽만 남는다(D-23 과 같은 결). 고칠 수는 있다.
 *
 * **신고는 접수까지다.** 처리 상태를 고르는 자리가 없고 DB 도 그 칸의 쓰기 권한을
 * 주지 않는다 — 신고자가 자기 신고를 닫으면 운영자 큐에 뜨지 않는다(FIX-36).
 */
export type ReplyPanelProps = {
  reviewId: string;
  currentReply: string | null;
  /** 공개 중인 후기에만 답변한다. 거둬졌거나 내려간 후기는 자리를 두지 않는다. */
  answerable: boolean;
  /** 우리가 이미 넣은 신고. 같은 사유를 두 번 넣게 두지 않는다. */
  reportedReasons: ReviewReportReason[];
};

export function ReplyPanel({
  reviewId,
  currentReply,
  answerable,
  reportedReasons,
}: ReplyPanelProps) {
  const router = useRouter();
  const [reply, setReply] = useState(currentReply ?? "");
  const [mode, setMode] = useState<"idle" | "reply" | "report">("idle");
  const [reason, setReason] = useState<ReviewReportReason | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function send(url: string, body: Record<string, unknown>) {
    setPending(true);
    setError(null);
    setDone(null);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await response.json()) as { ok: boolean; error?: { message: string } };

      if (!payload.ok) {
        setError(payload.error?.message ?? "처리하지 못했습니다.");

        return;
      }

      setMode("idle");
      setReason(null);
      router.refresh();
    } catch {
      setError("처리하지 못했습니다. 잠시 후 다시 시도해 주세요.");
    } finally {
      setPending(false);
    }
  }

  const trimmedReply = reply.trim();
  const availableReasons = REVIEW_REPORT_REASONS.filter(
    (candidate) => !reportedReasons.includes(candidate),
  );

  return (
    <div className="mt-3 space-y-3 rounded-md border border-border p-3" data-testid="reply-panel">
      <div className="flex flex-wrap gap-2">
        {answerable ? (
          <Button
            type="button"
            size="sm"
            variant={mode === "reply" ? "default" : "outline"}
            onClick={() => setMode(mode === "reply" ? "idle" : "reply")}
          >
            {currentReply === null ? "답변 쓰기" : "답변 고치기"}
          </Button>
        ) : null}

        {availableReasons.length > 0 ? (
          <Button
            type="button"
            size="sm"
            variant={mode === "report" ? "default" : "outline"}
            onClick={() => setMode(mode === "report" ? "idle" : "report")}
          >
            부당 후기 신고
          </Button>
        ) : null}
      </div>

      {!answerable ? (
        <p className="text-caption text-muted-foreground">
          공개 중인 후기에만 답변할 수 있습니다. 작성자가 거두었거나 운영자가 내린 후기입니다.
        </p>
      ) : null}

      {mode === "reply" ? (
        <label className="block space-y-1">
          <span className="text-caption font-medium text-foreground">
            답변 (고객과 다음 고객이 함께 읽습니다)
          </span>
          <textarea
            value={reply}
            onChange={(event) => setReply(event.target.value)}
            rows={3}
            maxLength={2_000}
            className="w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm"
            data-testid="vendor-reply"
          />
          <Button
            type="button"
            size="sm"
            disabled={pending || trimmedReply.length === 0}
            onClick={() => void send("/api/vendor/reviews", { reviewId, reply: trimmedReply })}
          >
            {pending ? "저장 중…" : "답변 저장"}
          </Button>
        </label>
      ) : null}

      {mode === "report" ? (
        <div className="space-y-2">
          <p className="text-caption font-medium text-foreground">신고 사유</p>
          <div className="flex flex-wrap gap-2">
            {availableReasons.map((candidate) => (
              <Button
                key={candidate}
                type="button"
                size="sm"
                variant={reason === candidate ? "default" : "outline"}
                onClick={() => setReason(candidate)}
              >
                {REVIEW_REPORT_REASON_LABEL[candidate]}
              </Button>
            ))}
          </div>

          {reason !== null ? (
            <p className="text-caption text-muted-foreground">
              {isVerifiableReason(reason)
                ? "거래 이력은 저희가 확인할 수 있는 사실입니다. 접수 후 운영자가 대조합니다."
                : "내용에 대한 주장이라 플랫폼이 사실 여부를 판정하지는 않습니다. 운영자가 보고 게시 여부를 정합니다."}
            </p>
          ) : null}

          <Button
            type="button"
            size="sm"
            disabled={pending || reason === null}
            onClick={() => {
              if (reason === null) return;
              void send(`/api/reviews/${reviewId}/report`, { reason });
            }}
          >
            {pending ? "접수 중…" : "신고 접수"}
          </Button>
        </div>
      ) : null}

      {done !== null ? <p className="text-sm text-foreground">{done}</p> : null}

      {error !== null ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
