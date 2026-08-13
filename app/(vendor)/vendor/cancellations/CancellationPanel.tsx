"use client";

import { useState } from "react";

import { EmptyState } from "@/components/ui/EmptyState";
import { Button } from "@/components/ui/button";
import {
  CANCEL_PLATFORM_ROLE_NOTICE,
  CONFIRMATION_TIMEOUT_NOTICE,
  DISPUTE_QUEUE_NOTICE,
  FAULT_LABEL,
  type FaultParty,
} from "@/lib/core/cancellation/cancellation";
import { cn } from "@/lib/utils";

/**
 * 업체 해지 응대 (S5-08 · F-V-08 인접 · D-24)
 *
 * ── 동의와 귀책을 따로 받는다 ───────────────────────────────────────────────
 * "해지에는 동의하지만 우리 잘못은 아니다" 가 실제로 흔한 답이다. 하나로 합치면
 * 그 상태를 표현할 수 없어 고객의 주장이 그대로 정산이 된다. 그래서 버튼이 둘이
 * 아니라 **동의 여부 + 귀책 의견**이다.
 *
 * ── 업체 화면에도 산정 근거를 보여준다 ──────────────────────────────────────
 * 업체가 무엇에 동의하는지 모르면 그 동의는 증적으로서 약하다(D-23).
 */
export type VendorCancellationItem = {
  id: string;
  bookingId: string;
  status: string;
  statusLabel: string;
  requesterSide: "couple" | "vendor";
  reasonLabel: string;
  reasonNote: string | null;
  faultLabel: string;
  coupleClaim: FaultParty | null;
  vendorAgreed: boolean | null;
  confirmDueAt: string | null;
  bandLabel: string | null;
  basisRef: string | null;
  isDraftRules: boolean;
  paidAmount: number | null;
  penaltyApplied: number | null;
  refundAmount: number | null;
};

const CLAIM_OPTIONS: { value: FaultParty; label: string }[] = [
  { value: "couple", label: "고객 사정" },
  { value: "vendor", label: "저희 사정" },
  { value: "mutual", label: "양측 합의" },
];

export function CancellationPanel({ items }: { items: VendorCancellationItem[] }) {
  if (items.length === 0) {
    return (
      <EmptyState
        title="해지 요청이 없어요"
        description="고객이 계약 해지를 요청하면 여기에 나타납니다."
      />
    );
  }

  return (
    <div className="space-y-4">
      {items.map((item) => (
        <CancellationCard key={item.id} item={item} />
      ))}

      <p className="text-xs text-neutral-500">{CANCEL_PLATFORM_ROLE_NOTICE}</p>
    </div>
  );
}

function CancellationCard({ item }: { item: VendorCancellationItem }) {
  const [claim, setClaim] = useState<FaultParty>(item.coupleClaim ?? "couple");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const answered = item.vendorAgreed !== null;
  const closed = item.status === "settled" || item.status === "disputed";

  async function confirm(agreed: boolean) {
    if (busy) return;

    setBusy(true);
    setError(null);

    try {
      const response = await fetch(`/api/cancellations/${item.id}/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agreed, claim }),
      });

      const payload = (await response.json()) as { ok: boolean; error?: { message: string } };

      if (payload.ok) {
        window.location.reload();

        return;
      }

      setError(payload.error?.message ?? "회신을 보내지 못했어요.");
    } catch {
      setError("회신을 보내지 못했어요. 잠시 후 다시 시도해 주세요.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-xl border border-border p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-foreground">
            {item.requesterSide === "couple" ? "고객" : "우리"}의 해지 요청
          </p>
          <p className="mt-0.5 text-xs text-neutral-500">{item.reasonLabel}</p>
        </div>
        <span
          className={cn(
            "shrink-0 rounded-full px-2 py-0.5 text-xs",
            item.status === "disputed"
              ? "bg-warning-surface text-warning-foreground"
              : "bg-neutral-100 text-neutral-600",
          )}
        >
          {item.statusLabel}
        </span>
      </div>

      {item.reasonNote ? (
        <p className="mt-2 rounded-lg bg-neutral-50 p-2 text-xs text-neutral-600">
          {item.reasonNote}
        </p>
      ) : null}

      <dl className="mt-3 space-y-1 text-xs text-neutral-600">
        <Line label="고객 의견" value={item.coupleClaim ? FAULT_LABEL[item.coupleClaim] : "없음"} />
        <Line label="확정 귀책" value={item.faultLabel} />
        <Line label="적용 구간" value={item.bandLabel ?? "산정 전"} />
        <Line label="기준" value={item.basisRef ?? "-"} />
        <Line
          label="고객이 낸 금액"
          value={item.paidAmount === null ? "-" : `${item.paidAmount.toLocaleString("ko-KR")}원`}
        />
        {item.penaltyApplied !== null ? (
          <Line
            label="확정 위약금"
            value={`${item.penaltyApplied.toLocaleString("ko-KR")}원`}
          />
        ) : null}
      </dl>

      {item.isDraftRules ? (
        <p className="mt-2 rounded-lg border border-warning bg-warning-surface px-2 py-1 text-xs text-warning-foreground">
          기준 수치가 법무 검수 전 가정치예요. 확정 기준이 반영되면 금액이 달라질 수 있어요.
        </p>
      ) : null}

      {closed ? (
        <p className="mt-3 text-xs text-neutral-600">
          {item.status === "disputed" ? DISPUTE_QUEUE_NOTICE : "정산이 끝난 건이에요."}
        </p>
      ) : answered ? (
        <p className="mt-3 text-xs text-neutral-600">
          회신을 보냈어요. {CONFIRMATION_TIMEOUT_NOTICE}
        </p>
      ) : (
        <div className="mt-4 space-y-3 border-t border-border pt-3">
          <div>
            <p className="text-xs font-medium text-neutral-700">누구 사정이라고 보시나요</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {CLAIM_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setClaim(option.value)}
                  className={cn(
                    "rounded-lg border px-3 py-1.5 text-xs",
                    claim === option.value
                      ? "border-brand-500 bg-brand-50 text-brand-700"
                      : "border-border text-neutral-700",
                  )}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          {error ? (
            <p role="alert" className="text-xs text-danger-foreground">
              {error}
            </p>
          ) : null}

          <div className="flex gap-2">
            <Button size="sm" disabled={busy} onClick={() => confirm(true)}>
              해지에 동의
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => confirm(false)}>
              이의 있음
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt>{label}</dt>
      <dd className="text-neutral-800">{value}</dd>
    </div>
  );
}
