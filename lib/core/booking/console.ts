// 예약 콘솔 (S5-10 · F-V-08 · §6.2 `/bookings/[id]` · §6.3 `/vendor/bookings`)
//
// ══════════════════════════════════════════════════════════════════════════
// **승인과 확정은 다른 사건이다** (D-36)
// ══════════════════════════════════════════════════════════════════════════
//
// `booking_status` 는 넷이고 `confirmed` 는 **계약 확정**을 뜻한다 — 서명이 끝나
// `activateContract` 가 찍는 값이다. 업체가 "이 예약을 받겠다" 고 한 것은 그보다
// 앞선 별개의 사건이고, 그것을 같은 칸에 적으면 **서명 없는 계약이 확정된 것으로
// 읽힌다.** 그래서 결정은 `accepted_at`·`declined_at` 짝 컬럼이 갖고, 이 파일은
// 그 둘을 **한 얼굴로 그리지 않는 것**이 일이다.

export const BOOKING_STATUSES = ["hold", "confirmed", "cancelled", "fulfilled"] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

export const BOOKING_STATUS_LABEL: Record<BookingStatus, string> = {
  hold: "예약 대기",
  confirmed: "계약 확정",
  cancelled: "취소됨",
  fulfilled: "이행 완료",
};

/** 업체의 결정. **상태와 별개**다 — 승인한 예약도 계약 전까지는 `hold` 다. */
export const BOOKING_DECISIONS = ["pending", "accepted", "declined"] as const;
export type BookingDecision = (typeof BOOKING_DECISIONS)[number];

export const BOOKING_DECISION_LABEL: Record<BookingDecision, string> = {
  pending: "승인 대기",
  accepted: "업체 승인",
  declined: "업체 거절",
};

export type BookingRow = {
  id: string;
  status: BookingStatus;
  acceptedAt: string | null;
  declinedAt: string | null;
  declineReason: string | null;
  createdAt: string;
};

export function decisionOf(booking: {
  acceptedAt: string | null;
  declinedAt: string | null;
}): BookingDecision {
  if (booking.declinedAt !== null) return "declined";
  if (booking.acceptedAt !== null) return "accepted";

  return "pending";
}

// =============================================================================
// 업체가 지금 무엇을 할 수 있는가
// =============================================================================

/**
 * 결정을 막는 이유.
 *
 * **'막혔다' 만 돌려주지 않는다.** 이유를 화면이 그대로 적어야 업체가 다음에 무엇을
 * 할지 안다(S5-06 의 `PayBlockReason` 과 같은 모양).
 */
export type DecideBlockReason = "already_accepted" | "already_declined" | "not_open";

export const DECIDE_BLOCK_MESSAGE: Record<DecideBlockReason, string> = {
  already_accepted: "이미 승인한 예약이에요. 승인은 되돌릴 수 없습니다.",
  already_declined: "이미 거절한 예약이에요. 다시 진행하려면 새 예약을 만들어야 합니다.",
  not_open: "진행 중인 예약이 아니에요. 취소·이행이 끝난 예약은 결정할 것이 없습니다.",
};

export type DecideGate = { allowed: boolean; reason: DecideBlockReason | null };

/**
 * 업체가 승인·거절할 수 있는가.
 *
 * **`hold` 만 결정 대상이다.** 계약이 확정된 뒤에 승인 버튼이 살아 있으면 그 버튼은
 * 아무 일도 하지 않는다 — 집행할 수 없는 조치를 화면에 만들지 않는다(D-143).
 */
export function canDecide(booking: {
  status: BookingStatus;
  acceptedAt: string | null;
  declinedAt: string | null;
}): DecideGate {
  if (booking.declinedAt !== null) return { allowed: false, reason: "already_declined" };
  if (booking.acceptedAt !== null) return { allowed: false, reason: "already_accepted" };
  if (booking.status !== "hold") return { allowed: false, reason: "not_open" };

  return { allowed: true, reason: null };
}

/**
 * 계약을 발행할 수 있는가.
 *
 * **승인이 계약 발행의 선행이다.** 이 문을 걸지 않으면 승인 버튼은 장식이 된다 —
 * 눌러도 다음이 달라지지 않는 버튼은 있으나 마나다.
 */
export type IssueBlockReason = "not_accepted" | "declined" | "not_open" | "already_issued";

export const ISSUE_BLOCK_MESSAGE: Record<IssueBlockReason, string> = {
  not_accepted: "예약을 먼저 승인해 주세요. 승인 없이 계약을 발행할 수 없습니다.",
  declined: "거절한 예약이에요. 계약을 발행할 수 없습니다.",
  not_open: "진행 중인 예약이 아니에요.",
  already_issued: "이미 발행된 계약이 있어요.",
};

