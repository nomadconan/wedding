import { describe, expect, it } from "vitest";

import { getDraftPenaltyRuleSet } from "../pricing/penalty-rules";
import { calculatePenalty } from "../pricing/penalty";
import { DISCLAIMER_REQUIRED_PHRASE } from "../legal";
import {
  CANCELLATION_STATUSES,
  CANCEL_REASON_CODES,
  CANCEL_STAGES,
  CancellationError,
  FAULT_PARTIES,
  allocateRefund,
  cancelStage,
  claimsVendorFault,
  confirmationDecision,
  resolveFault,
  settleCancellation,
  settlementReversal,
  slotMovement,
  type PenaltyBasis,
} from "./cancellation";

const NOW = new Date("2026-08-13T00:00:00.000Z");

function basis(over: Partial<PenaltyBasis> = {}): PenaltyBasis {
  return {
    standardPenalty: 2_000_000,
    contractPenalty: 2_000_000,
    bandCode: "D30_59",
    bandLabel: "예식일 59~30일 전",
    basisRef: "소비자분쟁해결기준(예식업)",
    ruleVersion: "test",
    isDraftRules: false,
    ...over,
  };
}

describe("취소 시점 — 계산값이라 저장하지 않는다", () => {
  it("한 푼도 안 냈으면 결제 전이다", () => {
    expect(
      cancelStage({
        paidAmount: 0,
        totalAmount: 10_000_000,
        eventDate: "2026-12-01",
        cancelDate: "2026-08-13",
      }),
    ).toBe("before_payment");
  });

  it("일부만 냈으면 일부 결제 후다", () => {
    expect(
      cancelStage({
        paidAmount: 2_000_000,
        totalAmount: 10_000_000,
        eventDate: "2026-12-01",
        cancelDate: "2026-08-13",
      }),
    ).toBe("partially_paid");
  });

  it("다 냈으면 완납 후다", () => {
    expect(
      cancelStage({
        paidAmount: 10_000_000,
        totalAmount: 10_000_000,
        eventDate: "2026-12-01",
        cancelDate: "2026-08-13",
      }),
    ).toBe("fully_paid");
  });

  it("예식일이 지났으면 결제 상태보다 우선한다", () => {
    expect(
      cancelStage({
        paidAmount: 0,
        totalAmount: 10_000_000,
        eventDate: "2026-08-01",
        cancelDate: "2026-08-13",
      }),
    ).toBe("after_event");
  });

  it("예식 당일은 아직 경과가 아니다 — 경계는 다음 날부터다", () => {
    expect(
      cancelStage({
        paidAmount: 0,
        totalAmount: 10_000_000,
        eventDate: "2026-08-13",
        cancelDate: "2026-08-13",
      }),
    ).toBe("before_payment");
  });

  it("예식일이 미정이면 결제 상태로만 판정한다", () => {
    expect(
      cancelStage({
        paidAmount: 5_000_000,
        totalAmount: 10_000_000,
        eventDate: null,
        cancelDate: "2026-08-13",
      }),
    ).toBe("partially_paid");
  });

  it("시각이 붙어 있어도 날짜만 본다 — 타임존으로 하루가 밀리지 않는다", () => {
    expect(
      cancelStage({
        paidAmount: 0,
        totalAmount: 100,
        eventDate: "2026-08-13",
        cancelDate: "2026-08-13T23:59:59+09:00",
      }),
    ).toBe("before_payment");
  });
});

describe("귀책 — 주장만으로 정해지지 않는다", () => {
  it("한쪽 주장만으로는 미정이다", () => {
    expect(resolveFault({ coupleClaim: "vendor", vendorClaim: null })).toBe("undecided");
  });

  it("주장이 갈리면 미정이다", () => {
    expect(resolveFault({ coupleClaim: "vendor", vendorClaim: "couple" })).toBe("undecided");
  });

  it("양측이 같은 귀책에 동의하면 확정된다", () => {
    expect(resolveFault({ coupleClaim: "couple", vendorClaim: "couple" })).toBe("couple");
  });

  it("운영자 조율 결과가 최종이다", () => {
    expect(
      resolveFault({ coupleClaim: "vendor", vendorClaim: "couple", adminDecision: "mutual" }),
    ).toBe("mutual");
  });

  it("운영자가 미정으로 두면 양측 판정으로 돌아간다", () => {
    expect(
      resolveFault({ coupleClaim: "couple", vendorClaim: "couple", adminDecision: "undecided" }),
    ).toBe("couple");
  });

  it("양측이 '확인 중'에 동의해도 확정이 아니다", () => {
    expect(resolveFault({ coupleClaim: "undecided", vendorClaim: "undecided" })).toBe("undecided");
  });

  it("업체 귀책을 주장하는 사유 코드를 구별한다", () => {
    expect(claimsVendorFault("vendor_unavailable")).toBe(true);
    expect(claimsVendorFault("service_quality")).toBe(true);
    expect(claimsVendorFault("budget")).toBe(false);
  });
});

