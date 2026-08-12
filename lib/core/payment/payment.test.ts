import { describe, expect, it } from "vitest";

import {
  DUE_ANCHORS,
  PAYMENT_SCHEDULE_STATUSES,
  PAYMENT_STATUSES,
  PaymentError,
  buildSettlementDraft,
  decideWebhook,
  dueAtOf,
  feeBasisOf,
  installmentTotal,
  minimizeWebhook,
  payableAtOf,
  paymentIdempotencyKey,
  plannerEarning,
  plannerPayoutState,
  ratioSumOk,
  resolveGraceDays,
  resolveSplitPlans,
  scheduleState,
  splitAmount,
  webhookDedupeKey,
  type InstallmentPlan,
} from "./payment";

/**
 * 분할 결제 · 정산 · 플래너 지급 (S5-01 잔여분)
 *
 * 여기서 고정하는 것은 **돈이 새지 않는다는 사실**이다 — 회차 합은 언제나 총액과 같고,
 * 요율은 스냅샷만 쓰며, 미결정 값을 코드가 지어내지 않고, 유예는 앞당겨지지 않는다.
 */
const TWO_STEP: InstallmentPlan[] = [
  { ratioBp: 2000, anchor: "on_contract", offsetDays: 0 },
  { ratioBp: 8000, anchor: "before_event", offsetDays: 30 },
];

describe("회차 비율 합", () => {
  it("10000bp 여야 통과한다", () => {
    expect(ratioSumOk(TWO_STEP)).toBe(true);
    expect(ratioSumOk([{ ratioBp: 2000 }, { ratioBp: 7000 }])).toBe(false);
    expect(ratioSumOk([{ ratioBp: 5000 }, { ratioBp: 6000 }])).toBe(false);
  });

  it("빈 회차는 통과하지 못한다", () => {
    expect(ratioSumOk([])).toBe(false);
  });

  it("합이 어긋나면 분할 자체를 거절한다", () => {
    expect(() => splitAmount(10_000_000, [{ ratioBp: 3000, anchor: "on_contract", offsetDays: 0 }])).toThrow(
      PaymentError,
    );
  });
});

describe("분할 금액 — 합이 총액과 어긋나지 않는다", () => {
  it("나누어 떨어지면 비율 그대로다", () => {
    const result = splitAmount(10_000_000, TWO_STEP);

    expect(result.map((item) => item.amount)).toEqual([2_000_000, 8_000_000]);
    expect(installmentTotal(result)).toBe(10_000_000);
  });

  it("잔여는 마지막 회차가 흡수한다", () => {
    // 1원 × 20% = 0.2원 → 내림 0원, 나머지 1원이 마지막으로 간다.
    const result = splitAmount(1, TWO_STEP);

    expect(result.map((item) => item.amount)).toEqual([0, 1]);
    expect(installmentTotal(result)).toBe(1);
  });

  it("3회 이상 분할에서도 합이 총액과 같다", () => {
    const three: InstallmentPlan[] = [
      { ratioBp: 3333, anchor: "on_contract", offsetDays: 0 },
      { ratioBp: 3333, anchor: "on_preparation", offsetDays: null },
      { ratioBp: 3334, anchor: "before_event", offsetDays: 7 },
    ];
    const result = splitAmount(10_000_001, three);

    expect(installmentTotal(result)).toBe(10_000_001);
    // 앞 회차는 비율대로 내림, 마지막이 나머지를 안는다.
    expect(result[0].amount).toBe(Math.floor((10_000_001 * 3333) / 10_000));
    expect(result[1].amount).toBe(Math.floor((10_000_001 * 3333) / 10_000));
  });

  it("어떤 총액에서도 합이 총액과 같다 (잔여 1~9원 구간을 훑는다)", () => {
    const five: InstallmentPlan[] = [
      { ratioBp: 2000, anchor: "on_contract", offsetDays: 0 },
      { ratioBp: 2000, anchor: "on_preparation", offsetDays: null },
      { ratioBp: 2000, anchor: "on_fulfillment", offsetDays: null },
      { ratioBp: 2000, anchor: "before_event", offsetDays: 14 },
      { ratioBp: 2000, anchor: "before_event", offsetDays: 7 },
    ];

    for (let extra = 0; extra <= 9; extra += 1) {
      const total = 33_333_333 + extra;

      expect(installmentTotal(splitAmount(total, five))).toBe(total);
    }
  });

  it("총액 0원도 합이 0이다 (음수 회차를 만들지 않는다)", () => {
    const result = splitAmount(0, TWO_STEP);

    expect(result.map((item) => item.amount)).toEqual([0, 0]);
    expect(result.every((item) => item.amount >= 0)).toBe(true);
  });

  it("내림을 쓰므로 앞 회차 합이 총액을 넘지 않는다", () => {
    // 반올림이면 앞 회차가 올라가 마지막이 음수가 될 수 있다.
    const three: InstallmentPlan[] = [
      { ratioBp: 3333, anchor: "on_contract", offsetDays: 0 },
      { ratioBp: 3333, anchor: "on_preparation", offsetDays: null },
      { ratioBp: 3334, anchor: "on_fulfillment", offsetDays: null },
    ];
    const result = splitAmount(3, three);

    expect(result.map((item) => item.amount)).toEqual([0, 0, 3]);
    expect(result.every((item) => item.amount >= 0)).toBe(true);
  });

  it("순번은 1부터 붙는다", () => {
    expect(splitAmount(100, TWO_STEP).map((item) => item.seq)).toEqual([1, 2]);
  });

  it("음수·소수 총액은 거절한다", () => {
    expect(() => splitAmount(-1, TWO_STEP)).toThrow(PaymentError);
    expect(() => splitAmount(1.5, TWO_STEP)).toThrow(PaymentError);
  });

  it("기준 사건과 오프셋의 짝이 어긋나면 거절한다 (DB CHECK 와 같은 규칙)", () => {
    expect(() =>
      splitAmount(100, [{ ratioBp: 10_000, anchor: "on_contract", offsetDays: 5 }]),
    ).toThrow(PaymentError);
    expect(() =>
      splitAmount(100, [{ ratioBp: 10_000, anchor: "before_event", offsetDays: 0 }]),
    ).toThrow(PaymentError);
    expect(() =>
      splitAmount(100, [{ ratioBp: 10_000, anchor: "on_fulfillment", offsetDays: 3 }]),
    ).toThrow(PaymentError);
  });
});

