"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  DISPUTE_ACTIONS,
  DISPUTE_ACTION_LABEL,
  type DisputeAction,
  type DisputeStatus,
  UNRESOLVED_NOTICE,
  agreementState,
  disputeProblem,
  isTerminal,
} from "@/lib/core/dispute/mediation";

/**
 * 예약 분쟁 조율 (S8-03 · D-24)
 *
 * **양측 동의 없이는 '합의' 버튼이 통하지 않는다.** 체크 둘이 다 켜져야 저장이 열리고,
 * 라우트와 DB CHECK 가 같은 말을 한다(세 층). 한쪽만 끄덕인 것을 합의로 적으면 그
 * 기록이 나중에 "합의했잖아요" 의 근거가 된다.
 *
 * **'플랫폼이 이렇게 정한다' 버튼이 없다.** 조치 넷은 전부 제시하거나 기록하는 일이다.
 */
export type MediatePanelProps = {
  disputeId: string;
  status: DisputeStatus;
  coupleAgreed: boolean;
  vendorAgreed: boolean;
};

export function MediatePanel({
  disputeId,
  status,
  coupleAgreed: initialCouple,
  vendorAgreed: initialVendor,
}: MediatePanelProps) {
  const router = useRouter();
  const [action, setAction] = useState<DisputeAction | null>(null);
  const [note, setNote] = useState("");
  const [coupleAgreed, setCoupleAgreed] = useState(initialCouple);
  const [vendorAgreed, setVendorAgreed] = useState(initialVendor);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (isTerminal(status)) return null;

  const problem = disputeProblem({ status, action, note, coupleAgreed, vendorAgreed });

  async function submit() {
    if (problem || !action) return;

    setPending(true);
    setError(null);

    try {
      const response = await fetch(`/api/admin/disputes/${disputeId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, note, coupleAgreed, vendorAgreed }),
      });
      const payload = (await response.json()) as { ok: boolean; error?: { message: string } };

      if (!payload.ok) {
        setError(payload.error?.message ?? "기록하지 못했습니다.");

        return;
      }

      setNote("");
      setAction(null);
      router.refresh();
    } catch {
      setError("기록하지 못했습니다. 잠시 후 다시 시도해 주세요.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="mt-3 space-y-3 rounded-md border border-border p-3" data-testid="mediate-panel">
      <div className="flex flex-wrap gap-2">
        {DISPUTE_ACTIONS.map((candidate) => (
          <Button
            key={candidate}
            type="button"
            size="sm"
            variant={action === candidate ? "default" : "outline"}
            onClick={() => setAction(action === candidate ? null : candidate)}
          >
            {DISPUTE_ACTION_LABEL[candidate]}
          </Button>
        ))}
      </div>

      <div className="space-y-2">
        <p className="text-caption text-muted-foreground">
          합의 진행 · <strong>{agreementState(coupleAgreed, vendorAgreed)}</strong>
        </p>
        <div className="flex flex-wrap gap-4">
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={coupleAgreed}
              onCheckedChange={(value) => setCoupleAgreed(value === true)}
            />
            커플 측 동의
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={vendorAgreed}
              onCheckedChange={(value) => setVendorAgreed(value === true)}
            />
            업체 측 동의
          </label>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={`note-${disputeId}`}>
          사유 <span className="text-danger">*</span>
        </Label>
        <Input
          id={`note-${disputeId}`}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder={
            action === "propose"
              ? "어떤 조율안을 제시했는지 적어 주세요."
              : "무엇을 근거로 그렇게 기록하는지 적어 주세요."
          }
          maxLength={2000}
        />
        <p className="text-caption text-muted-foreground">
          접수를 거두는 경우에도 사유가 필요합니다. 안 한 것도 설명할 수 있어야 합니다.
        </p>
      </div>

      {action === "unresolved" ? (
        <p className="rounded-md bg-muted p-2 text-caption text-muted-foreground">
          {UNRESOLVED_NOTICE}
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}

      <Button type="button" size="sm" disabled={Boolean(problem) || pending} onClick={submit}>
        {pending ? "기록 중…" : "기록하고 저장"}
      </Button>

      {problem && action ? <p className="text-caption text-muted-foreground">{problem}</p> : null}
    </div>
  );
}

export default MediatePanel;
