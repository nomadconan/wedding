import { describe, expect, it } from "vitest";

import {
  HOME_PENDING_SECTIONS,
  HOME_TASK_LIMIT,
  dDay,
  dDayState,
  homeTasks,
  pendingMetric,
  type HomeFacts,
} from "../schemas/home";

const facts = (overrides: Partial<HomeFacts> = {}): HomeFacts => ({
  onboardingComplete: true,
  weddingDateDecided: true,
  partnerLinked: true,
  cartItemCount: 1,
  comparableCount: 1,
  ...overrides,
});

describe("D-day", () => {
  it("오늘을 인자로 받는다 — 서버가 정하지 않는다", () => {
    expect(dDay("2026-08-10", "2027-05-05")).toBe(268);
  });

  it("당일은 0이다", () => {
    expect(dDayState("2027-05-05", "2027-05-05")).toEqual({ kind: "today" });
  });

  it("지난 날짜는 passed 이고 일수는 양수로 준다", () => {
    expect(dDayState("2027-05-06", "2027-05-05")).toEqual({ kind: "passed", days: 1 });
  });

  it("예식일 미정은 0일이 아니라 undecided 다", () => {
    expect(dDayState("2026-08-10", null)).toEqual({ kind: "undecided" });
  });

  it("서머타임 경계에서도 일수가 밀리지 않는다", () => {
    expect(dDay("2027-03-13", "2027-03-15")).toBe(2);
  });

  it("형식이 틀리면 던진다", () => {
    expect(() => dDay("2026-8-10", "잘못된 값")).toThrow(RangeError);
  });
});

describe("지금 할 일", () => {
  it("아무 문제가 없으면 비어 있다 — 항상 참인 권유를 넣지 않는다", () => {
    expect(homeTasks(facts())).toEqual([]);
  });

  it("온보딩이 먼저다 — 다른 제안은 그 위에 선다", () => {
    const tasks = homeTasks(
      facts({ onboardingComplete: false, partnerLinked: false, cartItemCount: 0 }),
    );

    expect(tasks[0].code).toBe("finish_onboarding");
  });

  it("온보딩 전에는 예식일을 따로 권하지 않는다 — 온보딩 안에서 묻는다", () => {
    const codes = homeTasks(
      facts({ onboardingComplete: false, weddingDateDecided: false }),
    ).map((task) => task.code);

    expect(codes).not.toContain("decide_wedding_date");
  });

  it("온보딩을 마쳤는데 날짜가 미정이면 다시 권한다", () => {
    const codes = homeTasks(facts({ weddingDateDecided: false })).map((task) => task.code);

    expect(codes).toContain("decide_wedding_date");
  });

  it("배우자 미연동이면 초대를 권한다", () => {
    expect(homeTasks(facts({ partnerLinked: false }))[0].code).toBe("invite_partner");
  });

  it("담은 것이 없으면 담기를 권하고, 있으면 권하지 않는다", () => {
    expect(homeTasks(facts({ cartItemCount: 0 }))[0].code).toBe("add_to_cart");
    expect(homeTasks(facts({ cartItemCount: 3 }))).toEqual([]);
  });

  it("비교는 담은 것이 둘 이상일 때만 권한다", () => {
    expect(homeTasks(facts({ comparableCount: 1 }))).toEqual([]);
    expect(homeTasks(facts({ comparableCount: 2 }))[0].code).toBe("compare_cart");
  });

  it("3건을 넘기지 않는다 (§6.2)", () => {
    const tasks = homeTasks({
      onboardingComplete: false,
      weddingDateDecided: false,
      partnerLinked: false,
      cartItemCount: 0,
      comparableCount: 2,
    });

    expect(tasks).toHaveLength(HOME_TASK_LIMIT);
  });

  it("순서가 항상 같다 — 우선순위가 코드마다 다르다", () => {
    const first = homeTasks(facts({ partnerLinked: false, cartItemCount: 0 }));
    const second = homeTasks(facts({ cartItemCount: 0, partnerLinked: false }));

    expect(first.map((t) => t.code)).toEqual(second.map((t) => t.code));
    expect(first.map((t) => t.code)).toEqual(["invite_partner", "add_to_cart"]);
  });

  it("모든 할 일이 갈 곳을 갖는다", () => {
    const tasks = homeTasks({
      onboardingComplete: false,
      weddingDateDecided: false,
      partnerLinked: false,
      cartItemCount: 0,
      comparableCount: 2,
    });

    expect(tasks.every((task) => task.href.startsWith("/"))).toBe(true);
  });
});

describe("아직 채울 수 없는 자리", () => {
  it("전부 담당 태스크를 밝힌다", () => {
    expect(HOME_PENDING_SECTIONS.every((section) => /^S\d/.test(section.filledBy))).toBe(true);
  });

  it("항목 키가 겹치지 않는다", () => {
    const keys = HOME_PENDING_SECTIONS.map((section) => section.key);

    expect(new Set(keys).size).toBe(keys.length);
  });

  it("0이 아니라 '아직 측정하지 않음'으로 만든다", () => {
    const metric = pendingMetric("budget");

    expect(metric.status).toBe("not_yet");
    expect(metric).not.toMatchObject({ status: "measured" });
  });

  it("사유와 담당 태스크를 값에 담는다", () => {
    // '다음 할 일' 은 S7-08 이 채워 목록에서 빠졌다 — 남은 자리로 같은 규칙을 확인한다.
    const metric = pendingMetric("budget");

    if (metric.status !== "not_yet") throw new Error("not_yet 이어야 한다");
    expect(metric.filledBy).toBe("S7-07");
    expect(metric.reason.length).toBeGreaterThan(0);
  });

  it("모르는 항목은 던진다", () => {
    // @ts-expect-error 정의되지 않은 키를 넣으면 타입에서 먼저 막힌다.
    expect(() => pendingMetric("nope")).toThrow(RangeError);
  });
});
