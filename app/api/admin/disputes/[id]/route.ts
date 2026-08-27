import type { NextRequest } from "next/server";

import { fail, failValidation, ok } from "@/lib/api/response";
import { MediationActionSchema } from "@/lib/core/dispute/mediation";
import { mediateDispute } from "@/lib/dispute/actions";
import { getSessionUser, isOperator } from "@/lib/supabase/auth";

/**
 * PATCH /api/admin/disputes/[id] — 조율안 등록·합의 기록 (F-A-12, §4.3)
 *
 * **§4.3 은 이 경로를 "조율안 등록·집행·환불" 로 적었다.** 집행과 환불은 여기서 하지
 * 않는다 — 돈을 움직이는 경로는 각 도메인이 이미 갖고 있고(`resolveEscrow`·
 * `applyVerdict`·`resolveCancellation`), 그것을 이 라우트가 다시 부르면 **집행 규칙이
 * 두 벌**이 된다(D-121). 예약 분쟁 자체에는 걸린 돈이 없고, 돈이 걸린 건은 큐에서
 * 그 도메인의 화면으로 넘어간다. **§4.3 문안 정정을 제안한다**(§7.5).
 *
 * **플랫폼은 판정자가 아니라 조율자다**(D-24). 그래서 조치가 넷뿐이고 전부
 * *제시하거나 기록하는* 일이다 — '플랫폼이 이렇게 정한다' 는 조치가 없다.
 *
 * `force-dynamic` (FIX-22 계열).
 */
export const dynamic = "force-dynamic";

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");
  if (!isOperator(user)) return fail(403, "ADMIN_FORBIDDEN", "권한이 없습니다.");

  const { id } = await context.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return fail(400, "DISPUTE_INVALID_ID", "분쟁 id 가 올바르지 않습니다.");
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "DISPUTE_INVALID_BODY", "요청 본문을 읽지 못했습니다.");
  }

  const parsed = MediationActionSchema.safeParse(body);
  if (!parsed.success) return failValidation(parsed.error.issues);

  const result = await mediateDispute({
    disputeId: id,
    action: parsed.data.action,
    note: parsed.data.note,
    coupleAgreed: parsed.data.coupleAgreed ?? false,
    vendorAgreed: parsed.data.vendorAgreed ?? false,
    operatorId: user.id,
    operatorRole: user.role,
    now: new Date().toISOString(),
  });

  if (!result.ok) return fail(result.status, result.code, result.message);

  return ok({ disputeId: id, status: result.status });
}
