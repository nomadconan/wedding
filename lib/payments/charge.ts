import { readSetting } from "@/lib/app-settings";
import { recordEvent } from "@/lib/audit/record";
import {
  SETTLEMENT_DEFERRED_EVENT,
  canCancelPayment,
  chargeFailureDisposition,
  decideRefund,
  paymentProgress,
  purposeOfSeq,
  settlementLinkage,
  viewSchedules,
  type ScheduleRow,
} from "@/lib/core/payment/checkout";
import { feeBasisOf, paymentIdempotencyKey } from "@/lib/core/payment/payment";
import { holdEscrow } from "@/lib/escrow/actions";
import { sendNotification } from "@/lib/notify/send";
import { createAdminClient } from "@/lib/supabase/admin";

import { MAX_PAYMENT_ATTEMPTS, canRetryPayment } from "./adapter";
import { resolveChargeAdapterName, type ChargeAdapter } from "./charge-adapter";
import { createNoopChargeAdapter, createStubChargeAdapter } from "./charge-stub";

/**
 * 회차 결제 실행 (S5-06 · §3.4 · §4.2 · D-18 · D-23 · D-28)
 *
 * ── 순서가 곧 설계다 (S4-08·S4-13 과 같은 구조) ─────────────────────────────
 *  1. **행을 먼저 만든다** — `payments.idempotency_key` 유니크와 회차당 `pending`
 *     부분 유니크(0030)가 동시 실행을 막는 지점이 여기다. 결제하고 나서 기록하면
 *     두 프로세스가 **둘 다 결제한 뒤에야** 충돌을 안다.
 *  2. **어댑터를 부른다** — 결과에 따라 `paid`·`failed` 로 옮긴다.
 *  3. **회차를 옮긴다** — 결제가 승인된 뒤에만. DB 트리거가 "승인된 결제 없이 회차
 *     완료 금지" 를 다시 판정한다(0030).
 *  4. **실패도 기록한다** — 조용히 사라지면 "왜 결제가 안 됐나" 를 답할 수 없다(D-23).
 *
 * ── 서비스롤로 쓴다 ─────────────────────────────────────────────────────────
 * `payments`·`payment_schedules`·`payment_consents` 에 쓰기 정책이 없다(0028·0030).
 * 클라이언트가 결제 행을 만들 수 있으면 **스스로 금액을 적을 수 있다.**
 * 권한 판정은 이 파일을 부르는 API 가 세션으로 하며, 대상은 RLS 로 좁혀 읽는다.
 */
function adapter(): ChargeAdapter {
  return resolveChargeAdapterName() === "stub"
    ? createStubChargeAdapter()
    : createNoopChargeAdapter();
}

export type ChargeFailure = { status: number; code: string; message: string };

function failure(status: number, code: string, message: string): ChargeFailure {
  return { status, code, message };
}

export function isChargeFailure(value: unknown): value is ChargeFailure {
  return typeof value === "object" && value !== null && "code" in value && "status" in value;
}

type ScheduleContext = {
  scheduleId: string;
  seq: number;
  amount: number;
  contractId: string;
  bookingId: string;
  coupleId: string;
  ownerId: string;
  contractStatus: string;
  contractTotal: number;
  schedules: ScheduleRow[];
};

/** 회차 하나를 결제하는 데 필요한 것들을 한 번에 읽는다. */
async function loadScheduleContext(scheduleId: string): Promise<ScheduleContext | null> {
  const admin = createAdminClient();

  const { data: scheduleRow } = await admin
    .from("payment_schedules")
    .select("id, seq, amount, status, due_at, contract_id")
    .eq("id", scheduleId)
    .maybeSingle();

  const schedule = scheduleRow as {
    id: string;
    seq: number;
    amount: number;
    contract_id: string;
  } | null;

  if (!schedule) return null;

  const { data: contractRow } = await admin
    .from("contracts")
    .select("id, booking_id, status, total_amount")
    .eq("id", schedule.contract_id)
    .maybeSingle();

  const contract = contractRow as {
    id: string;
    booking_id: string;
    status: string;
    total_amount: number;
  } | null;

  if (!contract) return null;

  const { data: bookingRow } = await admin
    .from("bookings")
    .select("id, couple_id")
    .eq("id", contract.booking_id)
    .maybeSingle();

  const booking = bookingRow as { id: string; couple_id: string } | null;
  if (!booking) return null;

  const { data: coupleRow } = await admin
    .from("couples")
    .select("id, owner_id")
    .eq("id", booking.couple_id)
    .maybeSingle();

  const couple = coupleRow as { owner_id: string } | null;
  if (!couple) return null;

  const { data: siblingRows } = await admin
    .from("payment_schedules")
    .select("id, seq, amount, status, due_at")
    .eq("contract_id", schedule.contract_id);

  const schedules: ScheduleRow[] = (
    (siblingRows ?? []) as {
      id: string;
      seq: number;
      amount: number;
      status: string;
      due_at: string | null;
    }[]
  ).map((row) => ({
    id: row.id,
    seq: row.seq,
    amount: row.amount,
    status: row.status as ScheduleRow["status"],
    dueAt: row.due_at,
  }));

  return {
    scheduleId: schedule.id,
    seq: schedule.seq,
    amount: schedule.amount,
    contractId: contract.id,
    bookingId: contract.booking_id,
    coupleId: booking.couple_id,
    ownerId: couple.owner_id,
    contractStatus: contract.status,
    contractTotal: contract.total_amount,
    schedules,
  };
}

