import { describe, expect, it } from "vitest";

import {
  DELETION_ACTIONS,
  DELETION_SLA_OPEN_ISSUE,
  DELETION_STATUSES,
  DeletionActionSchema,
  canApply,
  deletionProblem,
  deletionSla,
  isTerminal,
  sortQueue,
  statusAfter,
} from "./deletion";
import {
  PURGE_CRITICAL_HOURS,
  PURGE_JOB_NAME,
  type PurgeAudit,
  type PurgeOutcome,
  purgeAlerts,
  selectDuePurges,
  summarizePurgeRun,
} from "./purge";

const NOW = new Date("2026-08-27T12:00:00.000Z");
const UUID = "00000000-0000-0000-0000-0000000000a1";

const doc = (over: Partial<Parameters<typeof selectDuePurges>[0][number]> = {}) => ({
  id: "d1",
  storagePath: "contracts-raw/x.pdf",
  purgeScheduledAt: "2026-08-27T11:00:00.000Z",
  purgedAt: null,
  ...over,
});

// ── 파기 대상 고르기 ────────────────────────────────────────────────────────

describe("selectDuePurges", () => {
  it("예약 시각이 지난 것을 고른다", () => {
    expect(selectDuePurges([doc()], NOW)).toHaveLength(1);
  });

  it("아직 기한 전이면 두고 간다", () => {
    expect(selectDuePurges([doc({ purgeScheduledAt: "2026-08-27T13:00:00.000Z" })], NOW)).toEqual([]);
  });

  it("**경계 시각 당일을 포함한다** — 미루면 24시간이 25시간이 된다", () => {
    expect(selectDuePurges([doc({ purgeScheduledAt: NOW.toISOString() })], NOW)).toHaveLength(1);
  });

  it("이미 파기된 것은 다시 집지 않는다", () => {
    expect(selectDuePurges([doc({ purgedAt: "2026-08-27T11:30:00.000Z" })], NOW)).toEqual([]);
  });

  it("빈 목록은 빈 목록이다", () => {
    expect(selectDuePurges([], NOW)).toEqual([]);
  });
});

// ── 실행 요약 ───────────────────────────────────────────────────────────────

describe("summarizePurgeRun", () => {
  it("전부 성공하면 succeeded 이고 오류 요약이 없다", () => {
    const summary = summarizePurgeRun([
      { id: "a", result: "purged" },
      { id: "b", result: "purged" },
    ]);

    expect(summary).toEqual({
      processed: 2, purged: 2, alreadyGone: 0, failed: 0,
      status: "succeeded", errorSummary: null,
    });
  });

  it("**이미 없는 것은 실패가 아니다** — 목적은 '원문이 남아 있지 않다' 이다", () => {
    const summary = summarizePurgeRun([{ id: "a", result: "already_gone" }]);

    expect(summary.status).toBe("succeeded");
    expect(summary.alreadyGone).toBe(1);
  });

  it("하나라도 실패하면 failed 다", () => {
    const summary = summarizePurgeRun([
      { id: "a", result: "purged" },
      { id: "b", result: "failed", reason: "storage_error" },
    ]);

    expect(summary.status).toBe("failed");
    expect(summary.failed).toBe(1);
  });

  it("오류 요약은 **사유별 개수**다", () => {
    const outcomes: PurgeOutcome[] = [
      { id: "a", result: "failed", reason: "storage_error" },
      { id: "b", result: "failed", reason: "storage_error" },
      { id: "c", result: "failed", reason: "not_authorized" },
    ];

    expect(summarizePurgeRun(outcomes).errorSummary).toBe("not_authorized:1 storage_error:2");
  });

  it("**오류 요약에 경로도 id 도 담지 않는다** — 파기 실패 로그가 잔존 원문의 위치 목록이 되면 안 된다(§5.3)", () => {
    const summary = summarizePurgeRun([
      { id: "doc-abc-123", result: "failed", reason: "storage_error" },
    ]);

    expect(summary.errorSummary).not.toContain("doc-abc-123");
    expect(summary.errorSummary).not.toContain("/");
    expect(summary.errorSummary).not.toContain("contracts-raw");
  });

  it("아무것도 안 했으면 성공이다 (지울 것이 없었다)", () => {
    expect(summarizePurgeRun([])).toEqual({
      processed: 0, purged: 0, alreadyGone: 0, failed: 0,
      status: "succeeded", errorSummary: null,
    });
  });

  it("잡 이름이 고정이다 — 화면·배치·검사가 같은 문자열을 본다", () => {
    expect(PURGE_JOB_NAME).toBe("purge-documents");
  });
});

