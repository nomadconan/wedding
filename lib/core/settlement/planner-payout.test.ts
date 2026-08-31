import { describe, expect, it } from "vitest";

import { PLANNER_SETTLEMENT_STATUSES } from "../payment/payment";
import {
  GRACE_REASON_NOTICE,
  PAYOUT_ADAPTER_PENDING_NOTICE,
  PAYOUT_NOT_RECEIVED_NOTICE,
  PLANNER_PAYOUT_BLOCK_MESSAGE,
  PLANNER_PAYOUT_BLOCK_REASONS,
  PLANNER_RATE_SNAPSHOT_NOTICE,
  PlannerPayoutError,
  dueForPayable,
  plannerPayoutEligibility,
  plannerPayoutIdempotencyKey,
  plannerPayoutState,
  sharesPayoutVocabulary,
  summarizePlannerPayouts,
  type PlannerSettlementRow,
} from "./planner-payout";
import { PAYOUT_STATUSES, payoutIdempotencyKey } from "./settlement";

const NOW = new Date("2026-08-31T00:00:00.000Z");

function row(over: Partial<PlannerSettlementRow> = {}): PlannerSettlementRow {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    status: "earned",
    feeAmount: 270_000,
    earnedAt: "2026-08-01T00:00:00.000Z",
    payableAt: "2026-08-15T00:00:00.000Z",
    ...over,
  };
}

// =============================================================================
// 같은 값을 두 곳이 다르게 해석하지 않는다 (FIX-52 의 교훈)
// =============================================================================

describe("판정을 다시 만들지 않는다", () => {
  it("유예 판정은 lib/core/payment 의 함수를 그대로 쓴다", async () => {
    const payment = await import("../payment/payment");

    expect(plannerPayoutState).toBe(payment.plannerPayoutState);
  });

  it("**지급 상태 어휘가 업체 지급과 같다** — 운영자가 한 화면에서 둘을 본다", () => {
    expect(sharesPayoutVocabulary([...PAYOUT_STATUSES])).toBe(true);
    expect(sharesPayoutVocabulary(["pending", "paid"])).toBe(false);
    expect(sharesPayoutVocabulary(["pending", "paid", "failed", "voided"])).toBe(false);
  });

  it("멱등 열쇠의 접두어가 업체 지급과 갈린다 — 대사에서 구분돼야 한다", () => {
    const id = "22222222-2222-2222-2222-222222222222";

    expect(plannerPayoutIdempotencyKey({ plannerSettlementId: id })).toBe(
      `planner_settlement:${id}:payout:1`,
    );
    expect(plannerPayoutIdempotencyKey({ plannerSettlementId: id })).not.toBe(
      payoutIdempotencyKey({ settlementId: id }),
    );
  });

  it("**자동 재시도는 같은 열쇠를 쓴다** — 바꾸면 돈이 두 번 나간다", () => {
    const id = "22222222-2222-2222-2222-222222222222";

    expect(plannerPayoutIdempotencyKey({ plannerSettlementId: id, attempt: 1 })).toBe(
      plannerPayoutIdempotencyKey({ plannerSettlementId: id }),
    );
    expect(plannerPayoutIdempotencyKey({ plannerSettlementId: id, attempt: 2 })).not.toBe(
      plannerPayoutIdempotencyKey({ plannerSettlementId: id, attempt: 1 }),
    );
  });

  it("시도 번호가 규약을 벗어나면 던진다", () => {
    expect(() =>
      plannerPayoutIdempotencyKey({ plannerSettlementId: "x", attempt: 0 }),
    ).toThrow(PlannerPayoutError);
  });
});

// =============================================================================
// 유예 경계 — 하루가 정산 분쟁이 된다
// =============================================================================

describe("유예 경계", () => {
  it("**payable_at 정각에 지급 대상이 된다** — 하루 더 기다리면 유예가 15일이 된다", () => {
    expect(
      plannerPayoutState({ status: "earned", payableAt: NOW.toISOString(), now: NOW }),
    ).toBe("payable");
  });

  it("1밀리초 전은 아직 유예 중이다", () => {
    expect(
      plannerPayoutState({
        status: "earned",
        payableAt: "2026-08-31T00:00:00.001Z",
        now: NOW,
      }),
    ).toBe("waiting_grace");
  });

  it("지급 완료·무효는 시계와 무관하다", () => {
    expect(
      plannerPayoutState({ status: "paid", payableAt: "2099-01-01T00:00:00.000Z", now: NOW }),
    ).toBe("paid");
    expect(
      plannerPayoutState({ status: "void", payableAt: "2020-01-01T00:00:00.000Z", now: NOW }),
    ).toBe("void");
  });
});

// =============================================================================
// 합계 — payable 과 paid 를 합치지 않는다
// =============================================================================

