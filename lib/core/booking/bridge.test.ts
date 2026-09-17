import { describe, expect, it } from "vitest";

import {
  BRIDGE_BLOCK_MESSAGE,
  BRIDGE_BLOCK_REASONS,
  type BridgeFacts,
  bookingHref,
  bridgeGate,
  draftFromQuote,
  isExpiredAt,
} from "./bridge";

/**
 * 견적 → 예약 다리 (C-1)
 *
 * **경계값을 고정한다.** 기한 당일 자정, 수락 뒤 만료, 이미 만든 예약,
 * 금액 0 — 넷 다 실제로 일어나는 자리다.
 */

const now = new Date("2026-09-17T12:00:00.000Z");

const facts = (over: Partial<BridgeFacts> = {}): BridgeFacts => ({
  quoteStatus: "accepted",
  validUntil: null,
  alreadyBooked: false,
  inquiryClosed: false,
  totalAmount: 12_000_000,
  ...over,
});

describe("bridgeGate — 견적을 예약으로 넘길 수 있는가", () => {
  it("수락한 견적은 통과한다", () => {
    expect(bridgeGate(facts(), now)).toEqual({ allowed: true, reason: null });
  });

  it("**수락하지 않은 견적은 막는다** — 보낸 견적이 곧 합의는 아니다", () => {
    for (const status of ["sent", "declined"] as const) {
      const gate = bridgeGate(facts({ quoteStatus: status }), now);

      expect(gate.allowed).toBe(false);
      expect(gate.reason).toBe("quote_not_accepted");
    }
  });

  it("만료 상태의 견적은 **만료라고 말한다** — '수락 안 함' 과 뭉치지 않는다", () => {
    expect(bridgeGate(facts({ quoteStatus: "expired" }), now).reason).toBe("quote_expired");
  });

  it("**수락한 뒤 기한이 지나도 막는다** — 업체가 못 지킬 가격에 묶이지 않게", () => {
    const gate = bridgeGate(facts({ validUntil: "2026-09-17T11:59:59.000Z" }), now);

    expect(gate.reason).toBe("quote_expired");
  });

  it("경계 — 기한이 **바로 지금**이면 지난 것으로 본다", () => {
    expect(bridgeGate(facts({ validUntil: now.toISOString() }), now).reason).toBe("quote_expired");
  });

  it("경계 — 기한이 1밀리초 뒤면 아직 살아 있다", () => {
    const gate = bridgeGate(
      facts({ validUntil: new Date(now.getTime() + 1).toISOString() }),
      now,
    );

    expect(gate.allowed).toBe(true);
  });

  it("기한 없는 견적은 만료되지 않는다", () => {
    expect(isExpiredAt(null, now)).toBe(false);
    // 읽을 수 없는 값으로 만료를 **지어내지 않는다**.
    expect(isExpiredAt("그날까지", now)).toBe(false);
  });

  it("**이미 만든 예약이 있으면 그것을 먼저 말한다** — 만료보다 앞선다", () => {
    const gate = bridgeGate(
      facts({ alreadyBooked: true, validUntil: "2020-01-01T00:00:00.000Z" }),
      now,
    );

    // 만료를 먼저 말하면 사용자는 예약이 없다고 믿는다.
    expect(gate.reason).toBe("already_booked");
  });

  it("닫힌 문의로는 만들지 않는다", () => {
    expect(bridgeGate(facts({ inquiryClosed: true }), now).reason).toBe("target_closed");
  });

  it("**금액이 없으면 만들지 않는다** — 0 으로 채우면 정산 근거가 0 이 된다", () => {
    expect(bridgeGate(facts({ totalAmount: null }), now).reason).toBe("amount_missing");
    expect(bridgeGate(facts({ totalAmount: 0 }), now).reason).toBe("amount_missing");
    expect(bridgeGate(facts({ totalAmount: -1 }), now).reason).toBe("amount_missing");
  });

  it("막는 이유마다 **다음에 할 일**이 적혀 있다", () => {
    expect(Object.keys(BRIDGE_BLOCK_MESSAGE).sort()).toEqual([...BRIDGE_BLOCK_REASONS].sort());

    for (const reason of BRIDGE_BLOCK_REASONS) {
      expect(BRIDGE_BLOCK_MESSAGE[reason].length).toBeGreaterThan(10);
    }
  });
});

describe("draftFromQuote — 무엇을 적는가", () => {
  const draft = draftFromQuote({
    coupleId: "couple-1",
    vendorId: "vendor-1",
    productId: "product-1",
    quoteId: "quote-1",
    totalAmount: 12_000_000,
  });

  it("**`hold` 로 만든다** — 자리를 차지하지 않는다", () => {
    expect(draft.status).toBe("hold");
  });

  it("**업체 승인을 지어내지 않는다** — 초안에 승인 칸이 아예 없다(FIX-44)", () => {
    expect(Object.keys(draft)).not.toContain("acceptedAt");
    expect(Object.keys(draft)).not.toContain("status_confirmed");
  });

  it("**플래너를 만지지 않는다**(FIX-53) — 누구에게 맡겼는가는 planner_scopes 가 정한다", () => {
    expect(Object.keys(draft)).not.toContain("plannerId");
    expect(Object.keys(draft)).not.toContain("appliedPlannerFeeRateBp");
  });

  it("**요율을 만지지 않는다** — 서명이 끝날 때 박힌다", () => {
    expect(Object.keys(draft)).not.toContain("appliedFeeRateBp");
  });

  it("**자리를 잡지 않는다** — 초안에 slotId 가 없다", () => {
    expect(Object.keys(draft)).not.toContain("slotId");
  });

  it("계약금을 지어내지 않는다 — 회차를 나누는 것은 계약이다", () => {
    expect(draft.depositAmount).toBe(0);
  });

  it("출처를 남긴다 — 어느 견적에서 왔는지", () => {
    expect(draft.quoteId).toBe("quote-1");
  });

  it("상품이 없는 견적도 만들 수 있다", () => {
    expect(
      draftFromQuote({
        coupleId: "c",
        vendorId: "v",
        productId: null,
        quoteId: "q",
        totalAmount: 1,
      }).productId,
    ).toBeNull();
  });
});

describe("bookingHref", () => {
  it("만든 뒤 보낼 곳이 있다 — 만들고 안 보내면 어디로 갈지 모른다", () => {
    expect(bookingHref("abc")).toBe("/bookings/abc");
  });
});
