import { describe, expect, it } from "vitest";

import { MEMBERSHIP_TIERS, turnAllowance } from "../ai/limits";
import {
  BENEFIT_STATE_LABEL,
  MEMBERSHIP_BENEFITS,
  MEMBERSHIP_PLANS,
  MEMBERSHIP_REASON_NOTE,
  MEMBERSHIP_REASONS,
  daysLeft,
  differenceSummary,
  differingBenefits,
  membershipPrice,
  membershipState,
  type MembershipRow,
} from "./membership";

const NOW = "2026-08-21T12:00:00.000Z";

const row = (over: Partial<MembershipRow>): MembershipRow => ({
  plan: "premium",
  status: "active",
  startedAt: "2026-08-01T00:00:00.000Z",
  expiresAt: "2026-09-01T00:00:00.000Z",
  ...over,
});

describe("어휘 — DB 를 진실로 삼는다", () => {
  it("`membership_plan` enum 과 같다", () => {
    expect([...MEMBERSHIP_PLANS]).toEqual(["free", "premium"]);
  });

  it("**AI 상한이 쓰는 등급과 같은 어휘다** — 같은 것에 이름이 둘이면 경계마다 어긋난다", () => {
    expect([...MEMBERSHIP_TIERS]).toEqual([...MEMBERSHIP_PLANS]);
  });

  it("등급이 AI 턴 제한을 실제로 푼다", () => {
    expect(turnAllowance({ usedToday: 999, freeDailyTurns: 10, membership: "premium" })).toEqual({
      ok: true,
      remaining: null,
    });
  });
});

describe("지금 유효한 등급 — 저장값이 아니라 계산값", () => {
  it("산 적이 없으면 free 다", () => {
    expect(membershipState({ row: null, now: NOW })).toEqual({
      plan: "free",
      reason: "none",
      expiresAt: null,
      cancelPending: false,
    });
  });

  it("유효한 구독은 premium 이다", () => {
    const state = membershipState({ row: row({}), now: NOW });

    expect(state.plan).toBe("premium");
    expect(state.reason).toBe("active");
  });

  it("**기한이 지났으면 free 다** — 행이 premium 이어도 그렇다", () => {
    const state = membershipState({ row: row({ expiresAt: "2026-08-01T00:00:00.000Z" }), now: NOW });

    expect(state.plan).toBe("free");
    expect(state.reason).toBe("expired");
  });

  it("**경계는 지난 것으로 본다** — 같은 시각이면 끝난 것이다", () => {
    expect(membershipState({ row: row({ expiresAt: NOW }), now: NOW }).plan).toBe("free");
  });

  it("**해지해도 남은 기간은 쓴다** — 돈을 냈으니 그 기간은 그의 것이다", () => {
    const state = membershipState({ row: row({ status: "canceled" }), now: NOW });

    expect(state.plan).toBe("premium");
    expect(state.reason).toBe("canceled_until_expiry");
    expect(state.cancelPending).toBe(true);
  });

  it("해지했고 기한도 지났으면 free 다", () => {
    const state = membershipState({
      row: row({ status: "canceled", expiresAt: "2026-08-01T00:00:00.000Z" }),
      now: NOW,
    });

    expect(state.plan).toBe("free");
    expect(state.reason).toBe("expired");
  });

  it("**기한 없는 premium 은 유효로 본다** — 준 것을 안 준 것으로 만들지 않는다", () => {
    expect(membershipState({ row: row({ expiresAt: null }), now: NOW }).plan).toBe("premium");
  });

  it("`plan` 이 free 면 상태와 무관하게 free 다", () => {
    expect(membershipState({ row: row({ plan: "free" }), now: NOW }).reason).toBe("none");
  });

  it("`status = expired` 도 free 다", () => {
    expect(membershipState({ row: row({ status: "expired" }), now: NOW }).plan).toBe("free");
  });

  it("네 사유 모두 문구를 갖는다", () => {
    for (const reason of MEMBERSHIP_REASONS) {
      expect(MEMBERSHIP_REASON_NOTE[reason]).not.toBe("");
    }
  });
});

describe("남은 일수", () => {
  it("올림해서 준다", () => {
    expect(daysLeft("2026-08-22T00:00:00.000Z", NOW)).toBe(1);
    expect(daysLeft("2026-09-01T00:00:00.000Z", NOW)).toBe(11);
  });

  it("**지난 것은 0이고 음수가 되지 않는다**", () => {
    expect(daysLeft("2026-08-01T00:00:00.000Z", NOW)).toBe(0);
  });

  it("기한이 없으면 null 이다 — 0이 아니다", () => {
    expect(daysLeft(null, NOW)).toBeNull();
  });
});

describe("혜택 — 아무것도 닫지 않았다", () => {
  it("§2.1 이 적은 넷을 그대로 갖는다", () => {
    expect(MEMBERSHIP_BENEFITS.map((b) => b.key)).toEqual([
      "ai_turns",
      "reports",
      "price_detail",
      "priority_support",
    ]);
  });

  it("**지금 실제로 갈리는 것은 AI 턴 하나뿐이다**", () => {
    expect(differingBenefits().map((b) => b.key)).toEqual(["ai_turns"]);
  });

  it("**나머지는 '무료에도 제한이 없다' 를 그대로 적는다** — 있는 척하지 않는다", () => {
    const reports = MEMBERSHIP_BENEFITS.find((b) => b.key === "reports");

    expect(reports?.state).toBe("no_limit_yet");
    expect(reports?.note).toContain("무료에도");
  });

  it("아직 없는 기능은 없다고 적는다", () => {
    const priority = MEMBERSHIP_BENEFITS.find((b) => b.key === "priority_support");

    expect(priority?.state).toBe("not_built");
    expect(priority?.note).toContain("아직 만들지 않았");
  });

  it("혜택마다 문구가 있고 상태에 라벨이 있다", () => {
    for (const benefit of MEMBERSHIP_BENEFITS) {
      expect(benefit.note).not.toBe("");
      expect(BENEFIT_STATE_LABEL[benefit.state]).not.toBe("");
    }
  });

  it("**무엇이 달라지는지 한 줄로 말한다** — 차이를 감추지 않는다", () => {
    expect(differenceSummary()).toContain("AI 플래너 대화");
  });
});

describe("가격 — 값이 없으면 팔지 않는다", () => {
  it("값이 있으면 판다", () => {
    expect(membershipPrice({ amount: 9900, currency: "KRW" })).toEqual({
      ok: true,
      amount: 9900,
      currency: "KRW",
      cycle: "monthly",
    });
  });

  it("**값이 없으면 팔지 않는다**(O-17) — 코드가 가격을 고르지 않는다", () => {
    expect(membershipPrice({ amount: null, currency: "KRW" })).toEqual({
      ok: false,
      reason: "unconfigured",
    });
  });

  it("**0원으로 읽지 않는다** — 0원 구독은 '공짜로 준다' 인데 그렇게 정한 적이 없다", () => {
    expect(membershipPrice({ amount: 0, currency: "KRW" }).ok).toBe(false);
    expect(membershipPrice({ amount: -1, currency: "KRW" }).ok).toBe(false);
  });

  it("소수 금액을 받지 않는다", () => {
    expect(membershipPrice({ amount: 9900.5, currency: "KRW" }).ok).toBe(false);
  });

  it("통화가 없으면 KRW 로 본다", () => {
    const price = membershipPrice({ amount: 9900, currency: null });

    expect(price.ok && price.currency).toBe("KRW");
  });
});
