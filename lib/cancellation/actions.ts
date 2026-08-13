import { readIntSetting } from "@/lib/app-settings";
import { recordEvent } from "@/lib/audit/record";
import {
  allocateRefund,
  cancelStage,
  confirmationDecision,
  resolveFault,
  settleCancellation,
  settlementReversal,
  type CancelReasonCode,
  type CancellationSettlement,
  type FaultParty,
  type PenaltyBasis,
} from "@/lib/core/cancellation/cancellation";
import { calculatePenalty } from "@/lib/core/pricing/penalty";
import type { PenaltyCategory } from "@/lib/core/schemas/penalty";
import { sendNotification } from "@/lib/notify/send";
import { applyRefund } from "@/lib/payments/charge";
import { loadPenaltyRuleSet } from "@/lib/pricing/penalty-rule-set";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * 계약 해지 · 위약금 절차 (S5-08 · F-A-17 · §7.7 · D-23 · D-24)
 *
 * ── 순서가 곧 설계다 ────────────────────────────────────────────────────────
 *  1. **요청** — 산정 스냅샷을 함께 박는다. 나중에 룰이 바뀌어도 "무엇으로 계산했나" 가
 *     재현된다(D-23).
 *  2. **양측 확인** — 일치하면 확정, 갈리거나 기한이 지나면 **조율 큐**로.
 *     무응답을 동의로 읽지 않는다.
 *  3. **집행** — 환불 실행 · 계약/예약 취소 · 정산 되돌리기. 이 순서를 지키는 이유는
 *     돈이 먼저 움직여야 그 뒤 상태 변경이 실패해도 고객이 손해 보지 않기 때문이다.
 *
 * ── 플랫폼은 조율자다 (D-24) ────────────────────────────────────────────────
 * 이 파일은 **금액을 제시하고 합의를 기록**한다. 일방의 요청만으로 상대의 돈을
 * 움직이지 않는다 — 그래서 `fault='undecided'` 인 상태에서는 집행 경로가 막혀 있고
 * (DB 트리거도 같은 판정을 한다), 업체 귀책 배상액처럼 기준이 없는 금액은 만들지 않는다.
 *
 * ── 서비스롤로 쓴다 ─────────────────────────────────────────────────────────
 * `contract_cancellations` 에 쓰기 정책이 없다(0031). 당사자가 쓸 수 있으면 **자기
 * 귀책을 스스로 적고 위약금을 0 으로 적을 수 있다.** 권한 판정은 API 가 세션으로 한다.
 */
export type CancellationFailure = { status: number; code: string; message: string };

function failure(status: number, code: string, message: string): CancellationFailure {
  return { status, code, message };
}

export function isCancellationFailure(value: unknown): value is CancellationFailure {
  return typeof value === "object" && value !== null && "code" in value && "status" in value;
}

// =============================================================================
// 산정 — 요청 전 미리보기와 집행 시 재계산이 같은 함수를 쓴다
// =============================================================================

export type CancellationContext = {
  contractId: string;
  bookingId: string;
  coupleId: string;
  ownerId: string;
  vendorId: string;
  category: PenaltyCategory;
  totalAmount: number;
  depositAmount: number;
  eventDate: string | null;
  paidAmount: number;
  payments: { paymentId: string; seq: number; amount: number; refundedAmount: number }[];
};

