import type { Metadata } from "next";

import { AdminShell } from "@/components/layout/AdminShell";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { formatKrw } from "@/components/domain/PriceDisplay";
import {
  GRACE_REASON_NOTICE,
  PAYOUT_ADAPTER_PENDING_NOTICE,
  PAYOUT_NOT_RECEIVED_NOTICE,
  PLANNER_PAYOUT_STATE_LABEL,
  PLANNER_RATE_SNAPSHOT_NOTICE,
  PLANNER_SETTLEMENT_EMPTY_BODY,
  PLANNER_SETTLEMENT_EMPTY_TITLE,
  PLANNER_SETTLEMENT_TITLE,
} from "@/lib/core/settlement/planner-payout";
import { formatTimestamp } from "@/lib/core/format/timestamp";
import { plannerIdOf } from "@/lib/planners/delegation";
import { loadMyPlannerPayouts } from "@/lib/planners/payouts";
import { requireUser } from "@/lib/supabase/auth";

export const metadata: Metadata = {
  title: "내 정산 — 웨딩클리어",
};

/**
 * /pro/settlements — 플래너 수수료 원장 (§3.4 · §6 보완 제안 · S6-05)
 *
 * ── 이 화면이 지키는 규칙 ───────────────────────────────────────────────────
 * 1. **'받을 수 있음' 과 '받았음' 을 합치지 않는다**(S5-07 이 업체 정산에서 세운 원칙).
 *    `payable_at` 이 지났다는 것은 "보낼 수 있다" 이지 "보냈다" 가 아니다 — 합치면
 *    플래너는 이미 받은 줄 알고 입금을 기다리지 않는다.
 * 2. **유예 중인 금액을 0으로 접지 않는다.** 있는 돈이고 아직 못 받을 뿐이다.
 *    **왜 못 받는지**(환불·분쟁 창구)도 함께 적는다.
 * 3. **국면은 저장된 상태가 아니라 시계로 계산한다.** 배치가 하루 안 돌았다고
 *    "아직 유예 중" 이라는 틀린 문장을 보이지 않는다.
 * 4. **요율 스냅샷을 근거로 든다**(D-16). 금액만 적으면 "왜 이 금액인가" 를 재현할 수 없다.
 * 5. **지급 연동이 아직 없다는 사실을 숨기지 않는다**(D-28). 숨기면 언제 들어오는지
 *    묻는 사람에게 답할 수 없다.
 * 6. **캐시하지 않는다** — 유예가 시계로 판정되고 쿠키를 읽는다(함정 4).
 */
export const dynamic = "force-dynamic";