describe("운영 파라미터 — 값을 지어내지 않는다", () => {
  it("설정이 없으면 회차 계획을 만들지 않는다", () => {
    expect(resolveSplitPlans(null)).toMatchObject({ ok: false, reason: "undecided" });
    expect(resolveSplitPlans({})).toMatchObject({ ok: false, reason: "undecided" });
    expect(resolveSplitPlans({ installments: [] })).toMatchObject({ ok: false, reason: "undecided" });
  });

  it("설정을 읽어 회차 계획을 만든다", () => {
    const resolved = resolveSplitPlans({
      installments: [
        { ratioBp: 2000, anchor: "on_contract", offsetDays: 0 },
        { ratioBp: 8000, anchor: "before_event", offsetDays: 30 },
      ],
    });

    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.plans).toHaveLength(2);
  });

  it("합이 어긋난 설정은 invalid 다 — 조용히 고치지 않는다", () => {
    const resolved = resolveSplitPlans({
      installments: [{ ratioBp: 5000, anchor: "on_contract", offsetDays: 0 }],
    });

    expect(resolved).toMatchObject({ ok: false, reason: "invalid" });
  });

  it("알 수 없는 기한 기준은 거절한다", () => {
    const resolved = resolveSplitPlans({
      installments: [{ ratioBp: 10_000, anchor: "someday", offsetDays: null }],
    });

    expect(resolved).toMatchObject({ ok: false, reason: "invalid" });
  });

  it("유예 일수는 설정이 갖는다. 없으면 null 이다", () => {
    expect(resolveGraceDays({ days: 14 })).toBe(14);
    expect(resolveGraceDays({ days: 0 })).toBe(0);
    expect(resolveGraceDays({ value: null })).toBeNull();
    expect(resolveGraceDays(null)).toBeNull();
    expect(resolveGraceDays({ days: -1 })).toBeNull();
  });

  it("수수료 기준(O-15)은 코드가 고르지 않는다", () => {
    const undecided = feeBasisOf({ basis: null, openIssue: "O-15" });

    expect(undecided).toMatchObject({ ok: false, reason: "undecided", openIssue: "O-15" });
    expect(feeBasisOf(null).ok).toBe(false);
    expect(feeBasisOf({ basis: "post_discount" })).toEqual({ ok: true, basis: "post_discount" });
    expect(feeBasisOf({ basis: "무엇이든" }).ok).toBe(false);
  });
});

