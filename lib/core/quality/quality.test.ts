import { describe, expect, it } from "vitest";

import {
  AI_COST_OPEN_ISSUE,
  type CallLog,
  NOT_ATTEMPTED,
  QUALITY_TARGETS,
  VALIDATION_RESULTS,
  costUsable,
  estimateCost,
  isFailure,
  percentile,
  summarize,
  wasAttempted,
} from "./metrics";
import {
  FINDING_REPORT_REASONS,
  FINDING_REPORT_STATUS_LABEL,
  FindingReportResolveSchema,
  FindingReportSchema,
  REVIEW_VERDICTS,
  ReportReviewSchema,
  countByRule,
  reviewProgress,
} from "./review";

const UUID = "11111111-1111-4111-8111-111111111111";

const log = (over: Partial<CallLog> = {}): CallLog => ({
  feature: "report",
  model: "claude-x",
  promptVersion: "report@1",
  validationResult: "ok",
  retryCount: 0,
  latencyMs: 1_000,
  tokenIn: 100,
  tokenOut: 50,
  findingsGenerated: 5,
  findingsDiscarded: 0,
  createdAt: "2026-08-28T00:00:00.000Z",
  ...over,
});

const FEATURES = ["report", "planner", "estimate", "search"];
const NO_PRICES = { inputPerMTokKrw: null, outputPerMTokKrw: null };

// ══════════════════════════════════════════════════════════════════════════
// 부르지 않은 것은 실패가 아니다
// ══════════════════════════════════════════════════════════════════════════