export default async function PlannerSettlementsPage() {
  const user = await requireUser("/pro/settlements");
  const plannerId = await plannerIdOf(user.id);

  if (plannerId === null) {
    return (
      <AdminShell role="planner" title={PLANNER_SETTLEMENT_TITLE}>
        <ErrorState
          code="PLANNER_NOT_REGISTERED"
          title="아직 플래너 프로필이 없어요"
          description="내 프로필에서 등록을 마치면 정산이 쌓입니다."
        />
      </AdminShell>
    );
  }

  let payload: Awaited<ReturnType<typeof loadMyPlannerPayouts>>;
  try {
    payload = await loadMyPlannerPayouts({ plannerId, now: new Date() });
  } catch {
    return (
      <AdminShell role="planner" title={PLANNER_SETTLEMENT_TITLE}>
        <ErrorState
          code="PLANNER_PAYOUT_LOAD_FAILED"
          title="정산을 불러오지 못했어요"
          description="잠시 후 다시 시도해 주세요."
        />
      </AdminShell>
    );
  }

  const { summary } = payload;

  return (
    <AdminShell
      role="planner"
      title={PLANNER_SETTLEMENT_TITLE}
      description={
        payload.graceDays === null
          ? "지급 유예 기간이 아직 설정되지 않았어요. 값이 정해지면 그대로 계산됩니다."
          : `계약이 성사되면 수수료가 쌓이고, ${payload.graceDays}일 유예 뒤에 지급 대상이 됩니다.`
      }
    >
      <div className="space-y-4">
        {/* 합계 넷을 따로 적는다 — 합치면 받은 것과 받을 것이 섞인다. */}
        <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Tile label="지급 유예 중" bucket={summary.waitingGrace} tone="muted" />
          <Tile label="받을 수 있음" bucket={summary.payable} tone="brand" />
          <Tile label="지급 완료" bucket={summary.paid} tone="muted" />
          <Tile label="무효(해지)" bucket={summary.void} tone="muted" />
        </section>

        <p className="rounded-lg border border-border bg-muted px-3 py-2 text-xs text-neutral-700">
          {PAYOUT_NOT_RECEIVED_NOTICE}
        </p>
        <p className="text-xs text-neutral-600">{GRACE_REASON_NOTICE}</p>

        {payload.payoutAdapter !== "stub" || payload.payoutWired === false ? (
          <p className="rounded-lg bg-warning-surface px-3 py-2 text-xs text-warning-foreground">
            {PAYOUT_ADAPTER_PENDING_NOTICE}
          </p>
        ) : null}

        {payload.rows.length === 0 ? (
          <EmptyState
            title={PLANNER_SETTLEMENT_EMPTY_TITLE}
            description={PLANNER_SETTLEMENT_EMPTY_BODY}
          />
        ) : (
          <ul className="space-y-3" data-testid="planner-settlement-list">
            {payload.rows.map((row) => (
              <li key={row.id} className="rounded-xl border border-border bg-background p-4">
                <div className="flex items-baseline justify-between gap-2">
                  <h3 className="text-sm font-semibold text-foreground">
                    {formatKrw(row.feeAmount)}원
                  </h3>
                  <span
                    className="shrink-0 rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-700"
                    data-testid="payout-state"
                  >
                    {PLANNER_PAYOUT_STATE_LABEL[row.state]}
                  </span>
                </div>

                <dl className="mt-2 space-y-1 text-xs">
                  <Row label="계약 금액" value={`${formatKrw(row.grossAmount)}원`} />
                  {/* 요율 스냅샷 — 금액만으로는 "왜 이 금액인가" 를 못 푼다(D-16). */}
                  <Row
                    label="적용 요율"
                    value={`${(row.feeRateBp / 100).toFixed(2)}% (계약 시점)`}
                  />
                  <Row label="발생" value={formatTimestamp(row.earnedAt)} />
                  <Row label="지급 가능" value={formatTimestamp(row.payableAt)} />
                </dl>

                {row.attempts.length > 0 ? (
                  <ul className="mt-2 space-y-1 border-t border-border pt-2 text-xs text-neutral-600">
                    {row.attempts.map((attempt) => (
                      <li key={attempt.id}>
                        {attempt.attemptCount}차 시도 · {attempt.status}
                        {attempt.failureReason === null ? "" : ` — ${attempt.failureReason}`}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        <p className="text-xs text-neutral-500">{PLANNER_RATE_SNAPSHOT_NOTICE}</p>
      </div>
    </AdminShell>
  );
}

function Tile({
  label,
  bucket,
  tone,
}: {
  label: string;
  bucket: { count: number; amount: number };
  tone: "brand" | "muted";
}) {
  return (
    <div className="rounded-xl border border-border bg-background p-4">
      <p className="text-xs text-neutral-600">{label}</p>
      <p
        className={`mt-1 text-lg font-semibold ${tone === "brand" ? "text-brand-600" : "text-foreground"}`}
      >
        {formatKrw(bucket.amount)}원
      </p>
      <p className="mt-0.5 text-xs text-neutral-500">{bucket.count}건</p>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <dt className="shrink-0 text-neutral-500">{label}</dt>
      <dd className="text-neutral-800">{value}</dd>
    </div>
  );
}
