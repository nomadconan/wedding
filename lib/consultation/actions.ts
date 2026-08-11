import { recordEvent } from "@/lib/audit/record";
import {
  cancelVerdict,
  confirmDueAt,
  requiresDeposit,
  resolveVerdict,
  slotsForDate,
  type ConsultationOutcome,
  type ConsultationType,
  type Verdict,
} from "@/lib/core/consultation/consultation";
import { disputeDeposit, holdDeposit, releaseDeposit } from "@/lib/payments/deposit";
import { createAdminClient } from "@/lib/supabase/admin";

import { loadAvailability, loadConsultationSettings, loadTakenSlots } from "./loader";
import { notifyConsultation } from "./notify";

/**
 * 상담·탐방 쓰기 (S4-07 · S4-08 골격 · S4-09)
 *
 * ── 어떤 손으로 쓰는가 ──────────────────────────────────────────────────────
 * 신청·승인·거절·취소·이행 확인은 **세션 클라이언트**다(0025 정책이 경계).
 * 보증금과 **판정 결과**만 서비스롤이다 — §3.9 가 "보증금 상태 변경은 서비스롤
 * 전용" 이라 했고, `outcome`·`confirm_due_at` 은 당사자의 주장이 아니라 서버의
 * 결론이라 0025 가 컬럼 권한에서 뺐다.
 *
 * ── 판정은 한 곳에서만 한다 ─────────────────────────────────────────────────
 * §3.11 의 규칙은 `lib/core/consultation` 의 순수 함수가 갖는다. 이 파일은 그
 * 결과를 DB 와 결제 어댑터에 옮길 뿐이다 — 판정이 화면·API·배치에 흩어지면
 * 셋이 서로 다른 답을 내는 날이 온다.
 */
type Client = Awaited<ReturnType<typeof import("@/lib/supabase/server").createClient>>;

export type ActionFailure = { status: number; code: string; message: string };

/** 한국 표준시. 업체가 등록한 "토요일 14:00" 은 이 오프셋의 시각이다. */
export const KST_OFFSET_MINUTES = 540;

// =============================================================================
// 신청 (고객)
// =============================================================================

export async function createConsultation(
  supabase: Client,
  input: {
    coupleId: string;
    vendorId: string;
    actorId: string;
    type: ConsultationType;
    scheduledAt: string;
    location: string | null;
    now: Date;
  },
): Promise<{ consultationId: string; requiresDeposit: boolean } | ActionFailure> {
  if (new Date(input.scheduledAt).getTime() <= input.now.getTime()) {
    return { status: 422, code: "CONSULTATION_PAST", message: "지난 시각으로는 신청할 수 없어요." };
  }

  // 승인된 업체에만 신청한다. 심사 중 업체는 아직 거래 상대가 아니다.
  const { data: vendor } = await supabase
    .from("vendors")
    .select("id")
    .eq("id", input.vendorId)
    .eq("status", "active")
    .maybeSingle();

  if (!vendor) {
    return {
      status: 422,
      code: "CONSULTATION_VENDOR_INACTIVE",
      message: "승인된 업체에만 상담을 신청할 수 있어요.",
    };
  }

  // ── 고른 시각이 **업체가 등록한 슬롯**인지 서버가 다시 본다 ────────────────
  // 화면이 슬롯 목록에서 고르게 하지만, 화면을 우회한 요청도 같은 규칙을 지나야 한다.
  const rules = await loadAvailability(supabase, input.vendorId);

  if (rules.length === 0) {
    return {
      status: 422,
      code: "CONSULTATION_NO_AVAILABILITY",
      message: "이 업체는 아직 상담 가능 시간을 등록하지 않았어요.",
    };
  }

  const date = localDate(input.scheduledAt);
  const slots = slotsForDate(rules, date, KST_OFFSET_MINUTES, []);
  const slot = slots.find(
    (item) => new Date(item.startsAt).getTime() === new Date(input.scheduledAt).getTime(),
  );

  if (!slot) {
    return {
      status: 422,
      code: "CONSULTATION_SLOT_INVALID",
      message: "업체가 등록한 가능 시간에서 골라 주세요.",
    };
  }

  const { data: created, error } = await supabase
    .from("consultations")
    .insert({
      couple_id: input.coupleId,
      vendor_id: input.vendorId,
      type: input.type,
      scheduled_at: input.scheduledAt,
      // **슬롯 길이는 업체가 등록한 값이다.** 클라이언트가 정하면 30분 슬롯을 5분으로
      // 신청해 자리를 쪼갤 수 있다.
      duration_minutes: slot.minutes,
      location: input.location,
      // ends_at 은 트리거가 채운다(0025).
      ends_at: input.scheduledAt,
    })
    .select("id")
    .maybeSingle();

  if (error || !created) {
    return { status: 403, code: "CONSULTATION_CREATE_FAILED", message: "신청하지 못했어요." };
  }

  const consultationId = (created as { id: string }).id;

  await recordEvent({
    entityType: "consultation",
    entityId: consultationId,
    eventType: "consultation_requested",
    actor: { id: input.actorId, role: "couple" },
    afterState: "requested",
    // 날짜·장소를 넣지 않는다(§7.3). 유형만으로 무슨 일이 있었는지 충분하다.
    memo: input.type,
  });

  await notifyConsultation({
    consultationId,
    templateKey: "schedule.requested",
    audience: "vendor",
  });

  return { consultationId, requiresDeposit: requiresDeposit(input.type) };
}

