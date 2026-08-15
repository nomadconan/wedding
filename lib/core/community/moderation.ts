import {
  REPORT_REASON_LABEL,
  canTransition,
  resolutionProblem,
  type PostStatus,
  type ReportReason,
  type ReportStatus,
} from "./community";

/**
 * 커뮤니티 모더레이션 (S7-17 · 명세서 §2.3 F-A-18 · §7.7 · D-26)
 *
 * **운영자는 조율자다**(D-24). 그래서 이 층이 하는 일은 판단을 대신하는 것이 아니라
 * **절차와 기록을 강제하는 것**이다 — 어떤 조치든 사유가 붙고, 되돌릴 수 없는 조치와
 * 되돌릴 수 있는 조치를 구분하며, 처리 이력이 남는다.
 *
 * **기준을 지어내지 않는다(O-14).** 무엇이 도배이고 무엇이 위장 계정인지, 몇 시간 안에
 * 처리해야 하는지는 운영 정책이며 아직 정해지지 않았다. 그래서 이 파일은 **셀 수 있는
 * 신호만 계산하고 판정하지 않는다** — 임계값을 지금 정하면 그것이 운영 기준처럼 굳고
 * (0031 이 위약금 밴드에서 겪은 것과 같다), 나중에 바꿔도 이미 그 기준으로 내린 조치는
 * 되돌릴 수 없다.
 *
 * 프레임워크를 모르는 순수 모듈이다.
 */

// =============================================================================
// 조치
// =============================================================================

export const MODERATION_ACTIONS = ["hide", "restore", "reject"] as const;
export type ModerationAction = (typeof MODERATION_ACTIONS)[number];

export const MODERATION_ACTION_LABEL: Record<ModerationAction, string> = {
  hide: "비공개 처리",
  restore: "다시 공개",
  reject: "조치 없음",
};

export const MODERATION_ACTION_HINT: Record<ModerationAction, string> = {
  hide: "글이 목록과 상세에서 가려집니다. 작성자는 자기 글을 계속 볼 수 있어요.",
  restore: "가렸던 글을 다시 공개합니다.",
  reject: "신고를 확인했고 조치하지 않기로 합니다. 글은 그대로 남습니다.",
};

/**
 * **삭제는 조치 목록에 없다.**
 *
 * §2.3 은 "비공개·삭제(사유 필수)" 를 적었지만, 스키마는 **삭제를 작성자의 것**으로
 * 두었다(0038 — `deleted` 는 작성자 묘비이고 운영자 전이에는 없다). 운영자가 남의 글을
 * '삭제' 로 옮기면 화면에는 "작성자가 지웠다" 고 뜨는데 그것은 **거짓말**이다.
 *
 * 운영자에게 필요한 것은 **보이지 않게 하는 것**이고 `hidden` 이 그 일을 한다 — 그리고
 * 그 조치는 되돌릴 수 있다. 되돌릴 수 없는 완전 삭제(법적 요구·개인정보 노출)는
 * **O-03(법무 검수) 뒤에 별도 절차**로 만든다. 지금 만들면 그 절차의 기준이 없다.
 */
export const HARD_DELETE_NOTE =
  "완전 삭제는 아직 만들지 않았습니다. 비공개로 가린 뒤 법무 검수(O-03) 결과에 따라 절차를 정합니다.";

export type ModerationOutcome = {
  /** 대상 글의 다음 상태. `null` 이면 글을 건드리지 않는다. */
  postStatus: PostStatus | null;
  /** 신고의 다음 상태. */
  reportStatus: ReportStatus;
};

export function moderationOutcome(action: ModerationAction): ModerationOutcome {
  if (action === "hide") return { postStatus: "hidden", reportStatus: "resolved" };
  if (action === "restore") return { postStatus: "published", reportStatus: "resolved" };

  // 조치 없음 — 글은 그대로 두고 신고만 닫는다. **닫는 데에도 사유가 붙는다.**
  return { postStatus: null, reportStatus: "rejected" };
}

export type ModerationProblem = { field: "action" | "resolution" | "target"; message: string };

/**
 * 이 조치를 지금 할 수 있는가.
 *
 * **사유는 언제나 필수다.** 되돌릴 수 있는 조치(비공개)에도 요구하는 이유는, 나중에
 * "왜 가렸나" 를 묻는 사람이 작성자이기 때문이다 — 그때 답이 없으면 조치가 자의로
 * 읽힌다(0038 의 CHECK 가 DB 에서 같은 것을 막는다).
 */
