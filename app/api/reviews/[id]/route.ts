import type { NextRequest } from "next/server";

import { fail, failValidation, ok } from "@/lib/api/response";
import { ReviewUpdateSchema } from "@/lib/core/review/write";
import { retractReview, updateReview } from "@/lib/reviews/write";
import { getSessionUser } from "@/lib/supabase/auth";

/**
 * PATCH/DELETE /api/reviews/[id] — 후기 수정·철회 (S8-11 · F-C-17)
 *
 * **DELETE 가 행을 지우지 않는다.** 철회는 묘비이며(D-23) 행은 남는다 — 업체 답변과
 * 신고가 그 행에 매달려 있고, "무엇에 대한 답변이었나" 를 나중에 답할 수 있어야
 * 한다. DB 도 같은 말을 한다: `reviews` 에 DELETE 권한이 아무에게도 없다(0058).
 * 메서드 이름만 DELETE 인 이유는 **사용자가 하려는 일**이 그것이기 때문이고,
 * 응답이 무엇을 했는지 그대로 적는다(`retracted: true`).
 *
 * 무엇을 바꿀 수 있는지는 **컬럼 권한**이 정한다 — `vendor_id`·`booking_id`·`status`
 * 는 목록에 없어 이 라우트를 통하든 아니든 바뀌지 않는다.
 */
export const dynamic = "force-dynamic";

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "REVIEW_INVALID_BODY", "요청 본문을 읽지 못했습니다.");
  }

  const parsed = ReviewUpdateSchema.safeParse(body);
  if (!parsed.success) return failValidation(parsed.error.issues);

  const result = await updateReview(user.id, params.id, parsed.data);
  if (!result.ok) return fail(result.status, result.code, result.message);

  return ok({ reviewId: result.reviewId });
}

export async function DELETE(_request: NextRequest, { params }: { params: { id: string } }) {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  const result = await retractReview(user.id, params.id);
  if (!result.ok) return fail(result.status, result.code, result.message);

  return ok({ reviewId: result.reviewId, retracted: true });
}