function localDate(iso: string): string {
  const shifted = new Date(new Date(iso).getTime() + KST_OFFSET_MINUTES * 60_000);

  return shifted.toISOString().slice(0, 10);
}

// =============================================================================
// 승인 · 거절 (업체)
// =============================================================================

export async function approveConsultation(
  supabase: Client,
  input: { consultationId: string; actorId: string },
): Promise<{ consultationId: string; requiresDeposit: boolean } | ActionFailure> {
  const { data: before } = await supabase
    .from("consultations")
    .select("id, type, status")
    .eq("id", input.consultationId)
    .maybeSingle();

  if (!before) {
    return { status: 404, code: "CONSULTATION_NOT_FOUND", message: "예약을 찾을 수 없어요." };
  }

  const row = before as { type: ConsultationType; status: string };

  if (row.status !== "requested") {
    return { status: 409, code: "CONSULTATION_NOT_REQUESTED", message: "이미 처리된 신청이에요." };
  }

  // 보증금이 필요 없는 유형(전화·화상)은 승인이 곧 확정이다 — 결제를 기다릴 이유가 없다.
  const needsDeposit = requiresDeposit(row.type);
  const nextStatus = needsDeposit ? "approved" : "confirmed";

  const { data, error } = await supabase
    .from("consultations")
    .update({ status: nextStatus, approved_at: new Date().toISOString() })
    .eq("id", input.consultationId)
    .eq("status", "requested")
    .select("id")
    .maybeSingle();

  // **슬롯 겹침은 여기서 DB 가 거절한다**(0025 EXCLUDE). 같은 시각에 두 신청을
  // 동시에 승인해도 하나만 통과한다 — 앱이 먼저 조회해 확인하는 방식은 경합에서 진다.
  if (error) {
    return {
      status: 409,
      code: "CONSULTATION_SLOT_TAKEN",
      message: "그 시각에 이미 확정된 예약이 있어요.",
    };
  }

  if (!data) {
    return { status: 409, code: "CONSULTATION_NOT_REQUESTED", message: "이미 처리된 신청이에요." };
  }

  await recordEvent({
    entityType: "consultation",
    entityId: input.consultationId,
    eventType: "consultation_approved",
    actor: { id: input.actorId, role: "vendor" },
    beforeState: "requested",
    afterState: nextStatus,
    memo: null,
  });

  await notifyConsultation({
    consultationId: input.consultationId,
    templateKey: needsDeposit ? "schedule.approved" : "schedule.confirmed",
    audience: "couple",
  });

  return { consultationId: input.consultationId, requiresDeposit: needsDeposit };
}

