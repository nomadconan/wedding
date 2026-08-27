// 문서 파기 배치 (S8-04 · F-A-08 · 명세서 §4.3 배치 · §5.1 · §7.3)
//
// **배치가 '지금' 을 스스로 정하지 않는다.** `now` 를 인자로 받는다 — 같은 입력이면
// 같은 결과여야 시험할 수 있고, 파기는 되돌릴 수 없는 일이라 더욱 그렇다
// (`app/api/jobs/*` 의 다른 배치들과 같은 규칙).
//
// 이 파일은 DB 도 Storage 도 모른다. **무엇을 지울지 고르고 결과를 요약할 뿐**이다.

/** `job_runs.job_name`. 화면·배치·검사가 같은 문자열을 봐야 한다. */
export const PURGE_JOB_NAME = "purge-documents";

/** 파기 대상 한 건. `storagePath` 는 배치 안에서만 살고 **밖으로 나가지 않는다**(§5.3). */
export type PurgeCandidate = {
  id: string;
  storagePath: string;
  purgeScheduledAt: string;
  purgedAt: string | null;
};

/**
 * 지금 지워야 할 것.
 *
 * **경계일 당일을 포함한다** — `purge_scheduled_at <= now`. 예약 시각이 정확히 지금인
 * 건을 다음 시간까지 미루면 "24시간 내 파기"(§5.1)가 25시간이 된다.
 */
export function selectDuePurges(candidates: PurgeCandidate[], now: Date): PurgeCandidate[] {
  const cutoff = now.getTime();

  return candidates.filter(
    (row) => row.purgedAt === null && Date.parse(row.purgeScheduledAt) <= cutoff,
  );
}

export type PurgeOutcome =
  /** Storage 객체를 지웠고 `purged_at` 을 찍었다. */
  | { id: string; result: "purged" }
  /**
   * Storage 에 객체가 이미 없었다. **실패가 아니다** — 목적은 "원문이 남아 있지 않다"
   * 이고 그 상태는 달성돼 있다. `purged_at` 은 찍는다(안 찍으면 매시간 다시 시도한다).
   */
  | { id: string; result: "already_gone" }
  /** 지우지 못했다. `purged_at` 을 **찍지 않는다** — 다음 실행이 다시 집어야 한다. */
  | { id: string; result: "failed"; reason: string };

export type PurgeSummary = {
  processed: number;
  purged: number;
  alreadyGone: number;
  failed: number;
  /** `job_runs.status`. 하나라도 실패하면 `failed` 다. */
  status: "succeeded" | "failed";
  /**
   * `job_runs.error_summary`. **경로도 id 도 담지 않는다**(§5.3) —
   * 담는 것은 사유 코드와 개수뿐이다.
   */
  errorSummary: string | null;
};

/**
 * 실행 결과를 `job_runs` 한 줄로 요약한다.
 *
 * **`error_summary` 에 무엇을 담느냐가 이 함수의 핵심이다.** 실패한 문서의 경로를
 * 적으면 파기 실패 로그가 곧 **남아 있는 원문의 위치 목록**이 된다 — 지우려던 것을
 * 로그로 복제하는 셈이다. 그래서 사유별 개수만 적는다.
 */
export function summarizePurgeRun(outcomes: PurgeOutcome[]): PurgeSummary {
  const purged = outcomes.filter((row) => row.result === "purged").length;
  const alreadyGone = outcomes.filter((row) => row.result === "already_gone").length;
  const failures = outcomes.filter(
    (row): row is Extract<PurgeOutcome, { result: "failed" }> => row.result === "failed",
  );

  const byReason = new Map<string, number>();
  for (const failure of failures) {
    byReason.set(failure.reason, (byReason.get(failure.reason) ?? 0) + 1);
  }

  return {
    processed: outcomes.length,
    purged,
    alreadyGone,
    failed: failures.length,
    status: failures.length > 0 ? "failed" : "succeeded",
    errorSummary:
      failures.length === 0
        ? null
        : [...byReason.entries()]
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .map(([reason, count]) => `${reason}:${count}`)
            .join(" "),
  };
}

