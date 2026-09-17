// 견적 → 예약 다리 (C-1 · 명세서 §2.1 F-C-13 · §3.4 · D-36)
//
// ══════════════════════════════════════════════════════════════════════════
// **고객의 수락이 만드는 것은 `hold` 이지 합의가 아니다**
// ══════════════════════════════════════════════════════════════════════════
//
// B-1 이 찾은 것: 거래 사슬이 정확히 한 칸에서 끊겨 있었다. 견적을 수락해도
// `quotes.status` 만 바뀌고 예약이 생기지 않아, 계약을 발행할 `bookingId` 가
// 영원히 없었다. 하류(계약·서명·결제·정산)는 전부 만들어져 있었다.
//
// ── 무엇을 만드는가 ────────────────────────────────────────────────────────
// `status='hold'` · `accepted_at=null` 인 예약 하나.
//
// **`accepted_at` 을 채우지 않는다.** 견적이 업체의 제안이고 수락이 고객의 응답이니
// 합의가 선 것 아니냐고 물을 수 있다. 그런데 `bookings.accepted_at` 은 "업체가 **이
// 예약을** 받겠다고 한 시각" 이고 예약에는 견적에 없던 것이 들어간다 — 날짜와 자리다.
// 고객의 행위 하나로 업체 동의가 만들어지면 **그것이 FIX-44 가 막은 바로 그 모양**이다
// (커플이 업체 동의 없이 확정 예약을 만들고 그것으로 검증 후기를 썼다).
//
// 그래서 다리는 `pending` 갈래에 예약을 놓고 끝난다. 그 갈래는 이미 있다 —
// `VENDOR_LANE_HINT.pending` 이 "고객이 신청했고 아직 결정하지 않은 예약입니다" 다.
//
// ── 자리와 요율은 건드리지 않는다 ──────────────────────────────────────────
// **자리**는 `confirmed` 전이에서 잡힌다(`apply_booking_slot_movement` · 0031).
// `hold` 는 아무 자리도 차지하지 않으므로 다리가 재고를 깎지 않는다.
// **요율**은 서명이 끝날 때 박힌다(`activateContract`). `hold` 예약의 요율이 null 인
// 것은 정상이며 "아직 스냅샷하지 않았다" 는 뜻이다.
//
// ── 플래너를 입력으로 받지 않는다 (FIX-53 과 같은 자리) ────────────────────
// 예약에는 플래너 컬럼이 없고, 누구에게 맡겼는가는 `planner_scopes` 가 정한다.
// 계약 발행이 그 표를 읽어 `contracts.planner_id` 를 정하므로(S6-03) **다리는 플래너를
// 아예 만지지 않는다.** 만졌다면 고객이 고른 적 없는 플래너가 끼어들 수 있다.
//
// 프레임워크를 모르는 순수 모듈이다.

import type { QuoteStatus } from "../inquiry/inquiry";

// =============================================================================
// 만들 수 있는가
// =============================================================================

export const BRIDGE_BLOCK_REASONS = [
  "quote_not_accepted",
  "quote_expired",
  "already_booked",
  "target_closed",
  "amount_missing",
] as const;

export type BridgeBlockReason = (typeof BRIDGE_BLOCK_REASONS)[number];

/**
 * 막힌 이유를 화면이 그대로 적는다.
 *
 * **'안 됩니다' 만 돌려주지 않는다** — 다음에 무엇을 할지 말하지 않는 거절은
 * 사용자를 같은 버튼으로 돌려보낸다(S5-06 `PayBlockReason` 과 같은 모양).
 */
export const BRIDGE_BLOCK_MESSAGE: Record<BridgeBlockReason, string> = {
  quote_not_accepted: "먼저 견적을 수락해 주세요. 수락한 견적만 예약으로 넘어갑니다.",
  quote_expired: "유효기간이 지난 견적이에요. 업체에 다시 요청해 주세요.",
  already_booked: "이 견적으로 만든 예약이 이미 있어요.",
  target_closed: "이 문의는 이미 닫혔어요. 새로 문의해 주세요.",
  amount_missing: "견적 금액이 비어 있어 예약을 만들 수 없어요. 업체에 문의해 주세요.",
};

