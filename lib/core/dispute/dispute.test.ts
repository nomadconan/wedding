import { describe, expect, it } from "vitest";

import {
  DISPUTE_ACTIONS,
  DISPUTE_STATUSES,
  MEDIATOR_NOTICE,
  MediationActionSchema,
  UNRESOLVED_NOTICE,
  agreementState,
  canApply,
  disputeProblem,
  isTerminal,
  statusAfter,
} from "./mediation";
import {
  DISPUTE_SOURCES,
  HANDLED_AT,
  type QueueItem,
  elapsedHours,
  isOpenFor,
  queueSummary,
  sortDisputeQueue,
} from "./queue";

const NOW = new Date("2026-08-27T12:00:00.000Z");

const item = (over: Partial<QueueItem> = {}): QueueItem => ({
  source: "booking",
  id: "d1",
  status: "open",
  openedAt: "2026-08-27T10:00:00.000Z",
  amountKrw: null,
  reasonCode: "no_show",
  bookingId: "b1",
  isOpen: true,
  handledAt: "console",
  ...over,
});

// ── 큐: 어휘를 수렴시키지 않는다 ────────────────────────────────────────────

describe("isOpenFor — 출처마다 '열림' 규칙이 다르다", () => {
  it("예약 분쟁은 접수·조율 중이 열린 것이다", () => {
    expect(isOpenFor("booking", "open")).toBe(true);
    expect(isOpenFor("booking", "mediating")).toBe(true);
    expect(isOpenFor("booking", "agreed")).toBe(false);
  });

  it("**보증금·에스크로는 `disputed` 일 때만 열린다** — `held` 는 정상 보관이다", () => {
    expect(isOpenFor("consultation", "held")).toBe(false);
    expect(isOpenFor("consultation", "disputed")).toBe(true);
    expect(isOpenFor("escrow", "held")).toBe(false);
    expect(isOpenFor("escrow", "disputed")).toBe(true);
  });

  it("**같은 문자열이 출처마다 다르게 읽힌다** — 어휘를 하나로 합치지 않은 이유다", () => {
    // `open` 은 예약 분쟁에서는 열린 것이지만 보증금에는 그런 상태가 없다.
    expect(isOpenFor("booking", "open")).toBe(true);
    expect(isOpenFor("consultation", "open")).toBe(false);
  });

  it("모르는 상태는 열린 것으로 보지 않는다 — 큐를 오염시키지 않는다", () => {
    for (const source of DISPUTE_SOURCES) expect(isOpenFor(source, "made_up")).toBe(false);
  });
});

describe("HANDLED_AT — 위약금은 기존 화면으로 넘긴다", () => {
  it("취소·위약금만 /admin/penalties 다", () => {
    expect(HANDLED_AT.cancellation).toBe("penalties");
    expect(HANDLED_AT.booking).toBe("console");
    expect(HANDLED_AT.consultation).toBe("console");
    expect(HANDLED_AT.escrow).toBe("console");
  });

  it("네 출처가 전부 갈 곳을 갖는다 — 갈 곳 없는 건이 큐에 남지 않는다", () => {
    for (const source of DISPUTE_SOURCES) expect(HANDLED_AT[source]).toBeTruthy();
  });
});

