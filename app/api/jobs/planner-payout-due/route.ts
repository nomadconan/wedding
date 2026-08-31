import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/response";
import { authorizeJob } from "@/lib/ops/job-auth";
import { closeJobRun, openJobRun } from "@/lib/ops/job-run";
import { runPlannerPayoutDue } from "@/lib/planners/payouts";

/**
 * POST /api/jobs/planner-payout-due — 플래너 지급 유예 경과 전환 (§4.5 · D-21 · S6-05)
 *
 * 유예가 지난 `earned` 건을 `payable` 로 옮긴다.
 *
 * **판정은 순수 함수 하나가 한다**(`dueForPayable`). 이 배치는 대상을 골라 넘길 뿐이며
 * 자체 규칙을 갖지 않는다 — 갖는 순간 화면·API 와 답이 갈린다.
 *
 * **일찍 옮기는 것은 DB 가 막는다**(0028 트리거). 배치가 잘못 계산해도 유예 전에
 * 지급 대상이 되지 않는다 — 유예는 환불·분쟁 창구가 닫히기를 기다리는 기간이라
 * 앞당기면 회수할 수 없다.
 *
 * **배치가 늦어도 화면은 사실을 말한다.** 화면은 저장된 상태가 아니라 `payable_at` 과
 * 시계로 판정한다(`plannerPayoutState()`) — 이 배치가 하루 안 돌았다고 플래너가
 * "아직 유예 중" 이라는 틀린 문장을 보지 않는다.
 */
export async function POST(request: NextRequest) {
  if (!authorizeJob(request).ok) {
    return fail(401, "JOB_UNAUTHORIZED", "실행 권한이 없습니다.");
  }

  const raw = request.nextUrl.searchParams.get("now");
  const now = raw && !Number.isNaN(Date.parse(raw)) ? new Date(raw) : new Date();

  const run = await openJobRun("planner-payout-due");

  try {
    const result = await runPlannerPayoutDue(now);

    await closeJobRun(run, { status: "succeeded", processedCount: result.moved });

    return ok({ now: now.toISOString(), ...result });
  } catch {
    await closeJobRun(run, { status: "failed", errorSummary: "planner_payout_due_failed:1" });

    return fail(500, "JOB_FAILED", "배치를 끝내지 못했습니다.");
  }
}

/** **Vercel Cron 은 GET 으로 부른다.** POST 만 있으면 매번 405 가 되고 기록이 비어 있다. */
export const GET = POST;
