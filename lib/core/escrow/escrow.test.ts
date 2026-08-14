import { describe, expect, it } from "vitest";

import { ConfirmationError, confirmDueAt, pendingParties, twoSidedOutcome } from "../confirmation/two-sided";
import {
  ESCROW_PARTY_NOTICE,
  ESCROW_STATUSES,
  ESCROW_STATUS_DETAIL,
  EscrowError,
  RELEASE_CONDITION_VERSION,
  buildReleaseCondition,
  canTransition,
  decideRelease,
  isEscrowTarget,
  settlementEligible,
} from "./escrow";

const NOW = new Date("2026-08-14T00:00:00.000Z");

describe("공통 양측 판정 (S5-09 가 뽑아냈다)", () => {
  it("한쪽이라도 아니면 즉시 거절이다 — 기한을 채우게 하지 않는다", () => {
    expect(
      twoSidedOutcome({ partyA: true, partyB: false, dueAt: "2027-01-01T00:00:00Z", now: NOW }),
    ).toBe("rejected");
  });

  it("둘 다 그렇다면 일치다", () => {
    expect(twoSidedOutcome({ partyA: true, partyB: true, dueAt: null, now: NOW })).toBe("agreed");
  });

  it("기한이 지나면 timeout 이다 — 뜻은 도메인이 정한다", () => {
    expect(
      twoSidedOutcome({ partyA: true, partyB: null, dueAt: "2026-08-13T00:00:00Z", now: NOW }),
    ).toBe("timeout");
  });

  it("기한 당일 그 시각이면 지난 것으로 본다", () => {
    expect(
      twoSidedOutcome({ partyA: null, partyB: null, dueAt: NOW.toISOString(), now: NOW }),
    ).toBe("timeout");
  });

  it("기한이 없으면 계속 기다린다", () => {
    expect(twoSidedOutcome({ partyA: true, partyB: null, dueAt: null, now: NOW })).toBe("waiting");
  });

  it("읽을 수 없는 기한은 던진다", () => {
    expect(() =>
      twoSidedOutcome({ partyA: null, partyB: null, dueAt: "언젠가", now: NOW }),
    ).toThrow(ConfirmationError);
  });

  it("누구를 기다리는지 알려준다", () => {
    expect(
      pendingParties({ partyA: null, partyB: true, labelA: "고객", labelB: "업체" }),
    ).toEqual(["고객"]);
  });

  it("확인 기한은 설정 일수로 만든다 — 없으면 기한 없음이다", () => {
    expect(confirmDueAt(NOW, 7)).toBe("2026-08-21T00:00:00.000Z");
    expect(confirmDueAt(NOW, null)).toBeNull();
  });

  it("음수 기한 일수는 거절한다", () => {
    expect(() => confirmDueAt(NOW, -1)).toThrow(ConfirmationError);
  });
});

describe("예치 대상 — 잔금만이다 (F-C-16 · D-21)", () => {
  it("1회차(계약금)는 예치하지 않는다", () => {
    expect(isEscrowTarget({ seq: 1, purpose: "deposit" })).toBe(false);
  });

  it("2회차 이후(잔금)가 예치 대상이다", () => {
    expect(isEscrowTarget({ seq: 2, purpose: "balance" })).toBe(true);
    expect(isEscrowTarget({ seq: 3, purpose: "balance" })).toBe(true);
  });

  it("멤버십 결제는 이행 확인이라는 개념이 없다", () => {
    expect(isEscrowTarget({ seq: 2, purpose: "membership" })).toBe(false);
  });

  it("0 이하 순번은 거절한다", () => {
    expect(() => isEscrowTarget({ seq: 0, purpose: "balance" })).toThrow(EscrowError);
  });
});