// ── 경보 ────────────────────────────────────────────────────────────────────

const audit = (over: Partial<PurgeAudit> = {}): PurgeAudit => ({
  documentsTotal: 10, purged: 10, overdue: 0, scheduled: 0,
  oldestOverdueHours: null, maskingFailures: 0, maskingFailures24h: 0,
  ...over,
});
const okRun = { status: "succeeded", finishedAt: "2026-08-27T11:00:00.000Z" };

describe("purgeAlerts", () => {
  it("이상이 없으면 경보가 없다", () => {
    expect(purgeAlerts(audit(), okRun)).toEqual([]);
  });

  it("잔존 건이 있으면 경보한다", () => {
    const alerts = purgeAlerts(audit({ overdue: 3, oldestOverdueHours: 1 }), okRun);

    expect(alerts).toHaveLength(1);
    expect(alerts[0].code).toBe("PURGE_OVERDUE");
    expect(alerts[0].severity).toBe("warn");
  });

  it("오래 밀리면 critical 이다 — 개수만으로는 심각도를 알 수 없다", () => {
    const alerts = purgeAlerts(
      audit({ overdue: 1, oldestOverdueHours: PURGE_CRITICAL_HOURS }),
      okRun,
    );

    expect(alerts[0].severity).toBe("critical");
  });

  it("**한 번도 안 돌았으면 그것도 경보다** — 잔존 0건이 '정상' 처럼 보인다", () => {
    const alerts = purgeAlerts(audit(), null);

    expect(alerts.map((a) => a.code)).toContain("PURGE_NEVER_RAN");
  });

  it("마지막 실행이 실패면 critical 이다", () => {
    const alerts = purgeAlerts(audit(), { status: "failed", finishedAt: null });

    expect(alerts.find((a) => a.code === "PURGE_RUN_FAILED")?.severity).toBe("critical");
  });

  it("마스킹 실패는 **최근 24시간** 기준이다 — 옛날 한 건으로 계속 울리지 않는다", () => {
    expect(purgeAlerts(audit({ maskingFailures: 5, maskingFailures24h: 0 }), okRun)).toEqual([]);
    expect(
      purgeAlerts(audit({ maskingFailures: 5, maskingFailures24h: 1 }), okRun).map((a) => a.code),
    ).toContain("MASKING_FAILED");
  });

  it("**마스킹 차단은 정상 동작이라고 적는다** — 사용자를 고칠 대상으로 읽지 않게", () => {
    const alert = purgeAlerts(audit({ maskingFailures24h: 2 }), okRun)[0];

    expect(alert.action).toContain("정상 동작");
  });

  it("모든 경보에 다음에 할 일이 붙는다 — 할 일 없는 경보는 아무도 안 본다", () => {
    const alerts = purgeAlerts(
      audit({ overdue: 2, oldestOverdueHours: 9, maskingFailures24h: 1 }),
      { status: "failed", finishedAt: null },
    );

    expect(alerts.length).toBeGreaterThanOrEqual(3);
    for (const alert of alerts) expect(alert.action.length).toBeGreaterThan(0);
  });
});

// ── 삭제 요청 처리 ──────────────────────────────────────────────────────────

describe("삭제 요청 상태 전이", () => {
  it("조치는 셋뿐이고 **cancelled 가 없다** — 거두는 것은 요청자의 행위다", () => {
    expect([...DELETION_ACTIONS]).toEqual(["start", "complete", "reject"]);
    expect(DELETION_ACTIONS as readonly string[]).not.toContain("cancel");
  });

  it("조치가 상태로 옮겨진다", () => {
    expect(statusAfter("start")).toBe("in_progress");
    expect(statusAfter("complete")).toBe("completed");
    expect(statusAfter("reject")).toBe("rejected");
  });

  it("끝난 상태 셋", () => {
    expect(DELETION_STATUSES.filter(isTerminal)).toEqual(["completed", "rejected", "cancelled"]);
  });

  it("**끝난 요청은 되돌릴 수 없다** — 되돌리면 처리 기록이 뜻을 잃는다", () => {
    for (const status of ["completed", "rejected", "cancelled"] as const) {
      for (const action of DELETION_ACTIONS) expect(canApply(status, action)).toBe(false);
    }
  });

  it("start 는 접수된 건에만", () => {
    expect(canApply("pending", "start")).toBe(true);
    expect(canApply("in_progress", "start")).toBe(false);
  });

  it("짧은 건은 접수에서 바로 닫을 수 있다 — 형식적인 '처리 중' 을 강요하지 않는다", () => {
    expect(canApply("pending", "complete")).toBe(true);
    expect(canApply("pending", "reject")).toBe(true);
  });
});

