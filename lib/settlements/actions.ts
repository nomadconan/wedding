import { readIntSetting, readSetting } from "@/lib/app-settings";
import { recordEvent } from "@/lib/audit/record";
import { vendorBorneTotal } from "@/lib/core/coupon/coupon";
import { feeBasisOf } from "@/lib/core/payment/payment";
import {
  applyAdjustments,
  buildSettlement,
  payableDateOf,
  payoutEligibility,
  payoutIdempotencyKey,
  recalculable,
  settlementPeriod,
  type SettlementLine,
  type SettlementPeriod,
  type SettlementStatus,
} from "@/lib/core/settlement/settlement";
import { sendNotification } from "@/lib/notify/send";
import { createAdminClient } from "@/lib/supabase/admin";

import { canRetryPayout, resolvePayoutAdapterName, type PayoutAdapter } from "./payout-adapter";
import { createNoopPayoutAdapter, createStubPayoutAdapter } from "./payout-stub";

/**
 * 정산 집행 (S5-07 · F-V-09 · F-A-11 · §3.4 · §3.8 · D-16 · D-23 · D-27 · D-28)
 *
 * ── 순서가 곧 설계다 ────────────────────────────────────────────────────────
 *  1. **집계** — 그 기간에 **완납된** 예약을 모은다. 부분 납부 상태를 정산하면 이행
 *     전 대금을 업체에 지급하게 된다.
 *  2. **기준 적용** — `fee_basis`(O-15)가 없으면 `blocked` 로 남긴다. **실패가 아니라
 *     대기**이며 거래 내역은 이미 모여 있다.
 *  3. **확정** — 상계를 반영하고 지급 예정일을 박는다. 이후 금액은 동결된다(트리거).
 *  4. **지급** — 어댑터 호출. 멱등 열쇠는 정산서 id + 시도 회차다.
 *
 * ── 서비스롤로 쓴다 ─────────────────────────────────────────────────────────
 * `settlements`·`settlement_adjustments`·`settlement_payouts` 에 쓰기 정책이 없다.
 * 업체가 쓸 수 있으면 **자기 정산 금액을 스스로 적을 수 있다.** 업체에 열린 것은
 * `vendor_note`(이의 제기) 컬럼 하나뿐이며 그것도 컬럼 권한으로 좁혀 두었다(0033).
 */
function adapter(): PayoutAdapter {
  return resolvePayoutAdapterName() === "stub"
    ? createStubPayoutAdapter()
    : createNoopPayoutAdapter();
}

export type SettlementFailure = { status: number; code: string; message: string };

function failure(status: number, code: string, message: string): SettlementFailure {
  return { status, code, message };
}

export function isSettlementFailure(value: unknown): value is SettlementFailure {
  return typeof value === "object" && value !== null && "code" in value && "status" in value;
}

// =============================================================================
// 집계 대상 — 그 기간에 완납된 예약
// =============================================================================

/**
 * 정산 대상 거래를 모은다.
 *
 * **완납 기준이다.** 회차가 남아 있는 예약을 정산하면 이행이 끝나기 전에 대금이
 * 업체로 나가고, 그 뒤 해지되면 이미 나간 돈을 회수해야 한다(0031 이 플래너 수수료에서
 * 마주친 것과 같은 문제). 기간 판정은 **마지막 결제 시각**으로 한다 — 계약일이 아니라
 * 돈이 다 들어온 날이 정산의 사건이다.
 */
