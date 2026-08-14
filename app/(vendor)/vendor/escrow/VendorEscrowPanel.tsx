"use client";

import { useState } from "react";

import { EmptyState } from "@/components/ui/EmptyState";
import { Button } from "@/components/ui/button";
import {
  ESCROW_CONFIRM_NO,
  ESCROW_CONFIRM_QUESTION,
  ESCROW_CONFIRM_YES,
  ESCROW_DISPUTE_NOTICE,
  ESCROW_LEGAL_PENDING_NOTICE,
  ESCROW_PARTY_NOTICE,
  ESCROW_STUB_NOTICE,
  SETTLEMENT_HELD_NOTICE,
} from "@/lib/core/escrow/escrow";
import type { EscrowView } from "@/lib/escrow/loader";
import { cn } from "@/lib/utils";

/**
 * 업체 안전거래 응대 (S5-09 · D-24)
 *
 * ── 업체에게 이 화면이 필요한 이유 ──────────────────────────────────────────
 * 업체도 **이행 확인의 당사자**다. 확인하지 않으면 릴리즈가 늦어지고 정산도 함께
 * 늦어지는데, 그 지연의 책임을 고객에게 물을 수 없다.
 *
 * ── "묶여 있다" 가 아니라 "맡겨져 있다" ─────────────────────────────────────
 * 문구가 플랫폼을 채권자로 읽히게 하지 않는다(D-24). 정산과의 관계도 명시한다 —
 * 보관 중인 금액은 이행 확인 뒤에 정산에 들어간다.
 */
export function VendorEscrowPanel({
  holds,
  stubMode,
}: {
  holds: EscrowView[];
  stubMode: boolean;
}) {
  if (holds.length === 0) {
    return (
      <EmptyState
        title="안전거래 건이 없어요"
        description="고객이 잔금을 결제하면 이행이 확인될 때까지 안전거래로 맡겨집니다."
      />
    );
  }

  return (
    <div className="space-y-4">
      <p className="rounded-lg border border-brand-200 bg-brand-50 px-3 py-2 text-xs text-brand-700">
        {ESCROW_LEGAL_PENDING_NOTICE}
      </p>

      {stubMode ? (
        <p className="rounded-lg border border-warning bg-warning-surface px-3 py-2 text-xs text-warning-foreground">
          {ESCROW_STUB_NOTICE}
        </p>
      ) : null}

      <p className="text-xs text-neutral-600">{SETTLEMENT_HELD_NOTICE}</p>

      {holds.map((hold) => (
        <HoldCard key={hold.id} hold={hold} />
      ))}

      <p className="text-xs text-neutral-500">{ESCROW_PARTY_NOTICE}</p>
    </div>
  );
}

function HoldCard({ hold }: { hold: EscrowView }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const answered = hold.vendorConfirmed !== null;
  const open = hold.status === "held";

  async function confirm(confirmed: boolean) {
    if (busy) return;

    setBusy(true);
    setError(null);

    try {
      const response = await fetch("/api/escrow/release", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ holdId: hold.id, confirmed }),
      });

      const payload = (await response.json()) as { ok: boolean; error?: { message: string } };

      if (payload.ok) {
        window.location.reload();

        return;
      }

      setError(payload.error?.message ?? "확인을 보내지 못했어요.");
    } catch {
      setError("확인을 보내지 못했어요. 잠시 후 다시 시도해 주세요.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-xl border border-border p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-medium text-neutral-500">맡겨진 잔금</p>
          <p className="mt-1 text-xl font-bold tabular-nums text-foreground">
            {hold.heldAmount.toLocaleString("ko-KR")}
            <span className="ml-1 text-sm font-medium text-neutral-500">원</span>
          </p>
        </div>
        <span
          className={cn(
            "shrink-0 rounded-full px-2 py-0.5 text-xs",
            hold.status === "released"
              ? "bg-success-surface text-success-foreground"
              : hold.status === "disputed"
                ? "bg-warning-surface text-warning-foreground"
                : "bg-neutral-100 text-neutral-600",
          )}
        >
          {hold.statusLabel}
        </span>
      </div>

      <p className="mt-2 text-sm text-neutral-700">{hold.statusDetail}</p>

      <dl className="mt-3 space-y-1 border-t border-border pt-3 text-xs text-neutral-600">
        <Line label="고객 확인" value={confirmLabel(hold.coupleConfirmed)} />
        <Line label="우리 확인" value={confirmLabel(hold.vendorConfirmed)} />
        {hold.confirmDueAt ? <Line label="확인 기한" value={hold.confirmDueAt.slice(0, 10)} /> : null}
      </dl>

      {hold.resolutionNote ? (
        <p className="mt-3 rounded-lg bg-neutral-50 p-3 text-xs text-neutral-600">
          운영자 조율 결과 · {hold.resolutionNote}
        </p>
      ) : null}

      {open ? (
        <div className="mt-4 border-t border-border pt-3">
          <p className="text-sm font-medium text-foreground">{ESCROW_CONFIRM_QUESTION}</p>
          <p className="mt-1 text-xs text-neutral-600">{hold.pendingDetail}</p>

          {answered ? (
            <p className="mt-3 text-xs text-neutral-600">회신을 보냈어요. 고객 확인을 기다립니다.</p>
          ) : (
            <>
              {error ? (
                <p role="alert" className="mt-2 text-xs text-danger-foreground">
                  {error}
                </p>
              ) : null}

              <div className="mt-3 flex gap-2">
                <Button size="sm" disabled={busy} onClick={() => confirm(true)}>
                  {ESCROW_CONFIRM_YES}
                </Button>
                <Button size="sm" variant="outline" disabled={busy} onClick={() => confirm(false)}>
                  {ESCROW_CONFIRM_NO}
                </Button>
              </div>

              <p className="mt-2 text-xs text-neutral-500">{ESCROW_DISPUTE_NOTICE}</p>
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}

function confirmLabel(value: boolean | null): string {
  if (value === null) return "아직 응답 없음";

  return value ? "이행됨" : "이행되지 않음";
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt>{label}</dt>
      <dd className="text-neutral-800">{value}</dd>
    </div>
  );
}
