import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/response";
import { authorizeJob } from "@/lib/ops/job-auth";
import { PRICE_INDEX_ALL } from "@/lib/core/pricing/price-index";
import { recalculateIndex } from "@/lib/pricing/curation";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * POST /api/jobs/price-index-refresh — 참가격 지수 재계산 배치 (F-A-02 · §4.3 · 주 1회)
 *
 * **산출은 S3-08 의 `buildPriceIndex` 가 한다**(`recalculateIndex` 경유). 이 배치는
 * 어떤 칸을 돌릴지 고르고 결과를 `job_runs` 에 남기는 일만 한다 — 사분위 계산을 다시
 * 구현하면 소비자 화면(`GET /api/prices`)과 다른 값이 나올 수 있다.
 *
 * **운영자의 제외 표시를 지우지 않는다.** `recalculateIndex` 가 기존 `price_sources` 의
 * `excluded_reason` 을 읽어 그 상품을 표본에서 뺀다 — 배치가 큐레이션을 되돌리면
 * 운영자가 뺀 이상치가 매주 되살아난다.
 *
 * **인증은 서비스롤 키다**(앞선 배치 넷과 같은 규칙). 지수는 서비스의 핵심 값이라
 * 아무나 다시 셀 수 있으면 안 된다. 스케줄 등록은 **S8-13**.
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
      job_name: "price-index-refresh",
      started_at: startedAt,
      status: "running",
    })
    .select("id")
    .maybeSingle();

  const jobRunId = (opened as { id: string } | null)?.id ?? null;

  try {
    // 돌릴 칸: 공개 상품이 있는 지역·카테고리 조합. **없는 칸을 만들지 않는다** —
    // 표본이 0인 칸을 만들어 두면 화면이 "가격이 없다" 로 읽는다.
    const { data: vendorRows } = await admin
      .from("vendors")
      .select("region_code, category")
      .eq("status", "active")
      .limit(1_000);

    const cells = [
      ...new Map(
        ((vendorRows ?? []) as { region_code: string; category: string }[]).map(
          (row) => [`${row.region_code}|${row.category}`, row],
        ),
      ).values(),
    ];

    let built = 0;
    let insufficient = 0;

    for (const cell of cells) {
      const result = await recalculateIndex({
        regionCode: cell.region_code,
        category: cell.category,
        reason: "주기 재계산",
        // 배치에는 사람이 없다. 시스템 실행임을 증적이 그대로 말한다.
        operatorId: "00000000-0000-0000-0000-000000000000",
        operatorRole: "system",
      });

      if (!result.ok) continue;
      if (result.blocked) insufficient += 1;
      else built += 1;
    }

    if (jobRunId) {
      await admin
        .from("job_runs")
        .update({
          finished_at: new Date().toISOString(),
          status: "succeeded",
          processed_count: cells.length,
          // **표본 부족을 실패로 세지 않는다.** 아직 안 모인 것이지 고장이 아니다.
          error_summary:
            insufficient > 0 ? `insufficient_sample:${insufficient}` : null,
        })
        .eq("id", jobRunId);
    }

    return ok({
      cells: cells.length,
      built,
      insufficient,
      guestBucket: PRICE_INDEX_ALL,
    });
  } catch {
    if (jobRunId) {
      await admin
        .from("job_runs")
        .update({
          finished_at: new Date().toISOString(),
          status: "failed",
          error_summary: "refresh_failed:1",
        })
        .eq("id", jobRunId);
    }

    return fail(500, "JOB_FAILED", "지수 재계산을 끝내지 못했습니다.");
  }
}

/**
 * **Vercel Cron 은 GET 으로 부른다.** POST 만 있으면 스케줄은 도는데 매번 405 가 되고
 * `job_runs` 에는 아무것도 안 남아 화면은 "한 번도 안 돌았다" 로 보인다 — 틀린
 * 화면은 아니지만 원인을 가리킨다. 같은 핸들러를 둘 다 낸다.
 */
export const GET = POST;