async function collectLines(
  vendorId: string,
  period: SettlementPeriod,
): Promise<{ lines: SettlementLine[]; bookingIds: string[] }> {
  const admin = createAdminClient();

  const { data: bookingRows } = await admin
    .from("bookings")
    .select("id, total_amount, applied_fee_rate_bp, status")
    .eq("vendor_id", vendorId)
    .in("status", ["confirmed", "fulfilled"]);

  const bookings = (bookingRows ?? []) as {
    id: string;
    total_amount: number;
    applied_fee_rate_bp: number | null;
  }[];

  if (bookings.length === 0) return { lines: [], bookingIds: [] };

  const ids = bookings.map((row) => row.id);

  const { data: contractRows } = await admin
    .from("contracts")
    .select("id, booking_id, total_amount")
    .in("booking_id", ids)
    .eq("status", "active");

  const contracts = new Map(
    ((contractRows ?? []) as { id: string; booking_id: string; total_amount: number }[]).map(
      (row) => [row.booking_id, row],
    ),
  );

  const { data: scheduleRows } = await admin
    .from("payment_schedules")
    .select("id, contract_id, status")
    .in(
      "contract_id",
      [...contracts.values()].map((row) => row.id),
    );

  const { data: paymentRows } = await admin
    .from("payments")
    .select("booking_id, amount, refunded_amount, paid_at, status")
    .in("booking_id", ids)
    .in("status", ["paid", "partially_refunded"]);

  const { data: redemptionRows } = await admin
    .from("coupon_redemptions")
    .select("booking_id, discount_amount, borne_by")
    .in("booking_id", ids);

  const lines: SettlementLine[] = [];
  const included: string[] = [];

  for (const booking of bookings) {
    const contract = contracts.get(booking.id);
    if (!contract) continue;

    const schedules = ((scheduleRows ?? []) as { contract_id: string; status: string }[]).filter(
      (row) => row.contract_id === contract.id,
    );

    const active = schedules.filter((row) => row.status !== "void");

    // 완납이 아니면 이번 기간의 정산 대상이 아니다. 다음 기간에 다시 후보가 된다.
    if (active.length === 0 || active.some((row) => row.status !== "paid")) continue;

    const payments = ((paymentRows ?? []) as {
      booking_id: string;
      amount: number;
      refunded_amount: number;
      paid_at: string | null;
    }[]).filter((row) => row.booking_id === booking.id);

    if (payments.length === 0) continue;

    const lastPaidAt = payments
      .map((row) => row.paid_at)
      .filter((value): value is string => value !== null)
      .sort()
      .at(-1);

    if (!lastPaidAt) continue;

    const day = lastPaidAt.slice(0, 10);
    if (day < period.start || day > period.end) continue;

    const paidAmount = payments.reduce(
      (sum, row) => sum + row.amount - row.refunded_amount,
      0,
    );

    const redemptions = ((redemptionRows ?? []) as {
      booking_id: string | null;
      discount_amount: number;
      borne_by: "platform" | "vendor";
    }[])
      .filter((row) => row.booking_id === booking.id)
      .map((row) => ({ borneBy: row.borne_by, discountAmount: row.discount_amount }));

    lines.push({
      bookingId: booking.id,
      grossAmount: contract.total_amount ?? booking.total_amount,
      paidAmount,
      appliedFeeRateBp: booking.applied_fee_rate_bp,
      // **업체 부담분만** 뺀다. 플랫폼 쿠폰은 차감하지 않는다(D-27).
      vendorCouponDeduction: vendorBorneTotal(redemptions),
    });
    included.push(booking.id);
  }

  return { lines, bookingIds: included };
}

// =============================================================================
// 집계 실행 — 같은 행을 고친다 (새로 만들지 않는다)
// =============================================================================

export type RunResult = {
  settlementId: string;
  status: SettlementStatus;
  blockedReason: string | null;
  itemCount: number;
};

