import type { NextRequest } from "next/server";

import { fail, failValidation, ok } from "@/lib/api/response";
import { isCancellationFailure, resolveCancellation } from "@/lib/cancellation/actions";
import { loadDisputeQueue } from "@/lib/cancellation/loader";
import { PenaltyResolveSchema } from "@/lib/core/schemas/cancellation";
import { getSessionUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";

/**
 * 위약금 청구·지불 절차 (F-A-17 · §4.2 `POST /api/admin/penalties` · §7.7 · D-24)
 *
 *  - `GET`  조율 큐. 양측 확인이 갈렸거나 기한이 지난 건이 쌓인다.
 *  - `POST` 조율 결과를 확정하고 정산까지 진행한다.
 *
 * ── 운영자는 판정자가 아니라 조율자다 ───────────────────────────────────────
 * 그래서 **결론에 사유가 반드시 붙는다**(스키마가 요구하고 DB CHECK 가 한 번 더 본다).
 * 플랫폼이 재량으로 정한 값이 아님을 기록으로 남기기 위해서다 — 0025 가 보증금
 * 종결에, 0029 가 계약 취소에 건 것과 같은 규칙이다.
 *
 * ── 조항 문안 확정 전까지는 절차·기록만 ─────────────────────────────────────
 * F-A-17 이 그렇게 적었다(§7.7 · O-03). 이 라우트가 하는 일은 **귀책을 확정하고
 * 산정 결과를 집행**하는 것까지이며, 표준계약서 조항을 근거로 한 청구서 발행·독촉은
 * 문안이 확정된 뒤의 일이다.
 */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  if (!isOperator(user.role)) {
    return fail(403, "ADMIN_FORBIDDEN", "운영자만 볼 수 있어요.");
  }

  // 운영자 열람도 RLS 를 지난다 — 서비스롤로 우회하지 않는다(§5.5).
  return ok({ queue: await loadDisputeQueue(await createClient()) });
}

export async function POST(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  if (!isOperator(user.role)) {
    return fail(403, "ADMIN_FORBIDDEN", "운영자만 조율할 수 있어요.");
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "CANCEL_INVALID_BODY", "요청 본문을 읽을 수 없습니다.");
  }

  const parsed = PenaltyResolveSchema.safeParse(body);
  if (!parsed.success) return failValidation(parsed.error.issues);

  const result = await resolveCancellation({
    cancellationId: parsed.data.cancellationId,
    adminId: user.id,
    decision: parsed.data.decision,
    note: parsed.data.note,
  });

  if (isCancellationFailure(result)) return fail(result.status, result.code, result.message);

  return ok(result);
}

function isOperator(role: string | null | undefined): boolean {
  return role === "admin" || role === "ops";
}