describe("정산 — 시점과 귀책이 결과를 가른다", () => {
  it("결제 전 해지는 환불이 없고 청구액이 남는다", () => {
    const result = settleCancellation({
      stage: "before_payment",
      fault: "couple",
      paidAmount: 0,
      penalty: basis(),
    });

    expect(result.refundAmount).toBe(0);
    expect(result.balanceDue).toBe(2_000_000);
    expect(result.notes.join()).toContain("돌려드릴 금액이 없습니다");
  });

  it("일부 결제 후에는 낸 돈에서 위약금을 뺀다", () => {
    const result = settleCancellation({
      stage: "partially_paid",
      fault: "couple",
      paidAmount: 3_000_000,
      penalty: basis(),
    });

    expect(result.refundAmount).toBe(1_000_000);
    expect(result.balanceDue).toBe(0);
  });

  it("낸 돈이 위약금보다 적으면 차액이 청구된다", () => {
    const result = settleCancellation({
      stage: "partially_paid",
      fault: "couple",
      paidAmount: 500_000,
      penalty: basis(),
    });

    expect(result.refundAmount).toBe(0);
    expect(result.balanceDue).toBe(1_500_000);
  });

  it("완납 후에는 총액에서 위약금을 뺀 금액이 돌아간다", () => {
    const result = settleCancellation({
      stage: "fully_paid",
      fault: "couple",
      paidAmount: 10_000_000,
      penalty: basis(),
    });

    expect(result.refundAmount).toBe(8_000_000);
  });

  it("업체 귀책이면 위약금 없이 전액 환불이다", () => {
    const result = settleCancellation({
      stage: "fully_paid",
      fault: "vendor",
      paidAmount: 10_000_000,
      penalty: basis(),
    });

    expect(result.penaltyAmount).toBe(0);
    expect(result.refundAmount).toBe(10_000_000);
    expect(result.enforceable).toBe(true);
  });

  it("업체 귀책이어도 배상액을 코드가 만들지 않는다", () => {
    const result = settleCancellation({
      stage: "fully_paid",
      fault: "vendor",
      paidAmount: 10_000_000,
      penalty: basis(),
    });

    expect(result.notes.join()).toContain("당사자 협의 또는 분쟁조정");
  });

  it("합의 해지도 위약금 없이 전액 환불이다", () => {
    const result = settleCancellation({
      stage: "partially_paid",
      fault: "mutual",
      paidAmount: 4_000_000,
      penalty: basis(),
    });

    expect(result.penaltyAmount).toBe(0);
    expect(result.refundAmount).toBe(4_000_000);
  });

  it("귀책이 미정이면 계산은 하되 집행하지 않는다", () => {
    const result = settleCancellation({
      stage: "partially_paid",
      fault: "undecided",
      paidAmount: 3_000_000,
      penalty: basis(),
    });

    expect(result.enforceable).toBe(false);
    expect(result.refundAmount).toBe(1_000_000);
    expect(result.notes.join()).toContain("예상 금액");
  });

  it("계약서 조건이 기준보다 무거우면 기준을 적용한다", () => {
    const result = settleCancellation({
      stage: "fully_paid",
      fault: "couple",
      paidAmount: 10_000_000,
      penalty: basis({ contractPenalty: 5_000_000 }),
    });

    expect(result.penaltyAmount).toBe(2_000_000);
    expect(result.notes.join()).toContain("기준 금액으로 계산");
  });

  it("계약서 조건이 기준보다 가벼우면 그것을 적용한다", () => {
    const result = settleCancellation({
      stage: "fully_paid",
      fault: "couple",
      paidAmount: 10_000_000,
      penalty: basis({ contractPenalty: 500_000 }),
    });

    expect(result.penaltyAmount).toBe(500_000);
  });

  it("가정치 룰을 쓰면 그 사실이 결과에 남는다", () => {
    const result = settleCancellation({
      stage: "fully_paid",
      fault: "couple",
      paidAmount: 10_000_000,
      penalty: basis({ isDraftRules: true }),
    });

    expect(result.notes.join()).toContain("가정치");
  });

  it("모든 결과에 법률 자문이 아니라는 고지가 붙는다", () => {
    for (const fault of FAULT_PARTIES) {
      const result = settleCancellation({
        stage: "fully_paid",
        fault,
        paidAmount: 1_000_000,
        penalty: basis(),
      });

      expect(result.disclaimer).toContain(DISCLAIMER_REQUIRED_PHRASE);
    }
  });

  it("음수·소수 금액은 거절한다", () => {
    expect(() =>
      settleCancellation({
        stage: "fully_paid",
        fault: "couple",
        paidAmount: -1,
        penalty: basis(),
      }),
    ).toThrow(CancellationError);
  });

  it("T-04 위약금 엔진 결과를 그대로 받아 정산한다", () => {
    const penalty = calculatePenalty(
      {
        category: "hall",
        totalAmount: 10_000_000,
        depositAmount: 2_000_000,
        eventDate: "2026-10-01",
        cancelDate: "2026-08-13",
        contractTerm: { kind: "none" },
      },
      getDraftPenaltyRuleSet("hall"),
    );

    const result = settleCancellation({
      stage: "partially_paid",
      fault: "couple",
      paidAmount: 2_000_000,
      penalty: {
        standardPenalty: penalty.standard.penalty,
        contractPenalty: penalty.contract.penalty,
        bandCode: penalty.bandCode,
        bandLabel: penalty.bandLabel,
        basisRef: penalty.basisRef,
        ruleVersion: penalty.ruleVersion,
        isDraftRules: true,
      },
    });

    // 49일 전 → D30_59 구간(20%) = 2,000,000. 낸 돈과 같아 환불도 청구도 0이다.
    expect(penalty.bandCode).toBe("D30_59");
    expect(result.penaltyAmount).toBe(2_000_000);
    expect(result.refundAmount).toBe(0);
    expect(result.balanceDue).toBe(0);
  });
});