describe("기한 — 기준 사건 + 며칠", () => {
  const context = { contractIssuedAt: "2026-09-01T00:00:00.000Z", eventDate: "2027-05-15" };

  it("계약 체결 시 회차는 계약 시각이 기한이다", () => {
    expect(dueAtOf(TWO_STEP[0], context)).toBe("2026-09-01T00:00:00.000Z");
  });

  it("예식 기준 회차는 예식일에서 오프셋을 뺀다", () => {
    expect(dueAtOf(TWO_STEP[1], context)).toBe("2027-04-15T00:00:00.000Z");
  });

  it("기준 사건이 없으면 기한을 지어내지 않는다", () => {
    expect(dueAtOf(TWO_STEP[0], { contractIssuedAt: null, eventDate: "2027-05-15" })).toBeNull();
    expect(dueAtOf(TWO_STEP[1], { contractIssuedAt: "2026-09-01T00:00:00.000Z", eventDate: null })).toBeNull();
  });

  it("사건 기준 회차는 미리 계산하지 않는다 — 서버가 그때 찍는다", () => {
    expect(dueAtOf({ ratioBp: 5000, anchor: "on_preparation", offsetDays: null }, context)).toBeNull();
    expect(dueAtOf({ ratioBp: 5000, anchor: "on_fulfillment", offsetDays: null }, context)).toBeNull();
  });
});

describe("회차 상태 — 저장하지 않고 계산한다", () => {
  const now = new Date("2027-04-20T00:00:00.000Z");

  it("기한이 지나면 도래다 (경계 당일 포함)", () => {
    expect(scheduleState({ status: "scheduled", dueAt: "2027-04-15T00:00:00.000Z", now })).toBe("due");
    expect(
      scheduleState({ status: "scheduled", dueAt: "2027-04-20T00:00:00.000Z", now }),
    ).toBe("due");
  });

  it("기한이 남으면 예정이다", () => {
    expect(scheduleState({ status: "scheduled", dueAt: "2027-04-20T00:00:00.001Z", now })).toBe("upcoming");
  });

  it("기한이 없으면 미정이다 — 도래로 읽지 않는다", () => {
    expect(scheduleState({ status: "scheduled", dueAt: null, now })).toBe("unscheduled");
  });

  it("완료·취소는 저장된 상태를 그대로 쓴다", () => {
    expect(scheduleState({ status: "paid", dueAt: null, now })).toBe("paid");
    expect(scheduleState({ status: "void", dueAt: "2020-01-01T00:00:00.000Z", now })).toBe("void");
  });
});

describe("정산서 — 스냅샷 요율만 쓴다", () => {
  it("건별 스냅샷 요율로 계산하고 합계를 낸다", () => {
    const draft = buildSettlementDraft([
      { bookingId: "a", grossAmount: 10_000_000, appliedFeeRateBp: 500 },
      { bookingId: "b", grossAmount: 20_000_000, appliedFeeRateBp: 800 },
    ]);

    expect(draft.ok).toBe(true);
    if (!draft.ok) return;

    expect(draft.lines[0]).toMatchObject({ feeAmount: 500_000, netAmount: 9_500_000 });
    expect(draft.lines[1]).toMatchObject({ feeAmount: 1_600_000, netAmount: 18_400_000 });
    expect(draft.grossAmount).toBe(30_000_000);
    expect(draft.feeAmount).toBe(2_100_000);
    expect(draft.netAmount).toBe(27_900_000);
  });

  it("요율이 건마다 달라도 순액 합은 총액 - 수수료 합이다", () => {
    const draft = buildSettlementDraft([
      { bookingId: "a", grossAmount: 3_333_333, appliedFeeRateBp: 733 },
      { bookingId: "b", grossAmount: 1_777_777, appliedFeeRateBp: 512 },
    ]);

    expect(draft.ok).toBe(true);
    if (!draft.ok) return;

    const lineNetSum = draft.lines.reduce((sum, line) => sum + line.netAmount, 0);

    expect(draft.netAmount).toBe(lineNetSum);
    expect(draft.grossAmount - draft.feeAmount).toBe(draft.netAmount);
  });

  it("대표 요율은 실제 수수료에서 되짚는다 (요율을 평균해 다시 계산하지 않는다)", () => {
    const draft = buildSettlementDraft([
      { bookingId: "a", grossAmount: 10_000_000, appliedFeeRateBp: 500 },
      { bookingId: "b", grossAmount: 10_000_000, appliedFeeRateBp: 900 },
    ]);

    expect(draft.ok).toBe(true);
    if (!draft.ok) return;

    expect(draft.weightedFeeRateBp).toBe(700);
  });

  it("스냅샷이 없는 건이 있으면 정산서를 만들지 않는다 — 부분 결과를 내놓지 않는다", () => {
    const draft = buildSettlementDraft([
      { bookingId: "a", grossAmount: 10_000_000, appliedFeeRateBp: 500 },
      { bookingId: "b", grossAmount: 20_000_000, appliedFeeRateBp: null },
    ]);

    expect(draft).toMatchObject({ ok: false, reason: "missing_snapshot", bookingIds: ["b"] });
  });

  it("요율이 바뀌어도 스냅샷을 쓰는 한 정산액은 변하지 않는다 (D-16 회귀)", () => {
    const before = buildSettlementDraft([
      { bookingId: "a", grossAmount: 10_000_000, appliedFeeRateBp: 500 },
    ]);
    // 운영이 요율을 800bp 로 올렸다고 해도, 예약에 박힌 값은 500bp 다.
    const after = buildSettlementDraft([
      { bookingId: "a", grossAmount: 10_000_000, appliedFeeRateBp: 500 },
    ]);

    expect(before).toEqual(after);
  });

  it("빈 목록도 0원 정산서로 성립한다 (요율 없음으로 실패하지 않는다)", () => {
    const draft = buildSettlementDraft([]);

    expect(draft).toMatchObject({ ok: true, grossAmount: 0, feeAmount: 0, netAmount: 0 });
  });
});

