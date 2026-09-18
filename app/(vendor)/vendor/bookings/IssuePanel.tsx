"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";

/**
 * 계약서 발행 (C-1b · F-C-15 · §4.2 `POST /api/contracts`)
 *
 * ── 화면이 "할 수 있다" 고만 말하고 있었다 ─────────────────────────────────
 * `POST /api/contracts` 는 S5-06 에 만들어져 있었고 `canIssueContract` 가 문까지
 * 열어 두었는데, **누를 자리가 리포 어디에도 없었다** — `/api/contracts` 를 부르는
 * 클라이언트가 하나도 없다. 그래서 목록은 "**계약서를 발행할 수 있습니다.**" 라고
 * 적어 놓고 버튼을 주지 않았다. 사슬이 여기서 끊겨 **결제·서명·정산까지 UI 로는
 * 도달할 수 없었다**(C-1b 가 실제 Chrome 으로 걸어 보다 막혔다).
 *
 * 화면이 못 하는 일을 시키지 않는 것과 **할 수 있다고 적고 수단을 안 주는 것**은
 * 같은 결함의 양면이다. 후자가 더 나쁘다 — 사용자는 자기가 뭘 잘못한 줄 안다.
 *
 * ── DecidePanel 과 같은 규칙을 지킨다 ──────────────────────────────────────
 * 1. **되돌릴 수 없다는 것을 누르기 전에 말한다**(D-23). 발행과 동시에 결제 회차가
 *    만들어지고, 되돌리려면 해지 절차를 밟아야 한다.
 * 2. **실패 사유를 서버 문장 그대로 보여준다** — 화면이 자기 말로 바꾸면 왜 막혔는지가
 *    흐려진다.
 * 3. **`quoteId` 를 함께 보낸다.** 안 보내면 총액이 예약 금액으로 굳고 계약이 어느
 *    견적에서 나왔는지가 끊긴다 — 사슬을 잇자고 만든 `bookings.quote_id`(C-1)가
 *    계약에 가서 사라진다.
 * 4. **역할을 보내지 않는다.** 업체인지는 서버가 세션으로 판정한다(라우트 주석).
 */
export function IssuePanel({
  bookingId,
  quoteId,
}: {
  bookingId: string;
  quoteId: string | null;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function issue() {
    setPending(true);
    setError(null);

    try {
      const response = await fetch("/api/contracts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bookingId, quoteId }),
      });
      const payload = (await response.json()) as {
        ok: boolean;
        error?: { message?: string };
      };

      if (!response.ok || !payload.ok) {
        setError(payload.error?.message ?? "발행하지 못했습니다.");

        return;
      }

      setConfirming(false);
      router.refresh();
    } catch {
      setError("네트워크 문제로 발행하지 못했어요. 잠시 후 다시 시도해 주세요.");
    } finally {
      setPending(false);
    }
  }

  if (!confirming) {
    return (
      <div className="space-y-2" data-testid="issue-panel">
        <Button type="button" size="sm" onClick={() => setConfirming(true)}>
          계약서 발행
        </Button>
        {error !== null ? (
          <p className="text-caption text-warning" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-2 rounded-md border border-border p-3" data-testid="issue-confirm">
      <p className="text-caption text-muted-foreground">
        <strong>발행하면 되돌릴 수 없습니다.</strong> 발행과 동시에 결제 회차가 만들어지고,
        고객·업체 서명이 모두 끝나면 계약이 확정됩니다. 되돌리려면 해지 절차를 밟아야 합니다.
      </p>
      <div className="flex gap-2">
        <Button type="button" size="sm" disabled={pending} onClick={() => void issue()}>
          {pending ? "발행 중…" : "발행하기"}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={() => setConfirming(false)}>
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
