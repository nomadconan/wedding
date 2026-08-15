import { describe, expect, it } from "vitest";

import { RESOLUTION_MIN_LENGTH } from "./community";
import {
  ABUSE_DETECTION_OPEN_ISSUE,
  ABUSE_SIGNAL_LABEL,
  ABUSE_SIGNAL_NOTE,
  HARD_DELETE_NOTE,
  MODERATION_ACTIONS,
  MODERATION_ACTION_LABEL,
  buildResolution,
  countByReason,
  moderationMemo,
  moderationOutcome,
  moderationProblem,
  sortQueue,
} from "./moderation";

const reason = "가려야 할 광고성 문구를 확인했습니다.";

describe("조치 — 삭제는 목록에 없다", () => {
  it("셋뿐이다: 비공개·다시 공개·조치 없음", () => {
    expect([...MODERATION_ACTIONS]).toEqual(["hide", "restore", "reject"]);
  });

  it("**운영자가 '삭제' 로 옮기지 않는다** — 화면이 '작성자가 지웠다' 고 거짓말하게 된다", () => {
    for (const action of MODERATION_ACTIONS) {
      expect(moderationOutcome(action).postStatus).not.toBe("deleted");
    }
  });

  it("완전 삭제를 만들지 않은 이유를 코드가 갖는다 (O-03 대기)", () => {
    expect(HARD_DELETE_NOTE).toContain("O-03");
  });

  it("조치마다 사람이 읽는 이름이 있다", () => {
    for (const action of MODERATION_ACTIONS) {
      expect(MODERATION_ACTION_LABEL[action].length).toBeGreaterThan(0);
    }
  });

  it("비공개는 신고를 처리 완료로 닫는다", () => {
    expect(moderationOutcome("hide")).toEqual({ postStatus: "hidden", reportStatus: "resolved" });
  });

  it("조치 없음은 글을 건드리지 않는다", () => {
    expect(moderationOutcome("reject")).toEqual({ postStatus: null, reportStatus: "rejected" });
  });
});

describe("사유 — 언제나 필수다", () => {
  it("사유 없이 가릴 수 없다", () => {
    expect(
      moderationProblem({ action: "hide", resolution: "", targetStatus: "published" })?.field,
    ).toBe("resolution");
  });

  it("**조치 없음에도 사유가 붙는다** — 안 한 것도 설명해야 한다", () => {
    expect(
      moderationProblem({ action: "reject", resolution: "짧", targetStatus: "published" })?.field,
    ).toBe("resolution");
  });

  it("사유가 충분하면 통과한다", () => {
    expect(moderationProblem({ action: "hide", resolution: reason, targetStatus: "published" })).toBeNull();
    expect(reason.length).toBeGreaterThanOrEqual(RESOLUTION_MIN_LENGTH);
  });
});

describe("대상 상태 — 이미 지운 글은 건드리지 않는다", () => {
  it("작성자가 지운 글을 가릴 수 없다", () => {
    const problem = moderationProblem({ action: "hide", resolution: reason, targetStatus: "deleted" });

    expect(problem?.field).toBe("target");
    expect(problem?.message).toContain("조치 없음");
  });

  it("**지운 글도 신고는 닫을 수 있다** — 대상이 사라져도 신고는 남는다(S7-14)", () => {
    expect(
      moderationProblem({ action: "reject", resolution: reason, targetStatus: "deleted" }),
    ).toBeNull();
  });

  it("가려진 글을 다시 공개할 수 있다", () => {
    expect(
      moderationProblem({ action: "restore", resolution: reason, targetStatus: "hidden" }),
    ).toBeNull();
  });

  it("공개된 글을 다시 공개하려 하면 막는다", () => {
    expect(
      moderationProblem({ action: "restore", resolution: reason, targetStatus: "published" })?.field,
    ).toBe("target");
  });
});

describe("큐 — 오래된 것부터", () => {
  it("먼저 온 신고가 먼저 온다", () => {
    const sorted = sortQueue([
      { createdAt: "2026-08-03", status: "open" as const },
      { createdAt: "2026-08-01", status: "open" as const },
      { createdAt: "2026-08-02", status: "reviewing" as const },
    ]);

    expect(sorted.map((item) => item.createdAt)).toEqual(["2026-08-01", "2026-08-02", "2026-08-03"]);
  });

  it("사유별로 세되 우선순위를 만들지 않는다", () => {
    const counts = countByReason([
      { reasonCode: "spam" as const },
      { reasonCode: "spam" as const },
      { reasonCode: "abuse" as const },
    ]);

    expect(counts[0]).toEqual({ reason: "spam", label: "도배·광고", count: 2 });
    expect(counts).toHaveLength(2);
  });
});

describe("어뷰징 신호 — 세기만 하고 판정하지 않는다 (O-14)", () => {
  it("신호마다 사람이 읽는 이름이 있다", () => {
    for (const label of Object.values(ABUSE_SIGNAL_LABEL)) {
      expect(label.length).toBeGreaterThan(0);
    }
  });

  it("**판정이 아니라는 사실을 화면이 적는다**", () => {
    expect(ABUSE_SIGNAL_NOTE).toContain("판정이 아니");
    expect(ABUSE_SIGNAL_NOTE).toContain(ABUSE_DETECTION_OPEN_ISSUE);
  });

  it("임계값 상수를 두지 않았다 — 두면 그것이 기준처럼 굳는다", () => {
    // 신호 이름 셋뿐이고 숫자 기준이 없다.
    expect(Object.keys(ABUSE_SIGNAL_LABEL)).toEqual([
      "reportsOnTarget",
      "reportsByReporter",
      "hiddenPostsByAuthor",
    ]);
  });
});

describe("처리 이력", () => {
  it("증적에 사유 원문을 넣지 않는다 (§7.3)", () => {
    const memo = moderationMemo({ action: "hide", reasonCode: "commercial" });

    expect(memo).toBe("action:hide reason:commercial");
    expect(memo).not.toContain(reason);
  });

  it("처리자·시각이 함께 남는다 (0038 CHECK 와 같은 요구)", () => {
    const record = buildResolution({
      action: "hide",
      resolution: `  ${reason}  `,
      operatorId: "op-1",
      now: "2026-08-16T00:00:00.000Z",
    });

    expect(record).toEqual({
      status: "resolved",
      resolution: reason,
      resolvedBy: "op-1",
      resolvedAt: "2026-08-16T00:00:00.000Z",
    });
  });
});
