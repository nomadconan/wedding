import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/response";
import { loadAdminMetrics } from "@/lib/admin/metrics";
import { PERIOD_DAY_OPTIONS, resolvePeriod } from "@/lib/core/metrics/admin";
import { getSessionUser, isOperator } from "@/lib/supabase/auth";

/**
 * GET /api/admin/metrics — KPI 대시보드 집계 (F-A-07, §4.3)
 *
 * **`force-dynamic` 을 못 박는다(FIX-22 계열).** 이 응답은 쿠키(세션)에 따라 내용이
 * 달라지는데, Next 가 정적으로 굳히면 **권한을 잃은 사람에게 캐시된 지표가 계속 나간다.**
 * 지표는 전 플랫폼의 거래액과 수익이라 새어 나가면 안 되는 값이다.
 *
 * **경계는 세 층이 아니라 한 층이 진짜다.** 여기 `isOperator()` 는 401·403 을 제대로
 * 돌려주기 위한 UX 보조이고, 최종 판정은 `admin_metrics()` 안의 `is_operator()` 다
 * (CLAUDE.md §5.5). 이 검사를 지워도 데이터는 열리지 않는다 — 그렇게 만들어 두었다.
 */
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");
  if (!isOperator(user)) return fail(403, "ADMIN_FORBIDDEN", "권한이 없습니다.");

  // 기간은 목록에 있는 값으로 좁힌다. 임의 숫자는 기본값이 된다 — 거절하면
  // 주소를 손으로 고친 운영자에게 대시보드 대신 오류가 뜬다.
  const period = resolvePeriod(request.nextUrl.searchParams.get("days"), new Date());

  try {
    const payload = await loadAdminMetrics(period);

    return ok({
      period: payload.period,
      periodOptions: PERIOD_DAY_OPTIONS,
      // **상태를 그대로 싣는다.** 화면이 안 그리는 것만으로는 부족하고, 응답 본문에서도
      // "미확정" 이 숫자로 둔갑하지 않아야 한다. `undecided` 카드에는 value 가 없다.
      cards: payload.cards,
      funnel: payload.funnel,
      pending: payload.pending,
      feeBasis: payload.feeBasis,
    });
  } catch (caught) {
    const code = caught instanceof Error ? caught.message : "ADMIN_METRICS_FAILED";

    if (code === "ADMIN_METRICS_FORBIDDEN") {
      return fail(403, "ADMIN_FORBIDDEN", "권한이 없습니다.");
    }

    return fail(500, "ADMIN_METRICS_FAILED", "지표를 집계하지 못했습니다.");
  }
}
