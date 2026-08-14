"use client";

import { EmptyState } from "@/components/ui/EmptyState";
import { Button } from "@/components/ui/button";
import {
  ADJUSTMENT_CARRY_NOTICE,
  PAYOUT_STUB_NOTICE,
  RATE_SNAPSHOT_NOTICE,
  RECALCULATE_READY_NOTICE,
  SETTLEMENT_EMPTY_BODY,
  SETTLEMENT_EMPTY_TITLE,
  TAX_DOCUMENT_NOTE,
} from "@/lib/core/settlement/settlement";
import type { AdjustmentView, SettlementView } from "@/lib/settlements/loader";
import { cn } from "@/lib/utils";

/**
 * 업체 정산 (S5-07 · F-V-09 · §6.3 · D-16 · D-18)
 *
 * ── 총액·수수료·상계·순지급액을 구분한다 (D-18) ────────────────────────────
 * 한 숫자만 크게 적으면 업체는 그것을 받을 돈으로 읽는다. 네 값을 **같은 블록에
 * 나란히** 두고, 가장 큰 글씨는 **실제로 통장에 들어올 금액**이다.
 *
 * ── 결과만 보여주지 않는다 ──────────────────────────────────────────────────
 * 건별 명세에 **적용 요율(bp)** 을 함께 적는다. 요율이 왜 이 값인지는
 * `RATE_SNAPSHOT_NOTICE` 가 말한다 — **계약 확정 시점 스냅샷**이라 지금 설정된 요율과
 * 다를 수 있다(D-16). 업체가 그 차이를 발견하고 문의하는 것보다 먼저 읽는 편이 낫다.
 *
 * ── '설정 대기' 는 '실패' 가 아니다 ─────────────────────────────────────────
 * `fee_basis`(O-15)가 비어 있으면 정산을 세울 수 없다. 그것을 오류로 그리면 업체는
 * 장애로 이해하고 고객센터에 문의하며, 운영은 없는 장애를 찾는다. 그래서 **경고색이
 * 아니라 안내색**으로 두고 "거래 내역은 이미 모여 있다" 를 함께 적는다.
 */
export type SettlementsData = {
  settlements: SettlementView[];
  pendingAdjustments: AdjustmentView[];
  feeBasisResolved: boolean;
  stubMode: boolean;
};

export function SettlementsView({ data }: { data: SettlementsData }) {
  if (data.settlements.length === 0 && data.pendingAdjustments.length === 0) {
    return <EmptyState title={SETTLEMENT_EMPTY_TITLE} description={SETTLEMENT_EMPTY_BODY} />;
  }

  return (
    <div className="space-y-5">
      {data.stubMode ? (
        <p className="rounded-lg border border-warning bg-warning-surface px-3 py-2 text-xs text-warning-foreground">
          {PAYOUT_STUB_NOTICE}
        </p>
      ) : null}

      {data.pendingAdjustments.length > 0 ? (
        <PendingAdjustments items={data.pendingAdjustments} />
      ) : null}

      {data.settlements.map((settlement) => (
        <SettlementCard key={settlement.id} settlement={settlement} />
      ))}

      <section className="rounded-xl border border-border p-4">
        <h2 className="text-sm font-semibold text-foreground">세금계산서 자료</h2>
        <p className="mt-1 text-xs text-neutral-600">{TAX_DOCUMENT_NOTE}</p>
        <Button variant="outline" size="sm" className="mt-3" asChild>
          <a href="/api/vendor/settlements?format=csv" download>
            자료 내려받기 (CSV)
          </a>
        </Button>
      </section>

      <p className="text-xs text-neutral-500">{RATE_SNAPSHOT_NOTICE}</p>
    </div>
  );
}

/** **다음 정산에서 차감 예정.** 상계가 떠 있는 상태를 화면이 감추지 않는다. */
function PendingAdjustments({ items }: { items: AdjustmentView[] }) {
  const total = items.reduce((sum, item) => sum + item.amount, 0);

  return (
    <section className="rounded-xl border border-border bg-neutral-50 p-4">
      <h2 className="text-sm font-semibold text-foreground">다음 정산에서 차감 예정</h2>
      <p className="mt-1 text-xs text-neutral-600">{ADJUSTMENT_CARRY_NOTICE}</p>

      <ul className="mt-3 space-y-2">
        {items.map((item) => (
          <li key={item.id} className="flex items-start justify-between gap-3 text-sm">
            <div className="min-w-0">
              <p className="font-medium text-foreground">{item.sourceLabel}</p>
              <p className="mt-0.5 text-xs text-neutral-500">{item.reason}</p>
            </div>
            <p className="shrink-0 tabular-nums font-medium text-foreground">
              −{item.amount.toLocaleString("ko-KR")}원
            </p>
          </li>
        ))}
      </ul>

      <div className="mt-3 flex items-baseline justify-between border-t border-border pt-2 text-sm">
        <span className="text-neutral-600">합계</span>
        <span className="tabular-nums font-semibold text-foreground">
          −{total.toLocaleString("ko-KR")}원
        </span>
      </div>
    </section>
  );
}