describe("sortDisputeQueue", () => {
  it("열린 것이 먼저다", () => {
    const rows = [item({ id: "closed", isOpen: false }), item({ id: "open" })];

    expect(sortDisputeQueue(rows).map((r) => r.id)).toEqual(["open", "closed"]);
  });

  it("그 안에서 오래된 것부터다", () => {
    const rows = [
      item({ id: "new", openedAt: "2026-08-27T11:00:00.000Z" }),
      item({ id: "old", openedAt: "2026-08-20T11:00:00.000Z" }),
    ];

    expect(sortDisputeQueue(rows).map((r) => r.id)).toEqual(["old", "new"]);
  });

  it("**금액으로 줄을 세우지 않는다** — 작은 건이 오래 방치되는 것이 더 나쁘다", () => {
    const rows = [
      item({ id: "small", amountKrw: 30_000, openedAt: "2026-08-20T11:00:00.000Z" }),
      item({ id: "big", amountKrw: 12_000_000, openedAt: "2026-08-27T11:00:00.000Z" }),
    ];

    expect(sortDisputeQueue(rows)[0].id).toBe("small");
  });

  it("순서가 고정이다 — 같은 입력이면 같은 출력이다", () => {
    const rows = [
      item({ id: "b", source: "escrow" }),
      item({ id: "a", source: "consultation" }),
    ];

    expect(sortDisputeQueue(rows)).toEqual(sortDisputeQueue([...rows].reverse()));
  });

  it("입력을 바꾸지 않는다", () => {
    const rows = [item({ id: "x" }), item({ id: "y", isOpen: false })];
    const before = rows.map((r) => r.id);
    sortDisputeQueue(rows);

    expect(rows.map((r) => r.id)).toEqual(before);
  });
});

describe("queueSummary — 0건도 줄을 남긴다", () => {
  it("**분쟁이 없는 출처도 목록에 뜬다** — 없어서 안 뜨는 것과 큐에 안 붙은 것을 가른다(FIX-15)", () => {
    const summary = queueSummary([item({ source: "booking" })]);

    expect(summary).toHaveLength(DISPUTE_SOURCES.length);
    expect(summary.find((row) => row.source === "escrow")).toEqual({
      source: "escrow",
      label: "안전거래 이의",
      open: 0,
      total: 0,
    });
  });

  it("열린 것과 전체를 따로 센다", () => {
    const summary = queueSummary([
      item({ source: "escrow", id: "1", isOpen: true }),
      item({ source: "escrow", id: "2", isOpen: false }),
    ]);
    const escrow = summary.find((row) => row.source === "escrow");

    expect(escrow).toMatchObject({ open: 1, total: 2 });
  });

  it("빈 큐에서도 네 줄이 나온다", () => {
    expect(queueSummary([])).toHaveLength(4);
  });
});

describe("elapsedHours", () => {
  it("경과 시간을 시간 단위로 센다", () => {
    expect(elapsedHours("2026-08-27T10:00:00.000Z", NOW)).toBe(2);
  });

  it("미래 시각이 와도 음수가 되지 않는다", () => {
    expect(elapsedHours("2026-08-28T10:00:00.000Z", NOW)).toBe(0);
  });
});

// ── 조율: 플랫폼은 판정자가 아니다 ──────────────────────────────────────────

describe("조치 목록 — 판정하는 조치가 없다 (D-24)", () => {
  it("넷뿐이고 전부 **제시하거나 기록하는** 일이다", () => {
    expect([...DISPUTE_ACTIONS]).toEqual(["propose", "agree", "unresolved", "withdraw"]);
  });

  it("**'플랫폼이 정한다' 는 조치가 없다**", () => {
    for (const forbidden of ["decide", "rule", "judge", "enforce", "reject"]) {
      expect(DISPUTE_ACTIONS as readonly string[]).not.toContain(forbidden);
    }
  });

  it("조치가 상태로 옮겨진다", () => {
    expect(statusAfter("propose")).toBe("mediating");
    expect(statusAfter("agree")).toBe("agreed");
    expect(statusAfter("unresolved")).toBe("unresolved");
    expect(statusAfter("withdraw")).toBe("withdrawn");
  });

  it("종결 상태 셋", () => {
    expect(DISPUTE_STATUSES.filter(isTerminal)).toEqual(["agreed", "unresolved", "withdrawn"]);
  });

  it("**종결된 건은 되돌릴 수 없다** — 되돌리면 '그때 무엇으로 합의했나' 를 답할 수 없다", () => {
    for (const status of ["agreed", "unresolved", "withdrawn"] as const) {
      for (const action of DISPUTE_ACTIONS) expect(canApply(status, action)).toBe(false);
    }
  });

  it("조율안은 여러 번 낼 수 있다 — 한 번에 합의되는 분쟁은 드물다", () => {
    expect(canApply("mediating", "propose")).toBe(true);
  });
});