// =============================================================================
// 결제 전 동의 — 기록이 없으면 승인되지 않는다 (F-C-14)
// =============================================================================

export async function recordConsents(input: {
  scheduleId: string;
  userId: string;
  kinds: readonly string[];
  version: string;
  ipHash: string | null;
}): Promise<void> {
  const admin = createAdminClient();

  for (const kind of input.kinds) {
    // 회차·종류당 하나(0030 유니크). 재시도에서 다시 동의를 받게 하지 않는다.
    const { data } = await admin
      .from("payment_consents")
      .upsert(
        {
          payment_schedule_id: input.scheduleId,
          user_id: input.userId,
          kind,
          consent_version: input.version,
          ip_hash: input.ipHash,
        },
        { onConflict: "payment_schedule_id,kind", ignoreDuplicates: true },
      )
      .select("id")
      .maybeSingle();

    const created = data as { id: string } | null;

    if (created) {
      await recordEvent({
        entityType: "payment_consent",
        entityId: created.id,
        eventType: "payment_consent_recorded",
        actor: { id: input.userId },
        afterState: "agreed",
        // 종류와 판본만. 문구는 남기지 않는다(§7.3 — 문구는 코드가 판본으로 갖는다).
        memo: `kind=${kind} version=${input.version}`,
      });
    }
  }
}

// =============================================================================
// 승인
// =============================================================================

export type ChargeOutcome =
  | { status: "paid"; paymentId: string; fullyPaid: boolean }
  | { status: "duplicate"; paymentId: string }
  | { status: "failed"; paymentId: string | null; reason: string; retryable: boolean; nextAction: string };

