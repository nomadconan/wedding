import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/response";
import { authorizeJob } from "@/lib/ops/job-auth";
import { closeJobRun, openJobRun } from "@/lib/ops/job-run";
import { runSettlementAggregate } from "@/lib/settlements/actions";

/**
 * POST /api/jobs/settlement-aggregate — 정산 기간 집계 (§4.5 · S5-07 · FIX-08)
 *
 * **없어서 무엇이 막혀 있었나.** 집계 코드는 있었는데 부르는 것은 사람뿐이었다 —
 * `/admin/settlements` 에서 **업체를 하나씩 골라 눌러야** 했다. 월 마감을 사람이
 * 기억해야 하고, 한 업체를 빠뜨리면 **그 업체는 정산을 못 받는다.** 빠뜨렸다는 사실도
 * 어느 화면에 뜨지 않는다.
 *
 * **`?now=` 로 시각을 넘길 수 있다.** 기간은 그 시각에서 나오므로(`settlementPeriod`)
 * 이것이 곧 "어느 기간을 마감하는가" 이고, 같은 입력이면 같은 결과가 나온다.
 *
 * ── 하나도 명세가 되지 않으면 실행을 실패로 닫는다 ─────────────────────────
 * `fee_basis` 미결(O-15)이면 정산서는 `blocked` 로 선다. 그 **정산서**에게는 "실패가
 * 아니라 대기" 가 맞지만 **이 실행**에게는 아니다 — 후보가 있었는데 하나도 명세가
 * 되지 않았으면 마감이 통째로 빈 것이고, 그것을 `succeeded` 로 닫으면 `/admin/ops` 가
 * **"돌았다" 고만 적는다.** 그 화면이 들라고 만든 신호가 바로 이런 것이다.
 *
 * **값을 대신 정하지 않는다**(O-15) — 기본 기준을 고르면 업체가 받는 금액이 코드의
 * 선택이 된다.
 */
export async function POST(request: NextRequest) {
  if (!authorizeJob(request).ok) {
    return fail(401, "JOB_UNAUTHORIZED", "실행 권한이 없습니다.");
  }

  const raw = request.nextUrl.searchParams.get("now");
  const now = raw && !Number.isNaN(Date.parse(raw)) ? new Date(raw) : new Date();

  const run = await openJobRun("settlement-aggregate");

  try {
    const result = await runSettlementAggregate(now);

    // 후보가 있었는데 하나도 서지 못했다 — 왜인지를 요약 코드로 남긴다(§5.3 · 원문 금지).
    const stalled = result.scanned > 0 && result.drafted === 0 && result.blocked > 0;

    await closeJobRun(run, {
      status: result.failed > 0 || stalled ? "failed" : "succeeded",
      // **선 정산서만 센다.** `blocked` 를 함께 세면 마감이 빈 달과 찬 달이 같은 수가 된다.
      processedCount: result.drafted,
      errorSummary:
        result.failed > 0
          ? `settlement_write_failed:${result.failed}`
          : stalled
            ? `settlement_blocked:${result.blocked}:fee_basis_missing`
            : null,
    });

    return ok({ now: now.toISOString(), ...result });
  } catch {
    await closeJobRun(run, { status: "failed", errorSummary: "settlement_aggregate_failed:1" });

    return fail(500, "JOB_FAILED", "배치를 끝내지 못했습니다.");
  }
}

/** **Vercel Cron 은 GET 으로 부른다.** POST 만 있으면 매번 405 가 되고 기록이 비어 있다. */
export const GET = POST;
