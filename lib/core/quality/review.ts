// 샘플 검수와 오탐 신고 (S8-07 · F-A-04)
//
// **큐는 계산하고 기록은 저장한다.** 무엇을 검수해야 하는지는 완료된 분석과 검수
// 기록의 차집합이라 계산되지만(D-124), "누가 언제 무엇을 보고 어떻게 판단했나" 는
// 저장하지 않으면 사라진다.
//
// ── 5% 로 큐를 자르지 않는다 ────────────────────────────────────────────────
//
// §5.8 은 '샘플 검수 비율: 생성 리포트의 5%' 를 적지만 그 표의 열 제목은
// **'목표(가정)'** 이다. 그 값으로 큐를 잘라 "오늘 검수할 것 3건" 을 만들면 **가정치가
// 작업 지시로 바뀐다** — 운영자는 그 셋만 보고 나머지를 안 본 것이 정상이라고 읽는다.
//
// 그래서 **큐는 아직 검수되지 않은 분석 전부**이고, 5%는 **달성률의 기준선**으로만
// 쓴다: "완료 리포트 40건 중 1건 검수 · 목표 5%(가정) 기준 2건". 무엇을 볼지는
// 운영자가 정하고, 화면은 얼마나 봤는지를 사실대로 적는다.

import { z } from "zod";

export const REVIEW_VERDICTS = ["accurate", "inaccurate", "unclear"] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

/**
 * **표현을 사실 기술로 둔다.** '틀렸다' 가 아니라 '근거와 맞지 않는다' 이다 —
 * 검수는 우리 산출물을 우리가 보는 일이지만, 그 기록이 나중에 룰을 고치는 근거가
 * 되므로 무엇을 봤는지가 남아야 한다(§7.7 의 결과 그대로).
 */
export const REVIEW_VERDICT_LABEL: Record<ReviewVerdict, string> = {
  accurate: "근거와 맞음",
  inaccurate: "근거와 맞지 않음",
  unclear: "판단 보류",
};

export const REVIEW_VERDICT_HINT: Record<ReviewVerdict, string> = {
  accurate: "인용과 근거 조항이 룰이 말하는 것과 일치합니다.",
  inaccurate: "인용·근거·위험도 중 하나가 룰이 말하는 것과 다릅니다. 무엇이 다른지 적어 주세요.",
  unclear: "지금 자료로는 판단할 수 없습니다. 무엇이 부족한지 적어 주세요.",
};

/**
 * 검수 기록.
 *
 * **'근거와 맞음' 에도 메모가 필수다.** 예외를 두면 기록 대부분이 빈칸이 되고,
 * 나중에 "무엇을 보고 통과시켰나" 를 답할 수 없다. DB CHECK 이 같은 말을 한다(0059).
 */
export const ReportReviewSchema = z.object({
  analysisId: z.string().uuid(),
  verdict: z.enum(REVIEW_VERDICTS),
  note: z.string().trim().min(1, "무엇을 보았는지 적어 주세요.").max(1_000),
});
export type ReportReviewInput = z.infer<typeof ReportReviewSchema>;

// ── 오탐 신고 ───────────────────────────────────────────────────────────────

export const FINDING_REPORT_REASONS = [
  "not_in_document",
  "wrong_rule",
  "wrong_severity",
  "misread",
] as const;
export type FindingReportReason = (typeof FINDING_REPORT_REASONS)[number];

export const FINDING_REPORT_REASON_LABEL: Record<FindingReportReason, string> = {
  not_in_document: "계약서에 없는 내용입니다",
  wrong_rule: "이 조항에 해당하는 항목이 아닙니다",
  wrong_severity: "위험도가 실제와 다릅니다",
  misread: "내용을 잘못 읽었습니다",
};

/** 접수. **처리 상태를 받지 않는다** — 컬럼 권한이 이미 막지만 입구도 막는다. */
export const FindingReportSchema = z.object({
  findingId: z.string().uuid(),
  reason: z.enum(FINDING_REPORT_REASONS),
});
export type FindingReportInput = z.infer<typeof FindingReportSchema>;