export function canIssueContract(input: {
  status: BookingStatus;
  acceptedAt: string | null;
  declinedAt: string | null;
  hasLiveContract: boolean;
}): { allowed: boolean; reason: IssueBlockReason | null } {
  if (input.declinedAt !== null) return { allowed: false, reason: "declined" };
  if (input.hasLiveContract) return { allowed: false, reason: "already_issued" };
  if (input.status === "cancelled") return { allowed: false, reason: "not_open" };
  if (input.acceptedAt === null) return { allowed: false, reason: "not_accepted" };

  return { allowed: true, reason: null };
}

// =============================================================================
// 소비자 예약 상세가 여는 문들
// =============================================================================

/**
 * 예약 상세에서 갈 수 있는 곳.
 *
 * **이 화면이 없어서 다섯 기능이 진입점을 못 갖고 있었다** — 결제·취소·안전거래·
 * 계약·후기. 전부 라우트는 실재하는데 아무도 그리로 갈 수 없었다(FIX-25 계열).
 *
 * **막힌 문을 감추지 않는다.** 왜 지금 못 가는지를 함께 돌려준다 — 감추면 "그런 기능이
 * 없다" 로 읽히고, 실제로는 조건이 안 찼을 뿐이다.
 */
export type EntryKey = "contract" | "checkout" | "cancel" | "escrow" | "review";

export type Entry = {
  key: EntryKey;
  label: string;
  href: string;
  open: boolean;
  /** 못 가는 이유. 갈 수 있으면 null. */
  blocked: string | null;
};

export type EntryFacts = {
  bookingId: string;
  status: BookingStatus;
  acceptedAt: string | null;
  declinedAt: string | null;
  contractId: string | null;
  contractActive: boolean;
  hasPayableSchedule: boolean;
  escrowEnabled: boolean;
  hasEscrowHold: boolean;
  reviewable: boolean;
  reviewBlockedReason: string | null;
};

export function entryPoints(facts: EntryFacts): Entry[] {
  const id = facts.bookingId;

  return [
    {
      key: "contract",
      label: "계약서 보기",
      href: facts.contractId === null ? `/bookings/${id}` : `/contracts/${facts.contractId}`,
      open: facts.contractId !== null,
      blocked:
        facts.contractId !== null
          ? null
          : facts.acceptedAt === null
            ? "업체가 예약을 승인하면 계약서가 발행돼요."
            : "업체가 계약서를 발행하면 여기에서 볼 수 있어요.",
    },
    {
      key: "checkout",
      label: "결제하기",
      href: `/checkout/${id}`,
      open: facts.hasPayableSchedule,
      blocked: facts.hasPayableSchedule
        ? null
        : facts.contractActive
          ? "지금 낼 회차가 없어요. 완납했거나 다음 회차 기한이 아직 정해지지 않았습니다."
          : "계약이 확정된 뒤에 결제할 수 있어요.",
    },
    {
      key: "cancel",
      label: "해지·환불 요청",
      href: `/bookings/${id}/cancel`,
      // 해지는 **계약이 선 뒤**의 일이다. 계약 전 예약은 업체 거절이나 만료로 끝난다.
      open: facts.status === "confirmed",
      blocked:
        facts.status === "confirmed"
          ? null
          : facts.status === "cancelled"
            ? "이미 종료된 예약이에요."
            : "계약이 확정된 뒤에 해지 절차를 시작할 수 있어요.",
    },
    {
      key: "escrow",
      label: "안전거래",
      href: `/bookings/${id}/escrow`,
      // **미결 파라미터를 코드가 대신 답하지 않는다.** `escrow.enabled` 는 O-03 대기다.
      open: facts.hasEscrowHold,
      blocked: facts.hasEscrowHold
        ? null
        : facts.escrowEnabled
          ? "이 예약에는 아직 보관된 잔금이 없어요."
          : "안전거래는 아직 열려 있지 않아요(법무 검토 중).",
    },
    {
      key: "review",
      label: "후기 쓰기",
      href: `/reviews/new/${id}`,
      open: facts.reviewable,
      blocked: facts.reviewable ? null : facts.reviewBlockedReason,
    },
  ];
}

// =============================================================================
// 상태 타임라인 — **저장하지 않는다**
// =============================================================================

