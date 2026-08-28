import { fail, ok } from "@/lib/api/response";
import { loadQualityConsole } from "@/lib/quality/admin";
import { getSessionUser, isOperator } from "@/lib/supabase/auth";

/**
 * GET /api/admin/ai-quality — 품질·비용 집계와 검수 큐 (S8-07 · F-A-04 · §4.3)
 *
 * **비용이 미결이면 금액 자리를 0으로 채우지 않는다**(O-21 · 함정 3). 응답 본문의
 * `summary.cost.status` 가 `blocked` 이고 `openIssue` 가 함께 실린다 — 화면이 안
 * 그리는 것만으로는 부족하다. 이 API 를 직접 읽는 사람도 "비용이 0원이었다" 와
 * "단가를 모른다" 를 구분할 수 있어야 한다.
 *
 * **목표치도 '가정' 이라는 사실을 달고 나간다**(`targets.*.assumed`). §5.8 의 표는
 * 열 제목이 '목표(가정)' 이고, 그 숫자로 판정을 만들면 가정치가 운영 기준으로 굳는다.
 *
 * **계측되지 않은 기능이 목록에서 빠지지 않는다**(`byFeature[].instrumented` ·
 * `featuresWithoutCalls`). 0건과 '안 셌다' 와 '그런 호출이 없다' 는 다 다른 사실이다.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");
  if (!isOperator(user)) return fail(403, "ADMIN_FORBIDDEN", "권한이 없습니다.");

  try {
    const payload = await loadQualityConsole(new Date());

    return ok({
      summary: payload.summary,
      progress: payload.progress,
      queue: payload.queue,
      reports: payload.reports,
      ruleCounts: payload.ruleCounts,
      featuresWithoutCalls: payload.featuresWithoutCalls,
      costBlocked: payload.summary.cost.status === "blocked",
      openIssue: payload.summary.cost.status === "blocked" ? payload.summary.cost.openIssue : null,
    });
  } catch {
    return fail(500, "AI_QUALITY_LOAD_FAILED", "품질 지표를 불러오지 못했습니다.");
  }
}