export const FINDING_REPORT_STATUSES = ["open", "upheld", "rejected"] as const;
export type FindingReportStatus = (typeof FINDING_REPORT_STATUSES)[number];

/**
 * **어휘가 '맞다·틀리다' 가 아니다.**
 *
 * `upheld` 는 "사용자 말이 옳다" 가 아니라 **"룰을 손볼 자리로 받아들였다"** 이고,
 * `rejected` 는 "사용자가 틀렸다" 가 아니라 **"지금 룰대로 나온 결과다"** 이다.
 * 우리가 판정하는 것은 사용자가 아니라 **우리 룰**이다.
 */
export const FINDING_REPORT_STATUS_LABEL: Record<FindingReportStatus, string> = {
  open: "접수",
  upheld: "룰을 손볼 자리로 받음",
  rejected: "지금 룰대로 나온 결과",
};

export const FindingReportResolveSchema = z.object({
  reportId: z.string().uuid(),
  status: z.enum(["upheld", "rejected"]),
  note: z.string().trim().min(1, "처리 사유를 적어 주세요.").max(1_000),
});
export type FindingReportResolveInput = z.infer<typeof FindingReportResolveSchema>;

// ── 검수 진척 ───────────────────────────────────────────────────────────────

export type ReviewProgress = {
  completedAnalyses: number;
  reviewed: number;
  pending: number;
  /** 실제 검수율(bp). 분모가 0이면 `null` — 0% 가 아니다. */
  reviewedBp: number | null;
  /**
   * 목표(가정) 기준 몇 건인가. **큐를 자르는 값이 아니라 읽는 기준선**이다.
   * 분모가 0이면 0건이며, 이때는 "볼 것이 없다" 가 맞다.
   */
  targetCount: number;
  targetBp: number;
  targetAssumed: true;
};

export function reviewProgress(
  completedAnalyses: number,
  reviewed: number,
  targetBp: number,
): ReviewProgress {
  return {
    completedAnalyses,
    reviewed,
    pending: Math.max(completedAnalyses - reviewed, 0),
    reviewedBp:
      completedAnalyses === 0 ? null : Math.round((reviewed / completedAnalyses) * 10_000),
    // 올림이다 — 40건의 5%는 2건이고, 21건의 5%는 1.05건인데 **1건으로 내리면
    // 목표에 못 미치는 것을 목표 달성으로 적는다.**
    targetCount: Math.ceil((completedAnalyses * targetBp) / 10_000),
    targetBp,
    targetAssumed: true,
  };
}

/**
 * 룰별 오탐 신고 집계.
 *
 * **`rule_code` 로 센다.** 신고는 finding 하나에 붙지만 고칠 대상은 **룰**이고,
 * 원본 finding 은 재분석에 사라진다(그래서 0059 가 `rule_code` 를 스냅샷한다).
 * 어떤 룰이 반복해서 잘못 걸리는지가 F-A-03(룰 관리)이 받아야 할 신호다.
 */
export type RuleReportCount = { ruleCode: string; open: number; upheld: number; total: number };

export function countByRule(
  reports: readonly { ruleCode: string; status: string }[],
): RuleReportCount[] {
  const byRule = new Map<string, RuleReportCount>();

  for (const report of reports) {
    const row = byRule.get(report.ruleCode) ?? {
      ruleCode: report.ruleCode,
      open: 0,
      upheld: 0,
      total: 0,
    };

    row.total += 1;
    if (report.status === "open") row.open += 1;
    if (report.status === "upheld") row.upheld += 1;
    byRule.set(report.ruleCode, row);
  }

  // 손볼 자리로 받아들여진 것이 많은 룰부터. 같으면 접수 대기가 많은 쪽,
  // 그래도 같으면 코드순 — **순서가 흔들리면 읽는 사람이 목록을 의심한다**(S8-02).
  return [...byRule.values()].sort(
    (a, b) => b.upheld - a.upheld || b.open - a.open || a.ruleCode.localeCompare(b.ruleCode),
  );
}
