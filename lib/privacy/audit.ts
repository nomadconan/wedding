import { readIntSetting } from "@/lib/app-settings";
import {
  type DeletionStatus,
  type SlaVerdict,
  deletionSla,
  sortQueue,
} from "@/lib/core/privacy/deletion";
import {
  PURGE_JOB_NAME,
  type PrivacyAlert,
  type PurgeAudit,
  purgeAlerts,
} from "@/lib/core/privacy/purge";
import { createClient } from "@/lib/supabase/server";

/**
 * 개인정보 감사 로더 (S8-04 · F-A-08)
 *
 * **읽는 방식이 대상마다 다르고, 그 차이가 이 파일의 요점이다.**
 *
 * | 대상 | 방식 | 왜 |
 * |---|---|---|
 * | 삭제 요청 | **세션 + RLS** | 행을 읽고 하나씩 처리하는 큐다(D-115) |
 * | 배치 이력 | **세션 + RLS** | 같은 이유. 실행 한 줄 한 줄이 증적이다 |
 * | 문서 파기 현황 | **집계 함수** | `storage_path` 가 있어 **행을 보여 주면 안 된다**(§5.3) |
 *
 * 셋을 한 방식으로 통일하지 않았다 — 통일하면 둘 중 하나가 틀린 자리에 놓인다.
 */
export type DeletionRow = {
  id: string;
  userId: string;
  scope: string;
  status: DeletionStatus;
  requestedAt: string;
  completedAt: string | null;
  resolvedBy: string | null;
  resolutionReason: string | null;
  sla: SlaVerdict;
};

export type JobRunRow = {
  id: string;
  jobName: string;
  startedAt: string;
  finishedAt: string | null;
  status: string;
  processedCount: number | null;
  errorSummary: string | null;
};

export type PrivacyPayload = {
  audit: PurgeAudit;
  alerts: PrivacyAlert[];
  runs: JobRunRow[];
  requests: DeletionRow[];
  /** O-18 미결이면 null. 화면이 "기준 미확정" 을 그리는 근거다. */
  slaLimitHours: number | null;
};

/** `admin_purge_audit()` 가 돌려주는 jsonb 를 숫자로 좁힌다. */
function toAudit(json: unknown): PurgeAudit {
  const row = (json ?? {}) as Record<string, unknown>;

  // **키가 빠졌으면 0으로 읽지 않는다.** `Number(null)` 은 0 이고, 그러면
  // "집계 못 함" 이 "잔존 0건" 으로 조용히 바뀐다(S8-01 이 물린 것과 같은 함정).
  const num = (key: string): number => {
    const value = row[key];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`admin_purge_audit: ${key} 가 숫자가 아닙니다.`);
    }

    return value;
  };

  const oldest = row.oldestOverdueHours;

  return {
    documentsTotal: num("documentsTotal"),
    purged: num("purged"),
    overdue: num("overdue"),
    scheduled: num("scheduled"),
    // **여기만 null 을 허용한다** — 밀린 것이 없으면 '0시간' 이 아니라 '없음' 이다.
    oldestOverdueHours: typeof oldest === "number" && Number.isFinite(oldest) ? oldest : null,
    maskingFailures: num("maskingFailures"),
    maskingFailures24h: num("maskingFailures24h"),
  };
}

export async function loadPrivacyAudit(now: Date): Promise<PrivacyPayload> {
  const supabase = await createClient();

  // O-18 미결이면 null 이다. `readIntSetting` 이 `null` 을 0 으로 읽지 않는다(S7-17 이 물린 자리).
  const slaLimitHours = await readIntSetting("privacy.deletion_sla_hours", "value");

  const [auditResult, runsResult, requestsResult] = await Promise.all([
    supabase.rpc("admin_purge_audit"),
    supabase
      .from("job_runs")
      .select("id, job_name, started_at, finished_at, status, processed_count, error_summary")
      .eq("job_name", PURGE_JOB_NAME)
      .order("started_at", { ascending: false })
      .limit(20),
    supabase
      .from("data_deletion_requests")
      .select("id, user_id, scope, status, requested_at, completed_at, resolved_by, resolution_reason")
      .limit(200),
  ]);

  if (auditResult.error) {
    throw new Error(
      auditResult.error.code === "42501" ? "PRIVACY_FORBIDDEN" : "PRIVACY_LOAD_FAILED",
    );
  }
  if (runsResult.error || requestsResult.error) throw new Error("PRIVACY_LOAD_FAILED");

  const audit = toAudit(auditResult.data);

  type RawRun = {
    id: string; job_name: string; started_at: string; finished_at: string | null;
    status: string; processed_count: number | null; error_summary: string | null;
  };
  const runs: JobRunRow[] = ((runsResult.data ?? []) as RawRun[]).map((row) => ({
    id: row.id,
    jobName: row.job_name,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    status: row.status,
    processedCount: row.processed_count,
    errorSummary: row.error_summary,
  }));

  type RawRequest = {
    id: string; user_id: string; scope: string; status: DeletionStatus;
    requested_at: string; completed_at: string | null;
    resolved_by: string | null; resolution_reason: string | null;
  };
  const requests: DeletionRow[] = sortQueue(
    ((requestsResult.data ?? []) as RawRequest[]).map((row) => ({
      id: row.id,
      userId: row.user_id,
      scope: row.scope,
      status: row.status,
      requestedAt: row.requested_at,
      completedAt: row.completed_at,
      resolvedBy: row.resolved_by,
      resolutionReason: row.resolution_reason,
      sla: deletionSla(row.requested_at, now, slaLimitHours),
    })),
  );

  // 마지막 실행. **없으면 null 이고 그것도 경보다** — 잔존 0건이 '정상' 처럼 보인다.
  const lastRun = runs.length > 0 ? { status: runs[0].status, finishedAt: runs[0].finishedAt } : null;

  return { audit, alerts: purgeAlerts(audit, lastRun), runs, requests, slaLimitHours };
}