describe("disputeProblem — 양측 동의 없이는 합의가 아니다", () => {
  const base = { status: "mediating" as const, note: "조율함", coupleAgreed: true, vendorAgreed: true };

  it("문제가 없으면 null", () => {
    expect(disputeProblem({ ...base, action: "agree" })).toBeNull();
  });

  it("조치를 안 골랐으면 막는다", () => {
    expect(disputeProblem({ ...base, action: null })).not.toBeNull();
  });

  it.each([
    ["커플만", true, false],
    ["업체만", false, true],
    ["아무도", false, false],
  ])("**%s 동의하면 합의로 기록할 수 없다**", (_label, couple, vendor) => {
    const problem = disputeProblem({
      ...base,
      action: "agree",
      coupleAgreed: couple,
      vendorAgreed: vendor,
    });

    expect(problem).toContain("양측이 모두 동의");
  });

  it("합의가 아닌 조치에는 동의 여부를 묻지 않는다", () => {
    expect(
      disputeProblem({
        ...base,
        action: "unresolved",
        coupleAgreed: false,
        vendorAgreed: false,
      }),
    ).toBeNull();
  });

  it.each(DISPUTE_ACTIONS)("**%s 에도 사유가 필수다** — '조치 없음' 도 설명해야 한다", (action) => {
    expect(
      disputeProblem({ ...base, action, note: "   " }),
    ).toBe("사유를 적어 주세요.");
  });

  it("종결된 건은 이유를 밝히며 막는다", () => {
    expect(disputeProblem({ ...base, status: "agreed", action: "propose" })).toContain(
      "새 건으로 접수",
    );
  });
});

describe("MediationActionSchema", () => {
  it("사유가 있으면 통과한다", () => {
    expect(MediationActionSchema.parse({ action: "propose", note: "50% 환불 제안" }).action).toBe(
      "propose",
    );
  });

  it.each(["", "   ", "\n"])("빈 사유(%j)는 거절한다", (note) => {
    expect(() => MediationActionSchema.parse({ action: "withdraw", note })).toThrow();
  });

  it("모르는 조치는 받지 않는다 — 판정하는 조치를 만들어 보낼 수 없다", () => {
    expect(() => MediationActionSchema.parse({ action: "decide", note: "x" })).toThrow();
  });

  it("모르는 키는 통과시키지 않는다 (status 를 끼워 넣을 수 없다)", () => {
    expect(() =>
      MediationActionSchema.parse({ action: "agree", note: "x", status: "agreed" }),
    ).toThrow();
  });
});

describe("agreementState — 진행 정도를 구분한다", () => {
  it.each([
    [true, true, "양측 동의"],
    [true, false, "커플만 동의"],
    [false, true, "업체만 동의"],
    [false, false, "아직 동의 없음"],
  ])("(%s, %s) → %s", (couple, vendor, expected) => {
    expect(agreementState(couple, vendor)).toBe(expected);
  });

  it("**'아직 아무도' 와 '한쪽만' 이 같은 문장이 아니다**", () => {
    expect(agreementState(false, false)).not.toBe(agreementState(true, false));
  });
});

describe("고지 문구", () => {
  it("조율자 고지가 판정을 부인한다 (D-24)", () => {
    expect(MEDIATOR_NOTICE).toContain("조율자");
    expect(MEDIATOR_NOTICE).toContain("확정하지 않습니다");
  });

  it("**불성립 뒤 절차를 코드가 정하지 않는다** — 약관 소관임을 적는다", () => {
    expect(UNRESOLVED_NOTICE).toContain("이용약관");
    expect(UNRESOLVED_NOTICE).toContain("결정하지 않습니다");
  });
});