export async function rejectConsultation(
  supabase: Client,
  input: { consultationId: string; reason: string; actorId: string },
): Promise<{ consultationId: string } | ActionFailure> {
  const { data, error } = await supabase
    .from("consultations")
    .update({
      status: "rejected",
      rejected_at: new Date().toISOString(),
      reject_reason: input.reason,
    })
    .eq("id", input.consultationId)
    .eq("status", "requested")
    .select("id")
    .maybeSingle();

  if (error) {
    return { status: 403, code: "CONSULTATION_REJECT_FAILED", message: "처리하지 못했어요." };
  }

  if (!data) {
    return { status: 409, code: "CONSULTATION_NOT_REQUESTED", message: "이미 처리된 신청이에요." };
  }

  await recordEvent({
    entityType: "consultation",
    entityId: input.consultationId,
    eventType: "consultation_rejected",
    actor: { id: input.actorId, role: "vendor" },
    beforeState: "requested",
    afterState: "rejected",
    memo: null,
  });

  await notifyConsultation({
    consultationId: input.consultationId,
    templateKey: "schedule.rejected",
    audience: "couple",
  });

  return { consultationId: input.consultationId };
}

// =============================================================================
// 보증금 결제 → 확정
// =============================================================================

export async function payDeposit(
  supabase: Client,
  input: { consultationId: string; idempotencyKey: string; actorId: string },
  // 성공 반환에 `status` 를 쓰지 않는다 — ActionFailure.status 와 이름이 겹치면
  // 호출부의 `"status" in result` 판별이 무너진다(S4-12 에서 같은 것을 겪었다).
): Promise<{ consultationId: string; consultationStatus: string } | ActionFailure> {
  const { data } = await supabase
    .from("consultations")
    .select("id, type, status")
    .eq("id", input.consultationId)
    .maybeSingle();

  if (!data) {
    return { status: 404, code: "CONSULTATION_NOT_FOUND", message: "예약을 찾을 수 없어요." };
  }

  const row = data as { type: ConsultationType; status: string };

  if (row.status !== "approved") {
    return {
      status: 409,
      code: "CONSULTATION_NOT_APPROVED",
      message: "업체 승인 후에 보증금을 결제할 수 있어요.",
    };
  }

  if (!requiresDeposit(row.type)) {
    return {
      status: 422,
      code: "CONSULTATION_NO_DEPOSIT",
      message: "이 유형은 보증금을 받지 않아요.",
    };
  }

  const settings = await loadConsultationSettings();

  const held = await holdDeposit({
    consultationId: input.consultationId,
    amount: settings.depositAmount,
    currency: settings.currency,
    idempotencyKey: input.idempotencyKey,
    actorId: input.actorId,
  });

  if (held.status === "failed") {
    return { status: 402, code: "DEPOSIT_FAILED", message: held.reason };
  }

  // 보증금 대상이지만 금액이 설정되지 않았으면 보증금 없이 확정한다 —
  // 금액을 지어내 청구할 수는 없다.
  const { error } = await createAdminClient()
    .from("consultations")
    .update({ status: "confirmed" })
    .eq("id", input.consultationId)
    .eq("status", "approved");

  if (error) {
    return { status: 500, code: "CONSULTATION_CONFIRM_FAILED", message: "확정하지 못했어요." };
  }

  await recordEvent({
    entityType: "consultation",
    entityId: input.consultationId,
    eventType: "consultation_confirmed",
    actor: { id: input.actorId, role: "couple" },
    beforeState: "approved",
    afterState: "confirmed",
    memo: held.status === "not_required" ? "deposit_not_configured" : "deposit_held",
  });

  await notifyConsultation({
    consultationId: input.consultationId,
    templateKey: "schedule.confirmed",
    audience: "both",
  });

  return { consultationId: input.consultationId, consultationStatus: "confirmed" };
}

// =============================================================================
// 취소 (고객)
// =============================================================================

