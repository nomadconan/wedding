import { describe, expect, it } from "vitest";

import {
  CHECKOUT_CONSENT_ITEMS,
  CONSENT_KINDS,
  COUPON_SLOT_MESSAGE,
  PAY_BLOCK_MESSAGE,
  canCancelPayment,
  chargeFailureDisposition,
  checkoutAmounts,
  consentComplete,
  couponSlotState,
  decideRefund,
  nextPayable,
  paymentProgress,
  purposeOfSeq,
  refundableAmount,
  settlementLinkage,
  viewSchedules,
  type ScheduleRow,
} from "./checkout";
import { PaymentError } from "./payment";

const NOW = new Date("2026-08-13T00:00:00.000Z");

function schedule(over: Partial<ScheduleRow> & { seq: number }): ScheduleRow {
  return {
    id: `s${over.seq}`,
    amount: 1_000_000,
    status: "scheduled",
    dueAt: "2026-08-01T00:00:00.000Z",
    ...over,
  };
}

/** 2회 분할의 기본 모양 — 1회차 도래, 2회차 미도래. */
function twoInstallments(): ScheduleRow[] {
  return [
    schedule({ seq: 1, amount: 2_000_000, dueAt: "2026-08-01T00:00:00.000Z" }),
    schedule({ seq: 2, amount: 8_000_000, dueAt: "2026-12-01T00:00:00.000Z" }),
  ];
}

describe("결제 가능 회차 — 순서·기한·진행 중", () => {
  it("계약이 확정되기 전에는 어느 회차도 결제할 수 없다", () => {
    const views = viewSchedules({
      schedules: twoInstallments(),
      contractActive: false,
      now: NOW,
    });

    expect(views.every((view) => !view.payable)).toBe(true);
    expect(views[0].blockedReason).toBe("contract_not_active");
  });

  it("첫 회차부터 결제한다", () => {
    const views = viewSchedules({ schedules: twoInstallments(), contractActive: true, now: NOW });

    expect(views[0].payable).toBe(true);
    expect(nextPayable(views)?.seq).toBe(1);
  });

  it("앞 회차가 미납이면 뒤 회차를 낼 수 없다 — 계약금을 건너뛸 수 없다", () => {
    const views = viewSchedules({ schedules: twoInstallments(), contractActive: true, now: NOW });

    expect(views[1].payable).toBe(false);
    expect(views[1].blockedReason).toBe("earlier_unpaid");
  });

  it("앞 회차를 내면 다음 회차가 열린다 — 기한이 남아도 미리 낼 수 있다", () => {
    const rows = twoInstallments();
    rows[0] = { ...rows[0], status: "paid" };

    const views = viewSchedules({ schedules: rows, contractActive: true, now: NOW });

    expect(views[1].state).toBe("upcoming");
    expect(views[1].payable).toBe(true);
    expect(nextPayable(views)?.seq).toBe(2);
  });

  it("기한이 정해지지 않은 회차는 미리 낼 수 없다 — 고지할 수 없는 것을 받지 않는다", () => {
    const rows = [
      schedule({ seq: 1, status: "paid" }),
      schedule({ seq: 2, dueAt: null }),
    ];

    const views = viewSchedules({ schedules: rows, contractActive: true, now: NOW });

    expect(views[1].state).toBe("unscheduled");
    expect(views[1].payable).toBe(false);
    expect(views[1].blockedReason).toBe("due_undecided");
  });

  it("결제가 진행 중인 회차는 다시 열지 않는다", () => {
    const rows = twoInstallments();

    const views = viewSchedules({
      schedules: rows,
      contractActive: true,
      pendingScheduleIds: ["s1"],
      now: NOW,
    });

    expect(views[0].payable).toBe(false);
    expect(views[0].blockedReason).toBe("in_progress");
  });

  it("취소된 회차는 순서를 막지 않는다", () => {
    const rows = [
      schedule({ seq: 1, status: "void" }),
      schedule({ seq: 2 }),
    ];

    const views = viewSchedules({ schedules: rows, contractActive: true, now: NOW });

    expect(views[0].blockedReason).toBe("voided");
    expect(views[1].payable).toBe(true);
  });

  it("이미 낸 회차는 다시 낼 수 없다", () => {
    const rows = twoInstallments();
    rows[0] = { ...rows[0], status: "paid" };

    const views = viewSchedules({ schedules: rows, contractActive: true, now: NOW });

    expect(views[0].blockedReason).toBe("already_paid");
  });

  it("입력 순서가 뒤바뀌어도 순번대로 판정한다", () => {
    const rows = [...twoInstallments()].reverse();

    const views = viewSchedules({ schedules: rows, contractActive: true, now: NOW });

    expect(views.map((view) => view.seq)).toEqual([1, 2]);
    expect(views[0].payable).toBe(true);
  });

  it("기한 경계 당일은 도래로 본다", () => {
    const rows = [schedule({ seq: 1, dueAt: NOW.toISOString() })];

    const views = viewSchedules({ schedules: rows, contractActive: true, now: NOW });

    expect(views[0].state).toBe("due");
    expect(views[0].payable).toBe(true);
  });

  it("막힌 이유에는 모두 문구가 있다", () => {
    for (const reason of Object.keys(PAY_BLOCK_MESSAGE)) {
      expect(PAY_BLOCK_MESSAGE[reason as keyof typeof PAY_BLOCK_MESSAGE].length).toBeGreaterThan(0);
    }
  });
});

