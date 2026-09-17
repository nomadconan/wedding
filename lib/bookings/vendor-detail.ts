import { loadChainFacts } from "@/lib/bookings/chain";
import {
  BOOKING_DECISION_LABEL,
  BOOKING_STATUS_LABEL,
  DECIDE_BLOCK_MESSAGE,
  ISSUE_BLOCK_MESSAGE,
  type BookingDecision,
  type BookingStatus,
  type TimelineStep,
  type VendorLane,
  bookingTimeline,
  canDecide,
  canIssueContract,
  decisionOf,
  laneOf,
  settledLabelOf,
} from "@/lib/core/booking/console";
import { createClient } from "@/lib/supabase/server";

/**
 * 업체 거래 상세 (C-1 · F-V-08 · §6.3 `/vendor/bookings/[id]`)
 *
 * ══════════════════════════════════════════════════════════════════════════
 * **업체가 한 거래를 따라가려면 화면 일곱을 오갔다** (B-1 조사 2)
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 문의 `/vendor/inquiries` · 상담 `/vendor/consultations` · 예약 `/vendor/bookings` ·
 * 정산 `/vendor/settlements` · 해지 `/vendor/cancellations` · 안전거래 `/vendor/escrow` ·
 * 후기 `/vendor/reviews`. **소비자만 `/bookings/[id]` 로 한눈에 봤다.**
 *
 * 이 화면은 그 소비자판과 **같은 사실**(`loadChainFacts`)을 읽고 **업체 관점으로**
 * 접는다. 조회를 따로 쓰면 같은 예약이 두 화면에서 다르게 보이는 날이 온다.
 *
 * ── 면마다 다른 것 ─────────────────────────────────────────────────────────
 * **업체가 보고 소비자가 안 보는 것**: 승인·거절 버튼, 계약 발행 버튼, 갈래(lane).
 * **소비자가 보고 업체가 안 보는 것**: 결제하기·해지 요청·후기 쓰기 진입점 —
 * 그 넷은 **고객이 하는 행위**이고 업체 화면에 두면 누를 수 없는 버튼이 된다(D-143).
 * **둘 다 보는 것**: 상태·금액·타임라인·계약 상태·회차 진행.
 *
 * ── 고객 식별정보를 그리지 않는다 ──────────────────────────────────────────
 * `/vendor/bookings` 가 세운 규칙 그대로다 — 여기 필요한 것은 금액·일시·상태이지
 * 고객이 누구인가가 아니다. `coupleId` 는 조율 문의 때 운영자가 쓰는 참조로만 둔다.
 */

export type VendorBookingDetail = {
  id: string;
  status: BookingStatus;
  statusLabel: string;
  decision: BookingDecision;
  decisionLabel: string;
  lane: VendorLane;
  coupleId: string;
  productName: string | null;
  totalAmount: number;
  depositAmount: number;
  createdAt: string;
  acceptedAt: string | null;
  declinedAt: string | null;
  declineReason: string | null;
  /** 어느 견적에서 왔는가(C-1). null 이면 견적을 거치지 않은 예약이다. */
  quoteId: string | null;
  contractId: string | null;
  contractStatus: string | null;
  timeline: TimelineStep[];
  /** 회차 진행. **금액은 서버가 계산한 값 그대로** 쓴다. */
  schedules: { seq: number; amount: number; status: string; dueAt: string | null }[];
  paidCount: number;
  /** 결제가 끝났는가. 회차가 없으면 **'완납' 이 아니라 '회차 없음'** 이다. */
  settledLabel: string;
  canDecide: boolean;
  decideBlockedReason: string | null;
  canIssue: boolean;
  issueBlockedReason: string | null;
};

export async function loadVendorBookingDetail(input: {
  bookingId: string;
  vendorId: string;
}): Promise<VendorBookingDetail | null> {
  const facts = await loadChainFacts(input.bookingId);
  if (!facts) return null;

  // **내 업체의 예약인가.** `bookings_select` 는 업체 멤버를 이미 걸렀지만, 멤버가
  // 여러 업체에 속할 수 있으므로 **어느 업체로 열었는지**를 여기서 맞춘다.
  if (facts.booking.vendorId !== input.vendorId) return null;

  const { booking, liveContract: live } = facts;

  const decideGate = canDecide(booking);
  const issueGate = canIssueContract({
    status: booking.status,
    acceptedAt: booking.acceptedAt,
    declinedAt: booking.declinedAt,
    hasLiveContract: live !== null && live.status !== "cancelled",
  });

  return {
    id: booking.id,
    status: booking.status,
    statusLabel: BOOKING_STATUS_LABEL[booking.status],
    decision: decisionOf(booking),
    decisionLabel: BOOKING_DECISION_LABEL[decisionOf(booking)],
    lane: laneOf(booking),
    coupleId: booking.coupleId,
    productName: await productNameOf(booking.productId),
    totalAmount: booking.totalAmount,
    depositAmount: booking.depositAmount,
    createdAt: booking.createdAt,
    acceptedAt: booking.acceptedAt,
    declinedAt: booking.declinedAt,
    declineReason: booking.declineReason,
    quoteId: booking.quoteId,
    contractId: live?.id ?? null,
    contractStatus: live?.status ?? null,
    timeline: bookingTimeline({
      createdAt: booking.createdAt,
      acceptedAt: booking.acceptedAt,
      declinedAt: booking.declinedAt,
      declineReason: booking.declineReason,
      contractIssuedAt: live?.issuedAt ?? null,
      contractActivatedAt: live?.activatedAt ?? null,
      paidAts: facts.paidAts,
      cancelledAt: live?.cancelledAt ?? null,
      fulfilledAt: null,
    }),
    schedules: facts.schedules.map((schedule) => ({
      seq: schedule.seq,
      amount: schedule.amount,
      status: schedule.status,
      dueAt: schedule.dueAt,
    })),
    paidCount: facts.paidAts.length,
    settledLabel: settledLabelOf(facts.schedules.length, facts.paidAts.length),
    canDecide: decideGate.allowed,
    decideBlockedReason:
      decideGate.reason === null ? null : DECIDE_BLOCK_MESSAGE[decideGate.reason],
    canIssue: issueGate.allowed,
    issueBlockedReason: issueGate.reason === null ? null : ISSUE_BLOCK_MESSAGE[issueGate.reason],
  };
}

/** 상품 이름은 공개 데이터라 세션으로 읽힌다. 임베드 대신 따로 묻는다(함정 1). */
async function productNameOf(productId: string | null): Promise<string | null> {
  if (productId === null) return null;

  const supabase = await createClient();
  const { data } = await supabase
    .from("products")
    .select("name")
    .eq("id", productId)
    .maybeSingle();

  return (data as { name: string } | null)?.name ?? null;
}
