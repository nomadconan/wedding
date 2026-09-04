import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/response";
import { runEscrowRelease } from "@/lib/escrow/actions";
import { authorizeJob } from "@/lib/ops/job-auth";
import { closeJobRun, openJobRun } from "@/lib/ops/job-run";

/**
 * POST /api/jobs/escrow-release — 에스크로 자동 릴리즈 (§4.5 · S5-09 · FIX-14)
 *
 * 이행 확인이 끝났거나 확인 기한과 예식일이 모두 지난 홀드를 정리한다.
 *
 * **없어서 무엇이 막혀 있었나.** 판정 함수(`decideRelease`)는 있었지만 그것을 부르는
 * 자동 경로가 없었다 — 확인 버튼과 **화면 표시**뿐이었다. 아무도 화면을 열지 않으면
 * 잔금이 묶인 채 남고, 열린 홀드가 있는 예약은 `settlementEligible` 이 정산에서
 * 빼므로 **업체에게 가지도 않고 정산에도 들어오지 않는다.**
 *
 * **판정은 순수 함수 하나가 한다.** 이 배치는 대상을 골라 넘길 뿐이며 자체 규칙을
 * 갖지 않는다 — 갖는 순간 화면이 예고한 것과 배치가 한 것이 갈린다.
 *
 * **`?now=` 로 시각을 넘길 수 있다.** 배치가 스스로 시각을 정하면 같은 입력으로 같은
 * 결과가 나오지 않아 재현할 수 없다(`planner-payout-due` 와 같다).
 *
 * **되돌리지 않는다.** `held` 만 후보이며 `disputed` 는 건드리지 않는다 — 조율은
 * 사유를 붙여 사람이 끝내는 일이고(D-24), 종결된 것은 되돌리지 않는다(D-23).
 */
export async function POST(request: NextRequest) {
  if (!authorizeJob(request).ok) {
    return fail(401, "JOB_UNAUTHORIZED", "실행 권한이 없습니다.");
  }

  const raw = request.nextUrl.searchParams.get("now");
  const now = raw && !Number.isNaN(Date.parse(raw)) ? new Date(raw) : new Date();

  const run = await openJobRun("escrow-release");

  try {
    const result = await runEscrowRelease(now);

    // **`processedCount` 는 움직인 수다.** 살펴본 수를 적으면 아무것도 안 움직인 날과
    // 전부 움직인 날이 같은 숫자가 된다.
    await closeJobRun(run, {
      status: "succeeded",
      processedCount: result.released + result.disputed,
    });

    return ok({ now: now.toISOString(), ...result });
  } catch {
    await closeJobRun(run, { status: "failed", errorSummary: "escrow_release_failed:1" });

    return fail(500, "JOB_FAILED", "배치를 끝내지 못했습니다.");
  }
}

/** **Vercel Cron 은 GET 으로 부른다.** POST 만 있으면 매번 405 가 되고 기록이 비어 있다. */
export const GET = POST;
