import { readIntSetting, readSetting } from "@/lib/app-settings";
import { recordEvent } from "@/lib/audit/record";
import { confirmDueAt } from "@/lib/core/confirmation/two-sided";
import {
  buildReleaseCondition,
  canTransition,
  decideRelease,
  isEscrowTarget,
  type EscrowStatus,
} from "@/lib/core/escrow/escrow";
import { sendNotification } from "@/lib/notify/send";
import { createAdminClient } from "@/lib/supabase/admin";

import { resolveEscrowAdapterName, type EscrowAdapter } from "./adapter";
import { createNoopEscrowAdapter, createStubEscrowAdapter } from "./stub";

/**
 * 에스크로 절차 (S5-09 · F-C-16 · §4.2 · D-21 · D-23 · D-24 · D-28 · O-03)
 *
 * ── 플랫폼은 보관자다 (D-24) ────────────────────────────────────────────────
 * 이 파일은 **양측이 합의한 조건을 기록하고 그 조건대로 집행**한다. 한쪽의 요청만으로
 * 상대의 돈을 움직이지 않는다 — 이의가 들어오면 즉시 조율로 가고, 조율 결과에는
 * 사유가 반드시 붙는다(DB CHECK 도 같은 것을 요구한다).
 *
 * ── 실예치는 두 층을 지나야 한다 ────────────────────────────────────────────
 *  1. `app_settings.escrow.enabled` — **O-03 대기라 지금은 false** 다.
 *  2. 어댑터 — 프로덕션에서 스텁은 거부되고 기본값은 실패를 돌려주는 `noop` 이다.
 * 둘 다 통과해야 실제로 돈이 움직인다. 그 전까지는 **절차와 기록**이 돈다.
 *
 * ── 서비스롤로 쓴다 ─────────────────────────────────────────────────────────
 * `escrow_holds` 에 쓰기 정책이 없다(0035). 당사자가 쓸 수 있으면 **스스로 이행을
 * 확인하고 릴리즈**할 수 있다.
 */
function adapter(): EscrowAdapter {
  return resolveEscrowAdapterName() === "stub"
    ? createStubEscrowAdapter()
    : createNoopEscrowAdapter();
}

export type EscrowFailure = { status: number; code: string; message: string };

function failure(status: number, code: string, message: string): EscrowFailure {
  return { status, code, message };
}

export function isEscrowFailure(value: unknown): value is EscrowFailure {
  return typeof value === "object" && value !== null && "code" in value && "status" in value;
}

/** 실예치가 켜져 있는가. **O-03 대기 동안 false** 이며 그때도 절차는 돈다. */
async function escrowEnabled(): Promise<boolean> {
  return (await readSetting("escrow.enabled"))?.enabled === true;
}

// =============================================================================
// 예치 — 잔금 결제 뒤에 걸린다
// =============================================================================

export type HoldOutcome =
  | { status: "held"; holdId: string; simulated: boolean }
  | { status: "skipped"; reason: "not_target" | "already_held" }
  | { status: "failed"; reason: string; retryable: boolean };

/**
 * 잔금 회차를 안전거래로 맡는다.
 *
 * **결제 성공 경로가 부른다**(S5-06 `chargeInstallment`). 예치가 실패해도 **결제를
 * 되돌리지 않는다** — 고객은 이미 냈고, 되돌리면 그 돈이 어디에도 없는 상태가 된다.
 * 실패는 기록으로 남기고 운영이 본다(S4-13 이 알림에서 세운 "적재 실패가 본 작업을
 * 깨뜨리지 않는다" 와 같은 판단).
 */
