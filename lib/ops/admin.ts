import {
  ALERT_DELIVERY,
  type Alert,
  type BatchRow,
  type BatchRun,
  buildAlerts,
  buildBatchRows,
} from "@/lib/core/ops/monitor";
import {
  buildReadinessRows,
  readinessAlerts,
  type ReadinessRow,
} from "@/lib/core/ops/readiness";
import { createClient } from "@/lib/supabase/server";

import { cronSecretConfigured } from "./job-auth";
import { JOB_ROUTE_NAMES, SCHEDULED_JOB_NAMES } from "./registry";

/**
 * 모니터링 콘솔 (S8-13 · §7.4 · `/admin/ops`)
 *
 * **세션 클라이언트로 읽는다.** `job_runs`·`client_events` 둘 다 운영자 SELECT
 * 정책이 경계이며(D-115 — 행이 목적이면 정책), 서비스롤로 읽으면 그 경계를 우회해
 * "화면에서만 막는" 상태가 된다. 인가의 최종 경계는 RLS 다.
 *
 * **측정하지 않은 것을 0으로 표시하지 않는다.** 로그인 실패 집계는 클라이언트 신고에
 * 기대므로(FIX-32) **"이만큼은 있었다" 이지 "이게 전부다" 가 아니고**, 그 문장을
 * `loginObservability` 가 화면까지 들고 간다.
 */

export type LoginFailureRow = { code: string; count: number };

export type OpsPayload = {
  batches: BatchRow[];
  alerts: Alert[];
  /** 파기 기한이 지난 문서 수. §5.1 의무라 배치 상태와 별도로 센다. */
  purgeOverdue: number;
  /** 오픈 전에 값이 들어가야 하는 자리(FIX-11). 비어 있으면 거래가 서지 않는다. */
  readiness: ReadinessRow[];
  loginFailures: LoginFailureRow[];
  loginWindowHours: number;
  loginObservability: { complete: false; reason: string };
  alertDelivery: typeof ALERT_DELIVERY;
  /** 스케줄러 전용 키가 설정돼 있는가. **값이 아니라 유무만**(§5.4). */
  cronSecretConfigured: boolean;
  observedAt: string;
};

const LOGIN_WINDOW_HOURS = 24;

const LOGIN_INCOMPLETE =
  "로그인 실패 수는 브라우저가 보내 준 것만 셉니다. 로그인 요청은 브라우저에서 인증 서버로 직행해 서버에 흔적이 남지 않으므로(FIX-32), 네트워크가 끊겼거나 탭이 닫힌 실패는 여기 없습니다. **'이만큼은 있었다' 이지 '이게 전부다' 가 아닙니다.**";

