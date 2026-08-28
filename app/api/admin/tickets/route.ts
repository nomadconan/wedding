import type { NextRequest } from "next/server";

import { fail, failValidation, ok } from "@/lib/api/response";
import { TicketActionSchema, VendorSanctionSchema } from "@/lib/core/support/ticket";
import { applyTicketAction, applyVendorSanction, loadSupportConsole } from "@/lib/support/admin";
import { getSessionUser, isOperator } from "@/lib/supabase/auth";

/**
 * GET/PATCH /api/admin/tickets — CS 티켓 처리·제재 조치 (S8-09 · F-A-06 · §4.3)
 *
 * **큐를 합치지 않는다.** 옆 세 큐(커뮤니티·후기·오탐)의 **열린 건수와 링크만**
 * 함께 낸다 — 대상도 조치도 달라 한 목록에 섞으면 처리 절차가 서로 다른 건이 같은
 * 줄에 놓인다. S8-03 이 분쟁 넷을 합친 것과 다른 판단이며 이유는 그쪽 넷이 **같은
 * 사건에 대한 다른 기록**이었기 때문이다(D-121 · D-142).
 *
 * **담당자를 입력으로 받지 않는다.** 배정은 항상 자기 자신이다 — 남을 배정할 수
 * 있으면 "저 사람이 맡았다" 는 기록을 아무나 만들 수 있고 그것이 곧 책임 소재가 된다.
 *
 * **사용자 제재 경로가 없다.** 집행 수단이 없어서이며, 응답이 그 사실을 싣는다
 * (`userSanction.available = false` · O-14) — 화면이 안 그리는 것만으로는 부족하다.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");
  if (!isOperator(user)) return fail(403, "ADMIN_FORBIDDEN", "권한이 없습니다.");

  try {
    const payload = await loadSupportConsole();

    return ok({
      ...payload,
      // 집행할 수 없는 조치를 있는 것처럼 내지 않는다(함정 3).
      userSanction: { available: false, openIssue: "O-14" },
    });
  } catch {
    return fail(500, "SUPPORT_LOAD_FAILED", "티켓을 불러오지 못했습니다.");
  }
}

export async function PATCH(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");
  if (!isOperator(user)) return fail(403, "ADMIN_FORBIDDEN", "권한이 없습니다.");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "TICKET_INVALID_BODY", "요청 본문을 읽지 못했습니다.");
  }

  // 한 라우트가 둘을 받는다 — **어느 쪽인지는 본문 모양이 정한다.** `sanction` 이
  // 있으면 업체 제재이고 없으면 티켓 처리다. 의도를 먼저 가르지 않으면 제재 실수가
  // 티켓 스키마의 오류를 돌려받는다(S8-10 이 재계산에서 물린 자리).
  if (typeof body === "object" && body !== null && "sanction" in body) {
    const parsed = VendorSanctionSchema.safeParse(body);
    if (!parsed.success) return failValidation(parsed.error.issues);

    const result = await applyVendorSanction({
      ...parsed.data,
      operatorId: user.id,
      operatorRole: user.role,
    });

    if (!result.ok) return fail(result.status, result.code, result.message);

    return ok({ vendorId: parsed.data.vendorId, sanction: parsed.data.sanction });
  }

  const parsed = TicketActionSchema.safeParse(body);
  if (!parsed.success) return failValidation(parsed.error.issues);

  const result = await applyTicketAction({
    ...parsed.data,
    operatorId: user.id,
    operatorRole: user.role,
  });

  if (!result.ok) return fail(result.status, result.code, result.message);

  return ok({ ticketId: parsed.data.ticketId, action: parsed.data.action });
}