/** 해지 산정에 필요한 것을 한 번에 읽는다. */
export async function loadCancellationContext(
  bookingId: string,
): Promise<CancellationContext | null> {
  const admin = createAdminClient();

  const { data: bookingRow } = await admin
    .from("bookings")
    .select("id, couple_id, vendor_id, total_amount, deposit_amount, status")
    .eq("id", bookingId)
    .maybeSingle();

  const booking = bookingRow as {
    id: string;
    couple_id: string;
    vendor_id: string;
    total_amount: number;
    deposit_amount: number;
  } | null;

  if (!booking) return null;

  const { data: contractRow } = await admin
    .from("contracts")
    .select("id, status, total_amount")
    .eq("booking_id", bookingId)
    .neq("status", "cancelled")
    .maybeSingle();

  const contract = contractRow as { id: string; status: string; total_amount: number } | null;
  if (!contract) return null;

  const { data: vendorRow } = await admin
    .from("vendors")
    .select("category")
    .eq("id", booking.vendor_id)
    .maybeSingle();

  const { data: coupleRow } = await admin
    .from("couples")
    .select("owner_id, wedding_date")
    .eq("id", booking.couple_id)
    .maybeSingle();

  const couple = coupleRow as { owner_id: string; wedding_date: string | null } | null;
  if (!couple) return null;

  // 낸 돈은 결제 행이 말한다. 회차 상태가 아니라 **실제 승인된 금액**이어야
  // 부분 환불이 이미 일어난 경우에도 어긋나지 않는다.
  const { data: paymentRows } = await admin
    .from("payments")
    .select("id, amount, refunded_amount, status, payment_schedule_id")
    .eq("booking_id", bookingId)
    .in("status", ["paid", "partially_refunded", "refunded"]);

  const { data: scheduleRows } = await admin
    .from("payment_schedules")
    .select("id, seq")
    .eq("contract_id", contract.id);

  const seqOf = new Map(
    ((scheduleRows ?? []) as { id: string; seq: number }[]).map((row) => [row.id, row.seq]),
  );

  const payments = (
    (paymentRows ?? []) as {
      id: string;
      amount: number;
      refunded_amount: number;
      payment_schedule_id: string | null;
    }[]
  ).map((row) => ({
    paymentId: row.id,
    seq: row.payment_schedule_id ? (seqOf.get(row.payment_schedule_id) ?? 0) : 0,
    amount: row.amount,
    refundedAmount: row.refunded_amount,
  }));

  // 이미 돌려준 돈은 낸 돈에서 뺀다 — 안 그러면 같은 금액을 두 번 돌려주게 된다.
  const paidAmount = payments.reduce(
    (sum, payment) => sum + payment.amount - payment.refundedAmount,
    0,
  );

  return {
    contractId: contract.id,
    bookingId: booking.id,
    coupleId: booking.couple_id,
    ownerId: couple.owner_id,
    vendorId: booking.vendor_id,
    category: normalizeCategory((vendorRow as { category: string } | null)?.category ?? "hall"),
    totalAmount: contract.total_amount ?? booking.total_amount,
    depositAmount: booking.deposit_amount,
    eventDate: couple.wedding_date,
    paidAmount,
    payments,
  };
}

/**
 * 업체 카테고리를 위약금 카테고리로 옮긴다.
 *
 * **모르는 카테고리를 지어내지 않는다.** 룰 세트가 없는 카테고리는 `agency`(대행)로
 * 보는 것이 가장 보수적이다 — 예식장 구간과 같아 고객에게 불리하지 않고, 그 사실은
 * 산정 근거(`basisRef`)에 그대로 적혀 나간다.
 */
function normalizeCategory(category: string): PenaltyCategory {
  const known = ["hall", "studio", "dress", "makeup", "video", "agency"] as const;

  return (known as readonly string[]).includes(category)
    ? (category as PenaltyCategory)
    : "agency";
}

export type CancellationQuote = {
  settlement: CancellationSettlement;
  penalty: PenaltyBasis;
  daysBeforeEvent: number | null;
  objectionScript: string;
  paidAmount: number;
  totalAmount: number;
};

/**
 * 위약금 예상액.
 *
 * **요청 전에 반드시 보여준다.** 모르고 취소하면 안 된다 — 납득하지 못한 정산은
 * 그대로 분쟁이 된다.
 */
