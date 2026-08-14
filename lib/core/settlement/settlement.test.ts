import { describe, expect, it } from "vitest";

import {
  ADJUSTMENT_SOURCES,
  BLOCKED_REASONS,
  BLOCKED_REASON_DETAIL,
  PAYOUT_STATUSES,
  SETTLEMENT_STATUSES,
  SETTLEMENT_STATUS_LABEL,
  SettlementError,
  applyAdjustments,
  buildSettlement,
  needsRecalculation,
  payableDateOf,
  payoutEligibility,
  payoutIdempotencyKey,
  previousPeriod,
  recalculable,
  settlementPeriod,
  taxSummary,
  type SettlementLine,
} from "./settlement";

function line(over: Partial<SettlementLine> & { bookingId: string }): SettlementLine {
  return {
    grossAmount: 10_000_000,
    paidAmount: 10_000_000,
    appliedFeeRateBp: 500,
    vendorCouponDeduction: 0,
    ...over,
  };
}

describe("정산 기간 — 값은 설정이 갖는다", () => {
  it("월 단위 기간을 만든다", () => {
    expect(settlementPeriod(new Date("2026-08-14T12:00:00Z"))).toEqual({
      start: "2026-08-01",
      end: "2026-08-31",
    });
  });

  it("2월 말일을 맞춘다", () => {
    expect(settlementPeriod(new Date("2028-02-10T00:00:00Z")).end).toBe("2028-02-29");
  });

  it("직전 기간을 만든다 — 연도를 넘어간다", () => {
    expect(previousPeriod({ start: "2026-01-01", end: "2026-01-31" })).toEqual({
      start: "2025-12-01",
      end: "2025-12-31",
    });
  });

  it("모르는 주기는 조용히 월로 처리하지 않는다", () => {
    expect(() => settlementPeriod(new Date(), "week")).toThrow(SettlementError);
  });

  it("지급 예정일은 확정일 + 리드타임이다", () => {
    expect(payableDateOf(new Date("2026-09-01T00:00:00Z"), 7)).toBe("2026-09-08");
  });

  it("음수 리드타임은 거절한다", () => {
    expect(() => payableDateOf(new Date(), -1)).toThrow(SettlementError);
  });
});

describe("집계 — fee_basis 미결은 실패가 아니라 대기다", () => {
  it("기준이 없으면 blocked 이며 사유가 붙는다", () => {
    const result = buildSettlement({ lines: [line({ bookingId: "b1" })], feeBasis: null });

    expect(result.status).toBe("blocked");
    expect(result.status === "blocked" && result.reason).toBe("fee_basis_missing");
  });

  it("대기 문구가 '실패' 가 아니라 '아직 정해지지 않았다' 로 적혀 있다", () => {
    const detail = BLOCKED_REASON_DETAIL.fee_basis_missing;

    expect(detail).toContain("아직 정해지지 않았");
    expect(detail).toContain("거래 내역은 이미 모여 있");
    expect(detail).not.toContain("실패");
    expect(detail).not.toContain("오류");
  });

  it("상태 라벨도 '실패' 라고 적지 않는다", () => {
    expect(SETTLEMENT_STATUS_LABEL.blocked).toBe("설정 대기");
  });

  it("요율 스냅샷이 없으면 정산서를 만들지 않고 어느 예약인지 알려준다", () => {
    const result = buildSettlement({
      lines: [line({ bookingId: "b1" }), line({ bookingId: "b2", appliedFeeRateBp: null })],
      feeBasis: "pre_discount",
    });

    expect(result.status === "blocked" && result.reason).toBe("rate_snapshot_missing");
    expect(result.status === "blocked" && result.bookingIds).toEqual(["b2"]);
  });
});

describe("집계 — 수수료 기준이 금액을 가른다 (O-15)", () => {
  const lines = [line({ bookingId: "b1", grossAmount: 10_000_000, paidAmount: 9_000_000 })];

  it("할인 전 기준은 판매가에서 뗀다", () => {
    const result = buildSettlement({ lines, feeBasis: "pre_discount" });

    expect(result.status).toBe("draft");
    expect(result.status === "draft" && result.grossAmount).toBe(10_000_000);
    expect(result.status === "draft" && result.feeAmount).toBe(500_000);
  });

  it("할인 후 기준은 결제액에서 뗀다", () => {
    const result = buildSettlement({ lines, feeBasis: "post_discount" });

    expect(result.status === "draft" && result.grossAmount).toBe(9_000_000);
    expect(result.status === "draft" && result.feeAmount).toBe(450_000);
  });

  it("기준을 스냅샷으로 돌려준다 — 나중에 바뀌어도 재현된다", () => {
    const result = buildSettlement({ lines, feeBasis: "post_discount" });

    expect(result.status === "draft" && result.feeBasis).toBe("post_discount");
  });
});

