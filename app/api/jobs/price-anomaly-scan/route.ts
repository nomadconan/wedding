import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/response";
import { authorizeJob } from "@/lib/ops/job-auth";
import { loadAnomalies } from "@/lib/pricing/curation";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * POST /api/jobs/price-anomaly-scan — 가격 이상 탐지 배치 (F-A-14 · §4.3 · 매일)
 *
 * **큐를 표에 저장하지 않는다.** 플래그는 등록가와 지수에서 **계산되는 값**이고,
 * 저장하면 원본이 바뀔 때 큐가 낡는다(공통 제약). 이 배치가 하는 일은 **세어서
 * `job_runs` 에 남기는 것**이며, 화면은 볼 때마다 **같은 순수 함수**로 다시 센다 —
 * 그래서 배치와 화면의 답이 갈릴 수 없다.
 *
 * **임계값이 미결이면 돌지 않고 그 사실을 남긴다**(O-19). "0건 탐지" 로 적으면
 * 이상이 없는 것처럼 보이는데, 실제로는 **기준이 없어 보지 않은 것**이다.
 */
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  if (!authorizeJob(request).ok) {
    return fail(401, "JOB_UNAUTHORIZED", "실행 권한이 없습니다.");
  }

  const admin = createAdminClient();
  const startedAt = new Date().toISOString();

  const { data: opened } = await admin
    .from("job_runs")
    .insert({
      job_name: "price-anomaly-scan",
      started_at: startedAt,
      status: "running",
    })
    .select("id")
    .maybeSingle();

  const jobRunId = (opened as { id: string } | null)?.id ?? null;

  try {
    const payload = await loadAnomalies();
    const blocked =
      payload.bait.status === "blocked" && payload.addon.status === "blocked";

    if (jobRunId) {
      await admin
        .from("job_runs")
        .update({
          finished_at: new Date().toISOString(),
          // **막힌 것을 성공으로 적지 않는다.** 이력을 보는 사람이 "돌았고 0건" 으로 읽으면 안 된다.
          status: blocked ? "skipped" : "succeeded",
          processed_count: payload.flags.length,
          error_summary: blocked ? "threshold_undecided:O-19" : null,
        })
        .eq("id", jobRunId);
    }

    return ok({
      // 화면이 안 그려도 본문에서 구분되게 싣는다(함정 3).
      blocked,
      openIssue: blocked ? "O-19" : null,
      flagged: payload.flags.length,
      bait: payload.bait.status,
      addon: payload.addon.status,
    });
  } catch {
    if (jobRunId) {
      await admin
        .from("job_runs")
        .update({
          finished_at: new Date().toISOString(),
          status: "failed",
          error_summary: "scan_failed:1",
        })
        .eq("id", jobRunId);
    }

    return fail(500, "JOB_FAILED", "이상 탐지를 끝내지 못했습니다.");
  }
}

/**
 * **Vercel Cron 은 GET 으로 부른다.** POST 만 있으면 스케줄은 도는데 매번 405 가 되고
 * `job_runs` 에는 아무것도 안 남아 화면은 "한 번도 안 돌았다" 로 보인다 — 틀린
 * 화면은 아니지만 원인을 가리킨다. 같은 핸들러를 둘 다 낸다.
 */
export const GET = POST;