export async function holdEscrow(input: {
  scheduleId: string;
  paymentId: string;
  actorId: string;
  now?: Date;
}): Promise<HoldOutcome> {
  const admin = createAdminClient();
  const now = input.now ?? new Date();

  const { data: scheduleRow } = await admin
    .from("payment_schedules")
    .select("id, seq, amount, contract_id")
    .eq("id", input.scheduleId)
    .maybeSingle();

  const schedule = scheduleRow as {
    id: string;
    seq: number;
    amount: number;
    contract_id: string;
  } | null;

  if (!schedule) return { status: "skipped", reason: "not_target" };

  const { data: paymentRow } = await admin
    .from("payments")
    .select("id, booking_id, amount, purpose")
    .eq("id", input.paymentId)
    .maybeSingle();

  const payment = paymentRow as {
    booking_id: string | null;
    amount: number;
    purpose: string;
  } | null;

  if (!payment?.booking_id) return { status: "skipped", reason: "not_target" };

  // **잔금만 맡는다**(F-C-16 · 근거는 lib/core/escrow 주석).
  if (!isEscrowTarget({ seq: schedule.seq, purpose: payment.purpose })) {
    return { status: "skipped", reason: "not_target" };
  }

  const { data: existing } = await admin
    .from("escrow_holds")
    .select("id")
    .eq("payment_schedule_id", schedule.id)
    .maybeSingle();

  if (existing) return { status: "skipped", reason: "already_held" };

  const dueDays = await readIntSetting("escrow.confirm_due_days", "days");
  const enabled = await escrowEnabled();
  const idempotencyKey = `escrow:${schedule.id}:hold`;

  // 실예치가 꺼져 있으면 어댑터를 부르지 않는다 — 절차만 기록한다(O-03).
  let providerRef: string | null = null;
  let provider = "none";

  if (enabled) {
    const result = await adapter().hold({
      bookingId: payment.booking_id,
      paymentId: input.paymentId,
      amount: payment.amount,
      currency: "KRW",
      idempotencyKey,
    });

    if (!result.ok) {
      await recordEvent({
        entityType: "payment",
        entityId: input.paymentId,
        eventType: "escrow_hold_failed",
        actor: { id: input.actorId },
        memo: `amount=${payment.amount} retryable=${result.retryable}`,
      });

      return { status: "failed", reason: result.failureReason, retryable: result.retryable };
    }

    providerRef = result.providerRef;
    provider = adapter().name;
  }

  const { data: created, error } = await admin
    .from("escrow_holds")
    .insert({
      payment_id: input.paymentId,
      booking_id: payment.booking_id,
      payment_schedule_id: schedule.id,
      held_amount: payment.amount,
      // **조건을 스냅샷으로 박는다**(D-23). 규칙이 바뀌어도 이 건은 재현된다.
      release_condition: buildReleaseCondition(dueDays),
      status: "held",
      held_at: now.toISOString(),
      confirm_due_at: confirmDueAt(now, dueDays),
      provider,
      provider_ref: providerRef,
      idempotency_key: idempotencyKey,
    })
    .select("id")
    .maybeSingle();

  if (error || !created) {
    return { status: "failed", reason: "안전거래 기록을 만들지 못했습니다.", retryable: true };
  }

  const holdId = (created as { id: string }).id;

  await recordEvent({
    entityType: "escrow_hold",
    entityId: holdId,
    eventType: "escrow_held",
    actor: { id: input.actorId },
    afterState: "held",
    // 금액·회차·실예치 여부만. 이행 내용 서술은 넣지 않는다(§7.3).
    memo: `seq=${schedule.seq} amount=${payment.amount} enabled=${enabled}`,
  });

  await notifyCouple(payment.booking_id, "escrow.held", { holdId });

  return { status: "held", holdId, simulated: !enabled };
}

// =============================================================================
// 이행 확인 — 판정은 순수 함수가 한다
// =============================================================================

export type ConfirmOutcome = {
  status: EscrowStatus;
  action: "hold" | "release" | "dispute";
  detail: string;
};

export async function confirmFulfillment(input: {
  holdId: string;
  side: "couple" | "vendor";
  confirmed: boolean;
  actorId: string;
  now?: Date;
}): Promise<ConfirmOutcome | EscrowFailure> {
  const admin = createAdminClient();
  const now = input.now ?? new Date();

  const hold = await loadHold(input.holdId);
  if (!hold) return failure(404, "ESCROW_NOT_FOUND", "안전거래 기록을 찾을 수 없습니다.");

  if (hold.status !== "held") {
    return failure(422, "ESCROW_NOT_CONFIRMABLE", `이미 ${hold.status} 상태예요.`);
  }

  const coupleConfirmed = input.side === "couple" ? input.confirmed : hold.coupleConfirmed;
  const vendorConfirmed = input.side === "vendor" ? input.confirmed : hold.vendorConfirmed;

  const patch: Record<string, unknown> =
    input.side === "couple"
      ? { couple_confirmed: input.confirmed, couple_confirmed_at: now.toISOString() }
      : { vendor_confirmed: input.confirmed, vendor_confirmed_at: now.toISOString() };

  const decision = decideRelease({
    coupleConfirmed,
    vendorConfirmed,
    dueAt: hold.confirmDueAt,
    eventDate: hold.eventDate,
    now,
  });

  await admin.from("escrow_holds").update(patch).eq("id", hold.id);

  await recordEvent({
    entityType: "escrow_hold",
    entityId: hold.id,
    eventType: "escrow_confirmed",
    actor: { id: input.actorId, role: input.side },
    memo: `side=${input.side} confirmed=${input.confirmed} action=${decision.action}`,
  });

  if (decision.action === "dispute") {
    await moveToDisputed(hold.id, now, input.actorId);

    return { status: "disputed", action: "dispute", detail: decision.detail };
  }

  if (decision.action === "release") {
    const released = await settleHold({
      hold,
      direction: "release",
      reason: decision.reason === "agreed" ? "양측 이행 확인" : "확인 기한 경과",
      actorId: input.actorId,
      now,
    });

    return released
      ? { status: "released", action: "release", detail: decision.detail }
      : { status: "held", action: "hold", detail: "릴리즈를 처리하지 못했습니다. 잠시 후 다시 시도합니다." };
  }

  return { status: "held", action: "hold", detail: decision.detail };
}