export function moderationProblem(input: {
  action: ModerationAction;
  resolution: string;
  /** 대상 글의 현재 상태. 이미 지워진 글이면 `deleted` 다. */
  targetStatus: PostStatus;
}): ModerationProblem | null {
  const outcome = moderationOutcome(input.action);

  const reason = resolutionProblem({ status: outcome.reportStatus, resolution: input.resolution });
  if (reason !== null) return { field: "resolution", message: reason.message };

  if (outcome.postStatus === null) return null;

  // **작성자가 이미 지운 글은 운영자가 되살리지도 가리지도 않는다**(0038 전이표).
  // 신고는 여전히 닫을 수 있다 — '조치 없음' 이 그 경로다.
  if (!canTransition({ actor: "operator", from: input.targetStatus, to: outcome.postStatus })) {
    return {
      field: "target",
      message:
        input.targetStatus === "deleted"
          ? "작성자가 이미 지운 글이에요. 신고는 '조치 없음' 으로 닫을 수 있습니다."
          : "지금 상태에서는 할 수 없는 조치예요.",
    };
  }

  return null;
}

// =============================================================================
// 큐 정렬·분류
// =============================================================================

/**
 * 큐 순서.
 *
 * **오래된 것부터**다. 신고는 먼저 온 것이 먼저 처리돼야 하고, 무엇을 먼저 볼지
 * 우리가 고르기 시작하면 그 기준이 곧 운영 정책이 된다(O-14 가 정할 일이다).
 * 사유별 가중치를 두지 않은 이유가 그것이다.
 */
export type QueueSortable = { createdAt: string; status: ReportStatus };

export function sortQueue<T extends QueueSortable>(reports: readonly T[]): T[] {
  return [...reports].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** 사유별 건수. 분류는 화면이 묶어 보이기 위한 것이고 우선순위가 아니다. */
export function countByReason(
  reports: readonly { reasonCode: ReportReason }[],
): { reason: ReportReason; label: string; count: number }[] {
  const counts = new Map<ReportReason, number>();

  for (const report of reports) {
    counts.set(report.reasonCode, (counts.get(report.reasonCode) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, label: REPORT_REASON_LABEL[reason], count }))
    .sort((a, b) => b.count - a.count);
}

// =============================================================================
// 어뷰징·위장 계정 — **세기만 하고 판정하지 않는다** (O-14)
// =============================================================================

/**
 * 운영자가 볼 신호.
 *
 * **판정이 아니라 사실이다.** "이 계정은 위장이다" 를 코드가 말하려면 임계값이
 * 필요하고, 그 임계값이 O-14 다. 그래서 여기서는 **세어서 보여줄 뿐**이며 무엇이
 * 문제인지는 사람이 정한다.
 *
 * 세는 것도 최소로 둔다 — 더 많은 신호를 모으는 일은 **감시에 가까워진다**(§7.3).
 * 지금 세는 셋은 전부 **이미 있는 행**에서 나온다(새로 수집하는 값이 없다).
 */
export type AbuseSignals = {
  /** 이 대상에 대한 신고 수. 여럿이 같은 글을 신고했다는 사실. */
  reportsOnTarget: number;
  /** 이 신고자가 최근 낸 신고 수. 많다고 나쁜 것은 아니다 — 열심일 수도 있다. */
  reportsByReporter: number;
  /** 이 작성자의 글 중 지금 가려진 것의 수. */
  hiddenPostsByAuthor: number;
};

export const ABUSE_SIGNAL_LABEL: Record<keyof AbuseSignals, string> = {
  reportsOnTarget: "이 글에 들어온 신고",
  reportsByReporter: "이 신고자가 낸 신고",
  hiddenPostsByAuthor: "이 작성자의 가려진 글",
};

/**
 * **임계값을 두지 않는다.** 화면은 이 문장을 신호 옆에 그대로 적는다 — 숫자만 보이면
 * 사람은 그것을 기준처럼 읽고, 그러면 우리가 정하지 않은 기준이 생긴다.
 */
export const ABUSE_SIGNAL_NOTE =
  "숫자는 사실이고 판정이 아니에요. 무엇을 어뷰징으로 볼지는 아직 정하지 않았습니다(O-14).";

export const ABUSE_DETECTION_OPEN_ISSUE = "O-14";

// =============================================================================
// 처리 이력
// =============================================================================

/**
 * 증적에 남길 요약.
 *
 * **사유 원문을 넣지 않는다**(§7.3). 운영자가 적은 사유는 `community_reports.resolution`
 * 이 갖고, 증적에는 **무엇을 했는지와 어느 사유 코드였는지**만 남는다 — 같은 문장을
 * 두 곳에 두면 한쪽만 지워지는 날이 온다.
 */
export function moderationMemo(input: {
  action: ModerationAction;
  reasonCode: ReportReason;
}): string {
  return `action:${input.action} reason:${input.reasonCode}`;
}

/** 처리자·시각이 함께 남아야 닫힌다(0038 CHECK 와 같은 요구). */
export type ResolutionRecord = {
  status: ReportStatus;
  resolution: string;
  resolvedBy: string;
  resolvedAt: string;
};

export function buildResolution(input: {
  action: ModerationAction;
  resolution: string;
  operatorId: string;
  now: string;
}): ResolutionRecord {
  return {
    status: moderationOutcome(input.action).reportStatus,
    resolution: input.resolution.trim(),
    resolvedBy: input.operatorId,
    resolvedAt: input.now,
  };
}