export async function cancelConsultation(
  supabase: Client,
  input: { consultationId: string; reason: string | null; actorId: string; now: Date },
): Promise<{ consultationId: string; verdict: Verdict } | ActionFailure> {
  const { data } = await supabase
    .from("consultations")
    .select("id, status, scheduled_at")
    .eq("id", input.consultationId)
    .maybeSingle();

  if (!data) {
    return { status: 404, code: "CONSULTATION_NOT_FOUND", message: "예약을 찾을 수 없어요." };
  }

  const row = data as { status: string; scheduled_at: string };

  if (!["requested", "approved", "confirmed"].includes(row.status)) {
    return { status: 409, code: "CONSULTATION_NOT_CANCELLABLE", message: "취소할 수 없는 예약이에요." };
  }

  const settings = await loadConsultationSettings();
  // **판정은 순수 함수가 한다.** 무료 여부를 클라이언트가 주장하지 않는다.
  const verdict = cancelVerdict(row.scheduled_at, input.now, settings.freeCancelHours);

  const { error } = await supabase
    .from("consultations")
    .update({
      status: "cancelled",
      cancelled_at: input.now.toISOString(),
      cancel_reason: input.reason,
      cancelled_by: input.actorId,
    })
    .eq("id", input.consultationId);

  if (error) {
    return { status: 403, code: "CONSULTATION_CANCEL_FAILED", message: "취소하지 못했어요." };
  }

  // 확정 전이면 잡아 둔 보증금이 없다. `releaseDeposit` 이 알아서 건너뛴다.
  await releaseDeposit({
    consultationId: input.consultationId,
    action: verdict.deposit === "forfeit" ? "forfeit" : "refund",
    reason: verdict.reason,
    actorId: input.actorId,
  });

  await recordEvent({
    entityType: "consultation",
    entityId: input.consultationId,
    eventType: "consultation_cancelled",
    actor: { id: input.actorId, role: "couple" },
    beforeState: row.status,
    afterState: "cancelled",
    // 판정 사유를 남긴다 — "왜 환불이 아니었나" 를 나중에 재구성해야 한다(D-23).
    memo: verdict.reason.slice(0, 200),
  });

  await notifyConsultation({
    consultationId: input.consultationId,
    templateKey: "schedule.cancelled",
    audience: "both",
  });

  return { consultationId: input.consultationId, verdict };
}

// =============================================================================
// 이행 확인 (§3.11) — 양측이 각각 부른다
// =============================================================================

export async function submitConfirmation(
  supabase: Client,
  input: {
    consultationId: string;
    side: "couple" | "vendor";
    outcome: ConsultationOutcome;
    actorId: string;
    now: Date;
  },
): Promise<{ consultationId: string; verdict: Verdict | null } | ActionFailure> {
  const { data } = await supabase
    .from("consultations")
    .select("id, status, scheduled_at, couple_outcome, vendor_outcome")
    .eq("id", input.consultationId)
    .maybeSingle();

  if (!data) {
    return { status: 404, code: "CONSULTATION_NOT_FOUND", message: "예약을 찾을 수 없어요." };
  }

  const row = data as {
    status: string;
    scheduled_at: string;
    couple_outcome: ConsultationOutcome | null;
    vendor_outcome: ConsultationOutcome | null;
  };

  if (row.status !== "confirmed") {
    return {
      status: 409,
      code: "CONSULTATION_NOT_CONFIRMED",
      message: "확정된 예약만 이행 확인을 할 수 있어요.",
    };
  }

  if (new Date(row.scheduled_at).getTime() > input.now.getTime()) {
    return {
      status: 409,
      code: "CONSULTATION_NOT_YET",
      message: "예정 시각이 지난 뒤에 확인할 수 있어요.",
    };
  }

  const patch =
    input.side === "couple"
      ? { couple_outcome: input.outcome, couple_confirmed_at: input.now.toISOString() }
      : { vendor_outcome: input.outcome, vendor_confirmed_at: input.now.toISOString() };

  // 자기 칸에만, 한 번만 — 0025 트리거가 강제한다. 여기서 다시 판정하지 않는다.
  const { error } = await supabase
    .from("consultations")
    .update(patch)
    .eq("id", input.consultationId);

  if (error) {
    return {
      status: 403,
      code: "CONSULTATION_CONFIRM_FORBIDDEN",
      message: "이미 제출했거나 확인할 권한이 없어요.",
    };
  }

  await recordEvent({
    entityType: "consultation",
    entityId: input.consultationId,
    eventType: "consultation_confirmation_submitted",
    actor: { id: input.actorId, role: input.side },
    afterState: input.outcome,
    memo: null,
  });

  const couple = input.side === "couple" ? input.outcome : row.couple_outcome;
  const vendor = input.side === "vendor" ? input.outcome : row.vendor_outcome;

  // 아직 한쪽만 답했으면 기다린다 — 기한이 지나면 배치가 §3.11 기본값으로 마무리한다.
  if (couple === null || vendor === null) {
    return { consultationId: input.consultationId, verdict: null };
  }

  const verdict = await applyVerdict(input.consultationId, couple, vendor, input.actorId);

  return { consultationId: input.consultationId, verdict };
}

