import { createAdminClient } from "@/lib/supabase/admin";

/**
 * 배치 실행 이력 (S8-13 · §7.4)
 *
 * **네 배치가 `job_runs` 를 안 채우고 있었다.** `dday-notifications`·`sla-escalation`·
 * `consultation-confirm-request`·`consultation-resolve` 넷이며, 각 라우트 주석이
 * "`job_runs` 기록은 S8-13 소관" 이라고 적어 둔 채였다. 그 상태로는 모니터링 화면이
 * **돌았는데도 "한 번도 안 돌았다"** 고 적는다 — 화면이 틀린 것이 아니라 **볼 것이
 * 없는 것**이고, 그 둘은 화면에서 구분되지 않는다.
 *
 * 이미 채우던 셋(`purge-documents`·`price-index-refresh`·`price-anomaly-scan`)이 각자
 * 같은 코드를 복사해 갖고 있었다. 여기로 모아 **열고 닫는 모양을 하나로** 만든다.
 *
 * **`started_at` 을 열 때 못 박는다**(D-128) — NOT NULL 이고, 끝날 때 채우면 도중에
 * 프로세스가 죽은 실행은 행조차 안 남는다. **죽은 실행이야말로 봐야 할 실행이다.**
 */
export type JobRunHandle = { id: string | null };

export async function openJobRun(jobName: string): Promise<JobRunHandle> {
  const admin = createAdminClient();

  const { data } = await admin
    .from("job_runs")
    .insert({ job_name: jobName, started_at: new Date().toISOString(), status: "running" })
    .select("id")
    .maybeSingle();

  // **열지 못해도 배치를 중단하지 않는다.** 기록은 관측이고 배치는 일이다 —
  // 관측이 안 된다고 파기가 멈추면 그쪽이 더 큰 사고다.
  return { id: (data as { id: string } | null)?.id ?? null };
}

export async function closeJobRun(
  handle: JobRunHandle,
  result: { status: "succeeded" | "failed"; processedCount?: number; errorSummary?: string | null },
): Promise<void> {
  if (handle.id === null) return;

  const admin = createAdminClient();

  await admin
    .from("job_runs")
    .update({
      finished_at: new Date().toISOString(),
      status: result.status,
      processed_count: result.processedCount ?? 0,
      // **원문·경로를 싣지 않는다**(§5.3). 요약 코드만 남긴다.
      error_summary: result.errorSummary ?? null,
    })
    .eq("id", handle.id);
}
