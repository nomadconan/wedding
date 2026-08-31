import { fail, ok } from "@/lib/api/response";
import {
  GRACE_REASON_NOTICE,
  PAYOUT_ADAPTER_PENDING_NOTICE,
  PAYOUT_NOT_RECEIVED_NOTICE,
  PLANNER_RATE_SNAPSHOT_NOTICE,
} from "@/lib/core/settlement/planner-payout";
import { plannerIdOf } from "@/lib/planners/delegation";
import { loadMyPlannerPayouts } from "@/lib/planners/payouts";
import { getSessionUser } from "@/lib/supabase/auth";

/**
 * GET /api/planner/settlements — 플래너 본인의 수수료 원장 (F-C-18 · §3.4 · S6-05)
 *
 * **§4.2 에 없던 행이다**(반영 제안) — 명세는 `planner_settlements` 표와 배치는 적었지만
 * 플래너가 자기 정산을 읽는 경로는 배정하지 않았다.
 *
 * **`plannerId` 를 입력으로 받지 않는다** — 세션이 정한다. 받으면 남의 원장을 읽는
 * 요청을 만들 수 있고, 최종 경계인 RLS 가 막더라도 그런 요청이 만들어지는 것 자체가
 * 설계 결함이다(FIX-45·FIX-53 과 같은 자리).
 *
 * **'받을 수 있음' 과 '받았음' 을 합치지 않는다**(함정 3 — 본문에도 나눠 싣는다).
 * 합치면 플래너는 이미 입금된 줄 알고 기다리지 않는다.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  const plannerId = await plannerIdOf(user.id);
  if (!plannerId) return fail(403, "PLANNER_NOT_REGISTERED", "플래너 계정이 아닙니다.");

  try {
    const payload = await loadMyPlannerPayouts({ plannerId, now: new Date() });

    return ok({
      ...payload,
      notices: {
        notReceived: PAYOUT_NOT_RECEIVED_NOTICE,
        grace: GRACE_REASON_NOTICE,
        rateSnapshot: PLANNER_RATE_SNAPSHOT_NOTICE,
        adapterPending: PAYOUT_ADAPTER_PENDING_NOTICE,
      },
    });
  } catch {
    return fail(500, "PLANNER_PAYOUT_LOAD_FAILED", "정산을 불러오지 못했습니다.");
  }
}