export async function quoteCancellation(input: {
  context: CancellationContext;
  fault: FaultParty;
  now?: Date;
}): Promise<CancellationQuote> {
  const now = input.now ?? new Date();
  const cancelDate = now.toISOString().slice(0, 10);
  const { ruleSet } = await loadPenaltyRuleSet(input.context.category);

  // 예식일이 없으면 산정 기준일이 없다. **날짜를 지어내지 않고** 취소일을 예식일로
  // 두어 "가장 임박한 구간" 으로 계산한다 — 고객에게 유리한 쪽으로 틀리지 않기 위해서다.
  const eventDate = input.context.eventDate ?? cancelDate;

  const result = calculatePenalty(
    {
      category: input.context.category,
      totalAmount: input.context.totalAmount,
      depositAmount: Math.min(input.context.depositAmount, input.context.totalAmount),
      eventDate,
      cancelDate,
      // 계약서 위약 조항은 O-03 대기라 문안이 없다(§7.7). 조항이 없으므로 기준을
      // 그대로 비교값으로 쓴다 — 엔진이 그 사실을 notes 에 적는다.
      contractTerm: { kind: "none" },
    },
    ruleSet,
  );

  const penalty: PenaltyBasis = {
    standardPenalty: result.standard.penalty,
    contractPenalty: result.contract.penalty,
    bandCode: result.bandCode,
    bandLabel: result.bandLabel,
    basisRef: result.basisRef,
    ruleVersion: result.ruleVersion,
    isDraftRules: ruleSet.isDraft,
  };

  const stage = cancelStage({
    paidAmount: input.context.paidAmount,
    totalAmount: input.context.totalAmount,
    eventDate: input.context.eventDate,
    cancelDate,
  });

  return {
    settlement: settleCancellation({
      stage,
      fault: input.fault,
      paidAmount: input.context.paidAmount,
      penalty,
    }),
    penalty,
    daysBeforeEvent: input.context.eventDate === null ? null : result.daysBeforeEvent,
    objectionScript: result.objectionScript,
    paidAmount: input.context.paidAmount,
    totalAmount: input.context.totalAmount,
  };
}

// =============================================================================
// 요청
// =============================================================================

export async function requestCancellation(input: {
  bookingId: string;
  actorId: string;
  side: "couple" | "vendor";
  reasonCode: CancelReasonCode;
  reasonNote?: string | null;
  claim: FaultParty;
  now?: Date;
}): Promise<{ cancellationId: string } | CancellationFailure> {
  const admin = createAdminClient();
  const now = input.now ?? new Date();
  const context = await loadCancellationContext(input.bookingId);

  if (!context) return failure(404, "CANCEL_CONTRACT_NOT_FOUND", "해지할 계약을 찾을 수 없습니다.");

  const { data: openRow } = await admin
    .from("contract_cancellations")
    .select("id, status")
    .eq("contract_id", context.contractId)
    .neq("status", "withdrawn")
    .maybeSingle();

  if (openRow) {
    return failure(409, "CANCEL_ALREADY_OPEN", "이미 해지 절차가 진행 중이에요.");
  }

  const quote = await quoteCancellation({ context, fault: "undecided", now });
  const dueDays = await readIntSetting("cancellation.confirm_due_days", "days");

  const { data: created, error } = await admin
    .from("contract_cancellations")
    .insert({
      contract_id: context.contractId,
      booking_id: context.bookingId,
      requested_by: input.actorId,
      requester_side: input.side,
      reason_code: input.reasonCode,
      reason_note: input.reasonNote?.slice(0, 500) ?? null,
      // 요청자의 주장은 주장 칸에만 적는다. `fault` 는 확정 전까지 undecided 다.
      couple_claim: input.side === "couple" ? input.claim : null,
      vendor_claim: input.side === "vendor" ? input.claim : null,
      fault: "undecided",
      couple_agreed: input.side === "couple" ? true : null,
      vendor_agreed: input.side === "vendor" ? true : null,
      confirm_due_at:
        dueDays === null ? null : new Date(now.getTime() + dueDays * 86_400_000).toISOString(),
      rule_version: quote.penalty.ruleVersion,
      band_code: quote.penalty.bandCode,
      band_label: quote.penalty.bandLabel,
      basis_ref: quote.penalty.basisRef,
      is_draft_rules: quote.penalty.isDraftRules,
      paid_amount: quote.paidAmount,
      penalty_standard: quote.penalty.standardPenalty,
      penalty_contract: quote.penalty.contractPenalty,
      status: "requested",
    })
    .select("id")
    .maybeSingle();

  if (error || !created) {
    return failure(500, "CANCEL_CREATE_FAILED", "해지 요청을 남기지 못했습니다.");
  }

  const cancellationId = (created as { id: string }).id;

  await recordEvent({
    entityType: "contract_cancellation",
    entityId: cancellationId,
    eventType: "cancellation_requested",
    actor: { id: input.actorId, role: input.side },
    afterState: "requested",
    // 사유 코드·금액·구간만. 보충 설명 원문은 넣지 않는다(§7.3).
    memo: `reason=${input.reasonCode} claim=${input.claim} band=${quote.penalty.bandCode} paid=${quote.paidAmount}`,
  });

  await notify(context, "contract.cancel_requested", { cancellationId });

  return { cancellationId };
}

