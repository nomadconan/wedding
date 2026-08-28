import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/response";
import { authorizeJob } from "@/lib/ops/job-auth";
import { closeJobRun, openJobRun } from "@/lib/ops/job-run";
import { runDdayNotifications } from "@/lib/notify/dday";

/**
 * POST /api/jobs/dday-notifications — D-day 리마인더 배치 (S4-13, §4 배치표)
 *
 * **로직은 `lib/notify/dday.ts` 에 있고 여기는 부르는 자리다.**
 * 스케줄 등록(Cron 등록·`job_runs` 기록·실패 경보)은 **S8-13** 소관이다 — 커버리지
 * 표의 배치 절이 그렇게 정했다. S8-13 은 이 경로를 매일 09:00 KST 에 부르면 된다.
 *
 * **인증은 서비스롤 키로 한다.** 사람이 아니라 시스템이 부르는 경로이고, 사용자
 * 세션으로 열면 아무나 배치를 돌려 알림을 뿌릴 수 있다. 전용 비밀키를 따로 두는 것은
 * S8-13 이 실행 인프라를 정할 때 함께 정하면 되고, 그때까지는 이미 모든 환경에 있는
 * 값을 쓰는 편이 새 환경 변수를 하나 더 만드는 것보다 낫다.
 *
 * `today` 를 인자로 받는다 — 배치가 '오늘' 을 스스로 정하면 같은 입력으로 같은 결과가
 * 나오지 않아 재현할 수 없다(S2-06·S3-03 과 같은 규칙). 없으면 서버 날짜를 쓰되
 * **응답에 그 값을 실어** 무엇을 기준으로 돌았는지 남긴다.
 */
export async function POST(request: NextRequest) {
  if (!authorizeJob(request).ok) {
    return fail(401, "JOB_UNAUTHORIZED", "실행 권한이 없습니다.");
  }

  const raw = request.nextUrl.searchParams.get("today");
  const today =
    raw && /^\d{4}-\d{2}-\d{2}$/.test(raw)
      ? raw
      : new Date().toISOString().slice(0, 10);

  // **실행 이력을 남긴다**(S8-13). 이것이 없으면 모니터링 화면이 "한 번도 안 돌았다"
  // 고 적는다 — 돌았는데도 그렇다. **볼 것이 없는 것과 안 도는 것이 같아 보인다.**
  const run = await openJobRun("dday-notifications");

  try {
    const result = await runDdayNotifications(today);

    await closeJobRun(run, {
      status: "succeeded",
      processedCount: result.scanned,
      // **발송 실패를 배치 실패로 세지 않는다.** 배치는 돌았고 일부가 안 간 것이다.
      errorSummary: result.failed > 0 ? `send_failed:${result.failed}` : null,
    });

    return ok({ today, ...result });
  } catch {
    await closeJobRun(run, { status: "failed", errorSummary: "dday_failed:1" });

    // 실패 원인을 응답에 싣지 않는다(CLAUDE.md §5.3). 경보는 S8-13 이 붙인다.
    return fail(500, "JOB_FAILED", "배치를 끝내지 못했습니다.");
  }
}

/**
 * **Vercel Cron 은 GET 으로 부른다.** POST 만 있으면 스케줄은 도는데 매번 405 가 되고
 * `job_runs` 에는 아무것도 안 남아 화면은 "한 번도 안 돌았다" 로 보인다 — 틀린
 * 화면은 아니지만 원인을 가리킨다. 같은 핸들러를 둘 다 낸다.
 */
export const GET = POST;
