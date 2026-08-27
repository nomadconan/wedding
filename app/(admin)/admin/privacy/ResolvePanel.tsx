"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  DELETION_ACTIONS,
  type DeletionAction,
  type DeletionStatus,
  canApply,
  deletionProblem,
} from "@/lib/core/privacy/deletion";

/**
 * 삭제 요청 처리 (S8-04)
 *
 * **사유 없이 저장할 수 없다.** 화면이 막는 것은 편의이고 최종 판정은 라우트와
 * DB CHECK 다 — 세 층이 같은 말을 한다(S7-17 이 정한 규칙).
 *
 * **할 수 없는 조치는 자리를 두지 않는다.** 눌렀는데 "권한이 없다" 가 뜨면 화면이
 * 거짓 기대를 만든 것이다(S7-16 의 판단과 같다).
 */
const ACTION_LABEL: Record<DeletionAction, string> = {
  start: "처리 중으로",
  complete: "처리 완료",
  reject: "거절",
};

export type ResolvePanelProps = {
  requestId: string;
  status: DeletionStatus;
};

export function ResolvePanel({ requestId, status }: ResolvePanelProps) {
  const router = useRouter();
  const [action, setAction] = useState<DeletionAction | null>(null);
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const available = DELETION_ACTIONS.filter((candidate) => canApply(status, candidate));
  if (available.length === 0) return null;

  const problem = deletionProblem({ status, action, reason });

  async function submit() {
    if (problem || !action) return;

    setPending(true);
    setError(null);

    try {
      const response = await fetch("/api/admin/privacy-audit", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId, action, reason }),
      });
      const payload = (await response.json()) as { ok: boolean; error?: { message: string } };

      if (!payload.ok) {
        setError(payload.error?.message ?? "처리하지 못했습니다.");

        return;
      }

      setReason("");
      setAction(null);
      router.refresh();
    } catch {
      setError("처리하지 못했습니다. 잠시 후 다시 시도해 주세요.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="mt-3 space-y-2 rounded-md border border-border p-3" data-testid="resolve-panel">
      <div className="flex flex-wrap gap-2">
        {available.map((candidate) => (
          <Button
            key={candidate}
            type="button"
            size="sm"
            variant={action === candidate ? "default" : "outline"}
            onClick={() => setAction(action === candidate ? null : candidate)}
          >
            {ACTION_LABEL[candidate]}
          </Button>
        ))}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={`reason-${requestId}`}>
          처리 사유 <span className="text-danger">*</span>
        </Label>
        <Input
          id={`reason-${requestId}`}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="무엇을 어떻게 처리했는지 적어 주세요."
          maxLength={1000}
        />
        {/* '조치 없음' 도 설명해야 한다 — 거절에도 사유가 붙는다. */}
        <p className="text-caption text-muted-foreground">
          거절도 사유가 필요합니다. 안 한 것도 설명할 수 있어야 합니다.
        </p>
      </div>

      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}

      <Button type="button" size="sm" disabled={Boolean(problem) || pending} onClick={submit}>
        {pending ? "처리 중…" : "기록하고 저장"}
      </Button>

      {problem && action ? (
        <p className="text-caption text-muted-foreground">{problem}</p>
      ) : null}
    </div>
  );
}

export default ResolvePanel;