function SettlementCard({ settlement }: { settlement: SettlementView }) {
  const blocked = settlement.status === "blocked";

  return (
    <section className="rounded-xl border border-border p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-foreground">
            {settlement.periodStart} ~ {settlement.periodEnd}
          </p>
          {settlement.feeBasisLabel ? (
            <p className="mt-0.5 text-xs text-neutral-500">{settlement.feeBasisLabel}</p>
          ) : null}
        </div>
        <span
          className={cn(
            "shrink-0 rounded-full px-2 py-0.5 text-xs",
            settlement.status === "paid"
              ? "bg-success-surface text-success-foreground"
              : blocked
                ? "bg-brand-50 text-brand-700"
                : "bg-neutral-100 text-neutral-600",
          )}
        >
          {settlement.statusLabel}
        </span>
      </div>

      {blocked ? (
        // **경고색이 아니라 안내색이다.** 고장이 아니라 결정 하나가 비어 있는 상태다.
        <div className="mt-3 rounded-lg border border-brand-200 bg-brand-50 p-3">
          <p className="text-sm font-medium text-brand-700">{settlement.blockedLabel}</p>
          <p className="mt-1 text-xs text-brand-700">{settlement.blockedDetail}</p>
          {settlement.recalculable ? (
            <p className="mt-2 text-xs font-medium text-brand-700">{RECALCULATE_READY_NOTICE}</p>
          ) : null}
        </div>
      ) : (
        <>
          <dl className="mt-4 space-y-1.5 text-sm">
            <Row label="거래 총액" value={settlement.grossAmount} />
            <Row
              label={`플랫폼 수수료 (${(settlement.feeRateBp / 100).toFixed(2)}%)`}
              value={-settlement.feeAmount}
            />
            {/* 쿠폰·상계 행은 **0원이어도 감추지 않는다** — 있었는지 없었는지가 정보다. */}
            <Row label="쿠폰 차감" value={-settlement.couponDeduction} />
            <Row label="상계" value={-settlement.adjustmentAmount} />
          </dl>

          <div className="mt-3 flex items-baseline justify-between border-t border-border pt-3">
            <span className="text-sm font-medium text-neutral-700">지급액</span>
            <span className="text-2xl font-bold tabular-nums tracking-tight text-foreground">
              {(settlement.payoutAmount ?? settlement.netAmount).toLocaleString("ko-KR")}
              <span className="ml-1 text-sm font-medium text-neutral-500">원</span>
            </span>
          </div>

          {settlement.payableAt ? (
            <p className="mt-2 text-xs text-neutral-500">
              지급 예정일 · {settlement.payableAt}
              {settlement.paidAt ? ` · 지급 완료 ${settlement.paidAt.slice(0, 10)}` : ""}
            </p>
          ) : null}

          {settlement.items.length > 0 ? <ItemTable items={settlement.items} /> : null}

          {settlement.tax ? (
            <dl className="mt-3 space-y-1 rounded-lg bg-neutral-50 p-3 text-xs text-neutral-600">
              <p className="font-medium text-neutral-700">세금계산서 자료</p>
              <Line label="공급가액(수수료)" value={settlement.tax.supplyAmount} />
              <Line label="부가세" value={settlement.tax.taxAmount} />
              <Line label="합계" value={settlement.tax.totalAmount} />
            </dl>
          ) : null}
        </>
      )}
    </section>
  );
}

/** 건별 근거. **적용 요율을 함께 적는다** — 결과만 보여주면 납득할 수 없다. */
function ItemTable({ items }: { items: SettlementView["items"] }) {
  return (
    <div className="mt-4 overflow-x-auto">
      <table className="w-full min-w-[22rem] text-xs">
        <thead>
          <tr className="border-b border-border text-left text-neutral-500">
            <th className="py-1.5 pr-2 font-medium">거래</th>
            <th className="py-1.5 pr-2 text-right font-medium">대상 금액</th>
            <th className="py-1.5 pr-2 text-right font-medium">요율</th>
            <th className="py-1.5 pr-2 text-right font-medium">수수료</th>
            <th className="py-1.5 text-right font-medium">순액</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item, index) => (
            <tr key={item.bookingId ?? index} className="border-b border-border/60">
              <td className="py-1.5 pr-2 text-neutral-600">
                {item.bookingId ? `${item.bookingId.slice(0, 8)}…` : "-"}
              </td>
              <td className="py-1.5 pr-2 text-right tabular-nums">
                {item.amount.toLocaleString("ko-KR")}
              </td>
              <td className="py-1.5 pr-2 text-right tabular-nums text-neutral-600">
                {item.feeRateBp === null ? "-" : `${(item.feeRateBp / 100).toFixed(2)}%`}
              </td>
              <td className="py-1.5 pr-2 text-right tabular-nums">
                {item.feeAmount.toLocaleString("ko-KR")}
              </td>
              <td className="py-1.5 text-right tabular-nums font-medium">
                {item.netAmount.toLocaleString("ko-KR")}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Row({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-neutral-600">{label}</dt>
      <dd className="tabular-nums text-neutral-800">{value.toLocaleString("ko-KR")}원</dd>
    </div>
  );
}

function Line({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt>{label}</dt>
      <dd className="tabular-nums text-neutral-800">{value.toLocaleString("ko-KR")}원</dd>
    </div>
  );
}
