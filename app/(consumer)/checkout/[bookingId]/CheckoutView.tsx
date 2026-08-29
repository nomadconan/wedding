"use client";

import { useState } from "react";

import { BrokerNotice } from "@/components/domain/BrokerNotice";
import { EmptyState } from "@/components/ui/EmptyState";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { COUPON_STACKING_NOTICE } from "@/lib/core/coupon/coupon";
import type { WalletEntry } from "@/lib/core/coupon/wallet";
import {
  CHECKOUT_CONSENT_ITEMS,
  CHECKOUT_CONSENT_VERSION,
  CHECKOUT_EMPTY_BODY,
  CHECKOUT_EMPTY_TITLE,
  CHECKOUT_FULLY_PAID_BODY,
  CHECKOUT_FULLY_PAID_TITLE,
  CHECKOUT_RESULT_TITLE,
  CHECKOUT_STUB_NOTICE,
  COUPON_SLOT_MESSAGE,
  CONSENT_KINDS,
  consentComplete,
  type CheckoutAmounts,
  type ConsentKind,
  type CouponSlotState,
} from "@/lib/core/payment/checkout";
import { cn } from "@/lib/utils";

/**
 * 결제 화면 (S5-06 · §6.2 /checkout/[bookingId] · F-C-14 · D-18 · D-24)
 *
 * ── 총액과 이번 회차를 구분한다 (D-18) ──────────────────────────────────────
 * 가장 큰 숫자는 **이번에 낼 금액**이고, 계약 총액·이미 낸 금액·이번 결제 뒤 남는
 * 금액을 같은 블록에서 함께 보인다. 총액만 크게 적으면 20% 회차 화면에서 고객이
 * 놀라 이탈하고, 회차만 적으면 "이게 전부인 줄 알았다" 가 된다.
 *
 * ── 회차 목록을 감추지 않는다 ───────────────────────────────────────────────
 * 낼 수 없는 회차도 **사유와 함께** 보인다. 감추면 고객은 남은 회차가 몇 개이고
 * 언제 내는지 모른 채 결제한다 — F-C-14 가 요구하는 "결제 전 고지" 는 이번 회차만이
 * 아니라 **회차 계획 전체**다.
 *
 * ── 상태 3종 ────────────────────────────────────────────────────────────────
 * 비었을 때(계약 전) · 다 냈을 때 · 낼 수 있을 때. 실패는 화면 전환이 아니라
 * 같은 화면의 결과 영역이며 **다음 행동을 함께 적는다.**
 */
export type ScheduleItem = {
  id: string;
  seq: number;
  amount: number;
  status: string;
  dueAt: string | null;
  state: string;
  stateLabel: string;
  payable: boolean;
  blockedReason: string | null;
  blockedMessage: string | null;
};

export type CheckoutData = {
  contract: { id: string; status: string; totalAmount: number };
  schedules: ScheduleItem[];
  progress: { paidAmount: number; remainingAmount: number; fullyPaid: boolean };
  next: { scheduleId: string; seq: number; amounts: CheckoutAmounts } | null;
  coupon: {
    state: CouponSlotState;
    message: string;
    ownerTask: string;
    entries: WalletEntry[];
    summary: { total: number; usable: number | null; expiringSoon: number };
    stackingMode: "single" | "multiple";
  };
};

type Result =
  | { kind: "paid"; fullyPaid: boolean }
  | { kind: "failed"; message: string; nextAction: string | null }
  | null;

