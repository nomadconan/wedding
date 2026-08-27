import type { NextRequest } from "next/server";

import { fail, failValidation, ok } from "@/lib/api/response";
import { ReviewReportResolveSchema } from "@/lib/core/review/report";
import { resolveReviewReport } from "@/lib/reviews/admin";
import { getSessionUser, isOperator } from "@/lib/supabase/auth";

/**
 * PATCH /api/admin/review-reports — 부당 후기 신고 처리 (S8-11 · F-A-13)
 *
 * **`/api/admin/reviews` 와 나눴다.** 대상이 다르다 — 저쪽은 후기이고 이쪽은
 * 신고다. 한 라우트에 합치면 `targetId` 가 무엇을 가리키는지가 본문의 다른 칸에
 * 달리게 되고, 감사 로그의 `target_type` 도 요청마다 달라진다.
 *
 * **'내리지 않음' 도 사유를 요구한다** — 신고를 받아들이지 않은 이유를 답할 수
 * 없으면 업체 입장에서 그것은 처리가 아니라 무시다. 화면·라우트·DB CHECK 세 층이
 * 같은 말을 한다(0058).
 *
 * 인정(`upheld`)은 **후기를 내리는 일과 같은 사건**이라 한 요청에서 함께 처리한다.
 */
export const dynamic = "force-dynamic";

export async function PATCH(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");
  if (!isOperator(user)) return fail(403, "ADMIN_FORBIDDEN", "권한이 없습니다.");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "REVIEW_INVALID_BODY", "요청 본문을 읽지 못했습니다.");
  }

  const parsed = ReviewReportResolveSchema.safeParse(body);
  if (!parsed.success) return failValidation(parsed.error.issues);

  const result = await resolveReviewReport({
    ...parsed.data,
    operatorId: user.id,
    operatorRole: user.role,
  });

  if (!result.ok) return fail(result.status, result.code, result.message);

  return ok({ reportId: parsed.data.reportId, status: parsed.data.status });
}