export async function chargeInstallment(input: {
  scheduleId: string;
  actorId: string;
  /** 명시적 재결제 회차. 자동 재시도에서는 올리지 않는다(멱등이 사라진다). */
  attempt?: number;
  now?: Date;
}): Promise<ChargeOutcome | ChargeFailure> {
  const admin = createAdminClient();
  const now = input.now ?? new Date();
  const context = await loadScheduleContext(input.scheduleId);

  if (!context) return failure(404, "PAY_SCHEDULE_NOT_FOUND", "결제 회차를 찾을 수 없습니다.");

  // ── 낼 수 있는 회차인가 — 판정은 순수 함수가 한다 ─────────────────────────
  const { data: pendingRows } = await admin
    .from("payments")
    .select("payment_schedule_id")
    .eq("status", "pending")
    .not("payment_schedule_id", "is", null);

  const pendingIds = ((pendingRows ?? []) as { payment_schedule_id: string }[]).map(
    (row) => row.payment_schedule_id,
  );

  const views = viewSchedules({
    schedules: context.schedules,
    contractActive: context.contractStatus === "active",
    pendingScheduleIds: pendingIds,
    now,
  });

  const target = views.find((view) => view.id === context.scheduleId);

  if (!target) return failure(404, "PAY_SCHEDULE_NOT_FOUND", "결제 회차를 찾을 수 없습니다.");

  if (!target.payable) {
    return failure(422, `PAY_${(target.blockedReason ?? "blocked").toUpperCase()}`,
      target.blockedReason === null ? "지금 결제할 수 없는 회차예요." : blockedMessage(target.blockedReason));
  }

  const attempt = input.attempt ?? 1;
  const idempotencyKey = paymentIdempotencyKey({
    scheduleId: context.scheduleId,
    purpose: "charge",
    attempt,
  });

  // ── 멱등: 같은 열쇠의 결제가 이미 있으면 그것을 돌려준다 ──────────────────
  const { data: priorRow } = await admin
    .from("payments")
    .select("id, status, attempt_count")
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();

  const prior = priorRow as { id: string; status: string; attempt_count: number } | null;

  if (prior) {
    if (prior.status === "paid" || prior.status === "partially_refunded" || prior.status === "refunded") {
      return { status: "duplicate", paymentId: prior.id };
    }

    if (prior.status === "pending") {
      return { status: "duplicate", paymentId: prior.id };
    }

    // 실패한 열쇠는 되살리지 않는다 — 몇 번 시도했는지가 행으로 남아야 한다(0030).
    if (!canRetryPayment(prior.attempt_count)) {
      return failure(
        422,
        "PAY_ATTEMPTS_EXCEEDED",
        "결제 시도 횟수를 넘었습니다. 다른 결제 수단으로 시도하거나 고객센터로 문의해 주세요.",
      );
    }
  }

  const providerName = adapter().name;
  const attemptCount = (prior?.attempt_count ?? 0) + 1;

  // ── 1) 행을 먼저 만든다 ───────────────────────────────────────────────────
  const { data: created, error: createError } = await admin
    .from("payments")
    .insert({
      booking_id: context.bookingId,
      payment_schedule_id: context.scheduleId,
      purpose: purposeOfSeq(context.seq),
      amount: context.amount,
      status: "pending",
      // 실패한 이전 시도가 같은 열쇠를 점유하고 있으면 새 시도는 다른 열쇠여야 한다.
      idempotency_key: prior ? `${idempotencyKey}:r${attemptCount}` : idempotencyKey,
      attempt_count: attemptCount,
      provider: providerName,
    })
    .select("id")
    .maybeSingle();

  if (createError || !created) {
    // 유니크 충돌은 "이미 진행 중" 이다 — 동시에 두 번 누른 경우이며 사고가 아니다.
    if ((createError as { code?: string } | null)?.code === "23505") {
      return failure(409, "PAY_IN_PROGRESS", "이 회차의 결제가 이미 진행 중이에요.");
    }

    return failure(500, "PAY_CREATE_FAILED", "결제를 시작하지 못했습니다.");
  }

  const paymentId = (created as { id: string }).id;

  // ── 2) 어댑터 ─────────────────────────────────────────────────────────────
  const result = await adapter().charge({
    paymentScheduleId: context.scheduleId,
    amount: context.amount,
    currency: "KRW",
    idempotencyKey,
  });

  if (!result.ok) {
    const disposition = chargeFailureDisposition({
      retryable: result.retryable,
      attemptCount,
      maxAttempts: MAX_PAYMENT_ATTEMPTS,
    });

    await admin
      .from("payments")
      .update({
        status: "failed",
        failed_at: now.toISOString(),
        failure_reason: result.failureReason,
      })
      .eq("id", paymentId);

    await recordEvent({
      entityType: "payment",
      entityId: paymentId,
      eventType: "payment_failed",
      actor: { id: input.actorId },
      beforeState: "pending",
      afterState: "failed",
      memo: `seq=${context.seq} amount=${context.amount} retryable=${disposition.retryable}`,
    });

    await notifyCouple(context.ownerId, "payment.failed", {
      scheduleId: context.scheduleId,
      seq: context.seq,
    });

    return {
      status: "failed",
      paymentId,
      reason: result.failureReason,
      retryable: disposition.retryable,
      nextAction: disposition.nextAction,
    };
  }

  // ── 3) 승인 · 회차 완료 ───────────────────────────────────────────────────
  const paidAt = result.approvedAt;

  await admin
    .from("payments")
    .update({
      status: "paid",
      paid_at: paidAt,
      toss_payment_key: result.providerRef,
      failure_reason: null,
    })
    .eq("id", paymentId);

  await admin
    .from("payment_schedules")
    .update({ status: "paid", paid_at: paidAt })
    .eq("id", context.scheduleId);

  await recordEvent({
    entityType: "payment",
    entityId: paymentId,
    eventType: "payment_paid",
    actor: { id: input.actorId },
    beforeState: "pending",
    afterState: "paid",
    memo: `seq=${context.seq} amount=${context.amount} provider=${providerName}`,
  });

  await recordEvent({
    entityType: "payment_schedule",
    entityId: context.scheduleId,
    eventType: "schedule_paid",
    actor: { id: input.actorId },
    beforeState: "scheduled",
    afterState: "paid",
    memo: `seq=${context.seq} amount=${context.amount}`,
  });

  await linkSettlement({ paymentId, actorId: input.actorId, amount: context.amount });

  // **잔금은 안전거래로 맡는다**(S5-09 · F-C-16). 계약금(1회차)은 계약 성립의 증표라
  // 바로 업체에 전달되고 잔금만 예치된다 — 판정은 `isEscrowTarget` 이 한다.
  // **예치가 실패해도 결제를 되돌리지 않는다.** 고객은 이미 냈고, 되돌리면 그 돈이
  // 어디에도 없는 상태가 된다. 실패는 증적으로 남기고 운영이 본다.
  await holdEscrow({ scheduleId: context.scheduleId, paymentId, actorId: input.actorId });

  // ── 4) 완납 판정 — 세면 나오는 값이라 저장하지 않는다 ─────────────────────
  const progress = paymentProgress(
    context.schedules.map((row) =>
      row.id === context.scheduleId ? { ...row, status: "paid" as const } : row,
    ),
  );

  await notifyCouple(context.ownerId, "payment.succeeded", {
    scheduleId: context.scheduleId,
    seq: context.seq,
  });

  if (progress.fullyPaid) {
    await notifyCouple(context.ownerId, "payment.fully_paid", { contractId: context.contractId });
  }

  return { status: "paid", paymentId, fullyPaid: progress.fullyPaid };
}