describe("납부 진행 · 완납", () => {
  it("낸 금액과 남은 금액을 가른다", () => {
    const rows = twoInstallments();
    rows[0] = { ...rows[0], status: "paid" };

    const progress = paymentProgress(rows);

    expect(progress.totalAmount).toBe(10_000_000);
    expect(progress.paidAmount).toBe(2_000_000);
    expect(progress.remainingAmount).toBe(8_000_000);
    expect(progress.fullyPaid).toBe(false);
  });

  it("모든 회차를 내면 완납이다", () => {
    const rows = twoInstallments().map((row) => ({ ...row, status: "paid" as const }));

    expect(paymentProgress(rows).fullyPaid).toBe(true);
  });

  it("취소된 회차는 총액에도 납부액에도 세지 않는다", () => {
    const rows = [
      schedule({ seq: 1, amount: 2_000_000, status: "paid" }),
      schedule({ seq: 2, amount: 8_000_000, status: "void" }),
    ];

    const progress = paymentProgress(rows);

    expect(progress.totalAmount).toBe(2_000_000);
    expect(progress.remainingAmount).toBe(0);
    expect(progress.fullyPaid).toBe(true);
  });

  it("회차가 없으면 완납이 아니다 — 낼 것이 정해지지 않은 상태다", () => {
    expect(paymentProgress([]).fullyPaid).toBe(false);
  });
});

describe("결제 용도 — 첫 회차가 계약금", () => {
  it("1회차는 deposit, 나머지는 balance", () => {
    expect(purposeOfSeq(1)).toBe("deposit");
    expect(purposeOfSeq(2)).toBe("balance");
    expect(purposeOfSeq(5)).toBe("balance");
  });

  it("0 이하 순번은 거절한다", () => {
    expect(() => purposeOfSeq(0)).toThrow(PaymentError);
  });
});

describe("결제 실패 — 회차는 되돌리지 않는다", () => {
  it("실패해도 회차는 scheduled 로 남고 결제만 failed 다", () => {
    const disposition = chargeFailureDisposition({
      retryable: true,
      attemptCount: 1,
      maxAttempts: 3,
    });

    expect(disposition.scheduleStaysScheduled).toBe(true);
    expect(disposition.paymentStatus).toBe("failed");
    expect(disposition.retryable).toBe(true);
  });

  it("상한에 닿으면 재시도하지 않고 다음 행동을 안내한다", () => {
    const disposition = chargeFailureDisposition({
      retryable: true,
      attemptCount: 3,
      maxAttempts: 3,
    });

    expect(disposition.retryable).toBe(false);
    expect(disposition.nextAction).toContain("고객센터");
  });

  it("다시 시도해도 결과가 같은 실패는 재시도 대상이 아니다", () => {
    expect(
      chargeFailureDisposition({ retryable: false, attemptCount: 1, maxAttempts: 3 }).retryable,
    ).toBe(false);
  });
});

