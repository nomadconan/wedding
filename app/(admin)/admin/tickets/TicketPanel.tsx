"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  TICKET_ACTIONS,
  TICKET_ACTION_LABEL,
  TICKET_STATUS_HINT,
  type TicketAction,
  canApply,
  statusAfter,
} from "@/lib/core/support/ticket";

/**
 * 티켓 처리 (S8-09 · F-A-06)
 *
 * ── 이 폼이 지키는 규칙 ─────────────────────────────────────────────────────
 * 1. **할 수 없는 조치는 자리를 두지 않는다.** 종결된 티켓에는 버튼이 없다 — 눌렀는데
 *    "이미 종결" 이 뜨면 화면이 거짓 기대를 만든 것이다(S7-16 의 판단과 같다).
 * 2. **배정에도 사유를 요구한다.** 예외를 만들면 그 자리부터 빈칸이 된다.
 * 3. **담당자를 고르지 않는다.** 배정은 항상 자기 자신이다 — 남을 배정할 수 있으면
 *    "저 사람이 맡았다" 는 기록을 아무나 만들 수 있고 그것이 곧 책임 소재가 된다.
 * 4. **어휘가 신고자를 판정하지 않는다.** '조치함·조치하지 않음' 이며, 뒤쪽이
 *    "신고자가 틀렸다" 는 뜻이 아니라는 것을 힌트가 적는다(D-24).
 */
export type TicketPanelProps = { ticketId: string; status: string };

export function TicketPanel({ ticketId, status }: TicketPanelProps) {
  const router = useRouter();
  const [action, setAction] = useState<TicketAction | null>(null);
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const available = TICKET_ACTIONS.filter((candidate) => canApply(status, candidate));

  if (available.length === 0) {
    return (
      <p className="mt-2 text-caption text-muted-foreground" data-testid="ticket-terminal">
        종결된 티켓입니다. 다시 열지 않습니다 — 이어지는 문의는 새 티켓으로 받습니다.
      </p>
    );
  }

  const trimmed = note.trim();
  const problem = action !== null && trimmed.length === 0 ? "무엇을 왜 했는지 적어 주세요." : null;

  async function submit() {
    if (action === null || problem !== null) return;

    setPending(true);
    setError(null);

    try {
      const response = await fetch("/api/admin/tickets", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticketId, action, note: trimmed }),
      });
      const payload = (await response.json()) as { ok: boolean; error?: { message: string } };

      if (!payload.ok) {
        setError(payload.error?.message ?? "처리하지 못했습니다.");

        return;
      }

      setNote("");
      setAction(null);
      router.refresh();
    } catch {
      setError("처리하지 못했습니다. 잠시 후 다시 시도해 주세요.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="mt-3 space-y-2 rounded-md border border-border p-3" data-testid="ticket-panel">
      <div className="flex flex-wrap gap-2">
        {available.map((candidate) => (
          <Button
            key={candidate}
            type="button"
            size="sm"
            variant={action === candidate ? "default" : "outline"}
            onClick={() => setAction(candidate)}
          >
            {TICKET_ACTION_LABEL[candidate]}
          </Button>
        ))}
      </div>

      {action !== null ? (
        <p className="text-caption text-muted-foreground">{TICKET_STATUS_HINT[statusAfter(action)]}</p>
      ) : null}

      {action !== null ? (
        <label className="block space-y-1">
          <span className="text-caption font-medium text-foreground">
            사유 (필수 — 신고자에게 그대로 보입니다)
          </span>
          <textarea
            value={note}
            onChange={(event) => setNote(event.target.value)}
            rows={2}
            maxLength={1_000}
            className="w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm"
            data-testid="ticket-note"
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

      {action !== null ? (
        <Button type="button" size="sm" disabled={pending || problem !== null} onClick={() => void submit()}>
          {pending ? "처리 중…" : "기록하고 적용"}
        </Button>
      ) : null}
    </div>
  );
}