describe("DeletionActionSchema — 사유가 필수다", () => {
  it("사유가 있으면 통과한다", () => {
    expect(
      DeletionActionSchema.parse({ requestId: UUID, action: "complete", reason: "전부 삭제 완료" })
        .action,
    ).toBe("complete");
  });

  it.each(["", "   ", "\n"])("빈 사유(%j)는 거절한다", (reason) => {
    expect(() =>
      DeletionActionSchema.parse({ requestId: UUID, action: "complete", reason }),
    ).toThrow();
  });

  it("**'처리 중' 으로 옮길 때도 사유가 필요하다** — 옮겨 두고 잊는 것을 막는다", () => {
    expect(() =>
      DeletionActionSchema.parse({ requestId: UUID, action: "start", reason: "" }),
    ).toThrow();
  });

  it("모르는 조치는 받지 않는다", () => {
    expect(() =>
      DeletionActionSchema.parse({ requestId: UUID, action: "cancel", reason: "x" }),
    ).toThrow();
  });

  it("모르는 키는 통과시키지 않는다", () => {
    expect(() =>
      DeletionActionSchema.parse({ requestId: UUID, action: "complete", reason: "x", status: "completed" }),
    ).toThrow();
  });
});

describe("deletionProblem", () => {
  it("문제가 없으면 null", () => {
    expect(deletionProblem({ status: "pending", action: "complete", reason: "완료" })).toBeNull();
  });

  it("조치를 안 골랐으면 막는다", () => {
    expect(deletionProblem({ status: "pending", action: null, reason: "x" })).not.toBeNull();
  });

  it("사유가 비면 막는다", () => {
    expect(deletionProblem({ status: "pending", action: "complete", reason: "  " })).not.toBeNull();
  });

  it("끝난 요청은 이유를 밝히며 막는다", () => {
    expect(deletionProblem({ status: "completed", action: "complete", reason: "x" })).toContain(
      "이미 끝난",
    );
  });
});

describe("deletionSla — 기준이 없으면 판정하지 않는다 (O-18)", () => {
  const requested = "2026-08-27T00:00:00.000Z"; // 12시간 전

  it("**기준이 없으면 unknown 이다 — '정상' 이 아니다**", () => {
    const verdict = deletionSla(requested, NOW, null);

    expect(verdict.status).toBe("unknown");
    expect(verdict.status === "unknown" && verdict.openIssue).toBe(DELETION_SLA_OPEN_ISSUE);
  });

  it("기준이 없어도 경과 시간은 보여준다", () => {
    expect(deletionSla(requested, NOW, null).elapsedHours).toBe(12);
  });

  it("기준 안이면 남은 시간을 낸다", () => {
    const verdict = deletionSla(requested, NOW, 24);

    expect(verdict).toEqual({ status: "within", elapsedHours: 12, limitHours: 24, remainingHours: 12 });
  });

  it("기준을 넘기면 초과 시간을 낸다", () => {
    const verdict = deletionSla(requested, NOW, 6);

    expect(verdict).toEqual({ status: "overdue", elapsedHours: 12, limitHours: 6, overHours: 6 });
  });

  it("정확히 기한이면 초과다 — 경계는 넘긴 쪽에 둔다", () => {
    expect(deletionSla(requested, NOW, 12).status).toBe("overdue");
  });

  it("미래 시각이 와도 음수가 되지 않는다", () => {
    expect(deletionSla("2026-08-28T00:00:00.000Z", NOW, null).elapsedHours).toBe(0);
  });
});

describe("sortQueue — 오래된 것부터, 끝난 것은 아래로", () => {
  const rows = [
    { id: "new", requestedAt: "2026-08-27T10:00:00.000Z", status: "pending" as const },
    { id: "done", requestedAt: "2026-08-20T10:00:00.000Z", status: "completed" as const },
    { id: "old", requestedAt: "2026-08-21T10:00:00.000Z", status: "pending" as const },
  ];

  it("열린 것이 먼저, 그 안에서 오래된 것부터", () => {
    expect(sortQueue(rows).map((r) => r.id)).toEqual(["old", "new", "done"]);
  });

  it("입력을 바꾸지 않는다", () => {
    const before = rows.map((r) => r.id);
    sortQueue(rows);

    expect(rows.map((r) => r.id)).toEqual(before);
  });

  it("순서가 고정이다 — 같은 입력이면 같은 출력이다", () => {
    expect(sortQueue(rows)).toEqual(sortQueue([...rows].reverse()));
  });
});
