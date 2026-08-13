"use client";

import { useState } from "react";

import { BrokerNotice } from "@/components/domain/BrokerNotice";
import { EmptyState } from "@/components/ui/EmptyState";
import { Button } from "@/components/ui/button";
import {
  CANCEL_ALREADY_TITLE,
  CANCEL_EMPTY_BODY,
  CANCEL_EMPTY_TITLE,
  CANCEL_PLATFORM_ROLE_NOTICE,
  CANCEL_PREVIEW_NOTICE,
  CANCEL_PREVIEW_TITLE,
  CANCEL_REASON_LABEL,
  CANCEL_REASON_CODES,
  CONFIRMATION_TIMEOUT_NOTICE,
  DISPUTE_QUEUE_NOTICE,
  FAULT_LABEL,
  claimsVendorFault,
  type CancelReasonCode,
  type FaultParty,
} from "@/lib/core/cancellation/cancellation";
import { cn } from "@/lib/utils";

/**
 * 계약 해지 요청 (S5-08 · F-A-17 · §6.2 · D-24)
 *
 * ── 모르고 취소하게 두지 않는다 ─────────────────────────────────────────────
 * 요청 버튼보다 **위에** 예상 위약금과 **산정 근거**(구간·기준 출처·적용 규칙)를 둔다.
 * 결과 숫자만 보여주면 납득할 수 없고, 납득하지 못한 정산은 그대로 분쟁이 된다.
 *
 * ── 귀책은 '주장' 으로 적는다 ───────────────────────────────────────────────
 * 고객이 고르는 것은 **누구 사정이라고 보는가** 이지 판정이 아니다. 화면 문구가 그
 * 사실을 드러낸다 — "업체 사정으로 봅니다" 를 고른다고 위약금이 0 이 되지 않고,
 * 업체 확인이나 운영자 조율을 거친다.
 *
 * ── 상태 3종 ────────────────────────────────────────────────────────────────
 * 해지할 계약이 없을 때 · 이미 절차가 진행 중일 때 · 요청할 수 있을 때.
 */
export type CancelQuote = {
  settlement: {
    penaltyAmount: number;
    refundAmount: number;
    balanceDue: number;
    appliedRule: string;
    notes: string[];
    disclaimer: string;
  };
  penalty: { bandLabel: string; basisRef: string; isDraftRules: boolean };
  daysBeforeEvent: number | null;
  paidAmount: number;
  totalAmount: number;
};

export type CancelData = {
  bookingId: string;
  stageLabel: string;
  quote: CancelQuote | null;
  cancellation: {
    id: string;
    status: string;
    statusLabel: string;
    requesterSide: "couple" | "vendor";
    reasonLabel: string;
    faultLabel: string;
    coupleAgreed: boolean | null;
    vendorAgreed: boolean | null;
    confirmDueAt: string | null;
    penaltyApplied: number | null;
    refundAmount: number | null;
    balanceDue: number | null;
    resolutionNote: string | null;
  } | null;
};

const CLAIM_OPTIONS: { value: FaultParty; label: string; hint: string }[] = [
  { value: "couple", label: "저희 사정이에요", hint: "기준에 따른 위약금이 적용됩니다." },
  {
    value: "vendor",
    label: "업체 사정으로 봅니다",
    hint: "업체 확인을 거쳐야 하며, 확인되면 위약금 없이 환불됩니다.",
  },
  { value: "mutual", label: "양측이 합의했어요", hint: "업체도 같은 내용으로 확인해야 합니다." },
];