export async function runSettlement(input: {
  vendorId: string;
  period?: SettlementPeriod;
  actorId: string;
  now?: Date;
}): Promise<RunResult | SettlementFailure> {
  const admin = createAdminClient();
  const now = input.now ?? new Date();
  const periodSetting = await readSetting("settlement.period");
  const unit = typeof periodSetting?.unit === "string" ? periodSetting.unit : "month";
  const period = input.period ?? settlementPeriod(now, unit);

  const { lines } = await collectLines(input.vendorId, period);
  const basis = feeBasisOf(await readSetting("settlement.fee_basis"));
  const build = buildSettlement({ lines, feeBasis: basis.ok ? basis.basis : null });

  // 기간·업체당 하나다(0003 UNIQUE). **지우고 다시 만들지 않는다** — id 가 바뀌면
  // 증적이 가리키던 대상이 사라진다(D-23).
  const { data: existingRow } = await admin
    .from("settlements")
    .select("id, status")
    .eq("vendor_id", input.vendorId)
    .eq("period_start", period.start)
    .eq("period_end", period.end)
    .maybeSingle();

  const existing = existingRow as { id: string; status: SettlementStatus } | null;

  if (existing && !recalculable(existing.status)) {
    return failure(
      409,
      "SETTLEMENT_FROZEN",
      "확정된 정산서는 다시 계산하지 않습니다. 조정이 필요하면 상계로 다음 정산에 반영해요.",
    );
  }

  const patch =
    build.status === "blocked"
      ? {
          status: "blocked" as const,
          blocked_reason: build.reason,
          fee_basis: null,
          gross_amount: 0,
          fee_rate_bp: 0,
          fee_amount: 0,
          net_amount: 0,
          coupon_deduction: 0,
          payout_amount: null,
          calculated_at: now.toISOString(),
        }
      : {
          status: "draft" as const,
          blocked_reason: null,
          fee_basis: build.feeBasis,
          gross_amount: build.grossAmount,
          fee_rate_bp: build.weightedFeeRateBp,
          fee_amount: build.feeAmount,
          net_amount: build.grossAmount - build.feeAmount,
          coupon_deduction: build.couponDeduction,
          payout_amount: null,
          calculated_at: now.toISOString(),
        };

  const settlementId = existing
    ? await updateSettlement(existing.id, patch)
    : await insertSettlement({ vendorId: input.vendorId, period, patch });

  if (settlementId === null) {
    return failure(500, "SETTLEMENT_WRITE_FAILED", "정산서를 만들지 못했습니다.");
  }

  // 건별 명세는 매번 다시 만든다 — 집계 결과가 바뀌면 근거도 함께 바뀌어야 한다.
  await admin.from("settlement_items").delete().eq("settlement_id", settlementId);

  if (build.status === "draft" && build.items.length > 0) {
    await admin.from("settlement_items").insert(
      build.items.map((item) => ({
        settlement_id: settlementId,
        booking_id: item.bookingId,
        amount: item.amount,
        fee_rate_bp: item.feeRateBp,
        fee_amount: item.feeAmount,
        coupon_deduction: item.couponDeduction,
        net_amount: item.netAmount,
        adjustment: 0,
      })),
    );
  }

  await recordEvent({
    entityType: "settlement",
    entityId: settlementId,
    eventType: existing ? "settlement_recalculated" : "settlement_created",
    actor: { id: input.actorId },
    afterState: patch.status,
    // 금액·건수·사유만. 업체명·거래 내용은 넣지 않는다(§7.3).
    memo:
      build.status === "blocked"
        ? `period=${period.start}~${period.end} blocked=${build.reason}`
        : `period=${period.start}~${period.end} gross=${build.grossAmount} fee=${build.feeAmount} items=${build.items.length}`,
  });

  return {
    settlementId,
    status: patch.status,
    blockedReason: patch.blocked_reason,
    itemCount: build.status === "draft" ? build.items.length : 0,
  };
}

type SettlementPatch = Record<string, unknown>;

async function insertSettlement(input: {
  vendorId: string;
  period: SettlementPeriod;
  patch: SettlementPatch;
}): Promise<string | null> {
  const { data, error } = await createAdminClient()
    .from("settlements")
    .insert({
      vendor_id: input.vendorId,
      period_start: input.period.start,
      period_end: input.period.end,
      ...input.patch,
    })
    .select("id")
    .maybeSingle();

  return error || !data ? null : (data as { id: string }).id;
}

