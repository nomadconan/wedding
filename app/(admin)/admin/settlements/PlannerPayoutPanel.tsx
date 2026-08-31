"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { formatKrw } from "@/components/domain/PriceDisplay";
import {
  PAYOUT_ADAPTER_PENDING_NOTICE,
  PAYOUT_NOT_RECEIVED_NOTICE,
  PLANNER_PAYOUT_STATE_LABEL,
} from "@/lib/core/settlement/planner-payout";
import { formatTimestamp } from "@/lib/core/format/timestamp";
import type { PlannerSettlementView } from "@/lib/planners/payouts";

/**
 * 플래너 지급 (S6-05 · F-A-11)
 *
 * ── 왜 같은 화면인가 ────────────────────────────────────────────────────────
 * **이번에 나갈 돈을 한 화면이 든다.** 업체 정산과 플래너 지급을 다른 화면에 두면
 * 운영자가 마감할 때 한쪽만 보고 끝낸다 — 그리고 안 본 쪽은 아무도 모르게 밀린다
 * (FIX-08 이 업체 정산에서 이미 그 모양을 기록했다).
 *
 * ── 이 패널이 지키는 규칙 ───────────────────────────────────────────────────
 * 1. **'받을 수 있음' 은 아직 나간 돈이 아니다.** 버튼이 붙은 줄과 이미 나간 줄을
 *    상태로 갈라 적는다.
 * 2. **유예 중인 건에는 버튼을 만들지 않는다** — 눌러도 422 가 나는 버튼은 장식이고,
 *    유예를 앞당기는 것은 DB 가 막는다(0028).
 * 3. **실패도 결과다.** 실패 사유와 재시도 가능 여부를 그대로 보여준다.
 * 4. **지급 연동이 아직 없다는 사실을 위에 적는다**(D-28) — 눌렀는데 왜 실패하는지를
 *    누르기 전에 답한다.
 */
export function PlannerPayoutPanel({
  rows,
  plannerNames,
}: {
  rows: PlannerSettlementView[];
  plannerNames: Record<string, string>;
}) {
  const router = useRouter();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function pay(settlementId: string) {
    setPendingId(settlementId);
    setMessage(null);

    try {
      const response = await fetch("/api/admin/planner-payouts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settlementId }),
      });
      const payload = (await response.json()) as {
        ok: boolean;
        data?: { status: string; reason?: string; retryable?: boolean };
        error?: { message?: string };
      };

      if (!response.ok || !payload.ok) {
        setMessage(payload.error?.message ?? "지급을 실행하지 못했어요.");

        return;
      }

      setMessage(
        payload.data?.status === "paid"
          ? "지급이 성공했어요."
          : `지급이 실패했어요 — ${payload.data?.reason ?? "사유 미상"}${
              payload.data?.retryable ? " (다시 시도할 수 있어요)" : " (재시도해도 결과가 같아요)"
            }`,
      );
      router.refresh();
    } catch {
      setMessage("네트워크 문제로 처리하지 못했어요. 잠시 후 다시 시도해 주세요.");
    } finally {
      setPendingId(null);
    }
  }

  return (
    <section className="space-y-3" data-testid="planner-payout-panel">
      <div>
        <h2 className="text-base font-semibold text-foreground">플래너 지급</h2>
        <p className="mt-1 text-xs text-neutral-600">{PAYOUT_NOT_RECEIVED_NOTICE}</p>
      </div>

      <p className="rounded-lg bg-warning-surface px-3 py-2 text-xs text-warning-foreground">
        {PAYOUT_ADAPTER_PENDING_NOTICE}
      </p>

      {rows.length === 0 ? (
        <p className="rounded-xl border border-border bg-background px-4 py-6 text-center text-sm text-neutral-600">
          플래너 수수료가 아직 없어요. 카테고리를 맡긴 계약이 성사되면 여기에 쌓입니다.
        </p>
      ) : (
        <ul className="space-y-2">
          {rows.map((row) => (
            <li
              key={row.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-background p-4"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-foreground">
                  {/* 이름을 못 읽었으면 지어내지 않는다. */}
                  {plannerNames[row.plannerId] ?? "이름을 불러오지 못한 플래너"}
                </p>
                <p className="mt-0.5 text-xs text-neutral-600">
                  {formatKrw(row.feeAmount)}원 · 요율 {(row.feeRateBp / 100).toFixed(2)}% · 지급 가능{" "}
                  {formatTimestamp(row.payableAt)}
                </p>
                {row.attempts.length > 0 ? (
                  <p className="mt-0.5 text-xs text-neutral-500">
                    시도 {row.attempts.length}회
                    {row.attempts.at(-1)?.failureReason === null
                      ? ""
                      : ` · 마지막 실패: ${row.attempts.at(-1)?.failureReason}`}
                  </p>
                ) : null}
              </div>

              <div className="flex shrink-0 items-center gap-2">
                <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-700">
                  {PLANNER_PAYOUT_STATE_LABEL[row.state]}
                </span>
                {/* 유예 중·이미 나간 건에는 버튼을 만들지 않는다. */}
                {row.state === "payable" ? (
                  <Button size="sm" disabled={pendingId === row.id} onClick={() => pay(row.id)}>
                    지급 실행
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}

      {message === null ? null : (
        <p className="rounded-lg border border-border bg-muted px-3 py-2 text-xs text-neutral-700">
          {message}
        </p>
      )}
    </section>
  );
}
