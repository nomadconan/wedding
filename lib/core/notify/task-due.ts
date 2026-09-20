// 기한 알림 — 발송 지점 계산 (C-4d · 명세서 §2.1 F-C-21 확장 · §4.5 · §7.4)
//
// 프레임워크를 모르는 순수 모듈이다(CLAUDE.md §3.1).
//
// ── 사용자가 말한 것 ────────────────────────────────────────────────────────
// *"그날로부터 40일/35일 전부터 일정한 간격으로 발송"* — **시작 시점**과 **간격**
// 두 값이다. 둘 다 운영 파라미터이며 **코드가 고르지 않는다**(§7.4).
//   · `notify.task_due_lead_days`     — 기한 며칠 전부터 시작하는가
//   · `notify.task_due_interval_days` — 그 뒤 며칠마다 보내는가
//
// **값이 없으면 보내지 않는다.** 0 으로 읽으면 "기한 당일에만 한 번" 이 되어 조용히
// 다른 정책이 되고, 무제한으로 읽으면 매일 보낸다 — 둘 다 코드가 정책을 대신 답한
// 것이다(D-49 가 AI 상한에서, D-225 가 리드타임에서 세운 것과 같은 규칙).
//
// ── 왜 '지점' 으로 계산하고 '창' 으로 하지 않는가 ───────────────────────────
// "기한 40일 전부터 매일" 이면 소음이고, "창 안에 들어오면 한 번" 이면 재실행·장애
// 복구 때 판정이 흔들린다. **정확히 맞는 날에만 보낸다** — 기존 D-day 배치가
// `DDAY_MILESTONES` 로 한 것과 같은 방식이고, 그래야 멱등 열쇠에 **날짜가 아니라
// 지점**을 넣을 수 있다(열쇠에 실행 날짜를 넣으면 재실행이 중복을 만든다).
//
// ── 소음이 되지 않는 이유 ───────────────────────────────────────────────────
// 지점은 **각 항목 자신의 기한**에서 역산한다. 체크리스트 25종은 D-330~D+30 에 흩어져
// 있으므로 어느 하루에 지점과 정확히 맞는 항목은 보통 0~1개다. 항목 하나가 평생 받는
// 알림은 지점 수만큼(로컬 데모 값 기준 넷)이다.

export const TASK_DUE_LEAD_SETTING_KEY = "notify.task_due_lead_days";
export const TASK_DUE_INTERVAL_SETTING_KEY = "notify.task_due_interval_days";

/** 파라미터가 비었을 때 배치가 남기는 사유. **0 건 발송과 구분된다.** */
export const TASK_DUE_BLOCKED_REASON = "params_unset";

export type TaskDueSchedule =
  | { kind: "ready"; leadDays: number; intervalDays: number; points: readonly number[] }
  | { kind: "blocked"; reason: string };

/**
 * 발송 지점 목록. `[lead, lead−interval, …, 0]`.
 *
 * **기한 당일(0)은 항상 넣는다.** 간격으로 나누어떨어지지 않아 빠지는 것은 계산의
 * 사고이지 결정이 아니다 — 가장 중요한 날을 산술 때문에 놓칠 수는 없다.
 *
 * **값이 없거나 이상하면 `blocked` 다.** 호출부는 그때 **아무것도 보내지 않고**
 * 사유를 기록한다.
 */
export function taskDueSchedule(input: {
  leadDays: number | null;
  intervalDays: number | null;
}): TaskDueSchedule {
  const { leadDays, intervalDays } = input;

  if (leadDays === null || intervalDays === null) {
    return { kind: "blocked", reason: TASK_DUE_BLOCKED_REASON };
  }
  if (!Number.isInteger(leadDays) || leadDays < 0) {
    return { kind: "blocked", reason: "lead_invalid" };
  }
  // 간격 0 은 "매일" 이 아니라 **무한 루프**다. 매일 보내려면 1 을 적는다.
  if (!Number.isInteger(intervalDays) || intervalDays < 1) {
    return { kind: "blocked", reason: "interval_invalid" };
  }

  const points: number[] = [];
  for (let day = leadDays; day > 0; day -= intervalDays) points.push(day);
  points.push(0);

  return { kind: "ready", leadDays, intervalDays, points };
}

/** 오늘이 그 항목의 발송 지점인가. **지났으면 보내지 않는다**(음수는 지점이 아니다). */
export function isSendPoint(daysUntilDue: number, points: readonly number[]): boolean {
  return points.includes(daysUntilDue);
}

/**
 * 건너뛴 이유.
 *
 * **0 으로 접지 않는다**(§7.0b · 측정하지 않은 것을 0으로 표시하지 않는다). 배치가
 * "0건 보냈다" 만 남기면 **보낼 게 없었던 것**과 **보낼 수 없었던 것**이 같아 보인다.
 */
export const TASK_DUE_SKIP_REASONS = [
  /** 기한이 없다 — 태스크에 기한이 안 적혔거나 커플이 예식일을 안 정했다. */
  "no_due_date",
  /** 오늘이 발송 지점이 아니다. **대부분이 여기 들어온다** — 정상이다. */
  "not_a_send_point",
  /** 이미 끝낸 항목이다. */
  "done",
  /** 업체가 주문 기한을 안 적었다(`not_declared`). */
  "lead_time_not_declared",
  /** 업체가 "따로 기한 없음"(0)이라 적었다. */
  "no_order_deadline",
  /** 커플에 받을 사람이 없다. */
  "no_recipient",
  /** 수신 설정에서 그 채널을 꺼 뒀다. **실패가 아니다** — 사용자가 고른 것이다. */
  "prefs_off",
] as const;

export type TaskDueSkipReason = (typeof TASK_DUE_SKIP_REASONS)[number];

export type TaskDueCounts = {
  scanned: number;
  sent: number;
  duplicate: number;
  failed: number;
  /** 사유별 건너뜀. **합계 하나로 접지 않는다.** */
  skipped: Record<TaskDueSkipReason, number>;
};

export function emptyCounts(): TaskDueCounts {
  return {
    scanned: 0,
    sent: 0,
    duplicate: 0,
    failed: 0,
    skipped: Object.fromEntries(TASK_DUE_SKIP_REASONS.map((reason) => [reason, 0])) as Record<
      TaskDueSkipReason,
      number
    >,
  };
}

/** `job_runs.error_summary` 에 적을 한 줄. **0 인 사유는 적지 않는다**(없는 일을 세지 않는다). */
export function skipSummary(counts: TaskDueCounts): string | null {
  const parts = TASK_DUE_SKIP_REASONS.filter((reason) => counts.skipped[reason] > 0).map(
    (reason) => `${reason}:${counts.skipped[reason]}`,
  );

  if (counts.failed > 0) parts.unshift(`send_failed:${counts.failed}`);

  return parts.length === 0 ? null : parts.join(" ");
}