export function CancelView({ data }: { data: CancelData }) {
  const [reason, setReason] = useState<CancelReasonCode | null>(null);
  const [claim, setClaim] = useState<FaultParty>("couple");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (data.quote === null) {
    return <EmptyState title={CANCEL_EMPTY_TITLE} description={CANCEL_EMPTY_BODY} />;
  }

  if (data.cancellation !== null) {
    return <InProgress data={data} />;
  }

  async function submit() {
    if (reason === null || busy) return;

    setBusy(true);
    setError(null);

    try {
      const response = await fetch(`/api/bookings/${data.bookingId}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reasonCode: reason, reasonNote: note || null, claim }),
      });

      const payload = (await response.json()) as { ok: boolean; error?: { message: string } };

      if (payload.ok) {
        window.location.reload();

        return;
      }

      setError(payload.error?.message ?? "해지 요청을 보내지 못했어요.");
    } catch {
      setError("해지 요청을 보내지 못했어요. 잠시 후 다시 시도해 주세요.");
    } finally {
      setBusy(false);
    }
  }

  const quote = data.quote;

  return (
    <div className="space-y-5">
      <QuoteBlock quote={quote} stageLabel={data.stageLabel} />

      <section className="rounded-xl border border-border p-4">
        <h2 className="text-sm font-semibold text-foreground">해지 사유</h2>
        <ul className="mt-3 space-y-2">
          {CANCEL_REASON_CODES.map((code) => (
            <li key={code}>
              <button
                type="button"
                onClick={() => {
                  setReason(code);
                  // 업체 귀책을 주장하는 사유를 고르면 주장 칸도 함께 옮겨 준다.
                  // 다만 **확정은 아니다** — 아래 문구가 그 사실을 적는다.
                  if (claimsVendorFault(code)) setClaim("vendor");
                }}
                className={cn(
                  "w-full rounded-lg border px-3 py-2 text-left text-sm",
                  reason === code
                    ? "border-brand-500 bg-brand-50 text-brand-700"
                    : "border-border text-neutral-700",
                )}
              >
                {CANCEL_REASON_LABEL[code]}
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="rounded-xl border border-border p-4">
        <h2 className="text-sm font-semibold text-foreground">누구 사정이라고 보시나요</h2>
        <p className="mt-1 text-xs text-neutral-500">
          여기서 고른 것은 <strong>의견</strong>이에요. 업체 확인이나 운영자 조율을 거쳐 확정됩니다.
        </p>
        <ul className="mt-3 space-y-2">
          {CLAIM_OPTIONS.map((option) => (
            <li key={option.value}>
              <button
                type="button"
                onClick={() => setClaim(option.value)}
                className={cn(
                  "w-full rounded-lg border px-3 py-2 text-left",
                  claim === option.value
                    ? "border-brand-500 bg-brand-50"
                    : "border-border",
                )}
              >
                <span className="block text-sm font-medium text-foreground">{option.label}</span>
                <span className="mt-0.5 block text-xs text-neutral-600">{option.hint}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="rounded-xl border border-border p-4">
        <label htmlFor="cancel-note" className="text-sm font-semibold text-foreground">
          보충 설명 <span className="font-normal text-neutral-500">(선택)</span>
        </label>
        <textarea
          id="cancel-note"
          value={note}
          maxLength={500}
          rows={3}
          onChange={(event) => setNote(event.target.value)}
          className="mt-2 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
          placeholder="상황을 간단히 적어 주세요."
        />
        <p className="mt-1 text-xs text-neutral-500">
          연락처·주소 같은 개인정보는 적지 말아 주세요. 500자까지 쓸 수 있어요.
        </p>
      </section>

      {error ? (
        <p role="alert" className="rounded-lg border border-danger bg-danger-surface px-3 py-2 text-sm text-danger-foreground">
          {error}
        </p>
      ) : null}

      <Button className="w-full" disabled={reason === null || busy} onClick={submit}>
        {busy ? "요청 중…" : "해지 요청 보내기"}
      </Button>

      <p className="text-center text-xs text-neutral-500">{CANCEL_PLATFORM_ROLE_NOTICE}</p>

      <BrokerNotice variant="inline" />
    </div>
  );
}

/** 예상 금액과 **산정 근거**. 근거 없이 결과만 보여주지 않는다(§7.7). */
function QuoteBlock({ quote, stageLabel }: { quote: CancelQuote; stageLabel: string }) {
  return (
    <section className="rounded-xl border border-border p-4">
      <p className="text-xs font-medium text-neutral-500">{CANCEL_PREVIEW_TITLE}</p>

      <dl className="mt-3 space-y-1.5 text-sm">
        <Row label="계약 총액" value={quote.totalAmount} />
        <Row label="지금까지 낸 금액" value={quote.paidAmount} />
        <Row label="예상 위약금" value={quote.settlement.penaltyAmount} emphasize />
        {quote.settlement.refundAmount > 0 ? (
          <Row label="돌려받는 금액" value={quote.settlement.refundAmount} emphasize />
        ) : null}
        {quote.settlement.balanceDue > 0 ? (
          <Row label="추가로 내야 하는 금액" value={quote.settlement.balanceDue} emphasize />
        ) : null}
      </dl>

      <div className="mt-4 rounded-lg bg-neutral-50 p-3 text-xs text-neutral-600">
        <p className="font-medium text-neutral-700">산정 근거</p>
        <ul className="mt-1.5 space-y-1">
          <li>취소 시점 · {stageLabel}</li>
          <li>적용 구간 · {quote.penalty.bandLabel}</li>
          <li>기준 · {quote.penalty.basisRef}</li>
          {quote.daysBeforeEvent === null ? (
            <li>예식일이 정해지지 않아 가장 임박한 구간으로 계산했어요.</li>
          ) : (
            <li>예식일까지 {quote.daysBeforeEvent}일</li>
          )}
        </ul>
      </div>

      {quote.settlement.notes.length > 0 ? (
        <ul className="mt-3 space-y-1 text-xs text-neutral-600">
          {quote.settlement.notes.map((note) => (
            <li key={note}>· {note}</li>
          ))}
        </ul>
      ) : null}

      <p className="mt-3 text-xs text-neutral-500">{CANCEL_PREVIEW_NOTICE}</p>
      {/* §7.7 — 참고 정보이며 법률 자문이 아니라는 고지를 접거나 숨기지 않는다. */}
      <p className="mt-2 border-t border-border pt-2 text-xs text-neutral-500">
        {quote.settlement.disclaimer}
      </p>
    </section>
  );
}

function InProgress({ data }: { data: CancelData }) {
  const cancellation = data.cancellation;
  if (cancellation === null) return null;

  const mine = cancellation.requesterSide === "couple";

  return (
    <div className="space-y-5">
      <section className="rounded-xl border border-border p-4">
        <h2 className="text-base font-semibold text-foreground">{CANCEL_ALREADY_TITLE}</h2>
        <dl className="mt-3 space-y-1.5 text-sm">
          <TextRow label="상태" value={cancellation.statusLabel} />
          <TextRow label="요청한 쪽" value={mine ? "고객" : "업체"} />
          <TextRow label="사유" value={cancellation.reasonLabel} />
          <TextRow label="귀책" value={cancellation.faultLabel} />
          <TextRow
            label="고객 확인"
            value={agreeLabel(cancellation.coupleAgreed)}
          />
          <TextRow label="업체 확인" value={agreeLabel(cancellation.vendorAgreed)} />
        </dl>

        {cancellation.penaltyApplied !== null ? (
          <dl className="mt-3 space-y-1.5 border-t border-border pt-3 text-sm">
            <Row label="확정 위약금" value={cancellation.penaltyApplied} emphasize />
            <Row label="환불" value={cancellation.refundAmount ?? 0} />
            <Row label="추가 청구" value={cancellation.balanceDue ?? 0} />
          </dl>
        ) : null}

        {cancellation.resolutionNote ? (
          <p className="mt-3 rounded-lg bg-neutral-50 p-3 text-xs text-neutral-600">
            운영자 조율 결과 · {cancellation.resolutionNote}
          </p>
        ) : null}
      </section>

      <p className="rounded-lg border border-border px-3 py-2 text-xs text-neutral-600">
        {cancellation.status === "disputed" ? DISPUTE_QUEUE_NOTICE : CONFIRMATION_TIMEOUT_NOTICE}
      </p>

      <BrokerNotice variant="inline" />
    </div>
  );
}

function agreeLabel(value: boolean | null): string {
  if (value === null) return "아직 응답 없음";

  return value ? "동의" : "이의 있음";
}

function Row({ label, value, emphasize }: { label: string; value: number; emphasize?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-neutral-600">{label}</dt>
      <dd className={cn("tabular-nums", emphasize ? "font-semibold text-foreground" : "text-neutral-700")}>
        {value.toLocaleString("ko-KR")}원
      </dd>
    </div>
  );
}

function TextRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-neutral-600">{label}</dt>
      <dd className="text-neutral-800">{value}</dd>
    </div>
  );
}

export { FAULT_LABEL };
