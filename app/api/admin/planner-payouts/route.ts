import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, failValidation, ok } from "@/lib/api/response";
import { isPlannerPayoutFailure, payPlannerSettlement } from "@/lib/planners/payouts";
import { getSessionUser, isOperator } from "@/lib/supabase/auth";

/**
 * POST /api/admin/planner-payouts — 플래너 지급 실행 (F-A-11 · D-28 · S6-05)
 *
 * **§4.3 에 없던 행이다**(반영 제안) — F-A-11 이 "정산 집행" 을 적었지만 대상이 업체
 * 정산뿐이었다.
 *
 * **`plannerId` 도 금액도 입력으로 받지 않는다.** 원장 행이 정한다 — 받으면 남의
 * 원장을 내 계좌로 보내거나 금액을 부풀리는 요청을 만들 수 있다(FIX-45·FIX-53).
 * 받는 것은 **어느 건인가**와 **명시적 재지급인가**뿐이다.
 *
 * **지급 기록이 먼저, 원장 상태가 나중이다.** 0071 의 트리거가 성공한 지급 없이
 * `paid` 로 가는 것을 막으므로 순서가 곧 "나가지 않은 돈이 나갔다고 적히지 않는다"
 * 는 보장이다.
 */
export const dynamic = "force-dynamic";

const PaySchema = z.object({
  settlementId: z.string().uuid(),
  /** 명시적 재지급. **자동 재시도에서는 올리지 않는다** — 올리면 멱등이 사라진다. */
  attempt: z.number().int().min(1).max(9).optional(),
});

export async function POST(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");
  if (!isOperator(user)) return fail(403, "ADMIN_REQUIRED", "운영자만 실행할 수 있습니다.");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "PLANNER_PAYOUT_INVALID_BODY", "요청 본문을 읽지 못했습니다.");
  }

  const parsed = PaySchema.safeParse(body);
  if (!parsed.success) return failValidation(parsed.error.issues);

  const result = await payPlannerSettlement({
    settlementId: parsed.data.settlementId,
    actorId: user.id,
    actorRole: user.role,
    ...(parsed.data.attempt === undefined ? {} : { attempt: parsed.data.attempt }),
  });

  if (isPlannerPayoutFailure(result)) {
    return fail(result.status, result.code, result.message);
  }

  // **실패도 200 으로 돌려준다.** 지급 시도는 이뤄졌고 그 결과가 실패다 — 4xx 로
  // 답하면 화면이 "요청이 잘못됐다" 로 읽고 재시도 가능 여부를 잃는다.
  return ok(result);
}
