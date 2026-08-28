import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/response";
import { authorizeJob } from "@/lib/ops/job-auth";
import { runDocumentPurge } from "@/lib/privacy/purge";

/**
 * POST /api/jobs/purge-documents — 문서 원문 파기 배치 (F-A-08 · §4.3 배치표 · §5.1)
 *
 * **매시간 돈다.** `purge_scheduled_at` 이 지난 원문과 Storage 객체를 지우고
 * 실행 이력을 `job_runs` 에 남긴다. 실패는 `/admin/privacy` 가 경보로 그린다.
 *
 * **로직은 `lib/privacy/purge.ts` 에 있고 여기는 부르는 자리다** — 앞선 배치 셋
 * (`dday-notifications`·`sla-escalation`·`consultation-confirm-request`)과 같은 모양이다.
 * §4.3 이 이 일을 Edge Function 으로 적어 두었으나 Route Handler 로 세웠다(D-118) —
 * Deno 로 쓰면 파기 판정 로직이 두 벌이 되고, 파기는 되돌릴 수 없는 일이라 두 벌이
 * 갈리면 어느 쪽이 진짜 규칙인지 답할 수 없다.
 *
 * **인증은 서비스롤 키로 한다.** 사람이 아니라 시스템이 부르는 경로다 —
 * 사용자 세션으로 열면 아무나 파기를 돌릴 수 있고, 파기는 되돌릴 수 없다.
 * (앞선 배치 셋과 같은 방식. 전용 비밀키는 S8-13 이 실행 인프라를 정할 때 함께 정한다.)
 *
 * `now` 를 인자로 받는다 — 배치가 '지금' 을 스스로 정하면 같은 입력으로 같은 결과가
 * 나오지 않아 재현할 수 없다. 없으면 서버 시각을 쓰되 **응답에 그 값을 실어** 남긴다.
 */
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  if (!authorizeJob(request).ok) {
    return fail(401, "JOB_UNAUTHORIZED", "실행 권한이 없습니다.");
  }

  const raw = request.nextUrl.searchParams.get("now");
  const parsed = raw ? Date.parse(raw) : Number.NaN;
  const now = Number.isFinite(parsed) ? new Date(parsed) : new Date();

  try {
    const result = await runDocumentPurge(now);

    // **무엇을 지웠는지 id·경로를 싣지 않는다**(§5.3). 개수와 상태만 낸다.
    return ok(result);
  } catch {
    // 실패 원인을 응답에 싣지 않는다(§5.3). 이력은 `job_runs` 에 남았고
    // 경보는 `/admin/privacy` 가 그린다.
    return fail(500, "JOB_FAILED", "파기 배치를 끝내지 못했습니다.");
  }
}

/**
 * **Vercel Cron 은 GET 으로 부른다.** POST 만 있으면 스케줄은 도는데 매번 405 가 되고
 * `job_runs` 에는 아무것도 안 남아 화면은 "한 번도 안 돌았다" 로 보인다 — 틀린
 * 화면은 아니지만 원인을 가리킨다. 같은 핸들러를 둘 다 낸다.
 */
export const GET = POST;