// =============================================================================
// 조율 — 결과에는 사유가 붙는다 (D-24)
// =============================================================================

export async function resolveEscrow(input: {
  holdId: string;
  direction: "release" | "refund";
  note: string;
  adminId: string;
  now?: Date;
}): Promise<{ status: EscrowStatus } | EscrowFailure> {
  const now = input.now ?? new Date();

  if (input.note.trim() === "") {
    return failure(422, "ESCROW_NOTE_REQUIRED", "조율 결과에는 사유가 필요합니다.");
  }

  const hold = await loadHold(input.holdId);
  if (!hold) return failure(404, "ESCROW_NOT_FOUND", "안전거래 기록을 찾을 수 없습니다.");

  const target: EscrowStatus = input.direction === "release" ? "released" : "refunded";

  if (!canTransition(hold.status, target)) {
    return failure(422, "ESCROW_TRANSITION_BLOCKED", "이미 종결된 안전거래는 되돌릴 수 없어요.");
  }

  const done = await settleHold({
    hold,
    direction: input.direction,
    reason: input.note,
    actorId: input.adminId,
    resolvedBy: input.adminId,
    now,
  });

  if (!done) return failure(502, "ESCROW_SETTLE_FAILED", "안전거래를 처리하지 못했습니다.");

  return { status: target };
}

// =============================================================================
// 내부 — 보관 해제
// =============================================================================

type HoldRow = {
  id: string;
  bookingId: string;
  status: EscrowStatus;
  heldAmount: number;
  providerRef: string | null;
  confirmDueAt: string | null;
  coupleConfirmed: boolean | null;
  vendorConfirmed: boolean | null;
  eventDate: string | null;
};

async function loadHold(holdId: string): Promise<HoldRow | null> {
  const admin = createAdminClient();

  const { data } = await admin
    .from("escrow_holds")
    .select(
      "id, booking_id, status, held_amount, provider_ref, confirm_due_at, couple_confirmed, vendor_confirmed",
    )
    .eq("id", holdId)
    .maybeSingle();

  const row = data as Record<string, unknown> | null;
  if (!row?.booking_id) return null;

  const { data: bookingRow } = await admin
    .from("bookings")
    .select("couple_id")
    .eq("id", row.booking_id as string)
    .maybeSingle();

  const coupleId = (bookingRow as { couple_id: string } | null)?.couple_id ?? null;

  const { data: coupleRow } = coupleId
    ? await admin.from("couples").select("wedding_date").eq("id", coupleId).maybeSingle()
    : { data: null };

  return {
    id: row.id as string,
    bookingId: row.booking_id as string,
    status: row.status as EscrowStatus,
    heldAmount: row.held_amount as number,
    providerRef: (row.provider_ref as string | null) ?? null,
    confirmDueAt: (row.confirm_due_at as string | null) ?? null,
    coupleConfirmed: (row.couple_confirmed as boolean | null) ?? null,
    vendorConfirmed: (row.vendor_confirmed as boolean | null) ?? null,
    eventDate: (coupleRow as { wedding_date: string | null } | null)?.wedding_date ?? null,
  };
}

async function moveToDisputed(holdId: string, now: Date, actorId: string): Promise<void> {
  const admin = createAdminClient();

  await admin
    .from("escrow_holds")
    .update({ status: "disputed", disputed_at: now.toISOString() })
    .eq("id", holdId);

  await recordEvent({
    entityType: "escrow_hold",
    entityId: holdId,
    eventType: "escrow_disputed",
    actor: { id: actorId },
    beforeState: "held",
    afterState: "disputed",
  });
}

