import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/response";
import { runConfirmRequests } from "@/lib/consultation/batch";

/**
 * POST /api/jobs/consultation-confirm-request — 이행 확인 요청 배치 (§3.11 1번, S4-09)
 *
 * 예정 시각이 지난 확정 예약에 **확인 창을 열고 양측에 요청한다.** §3.11 이
 * "요청 발송은 `notifications` 에 기록된다" 고 명시한 그 발송이다 — 보증금 몰취의
 * 근거가 "확인해 달라고 했는데 답하지 않았다" 이므로, 요청 기록이 없으면 근거가
 * 통째로 사라진다(D-23).
 *
 * **로직은 `lib/consultation/batch.ts` 에 있고 여기는 부르는 자리다.**
 * 스케줄 등록(Cron·`job_runs`·경보)은 **S8-13** 소관 — `dday-notifications`·
 * `sla-escalation` 과 같은 규칙이다. S8-13 은 이 경로를 1시간마다 부르면 된다.
 *
 * `now` 를 인자로 받는다 — 배치가 '지금' 을 스스로 정하면 같은 입력으로 같은 결과가
 * 나오지 않아 재현할 수 없다(S2-06). 없으면 서버 시각을 쓰되 **응답에 실어** 무엇을
 * 기준으로 돌았는지 남긴다.
 */
export async function POST(request: NextRequest) {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const provided = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");

  if (!secret || provided !== secret) {
    return fail(401, "JOB_UNAUTHORIZED", "실행 권한이 없습니다.");
  }

  const raw = request.nextUrl.searchParams.get("now");
  const now = raw && !Number.isNaN(Date.parse(raw)) ? raw : new Date().toISOString();

  try {
    return ok({ now, ...(await runConfirmRequests(now)) });
  } catch {
    // 실패 원인을 응답에 싣지 않는다(CLAUDE.md §5.3). 경보는 S8-13 이 붙인다.
    return fail(500, "JOB_FAILED", "배치를 끝내지 못했습니다.");
  }
}
