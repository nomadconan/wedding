import { describe, expect, it } from "vitest";

import {
  LINKED_TEMPLATE_KEYS,
  notificationLink,
} from "./links";
import {
  TASK_DUE_BLOCKED_REASON,
  TASK_DUE_SKIP_REASONS,
  emptyCounts,
  isSendPoint,
  skipSummary,
  taskDueSchedule,
} from "./task-due";

describe("발송 지점 — 시작과 간격이 정한다", () => {
  it("lead 부터 interval 만큼 내려오고 기한 당일로 끝난다", () => {
    const schedule = taskDueSchedule({ leadDays: 40, intervalDays: 14 });

    expect(schedule.kind).toBe("ready");
    if (schedule.kind !== "ready") return;
    expect([...schedule.points]).toEqual([40, 26, 12, 0]);
  });

  it("**기한 당일(0)은 산술과 무관하게 항상 들어간다**", () => {
    // 40 - 7k 는 0 을 지나지 않는다(…, 5). 가장 중요한 날을 나눗셈 때문에 놓칠 수 없다.
    const schedule = taskDueSchedule({ leadDays: 40, intervalDays: 7 });

    expect(schedule.kind === "ready" && [...schedule.points]).toEqual([
      40, 33, 26, 19, 12, 5, 0,
    ]);
  });

  it("나누어떨어질 때 0 이 두 번 들어가지 않는다", () => {
    const schedule = taskDueSchedule({ leadDays: 40, intervalDays: 10 });

    expect(schedule.kind === "ready" && [...schedule.points]).toEqual([40, 30, 20, 10, 0]);
  });

  it("lead 가 0 이면 기한 당일 한 번이다 — 그것도 유효한 정책이다", () => {
    const schedule = taskDueSchedule({ leadDays: 0, intervalDays: 7 });

    expect(schedule.kind === "ready" && [...schedule.points]).toEqual([0]);
  });
});

describe("파라미터가 없으면 아무것도 보내지 않는다", () => {
  it("**둘 중 하나만 없어도 막힌다** — 0 으로 읽지 않는다", () => {
    expect(taskDueSchedule({ leadDays: null, intervalDays: 14 })).toEqual({
      kind: "blocked",
      reason: TASK_DUE_BLOCKED_REASON,
    });
    expect(taskDueSchedule({ leadDays: 40, intervalDays: null })).toEqual({
      kind: "blocked",
      reason: TASK_DUE_BLOCKED_REASON,
    });
  });

  it("**간격 0 은 '매일' 이 아니라 무한 루프다** — 거절한다", () => {
    const schedule = taskDueSchedule({ leadDays: 40, intervalDays: 0 });

    expect(schedule.kind).toBe("blocked");
    expect(schedule.kind === "blocked" && schedule.reason).toBe("interval_invalid");
  });

  it("매일 보내려면 1 을 적는다 — 막지 않는다", () => {
    const schedule = taskDueSchedule({ leadDays: 3, intervalDays: 1 });

    expect(schedule.kind === "ready" && [...schedule.points]).toEqual([3, 2, 1, 0]);
  });

  it("음수·소수는 거절한다", () => {
    expect(taskDueSchedule({ leadDays: -1, intervalDays: 7 }).kind).toBe("blocked");
    expect(taskDueSchedule({ leadDays: 40, intervalDays: 1.5 }).kind).toBe("blocked");
  });
});

describe("지점 판정 — 정확히 맞는 날만", () => {
  const points = [40, 26, 12, 0];

  it("맞는 날에만 참이다", () => {
    for (const day of points) expect(isSendPoint(day, points)).toBe(true);
    for (const day of [41, 39, 27, 25, 13, 1]) expect(isSendPoint(day, points)).toBe(false);
  });

  it("**기한이 지났으면 보내지 않는다** — 음수는 지점이 아니다", () => {
    for (const day of [-1, -12, -40]) expect(isSendPoint(day, points)).toBe(false);
  });
});

describe("건너뛴 사유를 합치지 않는다", () => {
  it("사유마다 칸이 있다", () => {
    const counts = emptyCounts();

    expect(Object.keys(counts.skipped).sort()).toEqual([...TASK_DUE_SKIP_REASONS].sort());
    for (const reason of TASK_DUE_SKIP_REASONS) expect(counts.skipped[reason]).toBe(0);
  });

  it("**0 인 사유는 적지 않는다** — 없는 일을 세지 않는다", () => {
    const counts = emptyCounts();
    counts.skipped.done = 3;

    expect(skipSummary(counts)).toBe("done:3");
  });

  it("아무 일도 없으면 요약이 없다 — 빈 문자열을 만들지 않는다", () => {
    expect(skipSummary(emptyCounts())).toBeNull();
  });

  it("발송 실패는 맨 앞에 온다 — 건너뜀과 섞이지 않는다", () => {
    const counts = emptyCounts();
    counts.failed = 2;
    counts.skipped.no_due_date = 1;

    expect(skipSummary(counts)).toBe("send_failed:2 no_due_date:1");
  });

  it("**네 갈래가 각각 다른 칸을 갖는다**(C-4b · D-225)", () => {
    // 업체가 안 적은 것 · 기한이 없다고 적은 것 · 예식일이 없는 것은 서로 다른 사정이다.
    for (const reason of ["lead_time_not_declared", "no_order_deadline", "no_due_date"] as const) {
      expect(TASK_DUE_SKIP_REASONS).toContain(reason);
    }
  });
});

describe("이동 링크 — 없는 화면으로 보내지 않는다 (D-98)", () => {
  it("체크리스트 알림은 목록으로 간다", () => {
    expect(notificationLink("task_due.remind", {})).toEqual({
      href: "/checklist",
      label: "체크리스트에서 보기",
    });
  });

  it("상품 주문 기한 알림은 그 상품 상세로 간다", () => {
    expect(notificationLink("task_due.order", { vendorId: "v1", productId: "p1" })?.href).toBe(
      "/explore/v1/p1",
    );
  });

  it("**참조가 모자라면 링크를 만들지 않는다** — 잘못된 곳으로 보내지 않는다", () => {
    expect(notificationLink("task_due.order", { vendorId: "v1" })).toBeNull();
    expect(notificationLink("task_due.order", {})).toBeNull();
    expect(notificationLink("task_due.order", { vendorId: "", productId: "p1" })).toBeNull();
  });

  it("아직 링크가 없는 템플릿은 null 이다 — 던지지 않는다", () => {
    expect(notificationLink("dday.remind", {})).toBeNull();
    expect(notificationLink("nope.nope", { a: 1 })).toBeNull();
    expect(notificationLink(null, null)).toBeNull();
  });

  it("**분모가 실재한다** — 링크 붙은 템플릿이 0개가 아니다", () => {
    expect(LINKED_TEMPLATE_KEYS.length).toBeGreaterThan(0);
    for (const key of LINKED_TEMPLATE_KEYS) {
      expect(key).toMatch(/^[a-z_]+\.[a-z_]+$/);
    }
  });
});