describe("집계 — 쿠폰은 업체 부담분만 뺀다 (D-27)", () => {
  it("업체 부담 쿠폰이 순액에서 빠진다", () => {
    const result = buildSettlement({
      lines: [line({ bookingId: "b1", vendorCouponDeduction: 300_000 })],
      feeBasis: "pre_discount",
    });

    expect(result.status === "draft" && result.couponDeduction).toBe(300_000);
    // 10,000,000 − 500,000(수수료) − 300,000(쿠폰) = 9,200,000
    expect(result.status === "draft" && result.netAmount).toBe(9_200_000);
  });

  it("플랫폼 부담 쿠폰은 0으로 들어와 차감되지 않는다", () => {
    const result = buildSettlement({
      lines: [line({ bookingId: "b1", vendorCouponDeduction: 0 })],
      feeBasis: "pre_discount",
    });

    expect(result.status === "draft" && result.couponDeduction).toBe(0);
    expect(result.status === "draft" && result.netAmount).toBe(9_500_000);
  });

  it("건별 순액이 DB CHECK 와 같은 식이다", () => {
    const result = buildSettlement({
      lines: [line({ bookingId: "b1", vendorCouponDeduction: 100_000 })],
      feeBasis: "pre_discount",
    });

    if (result.status !== "draft") throw new Error("draft 여야 한다");

    for (const item of result.items) {
      expect(item.netAmount).toBe(item.amount - item.feeAmount - item.couponDeduction);
    }
  });

  it("음수 쿠폰 차감은 거절한다", () => {
    expect(() =>
      buildSettlement({
        lines: [line({ bookingId: "b1", vendorCouponDeduction: -1 })],
        feeBasis: "pre_discount",
      }),
    ).toThrow(SettlementError);
  });

  it("건이 여럿이면 합산한다", () => {
    const result = buildSettlement({
      lines: [
        line({ bookingId: "b1", grossAmount: 5_000_000, vendorCouponDeduction: 100_000 }),
        line({ bookingId: "b2", grossAmount: 5_000_000, appliedFeeRateBp: 800 }),
      ],
      feeBasis: "pre_discount",
    });

    expect(result.status === "draft" && result.grossAmount).toBe(10_000_000);
    // 5,000,000×5% + 5,000,000×8% = 250,000 + 400,000
    expect(result.status === "draft" && result.feeAmount).toBe(650_000);
    expect(result.status === "draft" && result.netAmount).toBe(9_250_000);
  });
});

describe("상계 — 지급액은 음수가 되지 않는다", () => {
  const pending = [
    { id: "a1", sourceType: "cancellation_refund" as const, amount: 300_000, reason: "해지" },
    { id: "a2", sourceType: "manual" as const, amount: 100_000, reason: "조정" },
  ];

  it("순액 안에서 전부 뺀다", () => {
    const result = applyAdjustments(1_000_000, pending);

    expect(result.appliedTotal).toBe(400_000);
    expect(result.payoutAmount).toBe(600_000);
    expect(result.carriedTotal).toBe(0);
  });

  it("작은 것부터 넣는다 — 큰 건 하나가 작은 건들을 밀지 않는다", () => {
    const result = applyAdjustments(150_000, pending);

    expect(result.applied).toEqual([{ id: "a2", amount: 100_000 }]);
    expect(result.carried).toEqual([{ id: "a1", amount: 300_000 }]);
    expect(result.payoutAmount).toBe(50_000);
  });

  it("건을 쪼개지 않는다 — 통째로 들어가거나 통째로 넘어간다", () => {
    const result = applyAdjustments(200_000, [pending[0]]);

    expect(result.applied).toHaveLength(0);
    expect(result.carriedTotal).toBe(300_000);
    expect(result.payoutAmount).toBe(200_000);
  });

  it("모든 상계가 순액보다 크면 하나도 못 빼고 전부 넘어간다", () => {
    // 쪼개지 않으므로 50,000 으로는 100,000 짜리도 못 뺀다. 지급액은 그대로 남고
    // 상계는 다음 기간으로 간다 — **부분 반영보다 이월이 낫다**(재현 가능성).
    const result = applyAdjustments(50_000, pending);

    expect(result.applied).toHaveLength(0);
    expect(result.payoutAmount).toBe(50_000);
    expect(result.carriedTotal).toBe(400_000);
  });

  it("상계가 순액과 정확히 같으면 지급액이 0이다 — 음수가 아니다", () => {
    const result = applyAdjustments(400_000, pending);

    expect(result.appliedTotal).toBe(400_000);
    expect(result.payoutAmount).toBe(0);
    expect(result.carriedTotal).toBe(0);
  });

  it("상계가 없으면 순액이 그대로 지급액이다", () => {
    expect(applyAdjustments(1_000_000, []).payoutAmount).toBe(1_000_000);
  });

  it("음수 순액·음수 상계는 거절한다", () => {
    expect(() => applyAdjustments(-1, [])).toThrow(SettlementError);
    expect(() =>
      applyAdjustments(100, [{ id: "x", sourceType: "manual", amount: -1, reason: "r" }]),
    ).toThrow(SettlementError);
  });
});