function blockedMessage(reason: string): string {
  const messages: Record<string, string> = {
    already_paid: "이미 결제된 회차예요.",
    voided: "취소된 회차라 결제하지 않습니다.",
    contract_not_active: "계약이 확정된 뒤에 결제할 수 있어요.",
    earlier_unpaid: "앞 회차를 먼저 결제해 주세요.",
    due_undecided: "이 회차는 지급 시점이 아직 정해지지 않아 미리 결제할 수 없어요.",
    in_progress: "이 회차의 결제가 진행 중이에요. 결과를 기다려 주세요.",
  };

  return messages[reason] ?? "지금 결제할 수 없는 회차예요.";
}

/**
 * 정산 연계.
 *
 * **결제는 되는데 정산이 안 되는 상태를 조용히 두지 않는다.** `settlement.fee_basis`
 * 가 미결(O-15)이면 정산을 세울 수 없지만 결제를 막지는 않는다 — 고객이 낼 금액은
 * 계약 총액이 정하고, 수수료를 할인 전·후 어디서 뗄지는 플랫폼과 업체 사이의 문제다.
 * 대신 **보류를 셀 수 있게** 증적으로 남긴다. S5-07 이 이 이벤트를 근거로 밀린
 * 정산을 세운다.
 */
async function linkSettlement(input: {
  paymentId: string;
  actorId: string;
  amount: number;
}): Promise<void> {
  const basis = feeBasisOf(await readSetting("settlement.fee_basis"));
  const linkage = settlementLinkage({
    feeBasisResolved: basis.ok,
    openIssue: basis.ok ? undefined : basis.openIssue,
  });

  if (linkage.ok) return;

  await recordEvent({
    entityType: "payment",
    entityId: input.paymentId,
    eventType: SETTLEMENT_DEFERRED_EVENT,
    actor: { id: input.actorId },
    afterState: "settlement_pending",
    memo: `openIssue=${linkage.openIssue} amount=${input.amount}`,
  });
}

async function notifyCouple(
  userId: string,
  templateKey: "payment.succeeded" | "payment.failed" | "payment.fully_paid",
  params: Record<string, unknown>,
): Promise<void> {
  await sendNotification({
    userId,
    topic: "payment",
    channel: "in_app",
    templateKey,
    params,
    // 같은 회차의 같은 사건을 두 번 알리지 않는다.
    dedupeKey: `${templateKey}:${JSON.stringify(params)}`,
  });
}

// =============================================================================
// 취소 — 아직 안 나간 돈의 요청을 거둔다
// =============================================================================