// =============================================================================
// 양측 확인
// =============================================================================

export async function confirmCancellation(input: {
  cancellationId: string;
  side: "couple" | "vendor";
  agreed: boolean;
  claim: FaultParty;
  actorId: string;
  now?: Date;
}): Promise<{ status: string; settled: boolean } | CancellationFailure> {
  const admin = createAdminClient();
  const now = input.now ?? new Date();

  const { data } = await admin
    .from("contract_cancellations")
    .select(
      "id, booking_id, status, couple_claim, vendor_claim, couple_agreed, vendor_agreed, confirm_due_at",
    )
    .eq("id", input.cancellationId)
    .maybeSingle();

  const row = data as {
    id: string;
    booking_id: string;
    status: string;
    couple_claim: FaultParty | null;
    vendor_claim: FaultParty | null;
    couple_agreed: boolean | null;
    vendor_agreed: boolean | null;
    confirm_due_at: string | null;
  } | null;

  if (!row) return failure(404, "CANCEL_NOT_FOUND", "해지 절차를 찾을 수 없습니다.");

  if (row.status !== "requested") {
    return failure(422, "CANCEL_NOT_CONFIRMABLE", `이미 ${row.status} 상태예요.`);
  }

  const coupleAgreed = input.side === "couple" ? input.agreed : row.couple_agreed;
  const vendorAgreed = input.side === "vendor" ? input.agreed : row.vendor_agreed;
  const coupleClaim = input.side === "couple" ? input.claim : row.couple_claim;
  const vendorClaim = input.side === "vendor" ? input.claim : row.vendor_claim;

  const decision = confirmationDecision({
    coupleAgreed,
    vendorAgreed,
    dueAt: row.confirm_due_at,
    now,
  });

  const fault = resolveFault({ coupleClaim, vendorClaim });

  // **양측이 동의했는데 귀책 주장이 갈리면 그것도 불일치다.** "해지에는 동의하지만
  // 누구 잘못인지는 다르다" 는 상태이며, 그대로 정산하면 한쪽 주장이 이긴다.
  const nextStatus =
    decision === "agreed" ? (fault === "undecided" ? "disputed" : "agreed") : decision === "disputed" ? "disputed" : "requested";

  await admin
    .from("contract_cancellations")
    .update({
      couple_agreed: coupleAgreed,
      vendor_agreed: vendorAgreed,
      couple_claim: coupleClaim,
      vendor_claim: vendorClaim,
      fault: nextStatus === "agreed" ? fault : "undecided",
      status: nextStatus,
      disputed_at: nextStatus === "disputed" ? now.toISOString() : null,
    })
    .eq("id", row.id);

  await recordEvent({
    entityType: "contract_cancellation",
    entityId: row.id,
    eventType: "cancellation_confirmed",
    actor: { id: input.actorId, role: input.side },
    beforeState: row.status,
    afterState: nextStatus,
    memo: `side=${input.side} agreed=${input.agreed} claim=${input.claim} fault=${fault}`,
  });

  if (nextStatus !== "agreed") {
    return { status: nextStatus, settled: false };
  }

  const settled = await settleCancellationRecord({
    cancellationId: row.id,
    bookingId: row.booking_id,
    fault,
    actorId: input.actorId,
    now,
  });

  return { status: settled ? "settled" : "agreed", settled };
}

// =============================================================================
// 운영자 조율 (F-A-17)
// =============================================================================