/**
 * §6.2 가 예약 상세에 요구하는 '상태 타임라인'.
 *
 * **표를 새로 만들지 않는다**(D-124). 여기 들어가는 것은 전부 이미 어딘가에 시각으로
 * 적혀 있는 사실이고, 이 함수는 그것을 시간순으로 늘어놓을 뿐이다. 이력 표를 따로
 * 두면 두 곳이 갈리고, 갈린 쪽이 화면에 뜬다.
 *
 * **아직 안 일어난 일을 줄로 만들지 않는다** — 빈 줄이 있으면 읽는 사람이 그것을
 * '실패' 로 읽는다.
 */
export type TimelineStep = { at: string; label: string; detail: string | null };

export function bookingTimeline(input: {
  createdAt: string;
  acceptedAt: string | null;
  declinedAt: string | null;
  declineReason: string | null;
  contractIssuedAt: string | null;
  contractActivatedAt: string | null;
  paidAts: readonly string[];
  cancelledAt: string | null;
  fulfilledAt: string | null;
}): TimelineStep[] {
  const steps: TimelineStep[] = [{ at: input.createdAt, label: "예약 신청", detail: null }];

  if (input.acceptedAt !== null) {
    steps.push({ at: input.acceptedAt, label: "업체 승인", detail: null });
  }
  if (input.declinedAt !== null) {
    // **사유를 그대로 싣는다.** 거절에는 사유가 필수이고(D-24), 사유 없는 거절은
    // 조율의 근거가 되지 못한다.
    steps.push({ at: input.declinedAt, label: "업체 거절", detail: input.declineReason });
  }
  if (input.contractIssuedAt !== null) {
    steps.push({ at: input.contractIssuedAt, label: "계약서 발행", detail: null });
  }
  if (input.contractActivatedAt !== null) {
    steps.push({ at: input.contractActivatedAt, label: "계약 확정", detail: null });
  }
  input.paidAts.forEach((at, index) => {
    steps.push({ at, label: `${index + 1}회차 결제 완료`, detail: null });
  });
  if (input.cancelledAt !== null) {
    steps.push({ at: input.cancelledAt, label: "해지", detail: null });
  }
  if (input.fulfilledAt !== null) {
    steps.push({ at: input.fulfilledAt, label: "이행 완료", detail: null });
  }

  // 같은 시각이면 넣은 순서를 지킨다 — 발행과 확정이 같은 초에 찍히는 일이 있고,
  // 그때 순서가 뒤집히면 "확정 뒤에 발행" 이라는 없는 일이 화면에 뜬다.
  return steps
    .map((step, index) => ({ step, index }))
    .sort((a, b) =>
      Date.parse(a.step.at) === Date.parse(b.step.at)
        ? a.index - b.index
        : Date.parse(a.step.at) - Date.parse(b.step.at),
    )
    .map((entry) => entry.step);
}

// =============================================================================
// 업체 보드 — 갈래를 나눈다
// =============================================================================

export const VENDOR_LANES = ["pending", "accepted", "live", "closed"] as const;
export type VendorLane = (typeof VENDOR_LANES)[number];

export const VENDOR_LANE_LABEL: Record<VendorLane, string> = {
  pending: "승인 대기",
  accepted: "계약 발행 대기",
  live: "진행 중",
  closed: "종료",
};

export const VENDOR_LANE_HINT: Record<VendorLane, string> = {
  pending: "고객이 신청했고 아직 결정하지 않은 예약입니다.",
  accepted: "승인했지만 계약서를 아직 발행하지 않았습니다.",
  live: "계약이 확정됐습니다. 결제·이행이 진행됩니다.",
  closed: "취소·거절·이행 완료로 끝난 예약입니다.",
};

export function laneOf(booking: {
  status: BookingStatus;
  acceptedAt: string | null;
  declinedAt: string | null;
}): VendorLane {
  if (booking.status === "cancelled" || booking.status === "fulfilled") return "closed";
  if (booking.status === "confirmed") return "live";
  if (booking.acceptedAt !== null) return "accepted";

  return "pending";
}

/**
 * 갈래별로 묶는다.
 *
 * **0건인 갈래도 줄을 남긴다.** 비어 있는 갈래를 감추면 "그런 상태가 없다" 로 읽히고,
 * 승인 대기가 0건인 것과 승인 대기 갈래가 사라진 것은 전혀 다른 뜻이다.
 */
export function groupByLane<T extends { status: BookingStatus; acceptedAt: string | null; declinedAt: string | null }>(
  bookings: readonly T[],
): { lane: VendorLane; label: string; hint: string; rows: T[] }[] {
  return VENDOR_LANES.map((lane) => ({
    lane,
    label: VENDOR_LANE_LABEL[lane],
    hint: VENDOR_LANE_HINT[lane],
    rows: bookings.filter((booking) => laneOf(booking) === lane),
  }));
}
