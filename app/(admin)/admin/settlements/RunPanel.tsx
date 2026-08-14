"use client";

import { useState } from "react";

import { EmptyState } from "@/components/ui/EmptyState";
import { Button } from "@/components/ui/button";
import { RECALCULATE_BLOCKED_NOTICE } from "@/lib/core/settlement/settlement";
import type { SettlementView } from "@/lib/settlements/loader";
import { cn } from "@/lib/utils";

/**
 * 정산 집행 (F-A-11 · §6.4 · D-23)
 *
 * ── 운영자가 정하는 것은 '언제' 이지 '얼마' 가 아니다 ───────────────────────
 * 금액 입력칸이 없다. 집계·확정·지급 버튼만 있고 금액은 거래 이력에서 나온다 —
 * 입력칸을 두면 정산이 계산이 아니라 재량이 되고, 그 순간 스냅샷 요율(D-16)과
 * 상계 구조가 의미를 잃는다.
 *
 * ── 대기와 실패를 구분해 보여준다 ───────────────────────────────────────────
 * `blocked` 는 **결정 하나가 비어 있는 상태**다(O-15). 운영자 화면에서도 경고색이
 * 아니라 안내색으로 두고, 무엇을 채워야 하는지 적는다 — 그래야 운영이 코드가 아니라
 * 설정을 본다.
 */
export type AdminSettlementItem = SettlementView & { vendorId: string; vendorName: string };

export function RunPanel({
  items,
  vendors,
}: {
  items: AdminSettlementItem[];
  vendors: { id: string; name: string }[];
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function call(body: Record<string, unknown>, key: string) {
    if (busy) return;

    setBusy(key);
    setError(null);

    try {
      const response = await fetch("/api/admin/settlements/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const payload = (await response.json()) as { ok: boolean; error?: { message: string } };

      if (payload.ok) {
        window.location.reload();

        return;
      }

      setError(payload.error?.message ?? "처리하지 못했어요.");
    } catch {
      setError("처리하지 못했어요. 잠시 후 다시 시도해 주세요.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-border p-4">
        <h2 className="text-sm font-semibold text-foreground">이번 기간 집계</h2>
        <p className="mt-1 text-xs text-neutral-600">
          기간은 <code>app_settings.settlement.period</code> 가 정합니다. 이미 확정된 정산서는
          다시 계산하지 않아요.
        </p>
        <ul className="mt-3 flex flex-wrap gap-2">
          {vendors.map((vendor) => (
            <li key={vendor.id}>
              <Button
                size="sm"
                variant="outline"
                disabled={busy !== null}
                onClick={() => call({ action: "run", vendorId: vendor.id }, `run:${vendor.id}`)}
              >
                {busy === `run:${vendor.id}` ? "집계 중…" : `${vendor.name} 집계`}
              </Button>
            </li>
          ))}
        </ul>
      </section>

      {error ? (
        <p role="alert" className="rounded-lg border border-danger bg-danger-surface px-3 py-2 text-sm text-danger-foreground">
          {error}
        </p>
      ) : null}

      {items.length === 0 ? (
        <EmptyState
          title="정산서가 없어요"
          description="업체를 골라 집계하면 기간별 정산서가 만들어집니다."
        />
      ) : (
        items.map((item) => (
          <section key={item.id} className="rounded-xl border border-border p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-foreground">{item.vendorName}</p>
                <p className="mt-0.5 text-xs text-neutral-500">
                  {item.periodStart} ~ {item.periodEnd}
                  {item.feeBasisLabel ? ` · ${item.feeBasisLabel}` : ""}
                </p>
              </div>
              <span
                className={cn(
                  "shrink-0 rounded-full px-2 py-0.5 text-xs",
                  item.status === "blocked"
                    ? "bg-brand-50 text-brand-700"
                    : item.status === "paid"
                      ? "bg-success-surface text-success-foreground"
                      : "bg-neutral-100 text-neutral-600",
                )}
              >
                {item.statusLabel}
              </span>
            </div>

            {item.status === "blocked" ? (
              <div className="mt-3 rounded-lg border border-brand-200 bg-brand-50 p-3 text-xs text-brand-700">
                <p className="font-medium">{item.blockedLabel}</p>
                <p className="mt-1">{item.blockedDetail}</p>
              </div>
            ) : (
              <dl className="mt-3 space-y-1 text-xs text-neutral-600">
                <Line label="거래 총액" value={item.grossAmount} />
                <Line label="수수료" value={item.feeAmount} />
                <Line label="쿠폰 차감" value={item.couponDeduction} />
                <Line label="상계" value={item.adjustmentAmount} />
                <Line label="지급액" value={item.payoutAmount ?? item.netAmount} emphasize />
                {item.payableAt ? (
                  <div className="flex justify-between pt-1">
                    <dt>지급 예정일</dt>
                    <dd className="text-neutral-800">{item.payableAt}</dd>
                  </div>
                ) : null}
              </dl>
            )}

            {item.vendorNote ? (
              <p className="mt-3 rounded-lg bg-warning-surface p-2 text-xs text-warning-foreground">
                업체 이의 제기 · {item.vendorNote}
              </p>
            ) : null}

            <div className="mt-4 flex flex-wrap gap-2 border-t border-border pt-3">
              <Button
                size="sm"
                variant="outline"
                disabled={busy !== null || item.status !== "blocked"}
                onClick={() => call({ action: "run", vendorId: item.vendorId }, `re:${item.id}`)}
              >
                {busy === `re:${item.id}` ? "재계산 중…" : "다시 계산"}
              </Button>
              <Button
                size="sm"
                disabled={busy !== null || item.status !== "draft"}
                onClick={() => call({ action: "confirm", settlementId: item.id }, `c:${item.id}`)}
              >
                {busy === `c:${item.id}` ? "확정 중…" : "확정"}
              </Button>
              <Button
                size="sm"
                disabled={busy !== null || item.status !== "confirmed"}
                onClick={() => call({ action: "pay", settlementId: item.id }, `p:${item.id}`)}
              >
                {busy === `p:${item.id}` ? "지급 중…" : "지급"}
              </Button>
            </div>

            {item.status === "confirmed" || item.status === "paid" ? (
              <p className="mt-2 text-xs text-neutral-500">{RECALCULATE_BLOCKED_NOTICE}</p>
            ) : null}
          </section>
        ))
      )}
    </div>
  );
}

function Line({
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
      <dt>{label}</dt>
      <dd className={cn("tabular-nums", emphasize ? "font-semibold text-foreground" : "text-neutral-800")}>
        {value.toLocaleString("ko-KR")}원
      </dd>
    </div>
  );
}