export async function resolveCancellation(input: {
  cancellationId: string;
  adminId: string;
  decision: FaultParty;
  note: string;
  now?: Date;
}): Promise<{ status: string; settled: boolean } | CancellationFailure> {
  const admin = createAdminClient();
  const now = input.now ?? new Date();

  if (input.note.trim() === "") {
    return failure(422, "CANCEL_RESOLUTION_NOTE_REQUIRED", "조율 결과에는 사유가 필요합니다.");
  }

  const { data } = await admin
    .from("contract_cancellations")
    .select("id, booking_id, status")
    .eq("id", input.cancellationId)
    .maybeSingle();

  const row = data as { id: string; booking_id: string; status: string } | null;
  if (!row) return failure(404, "CANCEL_NOT_FOUND", "해지 절차를 찾을 수 없습니다.");

  if (row.status === "settled" || row.status === "withdrawn") {
    return failure(422, "CANCEL_CLOSED", "이미 종결된 절차예요.");
  }

  if (input.decision === "undecided") {
    return failure(422, "CANCEL_DECISION_REQUIRED", "귀책을 정해야 정산할 수 있어요.");
  }

  await admin
    .from("contract_cancellations")
    .update({
      admin_decision: input.decision,
      fault: input.decision,
      resolved_by: input.adminId,
      resolution_note: input.note.slice(0, 1000),
      status: "agreed",
      disputed_at: null,
    })
    .eq("id", row.id);

  await recordEvent({
    entityType: "contract_cancellation",
    entityId: row.id,
    eventType: "cancellation_resolved",
    actor: { id: input.adminId, role: "admin" },
    beforeState: row.status,
    afterState: "agreed",
    memo: `decision=${input.decision}`,
  });

  const settled = await settleCancellationRecord({
    cancellationId: row.id,
    bookingId: row.booking_id,
    fault: input.decision,
    actorId: input.adminId,
    now,
  });

  return { status: settled ? "settled" : "agreed", settled };
}

// =============================================================================
// 집행 — 돈이 먼저, 상태가 나중
// =============================================================================

async function settleCancellationRecord(input: {
  cancellationId: string;
  bookingId: string;
  fault: FaultParty;
  actorId: string;
  now: Date;
}): Promise<boolean> {
  const admin = createAdminClient();
  const context = await loadCancellationContext(input.bookingId);

  if (!context) return false;

  // **확정 시점에 다시 계산한다.** 요청 시점의 스냅샷은 미리보기였고, 그 사이 결제가
  // 하나 더 들어왔을 수 있다. 실제로 돌려줄 금액은 지금 낸 돈에서 나온다.
  const quote = await quoteCancellation({ context, fault: input.fault, now: input.now });
  const settlement = quote.settlement;

  if (!settlement.enforceable) return false;

  // ── 1) 환불 ───────────────────────────────────────────────────────────────
  const allocation = allocateRefund(context.payments, settlement.refundAmount);

  if (allocation.shortfall > 0) {
    // 배분하지 못한 금액을 삼키지 않는다. 조율로 보낸다 — 계산과 장부가 어긋난
    // 상태에서 일부만 돌려주면 나중에 무엇이 맞는지 알 수 없다.
    await admin
      .from("contract_cancellations")
      .update({ status: "disputed", disputed_at: input.now.toISOString() })
      .eq("id", input.cancellationId);

    await recordEvent({
      entityType: "contract_cancellation",
      entityId: input.cancellationId,
      eventType: "cancellation_refund_shortfall",
      actor: { id: input.actorId },
      afterState: "disputed",
      memo: `shortfall=${allocation.shortfall} refund=${settlement.refundAmount}`,
    });

    return false;
  }

  for (const line of allocation.lines) {
    await applyRefund({
      paymentId: line.paymentId,
      amount: line.amount,
      reason: `계약 해지 정산(${settlement.appliedRule})`.slice(0, 60),
      actorId: input.actorId,
      cancellationId: input.cancellationId,
    });
  }

  // ── 2) 계약·예약을 닫는다 ─────────────────────────────────────────────────
  // **회차(payment_schedules)는 건드리지 않는다.** 미납 회차를 void 로 만들면
  // 0028 의 비율 합 트리거가 "합이 10000bp 가 아니다" 로 커밋을 막는다(void 를 합에서
  // 빼기 때문이다). 그리고 건드릴 이유도 없다 — 계약이 `cancelled` 가 되는 순간
  // 0030 의 승인 트리거가 그 회차의 결제를 막는다.
  await admin
    .from("contracts")
    .update({
      status: "cancelled",
      cancelled_at: input.now.toISOString(),
      cancel_reason: `해지 정산 완료 · ${settlement.appliedRule}`.slice(0, 200),
    })
    .eq("id", context.contractId);

  // 예약을 취소하면 트리거가 자리를 되돌린다(0031).
  await admin.from("bookings").update({ status: "cancelled" }).eq("id", context.bookingId);

  // ── 3) 정산 되돌리기 ──────────────────────────────────────────────────────
  const reversal = await reversePlannerSettlement({
    bookingId: context.bookingId,
    cancellationId: input.cancellationId,
    actorId: input.actorId,
  });

  await admin
    .from("contract_cancellations")
    .update({
      status: "settled",
      settled_at: input.now.toISOString(),
      fault: input.fault,
      paid_amount: quote.paidAmount,
      penalty_standard: quote.penalty.standardPenalty,
      penalty_contract: quote.penalty.contractPenalty,
      penalty_applied: settlement.penaltyAmount,
      refund_amount: settlement.refundAmount,
      balance_due: settlement.balanceDue,
      band_code: quote.penalty.bandCode,
      band_label: quote.penalty.bandLabel,
      basis_ref: quote.penalty.basisRef,
      rule_version: quote.penalty.ruleVersion,
      is_draft_rules: quote.penalty.isDraftRules,
    })
    .eq("id", input.cancellationId);

  await recordEvent({
    entityType: "contract_cancellation",
    entityId: input.cancellationId,
    eventType: "cancellation_settled",
    actor: { id: input.actorId },
    beforeState: "agreed",
    afterState: "settled",
    memo: `fault=${input.fault} penalty=${settlement.penaltyAmount} refund=${settlement.refundAmount} due=${settlement.balanceDue} plannerReversal=${reversal}`,
  });

  await notify(context, "contract.cancel_settled", { cancellationId: input.cancellationId });

  return true;
}