export async function loadOpsConsole(now: Date): Promise<OpsPayload> {
  const supabase = await createClient();
  const since = new Date(now.getTime() - LOGIN_WINDOW_HOURS * 3_600_000).toISOString();

  const [runsResult, auditResult, eventsResult, commissionResult, plannerRateResult] =
    await Promise.all([
    supabase
      .from("job_runs")
      .select("job_name, started_at, finished_at, status, processed_count, error_summary")
      .order("started_at", { ascending: false })
      .limit(500),
    supabase.rpc("admin_purge_audit"),
    supabase
      .from("client_events")
      .select("code")
      .eq("kind", "login_failed")
      .gte("occurred_at", since)
      .limit(1_000),
    /**
     * **살아 있는 요율만 센다**(FIX-11 · FIX-12). `voided_at is null` 을 빼면 무효화된
     * 행까지 세어 "요율이 있다" 고 답하면서 계약은 계속 막힌다 — 가장 나쁜 종류의
     * 거짓말이다. `head: true` 라 행을 끌어오지 않고 수만 받는다.
     */
    supabase
      .from("commission_rates")
      .select("id", { count: "exact", head: true })
      .is("voided_at", null),
    supabase
      .from("planner_fee_rates")
      .select("id", { count: "exact", head: true })
      .is("voided_at", null),
  ]);

  // **권한 실패와 조회 실패를 구분한다** — 앞은 로그인 문제고 뒤는 장애다.
  if (runsResult.error) {
    throw new Error(runsResult.error.code === "42501" ? "OPS_FORBIDDEN" : "OPS_LOAD_FAILED");
  }
  if (auditResult.error) {
    throw new Error(auditResult.error.code === "42501" ? "OPS_FORBIDDEN" : "OPS_LOAD_FAILED");
  }
  if (eventsResult.error) throw new Error("OPS_LOAD_FAILED");

  /**
   * **못 센 것을 0으로 읽지 않는다.** 조회가 실패했는데 0으로 두면 화면이
   * "요율이 하나도 없다" 는 **틀린 경보**를 올리고, 운영자는 멀쩡한 요율을 찾아
   * 헤맨다. 파기 잔존에서 세운 규칙과 같다(S8-01 이 물린 함정).
   */
  if (commissionResult.error || typeof commissionResult.count !== "number") {
    throw new Error(commissionResult.error?.code === "42501" ? "OPS_FORBIDDEN" : "OPS_LOAD_FAILED");
  }
  if (plannerRateResult.error || typeof plannerRateResult.count !== "number") {
    throw new Error(
      plannerRateResult.error?.code === "42501" ? "OPS_FORBIDDEN" : "OPS_LOAD_FAILED",
    );
  }

  const runs: BatchRun[] = (
    (runsResult.data ?? []) as {
      job_name: string;
      started_at: string;
      finished_at: string | null;
      status: string;
      processed_count: number | null;
      error_summary: string | null;
    }[]
  ).map((row) => ({
    name: row.job_name,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    processedCount: row.processed_count ?? 0,
    errorSummary: row.error_summary,
  }));

  // **집계 키가 빠졌으면 0으로 읽지 않는다**(S8-01 이 물린 함정). 파기 잔존은 §5.1
  // 의무라 "집계 못 함" 이 "0건" 으로 바뀌면 그것이 곧 사고다.
  const overdueRaw = (auditResult.data as Record<string, unknown> | null)?.overdue;
  if (typeof overdueRaw !== "number" || !Number.isFinite(overdueRaw)) {
    throw new Error("OPS_LOAD_FAILED");
  }

  const counts = new Map<string, number>();
  for (const row of (eventsResult.data ?? []) as { code: string }[]) {
    counts.set(row.code, (counts.get(row.code) ?? 0) + 1);
  }

  const loginFailures = [...counts.entries()]
    .map(([code, count]) => ({ code, count }))
    // 많은 것부터. 같으면 코드 순 — **순서가 흔들리면 목록을 의심하게 된다.**
    .sort((a, b) => (b.count === a.count ? a.code.localeCompare(b.code) : b.count - a.count));

  const batches = buildBatchRows({
    routes: [...JOB_ROUTE_NAMES],
    scheduled: SCHEDULED_JOB_NAMES,
    runs,
  });

  const readiness = buildReadinessRows({
    liveCommissionRates: commissionResult.count,
    livePlannerFeeRates: plannerRateResult.count,
  });

  return {
    batches,
    // **준비 경보를 배치 경보와 같은 목록에 넣는다.** 운영자가 볼 자리가 하나여야
    // 하고, 심각도 정렬이 그 목록 안에서 이뤄져야 순서가 뜻을 갖는다.
    alerts: [
      ...readinessAlerts(readiness),
      ...buildAlerts({ batches, purgeOverdue: overdueRaw, loginFailures }),
    ],
    purgeOverdue: overdueRaw,
    readiness,
    loginFailures,
    loginWindowHours: LOGIN_WINDOW_HOURS,
    loginObservability: { complete: false, reason: LOGIN_INCOMPLETE },
    alertDelivery: ALERT_DELIVERY,
    // **서버에서만 읽는다.** 값이 아니라 유무만 내보낸다(§5.4).
    cronSecretConfigured: cronSecretConfigured(),
    observedAt: now.toISOString(),
  };
}
