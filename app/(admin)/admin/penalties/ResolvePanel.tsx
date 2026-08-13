"use client";

import { useState } from "react";

import { EmptyState } from "@/components/ui/EmptyState";
import { Button } from "@/components/ui/button";
import { FAULT_LABEL, type FaultParty } from "@/lib/core/cancellation/cancellation";
import { cn } from "@/lib/utils";

/**
 * 위약금 조율 (F-A-17 · §7.7 · D-24)
 *
 * ── 운영자는 조율자다 ───────────────────────────────────────────────────────
 * 그래서 **결론에 사유가 반드시 붙는다.** 사유 없이 버튼만 누를 수 없게 입력을
 * 필수로 두었고, API·DB 도 같은 것을 요구한다 — 세 층이 같은 규칙을 본다.
 *
 * ── 산정을 다시 하지 않는다 ─────────────────────────────────────────────────
 * 운영자가 정하는 것은 **귀책**이고 금액은 그 결과로 서버가 산정한다. 금액 입력칸을
 * 두지 않은 이유가 그것이다 — 두면 조율이 곧 임의 금액 결정이 되고, §7.7 의
 * "기준 대비 비교값" 원칙이 무너진다. 조항 문안이 확정되기 전까지(O-03) 이 화면이
 * 하는 일은 **절차와 기록**이다.
 */
export type QueueItem = {
  id: string;
  statusLabel: string;
  reasonLabel: string;
  reasonNote: string | null;
  coupleClaim: FaultParty | null;
  vendorClaim: FaultParty | null;
  coupleAgreed: boolean | null;
  vendorAgreed: boolean | null;
  bandLabel: string | null;
  basisRef: string | null;
  isDraftRules: boolean;
  paidAmount: number | null;
};

const DECISIONS: { value: "couple" | "vendor" | "mutual"; label: string; hint: string }[] = [
  { value: "couple", label: "고객 사정", hint: "기준 구간에 따른 위약금이 적용됩니다." },
  { value: "vendor", label: "업체 사정", hint: "위약금 없이 낸 금액을 전액 환불합니다." },
  { value: "mutual", label: "양측 합의", hint: "위약금 없이 원상 회복합니다." },
];

export function ResolvePanel({ items }: { items: QueueItem[] }) {
  if (items.length === 0) {
    return (
      <EmptyState
        title="조율할 건이 없어요"
        description="양측 확인이 갈리거나 기한이 지난 해지가 여기에 쌓입니다."
      />
    );
  }

  return (
    <div className="space-y-4">
      {items.map((item) => (
        <ResolveCard key={item.id} item={item} />
      ))}
    </div>
  );
}

function ResolveCard({ item }: { item: QueueItem }) {
  const [decision, setDecision] = useState<"couple" | "vendor" | "mutual" | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ready = decision !== null && note.trim().length > 0;

  async function submit() {
    if (!ready || busy) return;

    setBusy(true);
    setError(null);

    try {
      const response = await fetch("/api/admin/penalties", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cancellationId: item.id, decision, note }),
      });

      const payload = (await response.json()) as { ok: boolean; error?: { message: string } };

      if (payload.ok) {
        window.location.reload();

        return;
      }

      setError(payload.error?.message ?? "조율 결과를 저장하지 못했어요.");
    } catch {
      setError("조율 결과를 저장하지 못했어요.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-xl border border-border p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-foreground">{item.reasonLabel}</p>
          <p className="mt-0.5 text-xs text-neutral-500">
            고객 {claimText(item.coupleClaim, item.coupleAgreed)} · 업체{" "}
            {claimText(item.vendorClaim, item.vendorAgreed)}
          </p>
        </div>
        <span className="shrink-0 rounded-full bg-warning-surface px-2 py-0.5 text-xs text-warning-foreground">
          {item.statusLabel}
        </span>
      </div>

      {item.reasonNote ? (
        <p className="mt-2 rounded-lg bg-neutral-50 p-2 text-xs text-neutral-600">
          {item.reasonNote}
        </p>
      ) : null}

      <dl className="mt-3 space-y-1 text-xs text-neutral-600">
        <Line label="적용 구간" value={item.bandLabel ?? "산정 전"} />
        <Line label="기준" value={item.basisRef ?? "-"} />
        <Line
          label="고객이 낸 금액"
          value={item.paidAmount === null ? "-" : `${item.paidAmount.toLocaleString("ko-KR")}원`}
        />
      </dl>

      {item.isDraftRules ? (
        <p className="mt-2 rounded-lg border border-warning bg-warning-surface px-2 py-1 text-xs text-warning-foreground">
          기준 수치가 법무 검수 전 가정치입니다(O-03). 확정 기준이 들어오면 금액이 달라집니다.
        </p>
      ) : null}

      <div className="mt-4 space-y-3 border-t border-border pt-3">
        <div>
          <p className="text-xs font-medium text-neutral-700">귀책 결론</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {DECISIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => setDecision(option.value)}
                title={option.hint}
                className={cn(
                  "rounded-lg border px-3 py-1.5 text-xs",
                  decision === option.value
                    ? "border-brand-500 bg-brand-50 text-brand-700"
                    : "border-border text-neutral-700",
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
          {decision ? (
            <p className="mt-2 text-xs text-neutral-600">
              {DECISIONS.find((option) => option.value === decision)?.hint}
            </p>
          ) : null}
        </div>

        <div>
          <label htmlFor={`note-${item.id}`} className="text-xs font-medium text-neutral-700">
            조율 사유 <span className="text-danger">*</span>
          </label>
          <textarea
            id={`note-${item.id}`}
            value={note}
            rows={3}
            maxLength={1000}
            onChange={(event) => setNote(event.target.value)}
            className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
            placeholder="어떤 근거로 이렇게 판단했는지 적어 주세요. 당사자에게 그대로 전달됩니다."
          />
          <p className="mt-1 text-xs text-neutral-500">
            사유 없이 종결할 수 없습니다 — 플랫폼이 재량으로 정한 값이 아님을 남기기 위해서입니다.
          </p>
        </div>

        {error ? (
          <p role="alert" className="text-xs text-danger-foreground">
            {error}
          </p>
        ) : null}

        <Button size="sm" disabled={!ready || busy} onClick={submit}>
          {busy ? "처리 중…" : "조율 결과 확정하고 정산"}
        </Button>
      </div>
    </section>
  );
}

function claimText(claim: FaultParty | null, agreed: boolean | null): string {
  const agreeText = agreed === null ? "무응답" : agreed ? "동의" : "이의";

  return claim === null ? agreeText : `${agreeText}(${FAULT_LABEL[claim]})`;
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt>{label}</dt>
      <dd className="text-neutral-800">{value}</dd>
    </div>
  );
}
