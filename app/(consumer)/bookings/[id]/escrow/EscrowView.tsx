"use client";

import { useState } from "react";

import { BrokerNotice } from "@/components/domain/BrokerNotice";
import { EmptyState } from "@/components/ui/EmptyState";
import { Button } from "@/components/ui/button";
import {
  ESCROW_CONFIRM_NO,
  ESCROW_CONFIRM_QUESTION,
  ESCROW_CONFIRM_YES,
  ESCROW_DISPUTE_NOTICE,
  ESCROW_EMPTY_BODY,
  ESCROW_EMPTY_TITLE,
  ESCROW_LEGAL_PENDING_NOTICE,
  ESCROW_PARTY_NOTICE,
  ESCROW_STUB_NOTICE,
  ESCROW_TARGET_NOTICE,
  TIMEOUT_RELEASE_NOTICE,
} from "@/lib/core/escrow/escrow";
import type { EscrowView as EscrowRow } from "@/lib/escrow/loader";
import { cn } from "@/lib/utils";

/**
 * 안전거래 (S5-09 · F-C-16 · §6.2 · D-24 · O-03)
 *
 * ── "플랫폼이 돈을 받는다" 로 읽히지 않게 한다 (D-24) ──────────────────────
 * 화면의 주어는 **금액**이고 플랫폼이 하는 일은 **맡아 둔다**이다. 상태 문구도
 * `lib/core/escrow` 의 상수를 그대로 쓴다 — 화면마다 다시 쓰면 고지 내용이 갈라진다.
 * `BrokerNotice`(D-24)를 접거나 숨기지 않는다.
 *
 * ── 법적 요건이 미결이라는 사실을 숨기지 않는다 (O-03) ─────────────────────
 * 자금 보관은 결제보다 요건이 무겁다. 실예치가 켜지기 전에는 **절차와 기록만**
 * 동작한다는 것을 화면이 먼저 말한다 — "안전거래로 보호받고 있다" 는 오해가
 * 생기면 그 오해 자체가 손해가 된다.
 *
 * ── 상태 3종 ────────────────────────────────────────────────────────────────
 * 맡겨진 금액이 없을 때 · 확인을 기다릴 때 · 종결됐을 때.
 */
export type EscrowData = { holds: EscrowRow[]; stubMode: boolean };

export function EscrowView({ data }: { data: EscrowData }) {
  if (data.holds.length === 0) {
    return (
      <div className="space-y-5">
        <EmptyState title={ESCROW_EMPTY_TITLE} description={ESCROW_EMPTY_BODY} />
        <p className="text-xs text-neutral-600">{ESCROW_TARGET_NOTICE}</p>
        <BrokerNotice variant="inline" />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* O-03 — 실예치 전이라는 사실을 맨 위에 둔다. */}
      <p className="rounded-lg border border-brand-200 bg-brand-50 px-3 py-2 text-xs text-brand-700">
        {ESCROW_LEGAL_PENDING_NOTICE}
      </p>

      {data.stubMode ? (
        <p className="rounded-lg border border-warning bg-warning-surface px-3 py-2 text-xs text-warning-foreground">
          {ESCROW_STUB_NOTICE}
        </p>
      ) : null}

      {data.holds.map((hold) => (
        <HoldCard key={hold.id} hold={hold} />
      ))}

      <p className="text-xs text-neutral-600">{ESCROW_PARTY_NOTICE}</p>

      <BrokerNotice variant="inline" />
    </div>
  );
}

function HoldCard({ hold }: { hold: EscrowRow }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const answered = hold.coupleConfirmed !== null;
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
          <p className="text-xs font-medium text-neutral-500">맡겨진 금액</p>
          <p className="mt-1 text-2xl font-bold tabular-nums tracking-tight text-foreground">
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
        <Line label="업체 확인" value={confirmLabel(hold.vendorConfirmed)} />
        {hold.confirmDueAt ? (
          <Line label="확인 기한" value={hold.confirmDueAt.slice(0, 10)} />
        ) : null}
        {hold.releasedAt ? <Line label="전달 완료" value={hold.releasedAt.slice(0, 10)} /> : null}
        {hold.refundedAt ? <Line label="환불 완료" value={hold.refundedAt.slice(0, 10)} /> : null}
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
            <p className="mt-3 text-xs text-neutral-600">
              회신을 보냈어요. {TIMEOUT_RELEASE_NOTICE}
            </p>
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
              <p className="mt-1 text-xs text-neutral-500">{TIMEOUT_RELEASE_NOTICE}</p>
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