describe("합계", () => {
  const rows = [
    row({ id: "a", status: "earned", payableAt: "2026-09-30T00:00:00.000Z", feeAmount: 100 }),
    row({ id: "b", status: "earned", payableAt: "2026-08-15T00:00:00.000Z", feeAmount: 200 }),
    row({ id: "c", status: "payable", payableAt: "2026-08-01T00:00:00.000Z", feeAmount: 300 }),
    row({ id: "d", status: "paid", payableAt: "2026-08-01T00:00:00.000Z", feeAmount: 400 }),
    row({ id: "e", status: "void", payableAt: "2026-08-01T00:00:00.000Z", feeAmount: 500 }),
  ];

  const summary = summarizePlannerPayouts(rows, NOW);

  it("유예 중은 따로 센다 — 0으로 접지 않는다", () => {
    expect(summary.waitingGrace).toEqual({ count: 1, amount: 100 });
  });

  it("**받을 수 있는 것과 받은 것을 합치지 않는다**", () => {
    // b 는 상태가 earned 지만 유예가 지났으므로 '받을 수 있음' 이다(배치가 늦어도 사실을 말한다).
    expect(summary.payable).toEqual({ count: 2, amount: 500 });
    expect(summary.paid).toEqual({ count: 1, amount: 400 });
  });

  it("무효도 따로 센다 — 다른 합계에 섞이지 않는다", () => {
    expect(summary.void).toEqual({ count: 1, amount: 500 });
  });

  it("빈 목록은 네 자리 모두 0이다 — 자리 자체가 사라지지 않는다", () => {
    expect(summarizePlannerPayouts([], NOW)).toEqual({
      waitingGrace: { count: 0, amount: 0 },
      payable: { count: 0, amount: 0 },
      paid: { count: 0, amount: 0 },
      void: { count: 0, amount: 0 },
    });
  });

  it("**'받을 수 있음' 이 받은 것이 아니라는 문구를 든다**", () => {
    expect(PAYOUT_NOT_RECEIVED_NOTICE).toContain("아직 받은 것이 아니");
  });
});

// =============================================================================
// 지급 가능 판정
// =============================================================================

describe("지급 가능 판정", () => {
  const base = { feeAmount: 270_000, hasPending: false, failedCount: 0, maxAttempts: 3 };

  it("유예가 지났고 진행 중인 시도가 없으면 지급할 수 있다", () => {
    expect(plannerPayoutEligibility({ ...base, state: "payable" })).toEqual({ ok: true });
  });

  it("**유예 중에는 막는다** — 앞당기면 회수할 수 없다", () => {
    const result = plannerPayoutEligibility({ ...base, state: "waiting_grace" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("waiting_grace");
  });

  it("이미 지급된 건과 무효 건을 막는다", () => {
    expect(plannerPayoutEligibility({ ...base, state: "paid" })).toMatchObject({
      ok: false,
      reason: "already_paid",
    });
    expect(plannerPayoutEligibility({ ...base, state: "void" })).toMatchObject({
      ok: false,
      reason: "voided",
    });
  });

  it("**진행 중인 시도가 있으면 막는다** — 둘이 승인되면 두 번 나간다", () => {
    expect(
      plannerPayoutEligibility({ ...base, state: "payable", hasPending: true }),
    ).toMatchObject({ ok: false, reason: "in_progress" });
  });

  it("0원은 보내지 않는다", () => {
    expect(
      plannerPayoutEligibility({ ...base, state: "payable", feeAmount: 0 }),
    ).toMatchObject({ ok: false, reason: "zero_amount" });
  });

  it("**재시도 상한 경계** — 2회 실패까지는 열려 있고 3회에서 닫힌다", () => {
    expect(
      plannerPayoutEligibility({ ...base, state: "payable", failedCount: 2 }),
    ).toEqual({ ok: true });
    expect(
      plannerPayoutEligibility({ ...base, state: "payable", failedCount: 3 }),
    ).toMatchObject({ ok: false, reason: "attempts_exceeded" });
  });

  it("모든 막는 이유에 문구가 있다", () => {
    for (const reason of PLANNER_PAYOUT_BLOCK_REASONS) {
      expect(PLANNER_PAYOUT_BLOCK_MESSAGE[reason].length).toBeGreaterThan(0);
    }
  });
});

// =============================================================================
// 배치 대상
// =============================================================================

describe("배치 대상", () => {
  it("유예가 지난 earned 만 고른다", () => {
    const picked = dueForPayable(
      [
        row({ id: "a", status: "earned", payableAt: "2026-08-01T00:00:00.000Z" }),
        row({ id: "b", status: "earned", payableAt: "2026-09-30T00:00:00.000Z" }),
      ],
      NOW,
    );

    expect(picked.map((item) => item.id)).toEqual(["a"]);
  });

  it("**이미 payable 인 건을 다시 담지 않는다** — updated_at 만 흔들린다", () => {
    expect(
      dueForPayable([row({ status: "payable", payableAt: "2026-08-01T00:00:00.000Z" })], NOW),
    ).toEqual([]);
  });

  it("지급 완료·무효는 담지 않는다", () => {
    expect(
      dueForPayable(
        [
          row({ status: "paid", payableAt: "2026-08-01T00:00:00.000Z" }),
          row({ status: "void", payableAt: "2026-08-01T00:00:00.000Z" }),
        ],
        NOW,
      ),
    ).toEqual([]);
  });

  it("경계 정각 건은 오늘 담는다", () => {
    expect(
      dueForPayable([row({ status: "earned", payableAt: NOW.toISOString() })], NOW),
    ).toHaveLength(1);
  });

  it("원장 상태 어휘가 넷이다", () => {
    expect(PLANNER_SETTLEMENT_STATUSES).toEqual(["earned", "payable", "paid", "void"]);
  });
});

describe("화면 문구", () => {
  it("유예의 이유를 적는다 — 왜 못 받는지 답한다", () => {
    expect(GRACE_REASON_NOTICE).toContain("환불");
  });

  it("**요율 스냅샷을 근거로 든다**(D-16)", () => {
    expect(PLANNER_RATE_SNAPSHOT_NOTICE).toContain("소급");
  });

  it("**지급 연동이 아직 없다는 사실을 숨기지 않는다**(D-28)", () => {
    expect(PAYOUT_ADAPTER_PENDING_NOTICE).toContain("실제 이체");
  });
});