describe("플래너 지급 — 계약 성사 + 유예", () => {
  it("유예를 더해 지급 시점을 만든다", () => {
    expect(payableAtOf("2026-09-01T00:00:00.000Z", 14)).toBe("2026-09-15T00:00:00.000Z");
    expect(payableAtOf("2026-09-01T00:00:00.000Z", 0)).toBe("2026-09-01T00:00:00.000Z");
  });

  it("유예가 규약을 벗어나면 던진다", () => {
    expect(() => payableAtOf("2026-09-01T00:00:00.000Z", -1)).toThrow(PaymentError);
    expect(() => payableAtOf("어제", 14)).toThrow(PaymentError);
  });

  it("경계 당일 그 시각에 지급 대상이 된다", () => {
    const payableAt = "2026-09-15T00:00:00.000Z";

    expect(
      plannerPayoutState({ status: "earned", payableAt, now: new Date("2026-09-14T23:59:59.999Z") }),
    ).toBe("waiting_grace");
    expect(
      plannerPayoutState({ status: "earned", payableAt, now: new Date(payableAt) }),
    ).toBe("payable");
  });

  it("배치가 아직 안 돌아도 시계로 판정한다", () => {
    // 상태는 earned 인데 시각은 지났다 — 화면은 '지급 대상' 이라고 말해야 한다.
    expect(
      plannerPayoutState({
        status: "earned",
        payableAt: "2026-09-15T00:00:00.000Z",
        now: new Date("2026-10-01T00:00:00.000Z"),
      }),
    ).toBe("payable");
  });

  it("지급 완료·무효는 저장된 상태를 그대로 쓴다", () => {
    expect(
      plannerPayoutState({ status: "paid", payableAt: "2026-09-15T00:00:00.000Z", now: new Date() }),
    ).toBe("paid");
    expect(
      plannerPayoutState({ status: "void", payableAt: "2026-09-15T00:00:00.000Z", now: new Date() }),
    ).toBe("void");
  });

  it("플래너를 쓰지 않은 계약은 원장을 만들지 않는다 (0원 행을 쌓지 않는다)", () => {
    expect(
      plannerEarning({
        grossAmount: 10_000_000,
        appliedPlannerFeeRateBp: 0,
        earnedAt: "2026-09-01T00:00:00.000Z",
        graceDays: 14,
      }),
    ).toBeNull();
  });

  it("스냅샷 요율로 수수료와 지급 시점을 만든다", () => {
    const earning = plannerEarning({
      grossAmount: 10_000_000,
      appliedPlannerFeeRateBp: 300,
      earnedAt: "2026-09-01T00:00:00.000Z",
      graceDays: 14,
    });

    expect(earning).toEqual({
      grossAmount: 10_000_000,
      feeRateBp: 300,
      feeAmount: 300_000,
      earnedAt: "2026-09-01T00:00:00.000Z",
      payableAt: "2026-09-15T00:00:00.000Z",
    });
  });

  it("음수 요율은 던진다", () => {
    expect(() =>
      plannerEarning({
        grossAmount: 100,
        appliedPlannerFeeRateBp: -1,
        earnedAt: "2026-09-01T00:00:00.000Z",
        graceDays: 1,
      }),
    ).toThrow(PaymentError);
  });
});