describe("wasAttempted / isFailure", () => {
  it.each([...NOT_ATTEMPTED])("%s 는 시도가 아니다 — 실패율 분모에서 빠진다", (result) => {
    expect(wasAttempted(result)).toBe(false);
    expect(isFailure(result)).toBe(false);
  });

  it.each(["ok", "invalid_output", "call_failed"])("%s 는 실제로 부른 것이다", (result) => {
    expect(wasAttempted(result)).toBe(true);
  });

  it("실패는 스키마 불일치와 호출 실패 둘뿐이다", () => {
    expect(isFailure("invalid_output")).toBe(true);
    expect(isFailure("call_failed")).toBe(true);
    expect(isFailure("ok")).toBe(false);
  });

  it("null 은 시도로 세지 않는다 — 기록되지 않은 호출이다", () => {
    expect(wasAttempted(null)).toBe(false);
  });

  it("어휘가 일곱이다 (DB CHECK 과 같은 목록)", () => {
    expect(VALIDATION_RESULTS).toHaveLength(7);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 비율 — **분모가 0이면 0% 가 아니다**
// ══════════════════════════════════════════════════════════════════════════

describe("summarize", () => {
  it("키가 없어 한 번도 안 부른 상태에서 실패율이 100% 가 되지 않는다", () => {
    const summary = summarize(
      [log({ validationResult: "no_key" }), log({ validationResult: "no_key" })],
      { windowDays: 30, features: FEATURES, prices: NO_PRICES },
    );

    // 분모가 0이라 비율 자체가 없다. 0% 도 100% 도 아니다.
    expect(summary.validationFailure.bp).toBeNull();
    expect(summary.validationFailure.denominator).toBe(0);
    expect(summary.notAttempted).toBe(2);
    expect(summary.attempted).toBe(0);
  });

  it("실패율을 bp 로 낸다 — 부동소수점을 만들지 않는다", () => {
    const summary = summarize(
      [log(), log(), log(), log({ validationResult: "invalid_output" })],
      { windowDays: 30, features: FEATURES, prices: NO_PRICES },
    );

    expect(summary.validationFailure.bp).toBe(2_500);
    expect(Number.isInteger(summary.validationFailure.bp)).toBe(true);
  });

  it("폐기율의 분모는 호출 수가 아니라 생성된 finding 수다", () => {
    // 한 호출이 열 건을 내고 셋이 폐기된 것과, 열 번 불러 셋이 폐기된 것은 다르다.
    const summary = summarize(
      [log({ findingsGenerated: 10, findingsDiscarded: 3 })],
      { windowDays: 30, features: FEATURES, prices: NO_PRICES },
    );

    expect(summary.discard.bp).toBe(3_000);
    expect(summary.discard.denominator).toBe(10);
  });

  it("생성된 finding 이 없으면 폐기율이 없다", () => {
    const summary = summarize([log({ findingsGenerated: 0, findingsDiscarded: 0 })], {
      windowDays: 30,
      features: FEATURES,
      prices: NO_PRICES,
    });

    expect(summary.discard.bp).toBeNull();
  });

  it("**계측되지 않은 기능이 목록에서 빠지지 않는다** — 0건과 '안 셈' 을 가른다", () => {
    const summary = summarize([log({ feature: "report" })], {
      windowDays: 30,
      features: FEATURES,
      prices: NO_PRICES,
    });

    expect(summary.byFeature.map((row) => row.feature)).toEqual(FEATURES);
    expect(summary.byFeature.find((row) => row.feature === "report")?.instrumented).toBe(true);
    expect(summary.byFeature.find((row) => row.feature === "planner")?.instrumented).toBe(false);
  });

  it("목표를 함께 내되 '가정' 이라는 사실을 달고 있다", () => {
    const summary = summarize([log()], {
      windowDays: 30,
      features: FEATURES,
      prices: NO_PRICES,
    });

    expect(summary.targets.validationFailureBp.assumed).toBe(true);
    expect(QUALITY_TARGETS.discardBp.assumed).toBe(true);
    // **판정을 만들지 않는다** — 초과/미달 같은 칸이 없다.
    expect("exceeded" in summary.validationFailure).toBe(false);
  });
});

describe("percentile", () => {
  it("표본이 없으면 null 이다 — 0ms 가 아니다", () => {
    expect(percentile([], 95)).toBeNull();
  });

  it("보간하지 않는다 — 실제로 일어난 값만 낸다", () => {
    const values = [100, 200, 300, 400, 500];

    expect(percentile(values, 95)).toBe(500);
    expect(percentile(values, 50)).toBe(300);
    // 보간했다면 460 같은 값이 나온다. 그런 지연은 일어난 적이 없다.
    expect([100, 200, 300, 400, 500]).toContain(percentile(values, 95));
  });

  it("한 건이면 그 값이다", () => {
    expect(percentile([42], 95)).toBe(42);
  });

  it("p0 도 하한을 벗어나지 않는다", () => {
    expect(percentile([10, 20, 30], 0)).toBe(10);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 비용 — **단가가 없으면 금액을 만들지 않는다**(O-21)
// ══════════════════════════════════════════════════════════════════════════

describe("estimateCost", () => {
  it("단가가 미결이면 blocked 다 — 0원이 아니다", () => {
    const cost = estimateCost([log()], NO_PRICES);

    expect(cost.status).toBe("blocked");
    expect(cost.status === "blocked" && cost.openIssue).toBe(AI_COST_OPEN_ISSUE);
    // 토큰은 그대로 낸다 — 그것은 실측이고, 단가만 없는 것이다.
    expect(cost.tokenIn).toBe(100);
    expect(cost.tokenOut).toBe(50);
  });

  it.each([
    ["입력 단가만", { inputPerMTokKrw: 3_000, outputPerMTokKrw: null }],
    ["출력 단가만", { inputPerMTokKrw: null, outputPerMTokKrw: 15_000 }],
  ])("%s 있으면 계산하지 않는다 — 반쪽 금액은 금액이 아니다", (_label, prices) => {
    expect(costUsable(prices)).toBe(false);
    expect(estimateCost([log()], prices).status).toBe("blocked");
  });

  it("단가가 있으면 정수 원화로 낸다", () => {
    const cost = estimateCost(
      [log({ tokenIn: 1_000_000, tokenOut: 1_000_000 })],
      { inputPerMTokKrw: 3_000, outputPerMTokKrw: 15_000 },
    );

    expect(cost.status).toBe("measured");
    expect(cost.status === "measured" && cost.krw).toBe(18_000);
  });

  it("토큰을 먼저 다 더하고 마지막에 한 번 나눈다 — 누적 오차를 만들지 않는다", () => {
    const many = Array.from({ length: 3 }, () => log({ tokenIn: 1, tokenOut: 0 }));
    const cost = estimateCost(many, { inputPerMTokKrw: 1_000_000, outputPerMTokKrw: 0 });

    expect(cost.status === "measured" && cost.krw).toBe(3);
  });

  it("토큰이 없는 호출은 0으로 센다 — null 이 NaN 이 되지 않는다", () => {
    const cost = estimateCost([log({ tokenIn: null, tokenOut: null })], {
      inputPerMTokKrw: 3_000,
      outputPerMTokKrw: 15_000,
    });

    expect(cost.status === "measured" && cost.krw).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 검수·오탐 신고
// ══════════════════════════════════════════════════════════════════════════

describe("ReportReviewSchema", () => {
  it("'근거와 맞음' 에도 메모가 필수다", () => {
    expect(
      ReportReviewSchema.safeParse({ analysisId: UUID, verdict: "accurate", note: "  " }).success,
    ).toBe(false);
    expect(
      ReportReviewSchema.safeParse({ analysisId: UUID, verdict: "accurate", note: "인용 확인" })
        .success,
    ).toBe(true);
  });

  it("정의되지 않은 판단을 받지 않는다", () => {
    expect(
      ReportReviewSchema.safeParse({ analysisId: UUID, verdict: "wrong", note: "x" }).success,
    ).toBe(false);
    expect(REVIEW_VERDICTS).toHaveLength(3);
  });
});

describe("오탐 신고", () => {
  it("접수는 상태를 받지 않는다 — 신고자가 자기 신고를 닫을 수 없다", () => {
    const parsed = FindingReportSchema.safeParse({
      findingId: UUID,
      reason: "not_in_document",
      status: "rejected",
    });

    expect(parsed.success).toBe(true);
    expect(parsed.success && "status" in parsed.data).toBe(false);
  });

  it("정의되지 않은 사유는 거절한다", () => {
    expect(FindingReportSchema.safeParse({ findingId: UUID, reason: "spam" }).success).toBe(false);
    expect(FINDING_REPORT_REASONS).toHaveLength(4);
  });

  it("'지금 룰대로 나온 결과' 에도 사유가 필수다", () => {
    expect(
      FindingReportResolveSchema.safeParse({ reportId: UUID, status: "rejected", note: "" })
        .success,
    ).toBe(false);
  });

  it("접수 상태로는 처리를 끝낼 수 없다", () => {
    expect(
      FindingReportResolveSchema.safeParse({ reportId: UUID, status: "open", note: "보류" })
        .success,
    ).toBe(false);
  });

  it("처리 어휘가 사용자가 아니라 룰을 가리킨다", () => {
    expect(FINDING_REPORT_STATUS_LABEL.upheld).toContain("룰");
    expect(FINDING_REPORT_STATUS_LABEL.rejected).toContain("룰");
  });
});

describe("reviewProgress", () => {
  it("완료 리포트가 없으면 검수율이 null 이다 — 0% 가 아니다", () => {
    const progress = reviewProgress(0, 0, 500);

    expect(progress.reviewedBp).toBeNull();
    expect(progress.targetCount).toBe(0);
  });

  it("목표 건수를 올림한다 — 내리면 미달을 달성으로 적는다", () => {
    // 21건의 5% = 1.05건. 1건으로 내리면 1건만 봐도 목표 달성이 된다.
    expect(reviewProgress(21, 0, 500).targetCount).toBe(2);
    expect(reviewProgress(40, 0, 500).targetCount).toBe(2);
    expect(reviewProgress(20, 0, 500).targetCount).toBe(1);
  });

  it("검수율을 bp 로 낸다", () => {
    expect(reviewProgress(40, 2, 500).reviewedBp).toBe(500);
  });

  it("남은 건수가 음수가 되지 않는다", () => {
    expect(reviewProgress(2, 5, 500).pending).toBe(0);
  });

  it("목표가 가정이라는 사실을 달고 있다", () => {
    expect(reviewProgress(40, 2, 500).targetAssumed).toBe(true);
  });
});

describe("countByRule", () => {
  it("룰별로 접힌다 — 고칠 대상은 finding 이 아니라 룰이다", () => {
    const counts = countByRule([
      { ruleCode: "R-07", status: "open" },
      { ruleCode: "R-07", status: "upheld" },
      { ruleCode: "R-02", status: "open" },
    ]);

    expect(counts).toHaveLength(2);
    expect(counts[0]).toEqual({ ruleCode: "R-07", open: 1, upheld: 1, total: 2 });
  });

  it("손볼 자리로 받은 것이 많은 룰이 먼저 온다", () => {
    const counts = countByRule([
      { ruleCode: "R-01", status: "open" },
      { ruleCode: "R-02", status: "upheld" },
    ]);

    expect(counts[0].ruleCode).toBe("R-02");
  });

  it("같으면 코드순으로 고정한다 — 순서가 흔들리면 목록을 의심한다", () => {
    const counts = countByRule([
      { ruleCode: "R-09", status: "rejected" },
      { ruleCode: "R-03", status: "rejected" },
    ]);

    expect(counts.map((row) => row.ruleCode)).toEqual(["R-03", "R-09"]);
  });

  it("비어 있으면 빈 목록이다", () => {
    expect(countByRule([])).toEqual([]);
  });
});
