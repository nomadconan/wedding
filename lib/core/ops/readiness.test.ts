import { describe, expect, it } from "vitest";

import {
  READINESS_ALL_SET,
  READINESS_KEYS,
  buildReadinessRows,
  readinessAlerts,
} from "./readiness";

/**
 * FIX-11 — 요율이 0행이면 거래가 통째로 막히는데 **그 사실을 아는 자리가 없었다.**
 * 여기서 확인하는 것은 "없을 때 말하는가" 와 "있을 때는 조용한가" 둘이다.
 * 둘 다 봐야 한다 — 없을 때만 보면 **늘 경보를 올리는 코드**도 통과한다.
 */
describe("오픈 준비 — 값이 없어서 거래가 서지 않는 자리", () => {
  it("요율이 하나도 없으면 준비되지 않은 것이다", () => {
    const rows = buildReadinessRows({ liveCommissionRates: 0, livePlannerFeeRates: 0 });

    expect(rows.every((row) => !row.ready)).toBe(true);
  });

  it("요율이 있으면 준비된 것이다 — 늘 경보하지 않는다", () => {
    const rows = buildReadinessRows({ liveCommissionRates: 1, livePlannerFeeRates: 2 });

    expect(rows.every((row) => row.ready)).toBe(true);
    expect(readinessAlerts(rows)).toEqual([]);
  });

  it("한쪽만 비어 있으면 그 줄만 경보다", () => {
    const rows = buildReadinessRows({ liveCommissionRates: 0, livePlannerFeeRates: 3 });
    const alerts = readinessAlerts(rows);

    expect(alerts).toHaveLength(1);
    expect(alerts[0].key).toBe("readiness_missing:commission_rate");
  });

  it("준비되지 않은 경보는 critical 이다 — 첫 거래에서 바로 막힌다", () => {
    const alerts = readinessAlerts(
      buildReadinessRows({ liveCommissionRates: 0, livePlannerFeeRates: 0 }),
    );

    expect(alerts).toHaveLength(2);
    expect(alerts.every((alert) => alert.severity === "critical")).toBe(true);
  });

  it("경보가 값을 넣는 화면을 가리킨다 — 읽고 나서 갈 곳이 있어야 한다", () => {
    const alerts = readinessAlerts(
      buildReadinessRows({ liveCommissionRates: 0, livePlannerFeeRates: 0 }),
    );

    expect(alerts.every((alert) => alert.href === "/admin/commission-rates")).toBe(true);
  });

  it("무슨 일이 나는지 적는다 — 코드 이름만으로는 운영자가 못 읽는다", () => {
    const rows = buildReadinessRows({ liveCommissionRates: 0, livePlannerFeeRates: 0 });
    const commission = rows.find((row) => row.key === "commission_rate");

    expect(commission?.consequence).toContain("CONTRACT_RATE_UNRESOLVED");
  });

  it("**값을 코드가 고르지 않는다** — 미결 이슈 번호를 달고 나간다(O-02)", () => {
    const rows = buildReadinessRows({ liveCommissionRates: 0, livePlannerFeeRates: 0 });

    expect(rows.every((row) => row.openIssue === "O-02")).toBe(true);
    // 기본 요율 같은 숫자가 이 모듈에 있으면 안 된다.
    for (const row of rows) {
      expect(JSON.stringify(row)).not.toMatch(/"defaultRate|fallbackBp|기본 ?요율/);
    }
  });

  it("센 값을 그대로 싣는다 — 0 과 '못 셌다' 를 섞지 않는다", () => {
    const rows = buildReadinessRows({ liveCommissionRates: 7, livePlannerFeeRates: 0 });

    expect(rows.find((row) => row.key === "commission_rate")?.liveCount).toBe(7);
    expect(rows.find((row) => row.key === "planner_fee_rate")?.liveCount).toBe(0);
  });

  it("키 목록과 만들어지는 줄이 일치한다 — 하나 더해 놓고 안 그리는 일이 없게", () => {
    const rows = buildReadinessRows({ liveCommissionRates: 1, livePlannerFeeRates: 1 });

    expect(rows.map((row) => row.key).sort()).toEqual([...READINESS_KEYS].sort());
  });

  it("다 갖춰졌을 때의 문장이 '문제 없음' 이라고 말하지 않는다", () => {
    // 이 목록 밖의 설정까지 확인했다고 읽히면 안 된다.
    expect(READINESS_ALL_SET).toContain("목록에 없는 설정까지 확인한 것은 아닙니다");
  });
});
