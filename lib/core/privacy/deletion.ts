// 삭제 요청 SLA 추적·처리 (S8-04 · F-A-08 · 명세서 §7.3)
//
// S3-09 가 **접수**하고 여기가 **처리**한다. 상태는 다섯이며 그 중 셋만 운영자의 것이다.

import { z } from "zod";

/** `data_deletion_requests.status` (0004 CHECK 과 같은 어휘). */
export const DELETION_STATUSES = [
  "pending",
  "in_progress",
  "completed",
  "rejected",
  "cancelled",
] as const;
export type DeletionStatus = (typeof DELETION_STATUSES)[number];

export const DELETION_STATUS_LABEL: Record<DeletionStatus, string> = {
  pending: "접수됨",
  in_progress: "처리 중",
  completed: "처리 완료",
  rejected: "거절",
  cancelled: "요청자가 거둠",
};

/** `scope`. 계정 전체인가 서비스 데이터만인가. */
export const DELETION_SCOPE_LABEL: Record<string, string> = {
  account: "계정 전체",
  service_data: "서비스 데이터",
};

/**
 * 운영자가 할 수 있는 조치.
 *
 * **`cancelled` 는 없다** — 요청을 거두는 것은 요청자의 행위이며 RLS 정책도 그렇게
 * 되어 있다(`data_deletion_requests_cancel`). 운영자가 대신 거두면 "요청자가 거뒀다" 는
 * 기록이 거짓이 된다(S7-17 이 모더레이션에서 `deleted` 를 쓰지 않은 것과 같은 이유).
 */
export const DELETION_ACTIONS = ["start", "complete", "reject"] as const;
export type DeletionAction = (typeof DELETION_ACTIONS)[number];

const ACTION_TO_STATUS: Record<DeletionAction, DeletionStatus> = {
  start: "in_progress",
  complete: "completed",
  reject: "rejected",
};

export function statusAfter(action: DeletionAction): DeletionStatus {
  return ACTION_TO_STATUS[action];
}

/** 이미 끝난 요청은 다시 건드리지 않는다. */
export function isTerminal(status: DeletionStatus): boolean {
  return status === "completed" || status === "rejected" || status === "cancelled";
}

/**
 * 이 조치를 지금 할 수 있는가.
 *
 * 되돌릴 수 없는 조치라 **되돌아가는 전이를 허용하지 않는다** — `completed` 를
 * `in_progress` 로 되돌리면 처리 기록이 뜻을 잃는다. 되돌려야 할 일이 생기면
 * 새 요청으로 받는다.
 */
export function canApply(current: DeletionStatus, action: DeletionAction): boolean {
  if (isTerminal(current)) return false;
  if (action === "start") return current === "pending";

  // complete·reject 는 접수 직후에도 할 수 있다 — 짧은 건을 억지로 두 단계로
  // 나누게 하면 운영자가 `in_progress` 를 형식적으로 찍고 지나간다.
  return current === "pending" || current === "in_progress";
}

/**
 * 처리 요청 스키마.
 *
 * **사유가 필수다.** 세 층(화면·라우트·DB CHECK)이 같은 말을 한다 — 한 층만 두면
 * 다른 경로로 들어온 요청이 사유 없이 지나간다(S7-17 이 정한 규칙).
 * `start` 에도 사유를 요구하는 이유: '처리 중' 으로 옮겨 두고 잊는 것을 막는다 —
 * 무엇을 하고 있는지 한 줄이면 다음 사람이 이어받을 수 있다.
 */
export const DeletionActionSchema = z
  .object({
    requestId: z.string().uuid(),
    action: z.enum(DELETION_ACTIONS),
    reason: z.string().trim().min(1, "처리 사유를 적어 주세요.").max(1_000),
  })
  .strict();

export type DeletionActionInput = z.infer<typeof DeletionActionSchema>;

/** 화면이 저장 버튼을 막는 이유. 없으면 `null`. */
export function deletionProblem(input: {
  status: DeletionStatus;
  action: DeletionAction | null;
  reason: string;
}): string | null {
  if (!input.action) return "조치를 선택해 주세요.";
  if (!canApply(input.status, input.action)) {
    return isTerminal(input.status)
      ? "이미 끝난 요청입니다. 되돌리려면 새 요청으로 접수해 주세요."
      : "지금 상태에서는 할 수 없는 조치입니다.";
  }
  if (input.reason.trim().length === 0) return "처리 사유를 적어 주세요.";

  return null;
}

// ── SLA (O-18 미결) ─────────────────────────────────────────────────────────

/**
 * 처리 기한 판정.
 *
 * **기준이 없으면 판정하지 않는다.** §7.3 은 "SLA 내 처리" 라고만 적고 시간을 정하지
 * 않았고, 개인정보 삭제 요청의 법정 기한은 관할·근거법 소관이라 **코드가 고를 값이
 * 아니다**(O-18 · `app_settings.privacy.deletion_sla_hours`).
 *
 * 그래서 상태가 셋이다:
 *   `unknown`  기준이 없다 — 경과 시간만 보여준다. **'정상' 이 아니다.**
 *   `within`   기준 안이다
 *   `overdue`  기준을 넘겼다
 *
 * 지어낸 기한으로 "지연" 이라 적으면 **그것이 곧 운영 기준으로 굳는다** — 나중에 진짜
 * 기한이 정해졌을 때 이미 그 숫자로 일해 온 사람들이 있다.
 */
export type SlaVerdict =
  | { status: "unknown"; elapsedHours: number; openIssue: string }
  | { status: "within"; elapsedHours: number; limitHours: number; remainingHours: number }
  | { status: "overdue"; elapsedHours: number; limitHours: number; overHours: number };

export const DELETION_SLA_OPEN_ISSUE = "O-18";

export function deletionSla(
  requestedAt: string,
  now: Date,
  limitHours: number | null,
): SlaVerdict {
  const elapsedMs = Math.max(0, now.getTime() - Date.parse(requestedAt));
  const elapsedHours = Math.floor(elapsedMs / 3_600_000);

  if (limitHours === null) {
    return { status: "unknown", elapsedHours, openIssue: DELETION_SLA_OPEN_ISSUE };
  }

  return elapsedHours >= limitHours
    ? { status: "overdue", elapsedHours, limitHours, overHours: elapsedHours - limitHours }
    : { status: "within", elapsedHours, limitHours, remainingHours: limitHours - elapsedHours };
}

/**
 * 큐 정렬. **오래된 것부터**다(S7-17 이 모더레이션 큐에서 정한 규칙과 같다).
 *
 * 사유·범위별 가중치를 두지 않는다 — 무엇이 더 급한지는 **운영 정책이지 코드의 판단이
 * 아니고**, 지금 그 정책이 없다(O-18). 가중치를 지어내면 그것이 기준처럼 굳는다.
 */
export function sortQueue<T extends { requestedAt: string; status: DeletionStatus }>(
  rows: T[],
): T[] {
  return [...rows].sort((a, b) => {
    const aOpen = isTerminal(a.status) ? 1 : 0;
    const bOpen = isTerminal(b.status) ? 1 : 0;
    // 끝난 것은 아래로. 그 안에서는 오래된 것부터.
    if (aOpen !== bOpen) return aOpen - bOpen;

    return a.requestedAt < b.requestedAt ? -1 : a.requestedAt > b.requestedAt ? 1 : 0;
  });
}
