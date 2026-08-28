import { describe, expect, it } from "vitest";

import {
  ALERT_DELIVERY,
  BATCH_SPECS,
  BATCH_STATES,
  type BatchRun,
  buildAlerts,
  buildBatchRows,
} from "./monitor";

const ALL = BATCH_SPECS.map((spec) => spec.name);
const SCHEDULED = BATCH_SPECS.filter((spec) => spec.cron !== null).map((spec) => spec.name);

const run = (over: Partial<BatchRun> = {}): BatchRun => ({
  name: "purge-documents",
  status: "succeeded",
  startedAt: "2026-08-28T10:00:00.000Z",
  finishedAt: "2026-08-28T10:00:05.000Z",
  processedCount: 3,
  errorSummary: null,
  ...over,
});

const rowsOf = (input: Partial<Parameters<typeof buildBatchRows>[0]> = {}) =>
  buildBatchRows({ routes: ALL, scheduled: SCHEDULED, runs: [], ...input });

// ══════════════════════════════════════════════════════════════════════════
// "만들었다" 와 "돈다" 와 "돌았다" 는 다른 상태다
// ══════════════════════════════════════════════════════════════════════════

describe("buildBatchRows", () => {
  it("**라우트가 없으면 코드 없음이다** — 주기가 와도 부를 것이 없다", () => {
    const rows = buildBatchRows({ routes: [], scheduled: SCHEDULED, runs: [] });

    expect(rows.every((row) => row.state === "no_route")).toBe(true);
  });

  it("**라우트는 있는데 등록이 안 됐으면 아무도 안 부른다**", () => {
    const rows = buildBatchRows({ routes: ALL, scheduled: [], runs: [] });

    expect(rows.every((row) => row.state === "not_scheduled")).toBe(true);
  });

  it("**등록됐는데 기록이 없으면 '실행 없음' 이다** — 0회가 아니라 다른 상태다", () => {
    const purge = rowsOf().find((row) => row.name === "purge-documents");

    expect(purge?.state).toBe("never_ran");
    expect(purge?.lastRun).toBeNull();
  });

  it("기록이 있으면 실행됨이고 마지막 실행이 붙는다", () => {
    const purge = rowsOf({ runs: [run()] }).find((row) => row.name === "purge-documents");

    expect(purge?.state).toBe("ran");
    expect(purge?.lastRun?.status).toBe("succeeded");
  });

  it("**가장 최근 실행을 고른다** — 순서가 흔들리면 화면이 옛 결과를 말한다", () => {
    const purge = rowsOf({
      runs: [
        run({ startedAt: "2026-08-27T00:00:00.000Z", status: "failed" }),
        run({ startedAt: "2026-08-28T00:00:00.000Z", status: "succeeded" }),
      ],
    }).find((row) => row.name === "purge-documents");

    expect(purge?.lastRun?.status).toBe("succeeded");
  });

  it("**성공이 뒤따랐어도 실패 횟수를 남긴다** — 실패가 있었다는 사실이 신호다", () => {
    const purge = rowsOf({
      runs: [run({ status: "failed" }), run({ startedAt: "2026-08-28T11:00:00.000Z" })],
    }).find((row) => row.name === "purge-documents");

    expect(purge?.state).toBe("ran");
    expect(purge?.recentFailures).toBe(1);
  });

  it("라우트가 없는 배치는 cron 도 없다 (명세 §4.5 를 그대로 옮겼다)", () => {
    const noCron = BATCH_SPECS.filter((spec) => spec.cron === null).map((spec) => spec.name);

    expect(noCron).toEqual(["settlement-aggregate", "planner-payout-due", "wishlist-price-watch"]);
  });

  it("배치 열 종이 각각 **안 돌면 무엇이 깨지는지**를 적는다", () => {
    for (const spec of BATCH_SPECS) {
      expect(spec.consequence.length).toBeGreaterThan(15);
      expect(spec.purpose.length).toBeGreaterThan(5);
    }
    expect(BATCH_SPECS).toHaveLength(10);
  });

  it("상태가 넷이다", () => {
    expect([...BATCH_STATES]).toEqual(["no_route", "not_scheduled", "never_ran", "ran"]);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 경보 — 계산이고, 보내지 않는다
// ══════════════════════════════════════════════════════════════════════════

describe("buildAlerts", () => {
  const healthy = rowsOf({ runs: BATCH_SPECS.map((spec) => run({ name: spec.name })) });

  it("전부 정상이면 경보가 없다", () => {
    expect(buildAlerts({ batches: healthy, purgeOverdue: 0, loginFailures: [] })).toEqual([]);
  });

  it("**법적 의무가 걸린 배치가 안 도는 것이 critical 이다** — 실패보다 먼저 본다", () => {
    const alerts = buildAlerts({ batches: rowsOf(), purgeOverdue: 0, loginFailures: [] });
    const purge = alerts.find((alert) => alert.key.includes("purge-documents"));

    expect(purge?.severity).toBe("critical");
    expect(purge?.title).toContain("돌지 않고");
  });

  it("**법적 의무가 없는 배치는 안 돌아도 경보가 아니다** — 경보가 소음이 되면 안 본다", () => {
    const alerts = buildAlerts({ batches: rowsOf(), purgeOverdue: 0, loginFailures: [] });

    expect(alerts.filter((alert) => alert.key.startsWith("batch_not_running")).length).toBe(1);
  });

  it("마지막 실행이 실패면 경보다", () => {
    const rows = rowsOf({
      runs: BATCH_SPECS.map((spec) =>
        run({ name: spec.name, status: spec.name === "sla-escalation" ? "failed" : "succeeded" }),
      ),
    });
    const alerts = buildAlerts({ batches: rows, purgeOverdue: 0, loginFailures: [] });

    expect(alerts.some((alert) => alert.key === "batch_failed:sla-escalation")).toBe(true);
    expect(alerts.find((alert) => alert.key === "batch_failed:sla-escalation")?.severity).toBe(
      "warning",
    );
  });

  it("**파기 잔존은 배치 상태와 별도 신호다** — 배치가 성공해도 남은 문서가 있으면 사실이다", () => {
    const alerts = buildAlerts({ batches: healthy, purgeOverdue: 2, loginFailures: [] });

    expect(alerts.some((alert) => alert.key === "purge_overdue")).toBe(true);
    expect(alerts.find((alert) => alert.key === "purge_overdue")?.severity).toBe("critical");
  });

  it("**자격증명 실패는 경보가 아니다** — 비밀번호를 틀리는 것은 정상이다", () => {
    const alerts = buildAlerts({
      batches: healthy,
      purgeOverdue: 0,
      loginFailures: [{ code: "AUTH_INVALID_CREDENTIALS", count: 50 }],
    });

    expect(alerts).toEqual([]);
  });

  it("**인프라 계열 실패는 경보다** — FIX-24 가 이 신호가 없어 몇 주 안 잡혔다", () => {
    const alerts = buildAlerts({
      batches: healthy,
      purgeOverdue: 0,
      loginFailures: [
        { code: "AUTH_TIMEOUT", count: 3 },
        { code: "AUTH_INVALID_CREDENTIALS", count: 40 },
      ],
    });
    const login = alerts.find((alert) => alert.key === "login_infra_failures");

    expect(login?.severity).toBe("warning");
    // 자격증명 40건은 세지 않는다.
    expect(login?.title).toContain("3번");
  });

  it("**심각도 순으로 고정한다** — 순서가 흔들리면 목록을 의심한다", () => {
    const rows = rowsOf({
      runs: BATCH_SPECS.map((spec) =>
        run({ name: spec.name, status: spec.name === "sla-escalation" ? "failed" : "succeeded" }),
      ),
    });
    const alerts = buildAlerts({
      batches: rows,
      purgeOverdue: 1,
      loginFailures: [{ code: "AUTH_TIMEOUT", count: 1 }],
    });

    expect(alerts[0].severity).toBe("critical");
    expect(alerts[alerts.length - 1].severity).toBe("warning");
  });
});

describe("ALERT_DELIVERY", () => {
  it("**경보를 보내지 않는다는 사실을 들고 다닌다**(D-28 · D-147)", () => {
    expect(ALERT_DELIVERY.available).toBe(false);
    expect(ALERT_DELIVERY.reason).toContain("구분되지 않습니다");
  });
});
