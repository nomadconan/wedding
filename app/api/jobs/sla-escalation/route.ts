import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/response";
import { runExpiry, runSlaEscalation } from "@/lib/notify/sla";

/**
 * POST /api/jobs/sla-escalation — 미응답 에스컬레이션 + 만료 처리 (S4-13 잔여, §4 배치표)
 *
 * S4-13 이 "대상이 없어 만들지 않았다" 고 남긴 배치다. S4-04(채팅)·S4-12(문의)가
 * 훑을 표를 만들어 이제 돌 수 있다.
 *
 * **로직은 `lib/notify/sla.ts` 에 있고 여기는 부르는 자리다.** 스케줄 등록(Cron·
 * `job_runs` 기록·실패 경보)은 **S8-13** 소관이다 — `dday-notifications` 와 같은 규칙.
 * S8-13 은 이 경로를 1시간마다 부르면 된다.
 *
 * **만료를 같은 배치에서 함께 돌린다.** 만료는 시간이 지나면 저절로 벌어지는 일이라
 * 누군가 화면을 열어야 반영되면 안 된다 — 고객이 문의함을 열지 않아도 견적은
 * 만료되어야 하고, 그래야 만료된 가격을 수락하는 일이 생기지 않는다.
 *
 * `now`·`today` 를 인자로 받는다 — 배치가 '지금' 을 스스로 정하면 같은 입력으로 같은
 * 결과가 나오지 않아 재현할 수 없다(S2-06 규칙). 없으면 서버 시각을 쓰되 **응답에
 * 그 값을 실어** 무엇을 기준으로 돌았는지 남긴다.
 */
export async function POST(request: NextRequest) {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const provided = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");

  if (!secret || provided !== secret) {
    return fail(401, "JOB_UNAUTHORIZED", "실행 권한이 없습니다.");
  }

  const rawNow = request.nextUrl.searchParams.get("now");
  const now = rawNow && !Number.isNaN(Date.parse(rawNow)) ? rawNow : new Date().toISOString();
  const today = now.slice(0, 10);

  try {
    // 만료를 **먼저** 돌린다. 그래야 이미 지난 문의를 재촉하지 않는다.
    const expiry = await runExpiry(now, today);
    const escalation = await runSlaEscalation(now);

    return ok({ now, today, expiry, escalation });
  } catch {
    // 실패 원인을 응답에 싣지 않는다(CLAUDE.md §5.3). 경보는 S8-13 이 붙인다.
    return fail(500, "JOB_FAILED", "배치를 끝내지 못했습니다.");
  }
}