describe("환불 — 부분 환불을 전제한다", () => {
  it("승인된 결제만 환불한다", () => {
    const decision = decideRefund({
      status: "failed",
      amount: 1000,
      refundedAmount: 0,
      requested: 1000,
    });

    expect(decision.ok).toBe(false);
    expect(decision.ok === false && decision.reason).toBe("not_paid");
  });

  it("일부만 돌려주면 partially_refunded 다", () => {
    const decision = decideRefund({
      status: "paid",
      amount: 2_000_000,
      refundedAmount: 0,
      requested: 500_000,
    });

    expect(decision.ok).toBe(true);
    expect(decision.ok === true && decision.nextStatus).toBe("partially_refunded");
    expect(decision.ok === true && decision.refundedTotal).toBe(500_000);
  });

  it("남은 전액을 돌려주면 refunded 다 — 경계는 전액 쪽이다", () => {
    const decision = decideRefund({
      status: "partially_refunded",
      amount: 2_000_000,
      refundedAmount: 1_999_999,
      requested: 1,
    });

    expect(decision.ok === true && decision.nextStatus).toBe("refunded");
  });

  it("1원이 남으면 아직 refunded 가 아니다", () => {
    const decision = decideRefund({
      status: "paid",
      amount: 2_000_000,
      refundedAmount: 0,
      requested: 1_999_999,
    });

    expect(decision.ok === true && decision.nextStatus).toBe("partially_refunded");
  });

  it("받은 돈보다 많이 돌려줄 수 없다", () => {
    const decision = decideRefund({
      status: "paid",
      amount: 1_000_000,
      refundedAmount: 400_000,
      requested: 700_000,
    });

    expect(decision.ok === false && decision.reason).toBe("exceeds_paid");
  });

  it("이미 전액 환불된 결제는 더 돌려줄 것이 없다", () => {
    const decision = decideRefund({
      status: "partially_refunded",
      amount: 1_000_000,
      refundedAmount: 1_000_000,
      requested: 1,
    });

    expect(decision.ok === false && decision.reason).toBe("nothing_left");
  });

  it("0원·소수 환불은 거절한다", () => {
    for (const requested of [0, -1, 1.5]) {
      const decision = decideRefund({
        status: "paid",
        amount: 1000,
        refundedAmount: 0,
        requested,
      });

      expect(decision.ok === false && decision.reason).toBe("not_positive");
    }
  });

  it("환불 가능액은 낸 돈에서 이미 돌려준 것을 뺀 값이다", () => {
    expect(refundableAmount({ amount: 1000, refundedAmount: 300 })).toBe(700);
    expect(refundableAmount({ amount: 1000, refundedAmount: 1200 })).toBe(0);
  });

  it("승인 전 결제만 취소할 수 있다 — 환불과 다른 일이다", () => {
    expect(canCancelPayment("pending")).toBe(true);
    expect(canCancelPayment("paid")).toBe(false);
    expect(canCancelPayment("failed")).toBe(false);
  });
});