describe("멱등 · 웹훅", () => {
  it("같은 의도의 재시도는 같은 열쇠다", () => {
    const key = paymentIdempotencyKey({ scheduleId: "s1", purpose: "charge" });

    expect(paymentIdempotencyKey({ scheduleId: "s1", purpose: "charge" })).toBe(key);
  });

  it("다른 의도·다른 회차는 다른 열쇠다", () => {
    expect(paymentIdempotencyKey({ scheduleId: "s1", purpose: "charge" })).not.toBe(
      paymentIdempotencyKey({ scheduleId: "s1", purpose: "refund" }),
    );
    expect(paymentIdempotencyKey({ scheduleId: "s1", purpose: "charge" })).not.toBe(
      paymentIdempotencyKey({ scheduleId: "s2", purpose: "charge" }),
    );
  });

  it("명시적 재결제만 열쇠를 바꾼다", () => {
    expect(paymentIdempotencyKey({ scheduleId: "s1", purpose: "charge", attempt: 2 })).not.toBe(
      paymentIdempotencyKey({ scheduleId: "s1", purpose: "charge", attempt: 1 }),
    );
    expect(() => paymentIdempotencyKey({ scheduleId: "s1", purpose: "charge", attempt: 0 })).toThrow(
      PaymentError,
    );
  });

  it("웹훅 중복 열쇠는 provider 와 event id 로 만든다", () => {
    expect(webhookDedupeKey({ provider: "toss", eventId: "evt_1" })).toBe("toss:evt_1");
    expect(() => webhookDedupeKey({ provider: "", eventId: "evt_1" })).toThrow(PaymentError);
    expect(() => webhookDedupeKey({ provider: "toss", eventId: "  " })).toThrow(PaymentError);
  });

  it("서명을 먼저 본다 — 중복 판정보다 앞이다", () => {
    // 서명이 틀렸는데 '중복' 으로 접으면 남이 보낸 이벤트 id 로 진짜 이벤트를 막을 수 있다.
    expect(decideWebhook({ signatureOk: false, alreadyProcessed: true })).toEqual({
      action: "reject",
      reason: "bad_signature",
    });
    expect(decideWebhook({ signatureOk: true, alreadyProcessed: true })).toEqual({
      action: "skip",
      reason: "duplicate",
    });
    expect(decideWebhook({ signatureOk: true, alreadyProcessed: false })).toEqual({ action: "process" });
  });

  it("웹훅 원문에서 보관 대상만 남긴다", () => {
    const snapshot = minimizeWebhook({
      provider: "toss",
      eventId: "evt_1",
      status: "DONE",
      amount: 2_000_000,
      currency: "KRW",
      approvedAt: "2026-09-01T00:00:00.000Z",
      // 아래는 전부 빠져야 한다 — 식별정보이거나 중첩 객체다.
      customerName: "홍길동",
      customerMobilePhone: "01012345678",
      card: { number: "1234-****-****-5678" },
      receipt: { url: "https://..." },
    });

    expect(Object.keys(snapshot).sort()).toEqual(
      ["amount", "approvedAt", "currency", "eventId", "provider", "status"].sort(),
    );
    expect(JSON.stringify(snapshot)).not.toContain("홍길동");
    expect(JSON.stringify(snapshot)).not.toContain("1234");
  });
});

describe("값 집합", () => {
  it("상태 목록에 중복이 없다", () => {
    for (const list of [PAYMENT_STATUSES, PAYMENT_SCHEDULE_STATUSES, DUE_ANCHORS]) {
      expect(new Set(list).size).toBe(list.length);
    }
  });

  it("회차 상태에 '연체'가 없다 — 계산되는 값을 저장하지 않는다", () => {
    expect(PAYMENT_SCHEDULE_STATUSES).not.toContain("overdue");
    expect(PAYMENT_SCHEDULE_STATUSES).not.toContain("due");
  });
});
