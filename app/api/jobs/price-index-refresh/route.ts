import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/response";
import { authorizeJob } from "@/lib/ops/job-auth";
import { PRICE_INDEX_ALL } from "@/lib/core/pricing/price-index";
import { recalculateIndex } from "@/lib/pricing/curation";
import { tryWrite } from "@/lib/db/write";
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

    /**
     * **지역을 모르는 업체는 칸을 만들지 않는다**(C-2f).
     *
     * 이행에서 옮기지 못한 자유 문자열은 `null` 이 됐다. 그대로 두면 `"null|hall"`
     * 이라는 칸이 하나 생기고, 그 칸은 어느 지역 페이지에도 안 뜨면서 **표본만 빨아
     * 먹는다** — 강남 업체가 '지역 없음' 칸에 섞이면 강남 칸의 표본이 하한(5) 아래로
     * 떨어질 수 있다. 세지 않는 편이 정직하다. 그 업체들은 탐색 목록에는 그대로
     * 남는다(빼는 것은 우리 이행 사정을 업체에 떠넘기는 일이다).
     */
    const withRegion = ((vendorRows ?? []) as { region_code: string | null; category: string }[])
      .filter((row): row is { region_code: string; category: string } => row.region_code !== null);

    const skippedNoRegion = (vendorRows ?? []).length - withRegion.length;

    const cells = [
      ...new Map(
        withRegion.map((row) => [`${row.region_code}|${row.category}`, row]),
      ).values(),
    ];

    let built = 0;
    let insufficient = 0;
    // **증적이 안 남은 칸을 센다**(FIX-72). 배치는 계속 돌되 사실은 밖으로 나간다.
    let auditLost = 0;

    for (const cell of cells) {
      const result = await recalculateIndex({
        regionCode: cell.region_code,
        category: cell.category,
        reason: "주기 재계산",
        // 배치에는 사람이 없다 — **없는 것은 없다고 적는다**(FIX-71).
        // 전에는 0 uuid 와 "system" 을 넣었는데 `actor_id` 는 `auth.users` 를 참조하고
        // `actor_role` 은 `user_role` enum 이라 **둘 다 DB 가 거절했다.** 넣는 쪽이
        // 결과를 안 보므로 배치는 성공을 보고했고 증적만 사라졌다.
        // 시스템 실행임은 `action`·`source` 가 말한다.
        operatorId: null,
        operatorRole: null,
        // 사람이 없는 전이의 실행자는 `source` 가 말한다(D-173).
        source: "system",
      });

      if (!result.ok) continue;
      if (result.auditLost) auditLost += 1;
      if (result.blocked) insufficient += 1;
      else built += 1;
    }

    let runClosed = true;

    if (jobRunId) {
      runClosed = await tryWrite(
        "job_runs.update:close-refresh",
        admin
        .from("job_runs")
        .update({
          finished_at: new Date().toISOString(),
          status: "succeeded",
          processed_count: cells.length,
          // **표본 부족을 실패로 세지 않는다.** 아직 안 모인 것이지 고장이 아니다.
          // **증적 유실은 다르다** — 그것은 고장이고, 운영자가 봐야 한다(FIX-72).
          error_summary:
            [
              auditLost > 0 ? `audit_lost:${auditLost}` : null,
              insufficient > 0 ? `insufficient_sample:${insufficient}` : null,
              // **건너뛴 사실을 밖으로 낸다.** 조용히 빼면 표본이 왜 적은지 아무도 모른다.
              skippedNoRegion > 0 ? `no_region:${skippedNoRegion}` : null,
            ]
              .filter(Boolean)
              .join(" ") || null,
        })
        .eq("id", jobRunId),
      );
    }

    return ok({
      cells: cells.length,
      built,
      insufficient,
      // 지역을 모르는 업체 수. **0 으로 감추지 않는다** — 세지 않은 것이 있다는 사실이다.
      skippedNoRegion,
      guestBucket: PRICE_INDEX_ALL,
      // 마감을 못 적었으면 밖으로 낸다(FIX-73).
      runClosed,
    });
  } catch {
    // 기록을 남겼는지도 값으로 든다 — 실행이 없으면 남길 것도 없으니 true 다.
    let noted = true;

    if (jobRunId) {
      // `catch` 안이다 — 던지면 **원래 예외가 사라진다**. 그래도 **값은 받는다**:
      // 버리면 `check:writes` 가 잡고(그게 "삼키는 것이 아니다" 를 지키는 방법이다),
      // 못 적었으면 실패 응답에 적어 모니터가 `running` 으로 남은 행을 설명할 수 있게 한다.
      noted = await tryWrite(
        "job_runs.update:mark-failed",
        admin
          .from("job_runs")
          .update({
            finished_at: new Date().toISOString(),
            status: "failed",
            error_summary: "refresh_failed:1",
          })
          .eq("id", jobRunId),
      );
    }

    return fail(
      500,
      "JOB_FAILED",
      noted ? "지수 재계산을 끝내지 못했습니다." : "지수 재계산을 끝내지 못했고 실행 기록도 남기지 못했습니다.",
    );
  }
}

/**
 * **Vercel Cron 은 GET 으로 부른다.** POST 만 있으면 스케줄은 도는데 매번 405 가 되고
 * `job_runs` 에는 아무것도 안 남아 화면은 "한 번도 안 돌았다" 로 보인다 — 틀린
 * 화면은 아니지만 원인을 가리킨다. 같은 핸들러를 둘 다 낸다.
 */
export const GET = POST;
