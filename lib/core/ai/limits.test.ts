import { describe, expect, it } from "vitest";

import { AI_SETTING_KEYS, conversationGate, tokenAllowance, turnAllowance } from "./limits";

describe("턴 상한 — 무료 사용자 일일 제한", () => {
  it("남은 턴이 있으면 연다", () => {
    const verdict = turnAllowance({ usedToday: 3, freeDailyTurns: 10, membership: "free" });

    expect(verdict).toEqual({ ok: true, remaining: 7 });
  });

  it("다 쓰면 막는다", () => {
    const verdict = turnAllowance({ usedToday: 10, freeDailyTurns: 10, membership: "free" });

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("daily_limit");
  });

  it("**설정이 없으면 무제한이 아니라 막힌다** — 없는 상한을 무제한으로 읽으면 상한이 사라진다", () => {
    const verdict = turnAllowance({ usedToday: 0, freeDailyTurns: null, membership: "free" });

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("unconfigured");
  });

  it("멤버십은 턴 무제한이다 — 0이 아니라 null 이다", () => {
    expect(turnAllowance({ usedToday: 999, freeDailyTurns: 10, membership: "member" })).toEqual({
      ok: true,
      remaining: null,
    });
  });
});

describe("세션 토큰 상한 — 등급과 무관하다", () => {
  it("남은 토큰이 있으면 연다", () => {
    expect(tokenAllowance({ sessionTokens: 1_000, cap: 50_000 })).toEqual({
      ok: true,
      remaining: 49_000,
    });
  });

  it("상한에 닿으면 막는다", () => {
    const verdict = tokenAllowance({ sessionTokens: 50_000, cap: 50_000 });

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("session_cap");
  });

  it("설정이 없으면 막는다 — 비용 사고는 한 세션에서 난다", () => {
    const verdict = tokenAllowance({ sessionTokens: 0, cap: null });

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("unconfigured");
  });
});

describe("대화 게이트 — 토큰을 먼저 본다", () => {
  it("멤버십이어도 세션 토큰 상한에 걸린다", () => {
    const gate = conversationGate({
      usedToday: 0,
      sessionTokens: 60_000,
      freeDailyTurns: 10,
      sessionTokenCap: 50_000,
      membership: "member",
    });

    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.reason).toBe("session_cap");
  });

  it("둘 다 남아 있으면 남은 양을 함께 돌려준다", () => {
    const gate = conversationGate({
      usedToday: 2,
      sessionTokens: 1_000,
      freeDailyTurns: 10,
      sessionTokenCap: 50_000,
      membership: "free",
    });

    expect(gate).toEqual({ ok: true, turnsRemaining: 8, tokensRemaining: 49_000 });
  });

  it("토큰 설정이 없으면 멤버십도 못 연다", () => {
    const gate = conversationGate({
      usedToday: 0,
      sessionTokens: 0,
      freeDailyTurns: 10,
      sessionTokenCap: null,
      membership: "member",
    });

    expect(gate.ok).toBe(false);
  });

  it("막힐 때 사용자에게 보일 문장을 함께 준다 — 이유 없는 차단은 고장으로 읽힌다", () => {
    const gate = conversationGate({
      usedToday: 10,
      sessionTokens: 0,
      freeDailyTurns: 10,
      sessionTokenCap: 50_000,
      membership: "free",
    });

    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.notice.length).toBeGreaterThan(0);
  });
});

describe("파라미터 키 — 값이 아니라 키만 코드가 갖는다", () => {
  it("§7.4 가 정한 키 이름 그대로다", () => {
    expect(AI_SETTING_KEYS.freeDailyTurns.key).toBe("ai.free_daily_turns");
    expect(AI_SETTING_KEYS.sessionTokenCap.key).toBe("ai.session_token_cap");
  });
});