describe("환불 배분 — 나중 회차부터", () => {
  const payments = [
    { paymentId: "p1", seq: 1, amount: 2_000_000, refundedAmount: 0 },
    { paymentId: "p2", seq: 2, amount: 8_000_000, refundedAmount: 0 },
  ];

  it("잔금부터 돌려준다 — 계약금이 마지막까지 남는다", () => {
    const allocation = allocateRefund(payments, 8_000_000);

    expect(allocation.lines).toEqual([{ paymentId: "p2", seq: 2, amount: 8_000_000 }]);
    expect(allocation.shortfall).toBe(0);
  });

  it("잔금으로 모자라면 계약금까지 내려온다", () => {
    const allocation = allocateRefund(payments, 9_000_000);

    expect(allocation.lines).toEqual([
      { paymentId: "p2", seq: 2, amount: 8_000_000 },
      { paymentId: "p1", seq: 1, amount: 1_000_000 },
    ]);
    expect(allocation.allocated).toBe(9_000_000);
  });

  it("이미 환불된 만큼은 빼고 배분한다", () => {
    const allocation = allocateRefund(
      [{ paymentId: "p2", seq: 2, amount: 8_000_000, refundedAmount: 7_500_000 }],
      1_000_000,
    );

    expect(allocation.allocated).toBe(500_000);
    expect(allocation.shortfall).toBe(500_000);
  });

  it("배분하지 못한 금액을 삼키지 않는다", () => {
    const allocation = allocateRefund([], 1_000_000);

    expect(allocation.lines).toHaveLength(0);
    expect(allocation.shortfall).toBe(1_000_000);
  });

  it("0원 환불은 아무 줄도 만들지 않는다", () => {
    expect(allocateRefund(payments, 0).lines).toHaveLength(0);
  });

  it("입력 순서가 뒤바뀌어도 순번대로 배분한다", () => {
    const allocation = allocateRefund([...payments].reverse(), 8_500_000);

    expect(allocation.lines[0].seq).toBe(2);
    expect(allocation.lines[1].seq).toBe(1);
  });
});

