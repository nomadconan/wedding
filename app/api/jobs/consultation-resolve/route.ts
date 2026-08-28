import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/response";
import { authorizeJob } from "@/lib/ops/job-auth";
import { closeJobRun, openJobRun } from "@/lib/ops/job-run";
import { runResolve } from "@/lib/consultation/batch";

/**
 * POST /api/jobs/consultation-resolve — 이행 확인 자동 판정 배치 (§3.11, S4-09)
 *
 * 확인 기한이 지난 건을 §3.11 규칙대로 마무리한다 — 양측 일치면 자동 환불·몰취,
 * 불일치·한쪽 무응답이면 `disputed`, **양측 무응답이면 환불**(기본값).
 *
 * **판정은 `lib/core/consultation` 의 순수 함수 하나가 한다.** 이 배치는 대상을
 * 골라 넘길 뿐이다 — 배치가 자체 규칙을 갖는 순간 화면·API 와 답이 갈린다.
 *
 * 실행 등록은 **S8-13**. 1시간마다 부르면 된다.
 */
export async function POST(request: NextRequest) {
  if (!authorizeJob(request).ok) {
    return fail(401, "JOB_UNAUTHORIZED", "실행 권한이 없습니다.");
  }

  const raw = request.nextUrl.searchParams.get("now");
  const now =
    raw && !Number.isNaN(Date.parse(raw)) ? raw : new Date().toISOString();

  const run = await openJobRun("consultation-resolve");

  try {
    const result = await runResolve(now);

    await closeJobRun(run, {
      status: "succeeded",
      processedCount: result.scanned,
    });

    return ok({ now, ...result });
  } catch {
    await closeJobRun(run, {
      status: "failed",
      errorSummary: "resolve_failed:1",
    });

    return fail(500, "JOB_FAILED", "배치를 끝내지 못했습니다.");
  }
}

/**
 * **Vercel Cron 은 GET 으로 부른다.** POST 만 있으면 스케줄은 도는데 매번 405 가 되고
 * `job_runs` 에는 아무것도 안 남아 화면은 "한 번도 안 돌았다" 로 보인다 — 틀린
 * 화면은 아니지만 원인을 가리킨다. 같은 핸들러를 둘 다 낸다.
 */
export const GET = POST;
