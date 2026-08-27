"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  CURATION_ACTIONS,
  CURATION_ACTION_LABEL,
  type CurationAction,
  curationProblem,
} from "@/lib/core/pricing/curation";

/**
 * 원천 표본 조치 (S8-10 · F-A-02)
 *
 * **사유 없이 표본을 뺄 수 없다.** 참가격에서 표본 하나를 빼는 것은 **지수를 움직이는
 * 일**이고, 나중에 "이 값이 왜 빠졌나" 에 답할 수 있어야 한다. 화면이 막는 것은
 * 편의이고 최종 판정은 라우트와 **DB CHECK**(0056)다.
 *
 * **할 수 없는 조치는 자리를 두지 않는다** — 이미 제외된 표본에 '제외' 버튼이 있으면
 * 화면이 거짓 기대를 만든다.
 */
export type CurationPanelProps = {
  sourceId: string;
  excluded: boolean;
};

export function CurationPanel({ sourceId, excluded }: CurationPanelProps) {
  const router = useRouter();
  const [action, setAction] = useState<CurationAction | null>(null);
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const row = { excludedReason: excluded ? "excluded" : null };
  const available = CURATION_ACTIONS.filter(
    (candidate) => curationProblem({ row, action: candidate, reason: "x" }) === null,
  );
  const problem = curationProblem({ row, action, reason });

  async function submit() {
    if (problem || !action) return;

    setPending(true);
    setError(null);

    try {
      const response = await fetch("/api/admin/prices/recalculate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceId, action, reason }),
      });
      const payload = (await response.json()) as { ok: boolean; error?: { message: string } };

      if (!payload.ok) {
        setError(payload.error?.message ?? "기록하지 못했습니다.");

        return;
      }

      setReason("");
      setAction(null);
      router.refresh();
    } catch {
      setError("기록하지 못했습니다. 잠시 후 다시 시도해 주세요.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="mt-2 space-y-2" data-testid="curation-panel">
      <div className="flex flex-wrap gap-2">
        {available.map((candidate) => (
          <Button
            key={candidate}
            type="button"
            size="sm"
            variant={action === candidate ? "default" : "outline"}
            onClick={() => setAction(action === candidate ? null : candidate)}
          >
            {CURATION_ACTION_LABEL[candidate]}
          </Button>
        ))}
      </div>

      {action ? (
        <div className="space-y-1.5">
          <Label htmlFor={`reason-${sourceId}`}>
            사유 <span className="text-danger">*</span>
          </Label>
          <Input
            id={`reason-${sourceId}`}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="이 표본을 왜 그렇게 다루는지 적어 주세요."
            maxLength={1000}
          />
          <p className="text-caption text-muted-foreground">
            제외는 지수를 움직입니다. 나중에 &apos;이 값이 왜 빠졌나&apos;에 답할 수 있어야 합니다.
          </p>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}

      {action ? (
        <Button type="button" size="sm" disabled={Boolean(problem) || pending} onClick={submit}>
          {pending ? "기록 중…" : "기록하고 저장"}
        </Button>
      ) : null}

      {problem && action ? <p className="text-caption text-muted-foreground">{problem}</p> : null}
    </div>
  );
}

export default CurationPanel;