/**
 * 보관을 푼다.
 *
 * **어댑터가 실패하면 상태를 바꾸지 않는다.** 풀지 못했는데 `released` 로 적으면
 * 있지도 않은 지급이 기록되고, 그 기록이 정산으로 흘러간다(S4-08·S5-06 과 같은 판단).
 */
async function settleHold(input: {
  hold: HoldRow;
  direction: "release" | "refund";
  reason: string;
  actorId: string;
  resolvedBy?: string;
  now: Date;
}): Promise<boolean> {
  const admin = createAdminClient();
  const enabled = await escrowEnabled();

  if (enabled) {
    const result = await adapter().settle({
      providerRef: input.hold.providerRef ?? "",
      amount: input.hold.heldAmount,
      direction: input.direction,
      idempotencyKey: `escrow:${input.hold.id}:${input.direction}`,
      reason: input.reason,
    });

    if (!result.ok) {
      await recordEvent({
        entityType: "escrow_hold",
        entityId: input.hold.id,
        eventType: "escrow_settle_failed",
        actor: { id: input.actorId },
        memo: `direction=${input.direction} retryable=${result.retryable}`,
      });

      return false;
    }
  }

  const stamp = input.now.toISOString();

  const { error } = await admin
    .from("escrow_holds")
    .update(
      input.direction === "release"
        ? {
            status: "released",
            released_at: stamp,
            release_reason: input.reason.slice(0, 200),
            resolved_by: input.resolvedBy ?? null,
            resolution_note: input.resolvedBy ? input.reason.slice(0, 500) : null,
          }
        : {
            status: "refunded",
            refunded_at: stamp,
            release_reason: input.reason.slice(0, 200),
            resolved_by: input.resolvedBy ?? null,
            resolution_note: input.resolvedBy ? input.reason.slice(0, 500) : null,
          },
    )
    .eq("id", input.hold.id);

  if (error) return false;

  await recordEvent({
    entityType: "escrow_hold",
    entityId: input.hold.id,
    eventType: input.direction === "release" ? "escrow_released" : "escrow_refunded",
    actor: { id: input.actorId },
    beforeState: input.hold.status,
    afterState: input.direction === "release" ? "released" : "refunded",
    memo: `amount=${input.hold.heldAmount} reason=${input.reason.slice(0, 60)}`,
  });

  await notifyCouple(
    input.hold.bookingId,
    input.direction === "release" ? "escrow.released" : "escrow.refunded",
    { holdId: input.hold.id },
  );

  if (input.direction === "release") await notifyVendor(input.hold.bookingId, input.hold.id);

  return true;
}

// =============================================================================
// 알림 — 토픽을 늘리지 않았다 (0035 근거 7)
// =============================================================================

async function notifyCouple(
  bookingId: string,
  templateKey: "escrow.held" | "escrow.released" | "escrow.refunded",
  params: Record<string, unknown>,
): Promise<void> {
  const admin = createAdminClient();

  const { data: bookingRow } = await admin
    .from("bookings")
    .select("couple_id")
    .eq("id", bookingId)
    .maybeSingle();

  const coupleId = (bookingRow as { couple_id: string } | null)?.couple_id ?? null;
  if (!coupleId) return;

  const { data: coupleRow } = await admin
    .from("couples")
    .select("owner_id")
    .eq("id", coupleId)
    .maybeSingle();

  const ownerId = (coupleRow as { owner_id: string } | null)?.owner_id ?? null;
  if (!ownerId) return;

  await sendNotification({
    userId: ownerId,
    // 고객에게 에스크로는 **결제한 돈의 상태**다. 토픽을 늘리지 않는다.
    topic: "payment",
    channel: "in_app",
    templateKey,
    params,
    dedupeKey: `${templateKey}:${String(params.holdId)}`,
  });
}

async function notifyVendor(bookingId: string, holdId: string): Promise<void> {
  const admin = createAdminClient();

  const { data: bookingRow } = await admin
    .from("bookings")
    .select("vendor_id")
    .eq("id", bookingId)
    .maybeSingle();

  const vendorId = (bookingRow as { vendor_id: string } | null)?.vendor_id ?? null;
  if (!vendorId) return;

  const { data } = await admin
    .from("vendor_members")
    .select("user_id")
    .eq("vendor_id", vendorId);

  for (const row of (data ?? []) as { user_id: string }[]) {
    await sendNotification({
      userId: row.user_id,
      // 업체에게 릴리즈는 **정산으로 가는 사건**이다.
      topic: "settlement",
      channel: "in_app",
      templateKey: "escrow.released_vendor",
      params: { holdId },
      dedupeKey: `escrow.released_vendor:${holdId}:${row.user_id}`,
    });
  }
}
