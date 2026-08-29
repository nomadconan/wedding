import { describe, expect, it } from "vitest";

import {
  BOOKING_DECISIONS,
  type BookingStatus,
  DECIDE_BLOCK_MESSAGE,
  type EntryFacts,
  ISSUE_BLOCK_MESSAGE,
  VENDOR_LANES,
  bookingTimeline,
  canDecide,
  canIssueContract,
  decisionOf,
  entryPoints,
  groupByLane,
  laneOf,
} from "./console";

const booking = (over: Partial<{ status: BookingStatus; acceptedAt: string | null; declinedAt: string | null }> = {}) => ({
  status: "hold" as BookingStatus,
  acceptedAt: null as string | null,
  declinedAt: null as string | null,
  ...over,
});

// ══════════════════════════════════════════════════════════════════════════
// 승인과 확정은 다른 사건이다 (D-36)
// ══════════════════════════════════════════════════════════════════════════

describe("decisionOf", () => {
  it("아무 결정도 없으면 대기다", () => {
    expect(decisionOf(booking())).toBe("pending");
  });

  it("승인 시각이 있으면 승인이다", () => {
    expect(decisionOf(booking({ acceptedAt: "2026-08-01T00:00:00.000Z" }))).toBe("accepted");
  });

  it("**거절이 승인을 이긴다** — 둘 다 서면 표가 이미 깨진 것이고, 화면은 나쁜 쪽을 말한다", () => {
    expect(
      decisionOf({ acceptedAt: "2026-08-01T00:00:00.000Z", declinedAt: "2026-08-02T00:00:00.000Z" }),
    ).toBe("declined");
  });

  it("결정은 셋뿐이다", () => {
    expect([...BOOKING_DECISIONS]).toEqual(["pending", "accepted", "declined"]);
  });
});

describe("canDecide", () => {
  it("대기 중인 `hold` 만 결정할 수 있다", () => {
    expect(canDecide(booking())).toEqual({ allowed: true, reason: null });
  });

  it("**이미 승인한 예약은 다시 결정하지 못한다** — 승인은 되돌릴 수 없다(D-23)", () => {
    expect(canDecide(booking({ acceptedAt: "2026-08-01T00:00:00.000Z" })).reason).toBe(
      "already_accepted",
    );
  });

  it("**이미 거절한 예약도 마찬가지다** — 되살리려면 새 예약을 만든다", () => {
    expect(
      canDecide(booking({ declinedAt: "2026-08-01T00:00:00.000Z", status: "cancelled" })).reason,
    ).toBe("already_declined");
  });

  it("**계약이 확정된 뒤에는 결정할 것이 없다** — 살아 있는 버튼이면 장식이다(D-143)", () => {
    expect(canDecide(booking({ status: "confirmed" })).reason).toBe("not_open");
  });

  it("막는 이유마다 사람이 읽을 문장이 있다", () => {
    for (const message of Object.values(DECIDE_BLOCK_MESSAGE)) {
      expect(message.length).toBeGreaterThan(10);
    }
  });
});