describe("결제 전 동의 — 기록이 본체다", () => {
  it("모든 항목에 동의해야 결제할 수 있다", () => {
    expect(consentComplete([...CONSENT_KINDS])).toBe(true);
    expect(consentComplete(["installment_terms"])).toBe(false);
    expect(consentComplete([])).toBe(false);
  });

  it("모르는 항목을 채워 넣어도 통과하지 않는다", () => {
    expect(consentComplete(["installment_terms", "something_else"])).toBe(false);
  });

  it("동의 항목마다 무엇에 동의하는지 적혀 있다", () => {
    expect(CHECKOUT_CONSENT_ITEMS).toHaveLength(CONSENT_KINDS.length);

    for (const item of CHECKOUT_CONSENT_ITEMS) {
      expect(CONSENT_KINDS).toContain(item.kind);
      expect(item.detail.length).toBeGreaterThan(10);
    }
  });

  it("동의 문구에 조항 번호를 적지 않는다 — O-03 검수 전이다", () => {
    for (const item of CHECKOUT_CONSENT_ITEMS) {
      expect(`${item.label}${item.detail}`).not.toMatch(/제\s*\d+\s*조/);
    }
  });
});

describe("쿠폰 자리 — '아직 없음' 과 '쿠폰 없음' 을 구별한다", () => {
  it("기능이 없으면 unavailable 이다", () => {
    expect(couponSlotState({ featureReady: false, applicableCount: 0 })).toBe("unavailable");
  });

  it("기능이 있는데 쓸 쿠폰이 없으면 empty 다", () => {
    expect(couponSlotState({ featureReady: true, applicableCount: 0 })).toBe("empty");
  });

  it("쓸 쿠폰이 있으면 available 이다", () => {
    expect(couponSlotState({ featureReady: true, applicableCount: 2 })).toBe("available");
  });

  it("두 상태의 문구가 서로 다르다", () => {
    expect(COUPON_SLOT_MESSAGE.unavailable).not.toBe(COUPON_SLOT_MESSAGE.empty);
    expect(COUPON_SLOT_MESSAGE.unavailable).toContain("준비 중");
  });
});

describe("금액 표시 — 총액과 이번 회차를 구분한다", () => {
  it("이번에 낼 금액과 남는 금액을 함께 만든다", () => {
    const amounts = checkoutAmounts({
      contractTotal: 10_000_000,
      installmentAmount: 2_000_000,
      paidAmount: 0,
    });

    expect(amounts.payableAmount).toBe(2_000_000);
    expect(amounts.remainingAfterThis).toBe(8_000_000);
    expect(amounts.discountAmount).toBe(0);
  });

  it("할인이 붙으면 낼 금액이 줄어든다 — 쿠폰이 열리면 이 자리다", () => {
    const amounts = checkoutAmounts({
      contractTotal: 10_000_000,
      installmentAmount: 2_000_000,
      paidAmount: 0,
      discountAmount: 300_000,
    });

    expect(amounts.payableAmount).toBe(1_700_000);
  });

  it("회차 금액보다 큰 할인은 거절한다", () => {
    expect(() =>
      checkoutAmounts({
        contractTotal: 10_000_000,
        installmentAmount: 2_000_000,
        paidAmount: 0,
        discountAmount: 2_000_001,
      }),
    ).toThrow(PaymentError);
  });

  it("음수·소수 할인은 거절한다", () => {
    expect(() =>
      checkoutAmounts({
        contractTotal: 100,
        installmentAmount: 100,
        paidAmount: 0,
        discountAmount: -1,
      }),
    ).toThrow(PaymentError);
  });

  it("마지막 회차를 내면 남는 금액이 0이다", () => {
    const amounts = checkoutAmounts({
      contractTotal: 10_000_000,
      installmentAmount: 8_000_000,
      paidAmount: 2_000_000,
    });

    expect(amounts.remainingAfterThis).toBe(0);
  });
});

describe("정산 연계 — 결제는 되고 정산은 보류된다", () => {
  it("수수료 기준이 있으면 집계할 수 있다", () => {
    expect(settlementLinkage({ feeBasisResolved: true }).ok).toBe(true);
  });

  it("수수료 기준이 없으면 보류이며 결제를 막지 않는다", () => {
    const linkage = settlementLinkage({ feeBasisResolved: false });

    expect(linkage.ok).toBe(false);
    expect(linkage.ok === false && linkage.openIssue).toBe("O-15");
    expect(linkage.ok === false && linkage.detail).toContain("결제 자체는 정상");
  });
});