describe("재계산 — 확정된 정산서는 다시 계산하지 않는다", () => {
  it("대기·확정 전 정산서만 재계산한다", () => {
    expect(recalculable("blocked")).toBe(true);
    expect(recalculable("draft")).toBe(true);
  });

  it("확정·지급된 정산서는 재계산하지 않는다", () => {
    expect(recalculable("confirmed")).toBe(false);
    expect(recalculable("paid")).toBe(false);
    expect(recalculable("void")).toBe(false);
  });

  it("기준이 정해지면 재계산 대상이 된다", () => {
    expect(
      needsRecalculation({
        status: "blocked",
        blockedReason: "fee_basis_missing",
        feeBasisResolved: true,
      }),
    ).toBe(true);
  });

  it("기준이 아직 없으면 재계산 대상이 아니다", () => {
    expect(
      needsRecalculation({
        status: "blocked",
        blockedReason: "fee_basis_missing",
        feeBasisResolved: false,
      }),
    ).toBe(false);
  });

  it("스냅샷 누락은 기준이 정해져도 풀리지 않는다 — 다른 문제다", () => {
    expect(
      needsRecalculation({
        status: "blocked",
        blockedReason: "rate_snapshot_missing",
        feeBasisResolved: true,
      }),
    ).toBe(false);
  });
});

describe("지급 — 멱등 열쇠와 자격", () => {
  it("자동 재시도는 같은 열쇠다", () => {
    expect(payoutIdempotencyKey({ settlementId: "s1" })).toBe("settlement:s1:payout:1");
    expect(payoutIdempotencyKey({ settlementId: "s1", attempt: 1 })).toBe(
      "settlement:s1:payout:1",
    );
  });

  it("명시적 재지급만 열쇠가 달라진다", () => {
    expect(payoutIdempotencyKey({ settlementId: "s1", attempt: 2 })).toBe(
      "settlement:s1:payout:2",
    );
  });

  it("0 이하 시도 번호는 거절한다", () => {
    expect(() => payoutIdempotencyKey({ settlementId: "s1", attempt: 0 })).toThrow(
      SettlementError,
    );
  });

  it("확정된 정산서만 지급한다", () => {
    expect(
      payoutEligibility({ status: "draft", payoutAmount: 100, hasPending: false }),
    ).toMatchObject({ ok: false, reason: "not_confirmed" });
  });

  it("이미 지급된 정산서는 다시 지급하지 않는다", () => {
    expect(
      payoutEligibility({ status: "paid", payoutAmount: 100, hasPending: false }),
    ).toMatchObject({ ok: false, reason: "already_paid" });
  });

  it("진행 중인 지급이 있으면 새로 열지 않는다", () => {
    expect(
      payoutEligibility({ status: "confirmed", payoutAmount: 100, hasPending: true }),
    ).toMatchObject({ ok: false, reason: "in_progress" });
  });

  it("상계가 정산액을 모두 덮으면 지급할 것이 없다", () => {
    expect(
      payoutEligibility({ status: "confirmed", payoutAmount: 0, hasPending: false }),
    ).toMatchObject({ ok: false, reason: "zero_amount" });
  });

  it("확정 + 금액 있음 + 진행 중 없음이면 지급한다", () => {
    expect(payoutEligibility({ status: "confirmed", payoutAmount: 1, hasPending: false })).toEqual({
      ok: true,
    });
  });
});

describe("세금계산서 자료 — 자료까지, 발행은 아니다", () => {
  it("수수료가 공급가액이다 — 정산액이 아니다", () => {
    const summary = taxSummary(1_000_000, 1_000);

    expect(summary?.supplyAmount).toBe(1_000_000);
    expect(summary?.taxAmount).toBe(100_000);
    expect(summary?.totalAmount).toBe(1_100_000);
  });

  it("세액은 내림으로 계산한다", () => {
    expect(taxSummary(999, 1_000)?.taxAmount).toBe(99);
  });

  it("세율 설정이 없으면 자료를 만들지 않는다 — 지어낸 세율은 신고에 쓰인다", () => {
    expect(taxSummary(1_000_000, null)).toBeNull();
  });

  it("이 문서가 세금계산서가 아님을 자료 자체가 적는다", () => {
    expect(taxSummary(1_000, 1_000)?.note).toContain("세금계산서가 아니며");
  });

  it("규약을 벗어난 세율은 거절한다", () => {
    expect(() => taxSummary(1_000, 10_001)).toThrow(SettlementError);
  });
});

describe("값 집합", () => {
  it("목록에 중복이 없다", () => {
    for (const list of [
      SETTLEMENT_STATUSES,
      BLOCKED_REASONS,
      ADJUSTMENT_SOURCES,
      PAYOUT_STATUSES,
    ]) {
      expect(new Set(list).size).toBe(list.length);
    }
  });

  it("정산 상태에 'failed' 가 없다 — 미결은 실패가 아니다", () => {
    expect(SETTLEMENT_STATUSES).not.toContain("failed");
    expect(SETTLEMENT_STATUSES).toContain("blocked");
  });
});