/**
 * 판정을 집행한다.
 *
 * **서비스롤로 쓴다.** `outcome`·`resolved_at` 은 당사자의 주장이 아니라 서버의
 * 결론이라 0025 가 컬럼 권한에서 뺐다.
 */
export async function applyVerdict(
  consultationId: string,
  couple: ConsultationOutcome | null,
  vendor: ConsultationOutcome | null,
  actorId: string | null,
): Promise<Verdict> {
  const verdict = resolveVerdict(couple, vendor);
  const admin = createAdminClient();

  await admin
    .from("consultations")
    .update({
      status: verdict.status,
      outcome: verdict.outcome,
      resolved_at: new Date().toISOString(),
    })
    .eq("id", consultationId);

  if (verdict.deposit === "dispute") {
    // 돈은 그대로 잡아 둔 채 상태만 바꾼다. 운영자 조율 화면은 S4-10 이지만
    // **큐에 쌓이는 것은 지금부터**다(0025 부분 인덱스).
    await disputeDeposit({ consultationId, reason: verdict.reason });
  } else {
    await releaseDeposit({
      consultationId,
      action: verdict.deposit,
      reason: verdict.reason,
      actorId,
    });
  }

  await recordEvent({
    entityType: "consultation",
    entityId: consultationId,
    eventType: verdict.deposit === "dispute" ? "consultation_disputed" : "consultation_resolved",
    actor: { id: actorId ?? "00000000-0000-0000-0000-000000000000", role: "system" },
    afterState: verdict.status,
    // **판정 근거를 남긴다.** §3.11 4번이 요구하는 것이고, 조율 화면(S4-10)이
    // "왜 이렇게 정해졌나" 를 이 기록에서 읽는다.
    memo: verdict.reason.slice(0, 200),
  });

  await notifyConsultation({
    consultationId,
    templateKey: verdict.deposit === "dispute" ? "schedule.disputed" : "schedule.resolved",
    audience: "both",
  });

  return verdict;
}

// =============================================================================
// 배치가 쓰는 조각
// =============================================================================

/** 예정 시각이 지난 확정 예약에 확인 기한을 걸고 양측에 요청한다(§3.11 1번). */
export async function openConfirmationWindow(
  consultationId: string,
  scheduledAt: string,
  confirmDueHours: number | null,
): Promise<boolean> {
  const dueAt = confirmDueAt(scheduledAt, confirmDueHours);
  if (dueAt === null) return false;

  const { error } = await createAdminClient()
    .from("consultations")
    .update({ confirm_due_at: dueAt })
    .eq("id", consultationId)
    .is("confirm_due_at", null);

  if (error) return false;

  await notifyConsultation({
    consultationId,
    templateKey: "schedule.confirm_request",
    audience: "both",
  });

  return true;
}

export { loadTakenSlots };