describe("양측 확인 — 무응답을 동의로 읽지 않는다", () => {
  it("둘 다 동의하면 확정이다", () => {
    expect(
      confirmationDecision({ coupleAgreed: true, vendorAgreed: true, dueAt: null, now: NOW }),
    ).toBe("agreed");
  });

  it("한쪽이 이의를 내면 즉시 조율이다", () => {
    expect(
      confirmationDecision({ coupleAgreed: true, vendorAgreed: false, dueAt: null, now: NOW }),
    ).toBe("disputed");
  });

  it("아직 응답이 없으면 대기다", () => {
    expect(
      confirmationDecision({
        coupleAgreed: true,
        vendorAgreed: null,
        dueAt: "2026-08-20T00:00:00.000Z",
        now: NOW,
      }),
    ).toBe("waiting");
  });

  it("기한이 지나면 조율로 간다 — 자동 정산하지 않는다", () => {
    expect(
      confirmationDecision({
        coupleAgreed: true,
        vendorAgreed: null,
        dueAt: "2026-08-12T00:00:00.000Z",
        now: NOW,
      }),
    ).toBe("disputed");
  });

  it("기한 당일 그 시각이면 지난 것으로 본다", () => {
    expect(
      confirmationDecision({
        coupleAgreed: null,
        vendorAgreed: null,
        dueAt: NOW.toISOString(),
        now: NOW,
      }),
    ).toBe("disputed");
  });
});

describe("정산 되돌리기 — 나간 돈은 코드가 회수하지 않는다", () => {
  it("지급 전 플래너 수수료는 무효 처리한다", () => {
    const reversal = settlementReversal({
      plannerSettlementStatus: "earned",
      vendorSettlementLinked: false,
    });

    expect(reversal.planner).toBe("void");
    expect(reversal.needsOperator).toBe(false);
  });

  it("지급 대상 상태도 무효 처리한다", () => {
    expect(
      settlementReversal({ plannerSettlementStatus: "payable", vendorSettlementLinked: false })
        .planner,
    ).toBe("void");
  });

  it("이미 지급된 수수료는 회수 대상으로 표시하고 조율로 넘긴다", () => {
    const reversal = settlementReversal({
      plannerSettlementStatus: "paid",
      vendorSettlementLinked: false,
    });

    expect(reversal.planner).toBe("recover");
    expect(reversal.needsOperator).toBe(true);
    expect(reversal.notes.join()).toContain("자동 회수하지 않고");
  });

  it("플래너가 없으면 되돌릴 것이 없다", () => {
    expect(
      settlementReversal({ plannerSettlementStatus: null, vendorSettlementLinked: false }).planner,
    ).toBe("none");
  });

  it("정산서에 실린 건은 고치지 않고 조율로 넘긴다", () => {
    const reversal = settlementReversal({
      plannerSettlementStatus: null,
      vendorSettlementLinked: true,
    });

    expect(reversal.needsOperator).toBe(true);
    expect(reversal.notes.join()).toContain("정산서를 고치지 않고");
  });

  it("쿠폰은 아직 없어 신호가 켜지지 않는다 (S5-11 자리)", () => {
    expect(
      settlementReversal({ plannerSettlementStatus: null, vendorSettlementLinked: false })
        .couponReversalPending,
    ).toBe(false);
  });
});

describe("예약 자리 — 확정에서 줄이고 해지에서 되돌린다", () => {
  it("확정되면 자리를 하나 차지한다", () => {
    expect(slotMovement({ hasSlot: true, from: "hold", to: "confirmed" }).delta).toBe(-1);
  });

  it("취소되면 자리를 되돌린다", () => {
    expect(slotMovement({ hasSlot: true, from: "confirmed", to: "cancelled" }).delta).toBe(1);
  });

  it("이행 완료는 자리를 계속 차지한다 — 지난 날짜를 다시 팔지 않는다", () => {
    expect(slotMovement({ hasSlot: true, from: "confirmed", to: "fulfilled" }).delta).toBe(0);
  });

  it("이행 완료에서 취소로 가면 되돌린다", () => {
    expect(slotMovement({ hasSlot: true, from: "fulfilled", to: "cancelled" }).delta).toBe(1);
  });

  it("자리를 쓰지 않는 예약은 움직이지 않는다", () => {
    expect(slotMovement({ hasSlot: false, from: "hold", to: "confirmed" }).delta).toBe(0);
  });

  it("같은 상태로 갱신하면 움직이지 않는다", () => {
    expect(slotMovement({ hasSlot: true, from: "confirmed", to: "confirmed" }).delta).toBe(0);
  });
});

describe("값 집합", () => {
  it("목록에 중복이 없다", () => {
    for (const list of [CANCEL_STAGES, FAULT_PARTIES, CANCELLATION_STATUSES, CANCEL_REASON_CODES]) {
      expect(new Set(list).size).toBe(list.length);
    }
  });

  it("귀책 기본값 'undecided' 가 목록에 있다", () => {
    expect(FAULT_PARTIES).toContain("undecided");
  });
});