async function updateSettlement(id: string, patch: SettlementPatch): Promise<string | null> {
  const { error } = await createAdminClient().from("settlements").update(patch).eq("id", id);

  return error ? null : id;
}

// =============================================================================
// 확정 — 상계를 반영하고 금액을 동결한다
// =============================================================================

export async function confirmSettlement(input: {
  settlementId: string;
  actorId: string;
  now?: Date;
}): Promise<{ payoutAmount: number; carriedTotal: number } | SettlementFailure> {
  const admin = createAdminClient();
  const now = input.now ?? new Date();

  const { data } = await admin
    .from("settlements")
    .select("id, vendor_id, status, net_amount, coupon_deduction")
    .eq("id", input.settlementId)
    .maybeSingle();

  const row = data as {
    id: string;
    vendor_id: string;
    status: SettlementStatus;
    net_amount: number;
    coupon_deduction: number;
  } | null;

  if (!row) return failure(404, "SETTLEMENT_NOT_FOUND", "정산서를 찾을 수 없습니다.");

  if (row.status !== "draft") {
    return failure(422, "SETTLEMENT_NOT_CONFIRMABLE", `확정할 수 있는 상태가 아니에요(${row.status}).`);
  }

  // 미반영 상계를 가져온다. 이번에 못 뺀 것은 그대로 두어 **다음 정산이 가져간다.**
  const { data: pendingRows } = await admin
    .from("settlement_adjustments")
    .select("id, source_type, amount, reason")
    .eq("vendor_id", row.vendor_id)
    .is("applied_settlement_id", null);

  const pending = ((pendingRows ?? []) as {
    id: string;
    source_type: string;
    amount: number;
    reason: string;
  }[]).map((item) => ({
    id: item.id,
    sourceType: item.source_type as "cancellation_refund" | "coupon" | "planner_recovery" | "manual",
    amount: item.amount,
    reason: item.reason,
  }));

  // 순액에서 쿠폰 차감을 먼저 뺀 금액이 상계의 대상이다.
  const base = Math.max(0, row.net_amount - row.coupon_deduction);
  const application = applyAdjustments(base, pending);

  const leadDays = await readIntSetting("settlement.payout_lead_days", "days");

  const { error } = await admin
    .from("settlements")
    .update({
      status: "confirmed",
      confirmed_at: now.toISOString(),
      adjustment_amount: application.appliedTotal,
      payout_amount: application.payoutAmount,
      // 리드타임 설정이 없으면 예정일을 지어내지 않는다 — 운영이 값을 넣어야 한다.
      payable_at: leadDays === null ? null : payableDateOf(now, leadDays),
    })
    .eq("id", row.id);

  if (error) return failure(500, "SETTLEMENT_CONFIRM_FAILED", "정산서를 확정하지 못했습니다.");

  for (const applied of application.applied) {
    await admin
      .from("settlement_adjustments")
      .update({ applied_settlement_id: row.id, applied_at: now.toISOString() })
      .eq("id", applied.id);
  }

  await recordEvent({
    entityType: "settlement",
    entityId: row.id,
    eventType: "settlement_confirmed",
    actor: { id: input.actorId },
    beforeState: "draft",
    afterState: "confirmed",
    memo: `payout=${application.payoutAmount} adjustment=${application.appliedTotal} carried=${application.carriedTotal}`,
  });

  await notifyVendorOwner(row.vendor_id, "settlement.confirmed", { settlementId: row.id });

  return { payoutAmount: application.payoutAmount, carriedTotal: application.carriedTotal };
}

// =============================================================================
// 지급
// =============================================================================

export type PayOutcome =
  | { status: "paid"; payoutId: string }
  | { status: "failed"; payoutId: string; reason: string; retryable: boolean };