export type BridgeGate = { allowed: boolean; reason: BridgeBlockReason | null };

export type BridgeFacts = {
  quoteStatus: QuoteStatus;
  /** 견적 유효기간. null 이면 기한 없는 견적이다. */
  validUntil: string | null;
  /** 이 견적으로 이미 만든 예약이 있는가. DB 부분 유니크가 최종 경계이고 여기는 안내다. */
  alreadyBooked: boolean;
  /** 문의가 닫혔는가(`inquiries.closed_at`). */
  inquiryClosed: boolean;
  totalAmount: number | null;
};

/**
 * 이 견적을 예약으로 넘길 수 있는가.
 *
 * **순서가 뜻을 갖는다.** 이미 만들어진 예약이 있으면 그것을 먼저 말한다 — 만료·금액을
 * 먼저 따지면 "만료됐다" 는 말을 듣고 사용자는 예약이 없다고 믿는다.
 */
export function bridgeGate(facts: BridgeFacts, now: Date): BridgeGate {
  if (facts.alreadyBooked) return { allowed: false, reason: "already_booked" };

  if (facts.quoteStatus !== "accepted") {
    // 만료는 수락 자체를 막으므로(`decideQuote`) 여기 오는 만료는 **수락 뒤에 기한이
    // 지난 것**이다. 그 둘을 같은 문구로 뭉치지 않는다.
    return {
      allowed: false,
      reason: facts.quoteStatus === "expired" ? "quote_expired" : "quote_not_accepted",
    };
  }

  if (isExpiredAt(facts.validUntil, now)) return { allowed: false, reason: "quote_expired" };
  if (facts.inquiryClosed) return { allowed: false, reason: "target_closed" };

  // **금액이 없으면 만들지 않는다.** `bookings.total_amount` 는 not null 이고,
  // 0 으로 채우면 정산 근거가 0 이 된다(FIX-44 의 곁가지가 정확히 그것이었다).
  if (facts.totalAmount === null || facts.totalAmount <= 0) {
    return { allowed: false, reason: "amount_missing" };
  }

  return { allowed: true, reason: null };
}

/** 기한이 **지났는가**. 기한이 없으면 지나지 않는다. */
export function isExpiredAt(validUntil: string | null, now: Date): boolean {
  if (validUntil === null) return false;

  const at = Date.parse(validUntil);
  if (Number.isNaN(at)) return false;

  return at <= now.getTime();
}

// =============================================================================
// 무엇을 적는가
// =============================================================================

/**
 * 만들 예약의 값.
 *
 * **계산 가능한 값을 저장하지 않는다**(D-124). 여기서 정하는 것은 출처(`quoteId`)와
 * 금액·업체·상품뿐이고, 상태·자리·요율은 각자의 층이 정한다.
 */
export type BookingDraft = {
  coupleId: string;
  vendorId: string;
  productId: string | null;
  quoteId: string;
  totalAmount: number;
  /** 계약금. **견적이 말하지 않으면 0 이다** — 지어내지 않는다. */
  depositAmount: number;
  status: "hold";
};

export function draftFromQuote(input: {
  coupleId: string;
  vendorId: string;
  productId: string | null;
  quoteId: string;
  totalAmount: number;
}): BookingDraft {
  return {
    coupleId: input.coupleId,
    vendorId: input.vendorId,
    productId: input.productId,
    quoteId: input.quoteId,
    totalAmount: input.totalAmount,
    // **계약금을 지어내지 않는다.** 회차 구성은 계약 발행이 정하고(`splitAmount`),
    // 그 전까지 계약금은 정해진 바 없다. 0 은 "없다" 가 아니라 "아직 나누지 않았다" 이며
    // 회차를 만드는 것은 계약이다.
    depositAmount: 0,
    status: "hold",
  };
}

/** 예약을 만든 뒤 고객이 갈 곳. 만들고 보내지 않으면 사용자는 어디로 갈지 모른다. */
export function bookingHref(bookingId: string): string {
  return `/bookings/${bookingId}`;
}