/**
 * 플래너 수수료 되돌리기.
 *
 * **이미 지급된 것은 코드가 회수하지 않는다.** 계좌로 나간 돈을 자동으로 되가져올
 * 방법이 없고, 상계할 다음 지급이 있을지도 코드가 알 수 없다. 회수 대상이라는 사실을
 * 증적으로 남기고 조율로 넘긴다(D-24 — 플랫폼은 조율자다).
 */
async function reversePlannerSettlement(input: {
  bookingId: string;
  cancellationId: string;
  actorId: string;
}): Promise<string> {
  const admin = createAdminClient();

  const { data } = await admin
    .from("planner_settlements")
    .select("id, status")
    .eq("booking_id", input.bookingId)
    .maybeSingle();

  const row = data as { id: string; status: string } | null;

  // 업체 정산서는 만드는 경로가 아직 없다(S5-07). 있으면 조율로 보낸다 —
  // 확정된 정산서를 소급 수정하면 "언제 얼마를 정산했는가" 가 재현되지 않는다.
  const { count } = await admin
    .from("settlement_items")
    .select("id", { count: "exact", head: true })
    .eq("booking_id", input.bookingId);

  const reversal = settlementReversal({
    plannerSettlementStatus: (row?.status as "earned" | "payable" | "paid" | null) ?? null,
    vendorSettlementLinked: (count ?? 0) > 0,
  });

  if (row && reversal.planner === "void") {
    await admin.from("planner_settlements").update({ status: "void" }).eq("id", row.id);

    await recordEvent({
      entityType: "planner_settlement",
      entityId: row.id,
      eventType: "planner_settlement_voided",
      actor: { id: input.actorId },
      beforeState: row.status,
      afterState: "void",
      memo: `cancellation=${input.cancellationId}`,
    });
  }

  if (reversal.needsOperator) {
    await recordEvent({
      entityType: "contract_cancellation",
      entityId: input.cancellationId,
      eventType: "cancellation_settlement_recovery_needed",
      actor: { id: input.actorId },
      memo: `planner=${reversal.planner} vendorSettlement=${reversal.vendorSettlementLinked}`,
    });
  }

  return reversal.planner;
}

// =============================================================================
// 알림 — 토픽은 `contract` 다 (DB CHECK 에 이미 있다)
// =============================================================================

async function notify(
  context: CancellationContext,
  templateKey: "contract.cancel_requested" | "contract.cancel_settled",
  params: Record<string, unknown>,
): Promise<void> {
  await sendNotification({
    userId: context.ownerId,
    topic: "contract",
    channel: "in_app",
    templateKey,
    // 참조만. 금액·사유는 담지 않는다(§7.3).
    params,
    dedupeKey: `${templateKey}:${String(params.cancellationId)}`,
  });
}
