import { describe, expect, it } from "vitest";

import {
  LEAD_TIME_NOTE_MAX,
  LEAD_TIME_SANITY_MAX_DAYS,
  leadTimeOf,
  leadTimeProblems,
  orderDeadline,
  orderDeadlineCaption,
} from "./lead-time";

const note = "제작에 4주가 걸려요.";

describe("주문 기한 역산 — 예식일 − 리드타임", () => {
  it("예식일과 리드타임이 있으면 날짜를 낸다", () => {
    const result = orderDeadline({
      weddingDate: "2027-05-15",
      leadTime: { days: 30, note },
    });

    expect(result.kind).toBe("deadline");
    if (result.kind !== "deadline") return;
    expect(result.date).toBe("2027-04-15");
    expect(result.leadTimeDays).toBe(30);
    expect(result.note).toBe(note);
  });

  it("월·연 경계를 넘어도 맞는다", () => {
    const result = orderDeadline({ weddingDate: "2027-01-10", leadTime: { days: 45, note } });

    expect(result.kind === "deadline" && result.date).toBe("2026-11-26");
  });
});

describe("네 상태를 뭉치지 않는다", () => {
  it("**업체가 안 적었으면 `not_declared`** — 0 이 아니다", () => {
    const result = orderDeadline({ weddingDate: "2027-05-15", leadTime: null });

    expect(result.kind).toBe("not_declared");
    // 날짜도 일수도 만들지 않는다.
    expect(JSON.stringify(result)).not.toContain("0");
  });

  it("**0 은 '따로 기한 없음' 이라는 진술이다** — 안 적은 것과 다르다", () => {
    const result = orderDeadline({ weddingDate: "2027-05-15", leadTime: { days: 0, note } });

    expect(result.kind).toBe("no_deadline");
    expect(result.kind === "no_deadline" && result.note).toBe(note);
    // 예식 당일이 기한이라고 말하지 않는다.
    expect(JSON.stringify(result)).not.toContain("2027-05-15");
  });

  it("**예식일이 없으면 날짜를 지어내지 않는다** — 리드타임은 그래도 말한다", () => {
    const result = orderDeadline({ weddingDate: null, leadTime: { days: 30, note } });

    expect(result.kind).toBe("no_wedding_date");
    expect(result.kind === "no_wedding_date" && result.leadTimeDays).toBe(30);
  });

  it("읽을 수 없는 예식일도 날짜를 만들지 않는다", () => {
    const result = orderDeadline({ weddingDate: "올해 봄", leadTime: { days: 30, note } });

    expect(result.kind).toBe("no_wedding_date");
  });

  it("네 상태가 **서로 다른 문구**를 낸다 — 같은 말을 하지 않는다", () => {
    const captions = [
      orderDeadline({ weddingDate: "2027-05-15", leadTime: { days: 30, note } }),
      orderDeadline({ weddingDate: "2027-05-15", leadTime: { days: 0, note } }),
      orderDeadline({ weddingDate: null, leadTime: { days: 30, note } }),
      orderDeadline({ weddingDate: "2027-05-15", leadTime: null }),
    ].map(orderDeadlineCaption);

    expect(new Set(captions).size).toBe(4);
    for (const caption of captions) expect(caption.trim().length).toBeGreaterThan(5);
  });
});

describe("값과 근거는 한 덩어리다", () => {
  it("한쪽만 있으면 리드타임이 아니다", () => {
    expect(leadTimeOf({ days: 30, note: null })).toBeNull();
    expect(leadTimeOf({ days: null, note })).toBeNull();
    expect(leadTimeOf({ days: null, note: null })).toBeNull();
  });

  it("둘 다 있으면 값이 된다 — 늘 null 을 돌려주는 함수가 아니다", () => {
    expect(leadTimeOf({ days: 0, note })).toEqual({ days: 0, note });
    expect(leadTimeOf({ days: 30, note })).toEqual({ days: 30, note });
  });
});

describe("입력 검증 — 상한이 없으면 막는다", () => {
  const maxDays = 365;

  it("정상 입력은 통과한다 — 늘 거절하는 검사가 아니다", () => {
    expect(leadTimeProblems({ days: 30, note, maxDays })).toEqual([]);
    expect(leadTimeProblems({ days: 0, note, maxDays })).toEqual([]);
  });

  it("**근거 없는 숫자를 받지 않는다** — 값이 부푸는 것을 누르는 장치다", () => {
    const problems = leadTimeProblems({ days: 30, note: null, maxDays });

    expect(problems.map((p) => p.code)).toContain("LEAD_TIME_NOTE_REQUIRED");
  });

  it("공백만 적은 근거도 근거가 아니다", () => {
    expect(
      leadTimeProblems({ days: 30, note: "   ", maxDays }).map((p) => p.code),
    ).toContain("LEAD_TIME_NOTE_REQUIRED");
  });

  it("근거만 적을 수도 없다", () => {
    expect(leadTimeProblems({ days: null, note, maxDays }).map((p) => p.code)).toContain(
      "LEAD_TIME_DAYS_REQUIRED",
    );
  });

  it("**상한이 비어 있으면 저장을 막는다** — 없는 상한을 무제한으로 읽지 않는다", () => {
    const problems = leadTimeProblems({ days: 30, note, maxDays: null });

    expect(problems.map((p) => p.code)).toContain("LEAD_TIME_CAP_UNSET");
  });

  it("**지우는 요청은 상한과 무관하다** — 값이 사라지는 것까지 막지 않는다", () => {
    expect(leadTimeProblems({ days: null, note: null, maxDays: null })).toEqual([]);
    expect(leadTimeProblems({ days: null, note: "  ", maxDays: null })).toEqual([]);
  });

  it("상한을 넘으면 거절하고 몇 일까지인지 말한다", () => {
    const problems = leadTimeProblems({ days: 366, note, maxDays });

    expect(problems.map((p) => p.code)).toContain("LEAD_TIME_TOO_LONG");
    expect(problems[0]!.message).toContain("365");
  });

  it("음수·소수를 받지 않는다", () => {
    expect(leadTimeProblems({ days: -1, note, maxDays }).map((p) => p.code)).toContain(
      "LEAD_TIME_DAYS_INVALID",
    );
    expect(leadTimeProblems({ days: 1.5, note, maxDays }).map((p) => p.code)).toContain(
      "LEAD_TIME_DAYS_INVALID",
    );
  });

  it("근거 길이 상한이 있다", () => {
    expect(
      leadTimeProblems({ days: 30, note: "가".repeat(LEAD_TIME_NOTE_MAX + 1), maxDays }).map(
        (p) => p.code,
      ),
    ).toContain("LEAD_TIME_NOTE_TOO_LONG");
    expect(
      leadTimeProblems({ days: 30, note: "가".repeat(LEAD_TIME_NOTE_MAX), maxDays }),
    ).toEqual([]);
  });

  it("상식 범위가 운영 상한보다 넓다 — 둘의 역할이 다르다", () => {
    // DB CHECK 은 상식, `app_settings` 는 정책. 정책이 더 좁아야 바꿀 수 있다.
    expect(LEAD_TIME_SANITY_MAX_DAYS).toBeGreaterThan(maxDays);
  });
});