describe("canIssueContract", () => {
  const base = { status: "hold" as BookingStatus, acceptedAt: null, declinedAt: null, hasLiveContract: false };

  it("**승인 없이는 발행할 수 없다** — 이 문이 없으면 승인 버튼이 장식이 된다", () => {
    expect(canIssueContract(base).reason).toBe("not_accepted");
  });

  it("승인하면 발행할 수 있다", () => {
    expect(canIssueContract({ ...base, acceptedAt: "2026-08-01T00:00:00.000Z" })).toEqual({
      allowed: true,
      reason: null,
    });
  });

  it("**거절이 승인보다 먼저 판정된다**", () => {
    expect(
      canIssueContract({
        ...base,
        acceptedAt: "2026-08-01T00:00:00.000Z",
        declinedAt: "2026-08-02T00:00:00.000Z",
      }).reason,
    ).toBe("declined");
  });

  it("살아 있는 계약이 있으면 또 발행하지 않는다 (예약당 유효 계약 하나 · D-21)", () => {
    expect(
      canIssueContract({ ...base, acceptedAt: "2026-08-01T00:00:00.000Z", hasLiveContract: true })
        .reason,
    ).toBe("already_issued");
  });

  it("막는 이유마다 사람이 읽을 문장이 있다", () => {
    for (const message of Object.values(ISSUE_BLOCK_MESSAGE)) {
      expect(message.length).toBeGreaterThan(8);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 진입점 — 다섯 기능이 이 화면 없이는 갈 곳이 없었다
// ══════════════════════════════════════════════════════════════════════════

const facts = (over: Partial<EntryFacts> = {}): EntryFacts => ({
  bookingId: "b1",
  status: "hold",
  acceptedAt: null,
  declinedAt: null,
  contractId: null,
  contractActive: false,
  hasPayableSchedule: false,
  escrowEnabled: false,
  hasEscrowHold: false,
  reviewable: false,
  reviewBlockedReason: "계약이 확정된 거래에만 쓸 수 있어요.",
  ...over,
});

describe("entryPoints", () => {
  it("**다섯 문을 전부 그린다** — 못 가는 문도 지우지 않는다", () => {
    const entries = entryPoints(facts());

    expect(entries.map((entry) => entry.key)).toEqual([
      "contract",
      "checkout",
      "cancel",
      "escrow",
      "review",
    ]);
  });

  it("**막힌 문에는 이유가 반드시 붙는다** — 감추면 '그런 기능이 없다' 로 읽힌다", () => {
    for (const entry of entryPoints(facts())) {
      expect(entry.open).toBe(false);
      expect(entry.blocked).not.toBeNull();
      expect((entry.blocked ?? "").length).toBeGreaterThan(5);
    }
  });

  it("승인 전과 승인 후의 계약 안내가 다르다 — 다음에 할 일이 다르기 때문이다", () => {
    const before = entryPoints(facts()).find((entry) => entry.key === "contract");
    const after = entryPoints(facts({ acceptedAt: "2026-08-01T00:00:00.000Z" })).find(
      (entry) => entry.key === "contract",
    );

    expect(before?.blocked).toContain("승인하면");
    expect(after?.blocked).toContain("발행하면");
  });

  it("계약이 생기면 계약 문이 열리고 그 계약을 가리킨다", () => {
    const entry = entryPoints(facts({ contractId: "c1" })).find((e) => e.key === "contract");

    expect(entry?.open).toBe(true);
    expect(entry?.href).toBe("/contracts/c1");
  });

  it("**낼 회차가 있어야 결제 문이 열린다** — 계약만 확정돼도 낼 것이 없을 수 있다", () => {
    const noRound = entryPoints(facts({ status: "confirmed", contractActive: true })).find(
      (entry) => entry.key === "checkout",
    );

    expect(noRound?.open).toBe(false);
    expect(noRound?.blocked).toContain("낼 회차가 없어요");

    const payable = entryPoints(
      facts({ status: "confirmed", contractActive: true, hasPayableSchedule: true }),
    ).find((entry) => entry.key === "checkout");

    expect(payable?.open).toBe(true);
  });

  it("**해지는 계약이 선 뒤의 일이다** — 계약 전 예약은 거절·만료로 끝난다", () => {
    expect(entryPoints(facts()).find((e) => e.key === "cancel")?.open).toBe(false);
    expect(entryPoints(facts({ status: "confirmed" })).find((e) => e.key === "cancel")?.open).toBe(
      true,
    );
  });

  it("**안전거래가 꺼져 있는 것과 보관된 잔금이 없는 것을 구분해 적는다**(O-03)", () => {
    const off = entryPoints(facts()).find((entry) => entry.key === "escrow");
    const on = entryPoints(facts({ escrowEnabled: true })).find((entry) => entry.key === "escrow");

    expect(off?.blocked).toContain("법무 검토");
    expect(on?.blocked).toContain("보관된 잔금이 없어요");
  });

  it("**후기가 막힌 이유는 후기 쪽이 내려 준 문장을 그대로 쓴다** — 두 곳이 다른 말을 하면 안 된다", () => {
    const entry = entryPoints(facts({ reviewBlockedReason: "이미 후기를 남겼어요." })).find(
      (e) => e.key === "review",
    );

    expect(entry?.blocked).toBe("이미 후기를 남겼어요.");
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 타임라인 — 세어서 만들고 저장하지 않는다
// ══════════════════════════════════════════════════════════════════════════

describe("bookingTimeline", () => {
  const timeline = (over = {}) =>
    bookingTimeline({
      createdAt: "2026-08-01T00:00:00.000Z",
      acceptedAt: null,
      declinedAt: null,
      declineReason: null,
      contractIssuedAt: null,
      contractActivatedAt: null,
      paidAts: [],
      cancelledAt: null,
      fulfilledAt: null,
      ...over,
    });

  it("**아직 안 일어난 일을 줄로 만들지 않는다** — 빈 줄은 실패로 읽힌다", () => {
    expect(timeline()).toHaveLength(1);
    expect(timeline()[0].label).toBe("예약 신청");
  });

  it("일어난 일만 시간순으로 늘어놓는다", () => {
    const steps = timeline({
      acceptedAt: "2026-08-02T00:00:00.000Z",
      contractIssuedAt: "2026-08-03T00:00:00.000Z",
      contractActivatedAt: "2026-08-04T00:00:00.000Z",
      paidAts: ["2026-08-05T00:00:00.000Z"],
    });

    expect(steps.map((step) => step.label)).toEqual([
      "예약 신청",
      "업체 승인",
      "계약서 발행",
      "계약 확정",
      "1회차 결제 완료",
    ]);
  });

  it("**같은 시각이면 넣은 순서를 지킨다** — 뒤집히면 '확정 뒤에 발행' 이라는 없는 일이 뜬다", () => {
    const same = "2026-08-03T00:00:00.000Z";
    const steps = timeline({ contractIssuedAt: same, contractActivatedAt: same });

    expect(steps.map((step) => step.label)).toEqual(["예약 신청", "계약서 발행", "계약 확정"]);
  });

  it("**거절 사유를 그대로 싣는다**(D-24 — 사유 없는 거절은 조율의 근거가 아니다)", () => {
    const steps = timeline({
      declinedAt: "2026-08-02T00:00:00.000Z",
      declineReason: "그 날짜에 이미 예약이 있습니다.",
    });

    expect(steps[1].detail).toBe("그 날짜에 이미 예약이 있습니다.");
  });

  it("회차 결제가 여럿이면 회차 번호가 붙는다", () => {
    const steps = timeline({
      paidAts: ["2026-08-05T00:00:00.000Z", "2026-08-20T00:00:00.000Z"],
    });

    expect(steps.map((step) => step.label)).toEqual([
      "예약 신청",
      "1회차 결제 완료",
      "2회차 결제 완료",
    ]);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 업체 보드
// ══════════════════════════════════════════════════════════════════════════

describe("laneOf", () => {
  it("결정 전 `hold` 는 승인 대기다", () => {
    expect(laneOf(booking())).toBe("pending");
  });

  it("**승인했지만 계약 전인 갈래가 따로 있다** — 여기 쌓이면 업체가 발행을 잊은 것이다", () => {
    expect(laneOf(booking({ acceptedAt: "2026-08-01T00:00:00.000Z" }))).toBe("accepted");
  });

  it("계약이 확정되면 진행 중이다", () => {
    expect(laneOf(booking({ status: "confirmed", acceptedAt: "2026-08-01T00:00:00.000Z" }))).toBe(
      "live",
    );
  });

  it.each(["cancelled", "fulfilled"] as const)("%s 는 종료다", (status) => {
    expect(laneOf(booking({ status }))).toBe("closed");
  });
});

describe("groupByLane", () => {
  it("**0건인 갈래도 줄을 남긴다** — 갈래가 사라진 것과 0건인 것은 다른 뜻이다", () => {
    const groups = groupByLane([booking()]);

    expect(groups.map((group) => group.lane)).toEqual([...VENDOR_LANES]);
    expect(groups.find((group) => group.lane === "pending")?.rows).toHaveLength(1);
    expect(groups.find((group) => group.lane === "live")?.rows).toHaveLength(0);
  });

  it("갈래마다 무엇이 담기는지 문장이 붙는다", () => {
    for (const group of groupByLane([])) {
      expect(group.hint.length).toBeGreaterThan(10);
    }
  });
});