// ── 경보 (F-A-08 "파기 실패·잔존 건 경보") ──────────────────────────────────

export type PurgeAudit = {
  documentsTotal: number;
  purged: number;
  overdue: number;
  scheduled: number;
  /** 가장 오래 밀린 건의 경과 시간. **밀린 것이 없으면 null 이다** — 0 이 아니다. */
  oldestOverdueHours: number | null;
  maskingFailures: number;
  maskingFailures24h: number;
};

export type PrivacyAlert = {
  code: "PURGE_OVERDUE" | "PURGE_RUN_FAILED" | "PURGE_NEVER_RAN" | "MASKING_FAILED";
  severity: "warn" | "critical";
  message: string;
  /** 운영자가 다음에 할 일. 경보만 있고 할 일이 없으면 아무도 안 본다. */
  action: string;
};

/**
 * 잔존 건이 이 시간을 넘기면 **critical** 이다.
 *
 * §5.1 이 "분석 완료 후 24시간 내 파기" 를 요구하므로 예약 시각 자체가 이미 그 기한을
 * 반영하고 있다. 여기서 재는 것은 **예약 시각을 넘긴 뒤 얼마나 더 지났는가** 이고,
 * 매시간 도는 배치가 한 번만 실패해도 1시간이 밀리므로 한두 번의 실패는 warn 이다.
 * **이 값은 운영 파라미터가 아니라 배치 주기에서 나온 기술적 값**이라 코드에 둔다
 * (삭제 요청 SLA 와 다른 점이 이것이다 — 그쪽은 법정 기한이라 O-18 이 정한다).
 */
export const PURGE_CRITICAL_HOURS = 6;

/**
 * 경보를 만든다.
 *
 * **0 건이면 경보가 없다.** 화면은 "이상 없음" 과 "아직 못 셈" 을 다르게 그려야 하는데,
 * 그 구분은 값이 있느냐로 하고 이 함수는 **있는 값에 대해서만** 판정한다.
 */
export function purgeAlerts(
  audit: PurgeAudit,
  lastRun: { status: string; finishedAt: string | null } | null,
): PrivacyAlert[] {
  const alerts: PrivacyAlert[] = [];

  if (audit.overdue > 0) {
    const hours = audit.oldestOverdueHours ?? 0;
    alerts.push({
      code: "PURGE_OVERDUE",
      severity: hours >= PURGE_CRITICAL_HOURS ? "critical" : "warn",
      message: `파기 기한이 지난 원문이 ${audit.overdue.toLocaleString("en-US")}건 남아 있습니다 (가장 오래된 건 ${hours}시간 경과).`,
      action: "파기 배치를 실행하고, 반복되면 Storage 접근 권한을 확인해 주세요.",
    });
  }

  if (lastRun === null) {
    alerts.push({
      code: "PURGE_NEVER_RAN",
      severity: "warn",
      message: "파기 배치가 한 번도 실행되지 않았습니다.",
      action: "스케줄 등록 여부를 확인해 주세요. 실행 이력이 없으면 잔존 건도 줄지 않습니다.",
    });
  } else if (lastRun.status === "failed") {
    alerts.push({
      code: "PURGE_RUN_FAILED",
      severity: "critical",
      message: "마지막 파기 실행이 실패로 끝났습니다.",
      action: "실행 이력의 오류 요약을 확인해 주세요. 원문이 계속 남아 있습니다.",
    });
  }

  if (audit.maskingFailures24h > 0) {
    alerts.push({
      code: "MASKING_FAILED",
      severity: "warn",
      message: `최근 24시간 안에 마스킹이 끝나지 않아 분석이 중단된 건이 ${audit.maskingFailures24h.toLocaleString("en-US")}건 있습니다.`,
      // 마스킹 실패는 **막힌 것이 정상 동작**이다(§5.2 — 실패 시 호출 중단).
      // 고칠 대상은 사용자가 아니라 패턴이다.
      action: "차단은 정상 동작입니다. 같은 유형이 반복되면 마스킹 패턴을 점검해 주세요.",
    });
  }

  return alerts;
}
