import { recordEvent } from "@/lib/audit/record";
import type { DepositAction } from "@/lib/core/consultation/consultation";
import { createAdminClient } from "@/lib/supabase/admin";

import {
  canRetryPayment,
  resolveDepositAdapterName,
  type DepositAdapter,
} from "./adapter";
import { createNoopDepositAdapter, createStubDepositAdapter } from "./stub";

/**
 * 보증금 보관·해제 (S4-08 골격 · D-22 · D-24 · §3.9)
 *
 * ── 순서가 곧 설계다 (S4-13 의 `sendNotification` 과 같은 구조) ──────────────
 *  1. **행을 먼저 만든다** — `idempotency_key` 유니크가 동시 실행을 막는 지점이
 *     여기다. 결제하고 나서 기록하면 두 프로세스가 둘 다 결제한 뒤에야 충돌을 안다.
 *  2. **어댑터를 부른다** — 결과에 따라 `held`·`failed` 로 옮긴다.
 *  3. **실패도 기록한다** — 조용히 사라지면 "왜 확정이 안 됐나" 를 답할 수 없다.
 *
 * **서비스롤로 쓴다.** §3.9 가 "상태 변경은 서비스롤 전용" 이라 못박았고, 0025 가
 * `consultation_deposits` 의 쓰기 권한을 회수했다. 돈의 상태를 당사자가 바꿀 수
 * 있으면 그것은 보관이 아니다.
 */
function adapter(): DepositAdapter {
  return resolveDepositAdapterName() === "stub"
    ? createStubDepositAdapter()
    : createNoopDepositAdapter();
}

export type HoldResult =
  | { status: "held"; depositId: string }
  | { status: "duplicate"; depositId: string }
  | { status: "failed"; depositId: string | null; reason: string; retryable: boolean }
  /** 이 유형은 보증금을 받지 않는다. 실패가 아니다. */
  | { status: "not_required" };

/**
 * 보증금을 잡아 둔다.
 *
 * @param amount `app_settings.consultation.deposit_amount`. **코드가 정하지 않는다.**
 *               null 이면 금액이 설정되지 않은 것이고, 그때는 보증금 없이 진행한다 —
 *               금액을 지어내 청구할 수는 없다.
 */
export async function holdDeposit(input: {
  consultationId: string;
  amount: number | null;
  currency: string;
  idempotencyKey: string;
  actorId: string;
}): Promise<HoldResult> {
  if (input.amount === null || input.amount <= 0) return { status: "not_required" };

  const admin = createAdminClient();

  // 이미 같은 열쇠로 처리된 것이 있으면 그대로 돌려준다(멱등).
  const { data: existing } = await admin
    .from("consultation_deposits")
    .select("id, status")
    .eq("idempotency_key", input.idempotencyKey)
    .maybeSingle();

  if (existing) {
    const row = existing as { id: string; status: string };

    return row.status === "held"
      ? { status: "duplicate", depositId: row.id }
      : { status: "failed", depositId: row.id, reason: "이전 결제가 완료되지 않았습니다.", retryable: true };
  }

  // 상담당 보증금은 하나다(UNIQUE). 이미 보관 중이면 다시 잡지 않는다.
  const { data: prior } = await admin
    .from("consultation_deposits")
    .select("id, status, attempt_count")
    .eq("consultation_id", input.consultationId)
    .maybeSingle();

  const priorRow = prior as { id: string; status: string; attempt_count: number } | null;

  if (priorRow && priorRow.status === "held") {
    return { status: "duplicate", depositId: priorRow.id };
  }

  if (priorRow && !canRetryPayment(priorRow.attempt_count)) {
    return {
      status: "failed",
      depositId: priorRow.id,
      reason: "결제 시도 횟수를 넘었습니다. 고객센터로 문의해 주세요.",
      retryable: false,
    };
  }

  // ── 1) 행을 먼저 만든다(또는 재시도로 갱신한다) ──────────────────────────
  const pendingPatch = {
    consultation_id: input.consultationId,
    amount: input.amount,
    currency: input.currency,
    status: "pending",
    idempotency_key: input.idempotencyKey,
    attempt_count: (priorRow?.attempt_count ?? 0) + 1,
    failure_reason: null,
    provider: adapter().name,
  };

  const { data: created, error: createError } = priorRow
    ? await admin
        .from("consultation_deposits")
        .update(pendingPatch)
        .eq("id", priorRow.id)
        .select("id")
        .maybeSingle()
    : await admin.from("consultation_deposits").insert(pendingPatch).select("id").maybeSingle();

  if (createError || !created) {
    return {
      status: "failed",
      depositId: null,
      reason: "보증금 기록을 만들지 못했습니다.",
      retryable: true,
    };
  }

  const depositId = (created as { id: string }).id;

  // ── 2) 어댑터 호출 ────────────────────────────────────────────────────────
  const result = await adapter().hold({
    consultationId: input.consultationId,
    amount: input.amount,
    currency: input.currency,
    idempotencyKey: input.idempotencyKey,
  });

  if (!result.ok) {
    await admin
      .from("consultation_deposits")
      .update({ status: "failed", failure_reason: result.failureReason })
      .eq("id", depositId);

    await recordEvent({
      entityType: "consultation_deposit",
      entityId: depositId,
      eventType: "deposit_hold_failed",
      actor: { id: input.actorId },
      afterState: "failed",
      // 금액은 남긴다 — 개인정보가 아니고 분쟁에서 "얼마를 잡으려 했나" 가 쟁점이 된다.
      memo: `amount=${input.amount} retryable=${result.retryable}`,
    });

    return {
      status: "failed",
      depositId,
      reason: result.failureReason,
      retryable: result.retryable,
    };
  }

  const now = new Date().toISOString();

  await admin
    .from("consultation_deposits")
    .update({
      status: "held",
      held_at: now,
      provider_ref: result.providerRef,
      failure_reason: null,
    })
    .eq("id", depositId);

  await recordEvent({
    entityType: "consultation_deposit",
    entityId: depositId,
    eventType: "deposit_held",
    actor: { id: input.actorId },
    afterState: "held",
    memo: `amount=${input.amount}`,
  });

  return { status: "held", depositId };
}