export async function cancelPendingPayment(input: {
  paymentId: string;
  reason: string;
  actorId: string;
}): Promise<{ status: "cancelled" | "skipped"; reason?: string } | ChargeFailure> {
  const admin = createAdminClient();

  const { data } = await admin
    .from("payments")
    .select("id, status, toss_payment_key, payment_schedule_id")
    .eq("id", input.paymentId)
    .maybeSingle();

  const payment = data as {
    id: string;
    status: string;
    toss_payment_key: string | null;
    payment_schedule_id: string | null;
  } | null;

  if (!payment) return failure(404, "PAY_NOT_FOUND", "결제를 찾을 수 없습니다.");

  if (!canCancelPayment(payment.status)) {
    return { status: "skipped", reason: `이미 ${payment.status} 상태입니다.` };
  }

  const result = await adapter().cancel({
    providerRef: payment.toss_payment_key ?? "",
    idempotencyKey: paymentIdempotencyKey({
      scheduleId: payment.payment_schedule_id ?? payment.id,
      purpose: "cancel",
    }),
    reason: input.reason,
  });

  // **실패하면 상태를 바꾸지 않는다.** 거두지 못했는데 cancelled 로 적으면 있지도
  // 않은 취소가 기록되고, 그 기록이 분쟁의 근거가 된다(S4-08 과 같은 판단).
  if (!result.ok) {
    await admin
      .from("payments")
      .update({ failure_reason: result.failureReason })
      .eq("id", payment.id);

    return failure(502, "PAY_CANCEL_FAILED", result.failureReason);
  }

  await admin
    .from("payments")
    .update({ status: "cancelled", cancelled_at: new Date().toISOString() })
    .eq("id", payment.id);

  await recordEvent({
    entityType: "payment",
    entityId: payment.id,
    eventType: "payment_cancelled",
    actor: { id: input.actorId },
    beforeState: "pending",
    afterState: "cancelled",
    memo: input.reason.slice(0, 200),
  });

  return { status: "cancelled" };
}

// =============================================================================
// 환불 — 부분 환불이 기본형이다
// =============================================================================

/**
 * 환불을 적용한다.
 *
 * **얼마를 돌려줄지 정하지 않는다.** 위약금 적용과 운영자 승인은 S5-08 의 일이고,
 * 이 함수는 (가) 그 금액이 돌려줄 수 있는 범위 안인지 (나) 어댑터를 부르고
 * (다) 상태·누적 환불액을 옮기는 것까지다. 지금 이 함수를 부르는 곳은 **웹훅**이며
 * (PG 쪽에서 취소·환불이 일어난 경우), 운영자 화면은 S5-08 이 붙인다.
 */
export async function applyRefund(input: {
  paymentId: string;
  amount: number;
  reason: string;
  actorId: string;
  /** 해지 절차에서 나온 환불이면 그 절차. §3.4 가 적은 "위약금 산정 결과 연결" 이다. */
  cancellationId?: string | null;
}): Promise<{ status: "refunded"; nextStatus: string } | ChargeFailure> {
  const admin = createAdminClient();

  const { data } = await admin
    .from("payments")
    .select("id, status, amount, refunded_amount, toss_payment_key")
    .eq("id", input.paymentId)
    .maybeSingle();

  const payment = data as {
    id: string;
    status: string;
    amount: number;
    refunded_amount: number;
    toss_payment_key: string | null;
  } | null;

  if (!payment) return failure(404, "PAY_NOT_FOUND", "결제를 찾을 수 없습니다.");

  const decision = decideRefund({
    status: payment.status,
    amount: payment.amount,
    refundedAmount: payment.refunded_amount,
    requested: input.amount,
  });

  if (!decision.ok) {
    return failure(422, `PAY_REFUND_${decision.reason.toUpperCase()}`, decision.detail);
  }

  const result = await adapter().refund({
    providerRef: payment.toss_payment_key ?? "",
    amount: input.amount,
    idempotencyKey: `${paymentIdempotencyKey({ scheduleId: payment.id, purpose: "refund" })}:${decision.refundedTotal}`,
    reason: input.reason,
  });

  if (!result.ok) {
    return failure(502, "PAY_REFUND_FAILED", result.failureReason);
  }

  await admin
    .from("payments")
    .update({ status: decision.nextStatus, refunded_amount: decision.refundedTotal })
    .eq("id", payment.id);

  // 환불 원장. `refunds`(0003)는 S5-08 이 위약금과 함께 채우지만, 금액이 실제로
  // 움직인 사실은 지금 남겨야 한다 — 나중에 적으면 그 사이 기록이 비어 있다.
  await admin.from("refunds").insert({
    payment_id: payment.id,
    cancellation_id: input.cancellationId ?? null,
    amount: input.amount,
    reason_code: input.reason.slice(0, 60),
    status: "completed",
    // 상태와 시각의 짝은 DB CHECK 가 요구한다(0031) — 결제에 건 규칙과 같다.
    completed_at: new Date().toISOString(),
  });

  await recordEvent({
    entityType: "payment",
    entityId: payment.id,
    eventType: "payment_refunded",
    actor: { id: input.actorId },
    beforeState: payment.status,
    afterState: decision.nextStatus,
    memo: `amount=${input.amount} total=${decision.refundedTotal}/${payment.amount}`,
  });

  return { status: "refunded", nextStatus: decision.nextStatus };
}