export function CheckoutView({ data, stubMode }: { data: CheckoutData; stubMode: boolean }) {
  const [agreed, setAgreed] = useState<ConsentKind[]>([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result>(null);
  // 고른 쿠폰. **금액을 여기 담지 않는다** — 서버가 결제 순간에 다시 센다(S5-12).
  const [couponIssueId, setCouponIssueId] = useState<string | null>(null);

  const ready = consentComplete(agreed);
  const next = data.next;

  if (data.schedules.length === 0) {
    return (
      <EmptyState title={CHECKOUT_EMPTY_TITLE} description={CHECKOUT_EMPTY_BODY} />
    );
  }

  async function pay() {
    if (!next || busy) return;

    setBusy(true);
    setResult(null);

    try {
      const response = await fetch("/api/payments/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scheduleId: next.scheduleId,
          consents: agreed,
          // **id 만 보낸다.** 할인액을 보내면 클라이언트가 금액을 정하는 것이다.
          couponIssueId,
        }),
      });

      const payload = (await response.json()) as {
        ok: boolean;
        data?: { fullyPaid?: boolean };
        error?: { message: string; details?: { nextAction?: string } };
      };

      if (payload.ok) {
        setResult({ kind: "paid", fullyPaid: payload.data?.fullyPaid ?? false });
        // 결과를 반영해 회차 상태를 다시 읽는다. 낙관적 갱신을 하지 않는 이유 —
        // 돈이 오간 뒤의 화면은 서버가 말한 사실만 보여야 한다.
        window.location.reload();

        return;
      }

      setResult({
        kind: "failed",
        message: payload.error?.message ?? "결제하지 못했어요.",
        nextAction: payload.error?.details?.nextAction ?? null,
      });
    } catch {
      setResult({
        kind: "failed",
        message: "결제 요청을 보내지 못했어요.",
        nextAction: "네트워크 상태를 확인하고 다시 시도해 주세요.",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      {stubMode ? (
        <p className="rounded-lg border border-warning bg-warning-surface px-3 py-2 text-xs text-warning-foreground">
          {CHECKOUT_STUB_NOTICE}
        </p>
      ) : null}

      {data.progress.fullyPaid || next === null ? (
        <section className="rounded-xl border border-border bg-neutral-50 p-4">
          <h2 className="text-base font-semibold text-foreground">
            {data.progress.fullyPaid ? CHECKOUT_FULLY_PAID_TITLE : "지금 결제할 회차가 없어요"}
          </h2>
          <p className="mt-1 text-sm text-neutral-600">
            {data.progress.fullyPaid
              ? CHECKOUT_FULLY_PAID_BODY
              : "아래 회차 목록에서 각 회차의 상태와 사유를 확인할 수 있어요."}
          </p>
        </section>
      ) : (
        <AmountBlock seq={next.seq} amounts={next.amounts} />
      )}

      <ScheduleList items={data.schedules} />

      <CouponSlot coupon={data.coupon} selected={couponIssueId} onSelect={setCouponIssueId} />

      {next === null ? null : (
        <>
          <ConsentBlock agreed={agreed} onChange={setAgreed} />

          {result?.kind === "failed" ? (
            <section
              role="alert"
              className="rounded-xl border border-danger bg-danger-surface p-4 text-sm text-danger-foreground"
            >
              <p className="font-semibold">{CHECKOUT_RESULT_TITLE.failed}</p>
              <p className="mt-1">{result.message}</p>
              {result.nextAction ? <p className="mt-2">{result.nextAction}</p> : null}
            </section>
          ) : null}

          <Button className="w-full" disabled={!ready || busy} onClick={pay}>
            {busy
              ? "결제 중…"
              : `${next.amounts.payableAmount.toLocaleString("ko-KR")}원 결제하기`}
          </Button>

          {ready ? null : (
            <p className="text-center text-xs text-neutral-500">
              위 두 가지를 확인해야 결제할 수 있어요.
            </p>
          )}
        </>
      )}

      {/* D-24 — 플랫폼은 계약 당사자가 아니다. 결제 화면에서 접거나 숨기지 않는다. */}
      <BrokerNotice variant="inline" />
    </div>
  );
}

/** 총액과 이번 회차를 같은 블록에서 (D-18). */
function AmountBlock({ seq, amounts }: { seq: number; amounts: CheckoutAmounts }) {
  return (
    <section className="rounded-xl border border-border p-4">
      <p className="text-xs font-medium text-neutral-500">{seq}회차 결제 금액</p>
      <p className="mt-1 text-3xl font-bold tracking-tight text-foreground">
        {amounts.payableAmount.toLocaleString("ko-KR")}
        <span className="ml-1 text-base font-medium text-neutral-500">원</span>
      </p>

      <dl className="mt-4 space-y-1.5 border-t border-border pt-3 text-sm">
        <Row label="계약 총액" value={amounts.contractTotal} />
        <Row label="이미 낸 금액" value={amounts.paidAmount} />
        {/* 할인 행을 **0원이어도 감추지 않는다** — 쿠폰이 열리면 이 자리다(D-18). */}
        <Row label="할인" value={-amounts.discountAmount} />
        <Row label="이번 결제 뒤 남는 금액" value={amounts.remainingAfterThis} emphasize />
      </dl>
    </section>
  );
}

function Row({
  label,
  value,
  emphasize,
}: {
  label: string;
  value: number;
  emphasize?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-neutral-600">{label}</dt>
      <dd className={cn("tabular-nums", emphasize ? "font-semibold text-foreground" : "text-neutral-700")}>
        {value.toLocaleString("ko-KR")}원
      </dd>
    </div>
  );
}

/** 회차 계획 전체를 보인다 — 낼 수 없는 회차도 사유와 함께. */
function ScheduleList({ items }: { items: ScheduleItem[] }) {
  return (
    <section className="rounded-xl border border-border p-4">
      <h2 className="text-sm font-semibold text-foreground">회차 계획</h2>
      <ul className="mt-3 space-y-3">
        {items.map((item) => (
          <li key={item.id} className="flex items-start justify-between gap-3 text-sm">
            <div className="min-w-0">
              <p className="font-medium text-foreground">
                {item.seq}회차
                <span className="ml-2 text-xs font-normal text-neutral-500">{item.stateLabel}</span>
              </p>
              <p className="mt-0.5 text-xs text-neutral-500">
                {item.dueAt ? `기한 ${formatDate(item.dueAt)}` : "기한 미정"}
              </p>
              {item.blockedMessage && item.status === "scheduled" ? (
                <p className="mt-1 text-xs text-neutral-600">{item.blockedMessage}</p>
              ) : null}
            </div>
            <p className="shrink-0 tabular-nums font-medium text-foreground">
              {item.amount.toLocaleString("ko-KR")}원
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * 쿠폰 자리 (§6.2 · D-27 · **S5-12 가 열었다**).
 *
 * ── 이 자리가 지키는 규칙 ───────────────────────────────────────────────────
 * 1. **못 쓰는 쿠폰도 사유와 함께 보인다**(F-C-36). 감추면 "쿠폰이 없다" 로 읽히고,
 *    최소 결제 금액을 조금 넘기면 쓸 수 있다는 사실을 영영 모른다.
 * 2. **할인 전 · 할인액 · 할인 후를 함께 보인다**(D-18). 위의 금액 블록이 그 자리다.
 * 3. **여기서 쓰이지 않는다.** 고르는 것은 계산일 뿐이고, 사용 처리는 결제가 승인되는
 *    순간에 일어난다 — 그래야 결제가 실패했을 때 쿠폰만 사라지지 않는다.
 */
function CouponSlot({
  coupon,
  selected,
  onSelect,
}: {
  coupon: CheckoutData["coupon"];
  selected: string | null;
  onSelect: (issueId: string | null) => void;
}) {
  const usable = coupon.entries.filter((entry) => entry.usable === true);
  const blocked = coupon.entries.filter((entry) => entry.usable === false);

  return (
    <section className="rounded-xl border border-border p-4" data-testid="checkout-coupon">
      <h2 className="text-sm font-semibold text-foreground">쿠폰</h2>

      {coupon.entries.length === 0 ? (
        <p className="mt-1 text-sm text-neutral-600">{COUPON_SLOT_MESSAGE.empty}</p>
      ) : (
        <>
          <ul className="mt-3 space-y-2">
            <li>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  name="coupon"
                  className="mt-1"
                  checked={selected === null}
                  onChange={() => onSelect(null)}
                />
                <span className="text-neutral-700">쿠폰을 쓰지 않을게요</span>
              </label>
            </li>
            {usable.map((entry) => (
              <li key={entry.issueId}>
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="radio"
                    name="coupon"
                    className="mt-1"
                    checked={selected === entry.issueId}
                    onChange={() => onSelect(entry.issueId)}
                    data-testid="coupon-option"
                  />
                  <span>
                    <span className="font-medium text-foreground">{entry.name}</span>
                    <span className="ml-1 tabular-nums text-neutral-700">
                      −{(entry.discountAmount ?? 0).toLocaleString("ko-KR")}원
                    </span>
                    <span className="mt-0.5 block text-xs text-neutral-500">
                      {entry.issuerType === "vendor"
                        ? `${entry.issuerName ?? "업체"} 발행`
                        : "웨딩클리어 발행"}
                    </span>
                  </span>
                </label>
              </li>
            ))}
          </ul>

          {blocked.length > 0 ? (
            <div className="mt-3 border-t border-border pt-3">
              <p className="text-xs font-medium text-neutral-500">
                지금 쓸 수 없는 쿠폰 {blocked.length}장
              </p>
              <ul className="mt-1 space-y-1" data-testid="coupon-blocked">
                {blocked.map((entry) => (
                  <li key={entry.issueId} className="text-xs text-neutral-500">
                    <span className="text-neutral-600">{entry.name}</span> · {entry.blockedDetail}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <p className="mt-3 text-xs text-neutral-500">
            {COUPON_STACKING_NOTICE} 사용 처리는 <strong>결제가 승인되는 순간</strong>에
            이뤄집니다.
          </p>
        </>
      )}
    </section>
  );
}

/** 결제 전 고지·동의 (F-C-14). 동의 로그는 서버가 남긴다. */
function ConsentBlock({
  agreed,
  onChange,
}: {
  agreed: ConsentKind[];
  onChange: (next: ConsentKind[]) => void;
}) {
  function toggle(kind: ConsentKind, checked: boolean) {
    onChange(checked ? [...new Set([...agreed, kind])] : agreed.filter((item) => item !== kind));
  }

  return (
    <section className="rounded-xl border border-border p-4">
      <h2 className="text-sm font-semibold text-foreground">결제 전 확인</h2>
      <ul className="mt-3 space-y-3">
        {CHECKOUT_CONSENT_ITEMS.map((item) => (
          <li key={item.kind} className="flex gap-3">
            <Checkbox
              id={`consent-${item.kind}`}
              checked={agreed.includes(item.kind)}
              onCheckedChange={(checked) => toggle(item.kind, checked === true)}
              className="mt-0.5"
            />
            <label htmlFor={`consent-${item.kind}`} className="text-sm">
              <span className="font-medium text-foreground">{item.label}</span>
              <span className="mt-0.5 block text-xs text-neutral-600">{item.detail}</span>
            </label>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-neutral-500">
        확인 기록이 남습니다(판본 {CHECKOUT_CONSENT_VERSION}). 확인 항목은{" "}
        {CONSENT_KINDS.length}가지입니다.
      </p>
    </section>
  );
}

function formatDate(value: string): string {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return "미정";

  return `${date.getFullYear()}.${String(date.getMonth() + 1).padStart(2, "0")}.${String(
    date.getDate(),
  ).padStart(2, "0")}`;
}