/**
 * 보증금을 푼다 — 환불 또는 지급(몰취).
 *
 * **사유 없이 풀 수 없다.** 0025 의 CHECK 가 종결 상태에 `resolution_reason` 을
 * 요구하고, 그 사유는 §3.11 규칙이 정한 코드다. 플랫폼이 재량으로 정하는 값이
 * 아님을 기록으로 남기기 위해서다(D-24 중개자 지위).
 */
export async function releaseDeposit(input: {
  consultationId: string;
  action: Exclude<DepositAction, "dispute">;
  reason: string;
  actorId: string | null;
}): Promise<{ status: "released" | "skipped" | "failed"; reason?: string }> {
  const admin = createAdminClient();

  const { data } = await admin
    .from("consultation_deposits")
    .select("id, status, amount, provider_ref")
    .eq("consultation_id", input.consultationId)
    .maybeSingle();

  const deposit = data as {
    id: string;
    status: string;
    amount: number;
    provider_ref: string | null;
  } | null;

  // 보증금이 없거나(전화·화상) 이미 종결된 건이면 할 일이 없다.
  if (!deposit) return { status: "skipped", reason: "보증금이 없는 예약입니다." };
  if (deposit.status !== "held" && deposit.status !== "disputed") {
    return { status: "skipped", reason: `이미 ${deposit.status} 상태입니다.` };
  }

  const nextStatus = input.action === "refund" ? "refunded" : "forfeited";
  // 같은 건을 두 번 풀지 않는다. 결과 상태를 열쇠에 넣어 환불·몰취가 서로를 막지 않게 한다.
  const idempotencyKey = `deposit:${deposit.id}:${nextStatus}`;

  const result = await adapter().release({
    consultationId: input.consultationId,
    providerRef: deposit.provider_ref ?? "",
    amount: deposit.amount,
    direction: input.action,
    idempotencyKey,
  });

  if (!result.ok) {
    // **상태를 바꾸지 않는다.** 실패했는데 refunded 로 적으면 있지도 않은 환불이
    // 기록되고, 그 기록이 분쟁의 근거가 된다.
    await admin
      .from("consultation_deposits")
      .update({ failure_reason: result.failureReason })
      .eq("id", deposit.id);

    await recordEvent({
      entityType: "consultation_deposit",
      entityId: deposit.id,
      eventType: "deposit_release_failed",
      actor: { id: input.actorId ?? "00000000-0000-0000-0000-000000000000" },
      beforeState: deposit.status,
      memo: `action=${input.action} retryable=${result.retryable}`,
    });

    return { status: "failed", reason: result.failureReason };
  }

  await admin
    .from("consultation_deposits")
    .update({
      status: nextStatus,
      resolved_at: new Date().toISOString(),
      resolution_reason: input.reason,
      resolved_by: input.actorId,
      provider_ref: result.providerRef,
      failure_reason: null,
    })
    .eq("id", deposit.id);

  await recordEvent({
    entityType: "consultation_deposit",
    entityId: deposit.id,
    eventType: input.action === "refund" ? "deposit_refunded" : "deposit_forfeited",
    actor: { id: input.actorId ?? "00000000-0000-0000-0000-000000000000" },
    beforeState: deposit.status,
    afterState: nextStatus,
    // 사유 코드를 남긴다 — 왜 그렇게 처리했는지가 곧 조율의 근거다(§3.11 4번).
    memo: input.reason.slice(0, 200),
  });

  return { status: "released" };
}

/** 조율 대기로 옮긴다. 돈은 그대로 잡아 둔 채 상태만 바꾼다. */
export async function disputeDeposit(input: {
  consultationId: string;
  reason: string;
}): Promise<void> {
  const admin = createAdminClient();

  const { data } = await admin
    .from("consultation_deposits")
    .select("id, status")
    .eq("consultation_id", input.consultationId)
    .maybeSingle();

  const deposit = data as { id: string; status: string } | null;
  if (!deposit || deposit.status !== "held") return;

  await admin
    .from("consultation_deposits")
    .update({ status: "disputed" })
    .eq("id", deposit.id);

  await recordEvent({
    entityType: "consultation_deposit",
    entityId: deposit.id,
    eventType: "deposit_disputed",
    actor: { id: "00000000-0000-0000-0000-000000000000" },
    beforeState: "held",
    afterState: "disputed",
    memo: input.reason.slice(0, 200),
  });
}