export async function paySettlement(input: {
  settlementId: string;
  actorId: string;
  attempt?: number;
  now?: Date;
}): Promise<PayOutcome | SettlementFailure> {
  const admin = createAdminClient();
  const now = input.now ?? new Date();

  const { data } = await admin
    .from("settlements")
    .select("id, vendor_id, status, payout_amount")
    .eq("id", input.settlementId)
    .maybeSingle();

  const row = data as {
    id: string;
    vendor_id: string;
    status: SettlementStatus;
    payout_amount: number | null;
  } | null;

  if (!row) return failure(404, "SETTLEMENT_NOT_FOUND", "정산서를 찾을 수 없습니다.");

  const { data: pendingRows } = await admin
    .from("settlement_payouts")
    .select("id, status, attempt_count")
    .eq("settlement_id", row.id);

  const payouts = (pendingRows ?? []) as { id: string; status: string; attempt_count: number }[];

  const eligibility = payoutEligibility({
    status: row.status,
    payoutAmount: row.payout_amount ?? 0,
    hasPending: payouts.some((item) => item.status === "pending"),
  });

  if (!eligibility.ok) {
    return failure(422, `SETTLEMENT_PAYOUT_${eligibility.reason.toUpperCase()}`, eligibility.detail);
  }

  const attempt = input.attempt ?? 1;
  const key = payoutIdempotencyKey({ settlementId: row.id, attempt });
  const attemptCount = payouts.length + 1;

  if (!canRetryPayout(payouts.filter((item) => item.status === "failed").length)) {
    return failure(
      422,
      "SETTLEMENT_PAYOUT_ATTEMPTS_EXCEEDED",
      "지급 시도 횟수를 넘었습니다. 계좌 정보를 확인하거나 담당자에게 문의해 주세요.",
    );
  }

  const providerName = adapter().name;

  // ── 1) 행을 먼저 만든다 — 유니크가 동시 실행을 막는 지점이다 ──────────────
  const { data: created, error: createError } = await admin
    .from("settlement_payouts")
    .insert({
      settlement_id: row.id,
      amount: row.payout_amount ?? 0,
      status: "pending",
      idempotency_key: key,
      attempt_count: attemptCount,
      provider: providerName,
    })
    .select("id")
    .maybeSingle();

  if (createError || !created) {
    if ((createError as { code?: string } | null)?.code === "23505") {
      return failure(409, "SETTLEMENT_PAYOUT_IN_PROGRESS", "이 정산서의 지급이 이미 진행 중이에요.");
    }

    return failure(500, "SETTLEMENT_PAYOUT_CREATE_FAILED", "지급을 시작하지 못했습니다.");
  }

  const payoutId = (created as { id: string }).id;

  // ── 2) 어댑터 ─────────────────────────────────────────────────────────────
  const result = await adapter().pay({
    settlementId: row.id,
    vendorId: row.vendor_id,
    amount: row.payout_amount ?? 0,
    currency: "KRW",
    idempotencyKey: key,
  });

  if (!result.ok) {
    await admin
      .from("settlement_payouts")
      .update({
        status: "failed",
        failed_at: now.toISOString(),
        failure_reason: result.failureReason,
      })
      .eq("id", payoutId);

    await recordEvent({
      entityType: "settlement_payout",
      entityId: payoutId,
      eventType: "payout_failed",
      actor: { id: input.actorId },
      beforeState: "pending",
      afterState: "failed",
      memo: `amount=${row.payout_amount} retryable=${result.retryable}`,
    });

    return { status: "failed", payoutId, reason: result.failureReason, retryable: result.retryable };
  }

  // ── 3) 성공 — 지급 기록이 먼저, 정산서 상태가 나중 ────────────────────────
  // 순서가 중요하다: 0033 의 트리거가 **성공한 지급 행 없이 paid 로 가는 것**을 막는다.
  await admin
    .from("settlement_payouts")
    .update({ status: "paid", paid_at: result.paidAt, provider_ref: result.providerRef })
    .eq("id", payoutId);

  await admin
    .from("settlements")
    .update({ status: "paid", paid_at: result.paidAt })
    .eq("id", row.id);

  await recordEvent({
    entityType: "settlement_payout",
    entityId: payoutId,
    eventType: "payout_paid",
    actor: { id: input.actorId },
    beforeState: "pending",
    afterState: "paid",
    memo: `amount=${row.payout_amount} provider=${providerName}`,
  });

  await notifyVendorOwner(row.vendor_id, "settlement.paid", { settlementId: row.id });

  return { status: "paid", payoutId };
}

