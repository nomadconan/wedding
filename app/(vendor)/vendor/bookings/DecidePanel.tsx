"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";

/**
 * 예약 승인·거절 (S5-10 · F-V-08)
 *
 * ── 이 폼이 지키는 규칙 ─────────────────────────────────────────────────────
 * 1. **승인은 되돌릴 수 없다는 것을 누르기 전에 말한다**(D-23). 승인 뒤에 계약이
 *    발행되고 결제가 걸리므로, 되돌리려면 해지 절차를 밟아야 한다.
 * 2. **거절 사유가 필수다**(D-24). 화면이 먼저 막고, API 가 422 로 막고, CHECK 이
 *    마지막으로 막는다 — 셋이 같은 것을 요구한다.
 * 3. **거절은 예약을 끝낸다는 것도 미리 말한다.** 거절한 예약은 되살릴 수 없고
 *    새 예약을 만들어야 한다(트리거가 강제한다).
 * 4. **실패 사유를 서버 문장 그대로 보여준다** — 화면이 자기 말로 바꾸면 왜 막혔는지
 *    가 흐려진다.
 */
export function DecidePanel({ bookingId }: { bookingId: string }) {
  const router = useRouter();
  const [mode, setMode] = useState<"idle" | "accept" | "decline">("idle");
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(decision: "accept" | "decline") {
    setPending(true);
    setError(null);

    try {
      const response = await fetch(`/api/vendor/bookings/${bookingId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, reason: decision === "decline" ? reason : null }),
      });
      const payload = (await response.json()) as {
        ok: boolean;
        error?: { message?: string };
      };

      if (!response.ok || !payload.ok) {
        setError(payload.error?.message ?? "처리하지 못했습니다.");

        return;
      }

      setMode("idle");
      router.refresh();
    } catch {
      setError("네트워크 문제로 처리하지 못했어요. 잠시 후 다시 시도해 주세요.");
    } finally {
      setPending(false);
    }
  }

  if (mode === "idle") {
    return (
      <div className="space-y-2" data-testid="decide-panel">
        <div className="flex gap-2">
          <Button type="button" size="sm" onClick={() => setMode("accept")}>
            승인
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => setMode("decline")}>
            거절
          </Button>
        </div>
        {error !== null ? (
          <p className="text-caption text-warning" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  if (mode === "accept") {
    return (
      <div className="space-y-2 rounded-md border border-border p-3" data-testid="decide-accept">
        <p className="text-caption text-muted-foreground">
          <strong>승인은 되돌릴 수 없습니다.</strong> 승인하면 계약서를 발행할 수 있고, 발행
          뒤에는 결제 회차가 만들어집니다. 되돌리려면 해지 절차를 밟아야 합니다.
        </p>
        <div className="flex gap-2">
          <Button type="button" size="sm" disabled={pending} onClick={() => submit("accept")}>
            {pending ? "처리 중…" : "승인하기"}
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => setMode("idle")}>
            취소
          </Button>
        </div>
        {error !== null ? (
          <p className="text-caption text-warning" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  const reasonEmpty = reason.trim().length === 0;

  return (
    <div className="space-y-2 rounded-md border border-border p-3" data-testid="decide-decline">
      <p className="text-caption text-muted-foreground">
        <strong>거절하면 이 예약은 끝납니다.</strong> 되살릴 수 없고, 다시 진행하려면 새
        예약을 만들어야 합니다. <strong>사유는 고객에게 그대로 보입니다.</strong>
      </p>
      <label className="block text-caption font-medium text-foreground" htmlFor="decline-reason">
        거절 사유
      </label>
      <textarea
        id="decline-reason"
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        rows={3}
        maxLength={500}
        className="w-full rounded-md border border-border bg-background p-2 text-sm text-foreground"
        placeholder="예) 요청하신 날짜에 이미 다른 예약이 있습니다."
      />
      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={pending || reasonEmpty}
          onClick={() => submit("decline")}
        >
          {pending ? "처리 중…" : "거절하기"}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={() => setMode("idle")}>
          취소
        </Button>
      </div>
      {reasonEmpty ? (
        <p className="text-caption text-muted-foreground">
          사유 없는 거절은 고객에게 아무것도 알려주지 못합니다.
        </p>
      ) : null}
      {error !== null ? (
        <p className="text-caption text-warning" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
