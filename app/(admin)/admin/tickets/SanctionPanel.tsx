"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  USER_SANCTION_UNAVAILABLE,
  VENDOR_SANCTION_HINT,
  VENDOR_SANCTION_LABEL,
  type VendorSanction,
} from "@/lib/core/support/ticket";

/**
 * 업체 공개 중지·재개 (S8-09 · F-A-06 '제재 조치')
 *
 * **집행할 수 있는 것만 버튼으로 둔다.** 업체 중지는 `vendors.status='suspended'` 이고
 * 공개 정책이 `status='active'` 만 보여주므로 **실제로 사라진다** — 화면이 "중지했다"
 * 고 적으면 그것이 사실이다.
 *
 * **사용자 정지 버튼이 없다.** 집행 수단이 없어서이며, 그 사실을 감추지 않고 적는다 —
 * 칸만 만들면 화면은 "정지됨" 이라 적는데 그 사용자는 계속 서비스를 쓴다.
 *
 * **진행 중인 예약·계약은 건드리지 않는다.** 되돌릴 수 없는 일 둘을 한 버튼에 묶지
 * 않으며, 누르기 전에 그 사실을 말한다.
 */
export type SanctionPanelProps = {
  vendorId: string;
  vendorName: string;
  suspended: boolean;
  /** 어느 티켓에서 나온 조치인가. 없으면 직접 조치다. */
  ticketId: string | null;
};

export function SanctionPanel({ vendorId, vendorName, suspended, ticketId }: SanctionPanelProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sanction: VendorSanction = suspended ? "reinstate" : "suspend";
  const trimmed = reason.trim();
  const problem = trimmed.length === 0 ? "사유를 적어 주세요." : null;

  async function submit() {
    if (problem !== null) return;

    setPending(true);
    setError(null);

    try {
      const response = await fetch("/api/admin/tickets", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vendorId, sanction, reason: trimmed, ticketId }),
      });
      const payload = (await response.json()) as { ok: boolean; error?: { message: string } };

      if (!payload.ok) {
        setError(payload.error?.message ?? "조치하지 못했습니다.");

        return;
      }

      setReason("");
      setOpen(false);
      router.refresh();
    } catch {
      setError("조치하지 못했습니다. 잠시 후 다시 시도해 주세요.");
    } finally {
      setPending(false);
    }
  }

  if (!open) {
    return (
      <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)}>
        {VENDOR_SANCTION_LABEL[sanction]}
      </Button>
    );
  }

  return (
    <div className="mt-2 space-y-2 rounded-md border border-border p-3" data-testid="sanction-panel">
      <p className="text-sm font-medium text-foreground">
        {vendorName} — {VENDOR_SANCTION_LABEL[sanction]}
      </p>
      <p className="text-caption text-muted-foreground">{VENDOR_SANCTION_HINT[sanction]}</p>

      <label className="block space-y-1">
        <span className="text-caption font-medium text-foreground">
          사유 (필수 — 되돌릴 때도 기록에 남습니다)
        </span>
        <textarea
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          rows={2}
          maxLength={1_000}
          className="w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm"
          data-testid="sanction-reason"
        />
      </label>

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

      <div className="flex gap-2">
        <Button type="button" size="sm" disabled={pending || problem !== null} onClick={() => void submit()}>
          {pending ? "적용 중…" : "적용"}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
          접기
        </Button>
      </div>

      <p className="text-caption text-muted-foreground">
        <strong>사용자 계정 정지는 여기서 할 수 없습니다.</strong>{" "}
        {USER_SANCTION_UNAVAILABLE.message} ({USER_SANCTION_UNAVAILABLE.openIssue})
      </p>
    </div>
  );
}