// =============================================================================
// 상계 등록 — 다른 도메인이 부른다
// =============================================================================

/**
 * 상계를 등록한다.
 *
 * **금액을 덮어쓰지 않고 다음 정산으로 넘긴다.** 확정된 정산서를 소급 수정하면
 * "언제 얼마를 정산했는가" 가 재현되지 않는다(D-23). 0031 이 해지에서 "확정 정산서는
 * 고치지 않고 조율로 보낸다" 고 한 자리를 이 함수가 채운다.
 *
 * **같은 근거로 두 번 상계하지 않는다** — 부분 유니크가 경계이며, 중복 등록은 조용히
 * 무시하지 않고 그대로 돌려준다(호출부가 알아야 한다).
 */
export async function addAdjustment(input: {
  vendorId: string;
  sourceType: "cancellation_refund" | "coupon" | "planner_recovery" | "manual";
  sourceId?: string | null;
  bookingId?: string | null;
  amount: number;
  reason: string;
  actorId: string;
}): Promise<{ adjustmentId: string } | { duplicate: true } | SettlementFailure> {
  if (!Number.isInteger(input.amount) || input.amount < 1) {
    return failure(422, "SETTLEMENT_ADJUSTMENT_AMOUNT", "상계 금액은 1원 이상 정수여야 합니다.");
  }

  const { data, error } = await createAdminClient()
    .from("settlement_adjustments")
    .insert({
      vendor_id: input.vendorId,
      source_type: input.sourceType,
      source_id: input.sourceId ?? null,
      booking_id: input.bookingId ?? null,
      amount: input.amount,
      reason: input.reason.slice(0, 200),
      created_by: input.actorId,
    })
    .select("id")
    .maybeSingle();

  if (error) {
    if ((error as { code?: string }).code === "23505") return { duplicate: true };

    return failure(500, "SETTLEMENT_ADJUSTMENT_FAILED", "상계를 등록하지 못했습니다.");
  }

  const adjustmentId = (data as { id: string }).id;

  await recordEvent({
    entityType: "settlement",
    entityId: adjustmentId,
    eventType: "settlement_adjustment_added",
    actor: { id: input.actorId },
    afterState: "pending",
    memo: `source=${input.sourceType} amount=${input.amount}`,
  });

  return { adjustmentId };
}

// =============================================================================
// 알림 — 토픽은 `settlement` 다 (0033 이 CHECK 에 더했다)
// =============================================================================

async function notifyVendorOwner(
  vendorId: string,
  templateKey: "settlement.confirmed" | "settlement.paid",
  params: Record<string, unknown>,
): Promise<void> {
  const admin = createAdminClient();

  // **대표에게만 보낸다.** 정산 금액은 대표 전용이고(§3.9) 알림은 그 경계를 넘지 않는다.
  const { data } = await admin
    .from("vendor_members")
    .select("user_id")
    .eq("vendor_id", vendorId)
    .eq("vendor_role", "owner");

  for (const row of (data ?? []) as { user_id: string }[]) {
    await sendNotification({
      userId: row.user_id,
      topic: "settlement",
      channel: "in_app",
      templateKey,
      // 참조만. 금액은 담지 않는다 — 상계로 바뀔 수 있고 알림함에 옛 숫자가 남는다.
      params,
      dedupeKey: `${templateKey}:${String(params.settlementId)}`,
    });
  }
}