describe("릴리즈 판정 — 무응답은 릴리즈이되 예식일이 지나야 한다", () => {
  const base = {
    coupleConfirmed: null as boolean | null,
    vendorConfirmed: null as boolean | null,
    dueAt: "2026-08-13T00:00:00.000Z",
    eventDate: "2026-08-01",
    now: NOW,
  };

  it("양측이 이행을 확인하면 릴리즈다", () => {
    const result = decideRelease({ ...base, coupleConfirmed: true, vendorConfirmed: true });

    expect(result.action).toBe("release");
    expect(result.action === "release" && result.reason).toBe("agreed");
  });

  it("예식일 전이어도 양측이 확인하면 릴리즈다 — 합의가 우선이다", () => {
    const result = decideRelease({
      ...base,
      coupleConfirmed: true,
      vendorConfirmed: true,
      eventDate: "2027-01-01",
    });

    expect(result.action).toBe("release");
  });

  it("한쪽이 이행되지 않았다고 하면 조율이다", () => {
    const result = decideRelease({ ...base, coupleConfirmed: false, vendorConfirmed: true });

    expect(result.action).toBe("dispute");
    expect(result.detail).toContain("그대로 맡겨져");
  });

  it("**무응답 + 예식일 경과면 릴리즈다** — 고객의 방치가 이득이 되지 않게", () => {
    const result = decideRelease(base);

    expect(result.action).toBe("release");
    expect(result.action === "release" && result.reason).toBe("timeout");
  });

  it("**예식일 전에는 기한이 지나도 릴리즈하지 않는다** — 이행이 없었다", () => {
    const result = decideRelease({ ...base, eventDate: "2027-01-01" });

    expect(result.action).toBe("hold");
    expect(result.action === "hold" && result.reason).toBe("before_event");
  });

  it("예식 당일은 아직 지나지 않은 것으로 본다", () => {
    const result = decideRelease({ ...base, eventDate: "2026-08-14" });

    expect(result.action).toBe("hold");
  });

  it("예식일이 미정이면 무응답 릴리즈를 하지 않는다", () => {
    const result = decideRelease({ ...base, eventDate: null });

    expect(result.action).toBe("hold");
  });

  it("기한 전이면 계속 기다린다", () => {
    const result = decideRelease({ ...base, dueAt: "2027-01-01T00:00:00.000Z" });

    expect(result.action).toBe("hold");
    expect(result.action === "hold" && result.reason).toBe("waiting");
  });

  it("이의는 예식일과 무관하게 즉시 조율이다", () => {
    const result = decideRelease({
      ...base,
      vendorConfirmed: false,
      eventDate: "2027-01-01",
      dueAt: "2027-01-01T00:00:00.000Z",
    });

    expect(result.action).toBe("dispute");
  });
});

describe("상태 전이 — 종결은 되돌리지 않는다 (D-23)", () => {
  it("보관 중에서 세 방향으로 갈 수 있다", () => {
    expect(canTransition("held", "released")).toBe(true);
    expect(canTransition("held", "refunded")).toBe(true);
    expect(canTransition("held", "disputed")).toBe(true);
  });

  it("조율에서 보관으로 돌아가지 않는다 — 이의가 있었다는 사실이 남아야 한다", () => {
    expect(canTransition("disputed", "held")).toBe(false);
  });

  it("조율 결과는 어느 쪽으로도 갈 수 있다", () => {
    expect(canTransition("disputed", "released")).toBe(true);
    expect(canTransition("disputed", "refunded")).toBe(true);
  });

  it("종결된 홀드는 어디로도 못 간다", () => {
    for (const to of ESCROW_STATUSES) {
      expect(canTransition("released", to)).toBe(false);
      expect(canTransition("refunded", to)).toBe(false);
    }
  });
});

describe("정산 연결 — 보관 중인 돈은 지급하지 않는다", () => {
  it("전부 종결됐으면 정산 대상이다", () => {
    expect(settlementEligible([{ status: "released" }, { status: "refunded" }]).ok).toBe(true);
  });

  it("홀드가 없으면 정산 대상이다", () => {
    expect(settlementEligible([]).ok).toBe(true);
  });

  it("보관 중인 홀드가 있으면 이번 정산에서 뺀다", () => {
    const result = settlementEligible([{ status: "held" }]);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("escrow_open");
    expect(result.ok === false && result.detail).toContain("다음 정산에 포함");
  });

  it("조율 중인 홀드도 정산에서 뺀다", () => {
    expect(settlementEligible([{ status: "disputed" }]).ok).toBe(false);
  });
});

describe("릴리즈 조건 — 스냅샷으로 박는다", () => {
  it("판본과 폴백 방향을 함께 남긴다", () => {
    const condition = buildReleaseCondition(7);

    expect(condition).toEqual({
      basis: "event_completed",
      confirmDueDays: 7,
      timeoutAction: "release",
      version: RELEASE_CONDITION_VERSION,
    });
  });

  it("기한 설정이 없으면 null 로 남는다 — 일수를 지어내지 않는다", () => {
    expect(buildReleaseCondition(null).confirmDueDays).toBeNull();
  });

  it("음수 기한은 거절한다", () => {
    expect(() => buildReleaseCondition(-1)).toThrow(EscrowError);
  });
});

describe("문구 — 플랫폼은 보관자다 (D-24)", () => {
  it("고지가 '맡아 두는 역할' 과 '계약 당사자가 아니다' 를 함께 말한다", () => {
    expect(ESCROW_PARTY_NOTICE).toContain("맡아 두는 역할");
    expect(ESCROW_PARTY_NOTICE).toContain("계약 당사자가 아닙니다");
  });

  it("상태 설명이 '플랫폼이 받는다' 로 읽히지 않는다", () => {
    for (const detail of Object.values(ESCROW_STATUS_DETAIL)) {
      expect(detail).not.toMatch(/플랫폼이 (돈|금액|대금)을 받/);
    }
  });

  it("보관 중 설명이 '맡겨져' 를 쓴다", () => {
    expect(ESCROW_STATUS_DETAIL.held).toContain("맡겨져");
  });
});
