import type { NextRequest } from "next/server";

import { fail, failValidation, ok } from "@/lib/api/response";
import { VendorReplySchema } from "@/lib/core/review/write";
import { loadVendorReviewBoard, replyToReview } from "@/lib/reviews/vendor";
import { getSessionUser } from "@/lib/supabase/auth";
import { findMemberVendor } from "@/lib/vendor/products";

/**
 * GET/POST /api/vendor/reviews — 후기 열람·답변 (S8-11 · F-V-11 · §4.3 신설 제안)
 *
 * **대상 업체를 입력으로 받지 않는다.** 세션 사용자가 속한 업체를 서버가 찾는다 —
 * 클라이언트가 보낸 `vendorId` 를 신뢰하면 남의 후기에 답변할 수 있다.
 *
 * **답변은 서비스롤 경유다**(D-62). 컬럼 권한은 역할 단위(`authenticated`)라
 * 업체에 UPDATE 를 열면 같은 역할인 작성자에게도 같은 칸이 열린다(0058 §3).
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  const vendor = await findMemberVendor(user.id);
  if (!vendor) return fail(403, "VENDOR_FORBIDDEN", "업체 계정만 이용할 수 있습니다.");

  try {
    const board = await loadVendorReviewBoard(vendor.id);

    return ok(board);
  } catch {
    return fail(500, "REVIEW_LOAD_FAILED", "후기를 불러오지 못했습니다.");
  }
}

export async function POST(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  const vendor = await findMemberVendor(user.id);
  if (!vendor) return fail(403, "VENDOR_FORBIDDEN", "업체 계정만 이용할 수 있습니다.");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "REVIEW_INVALID_BODY", "요청 본문을 읽지 못했습니다.");
  }

  const parsed = VendorReplySchema.safeParse(body);
  if (!parsed.success) return failValidation(parsed.error.issues);

  const result = await replyToReview({
    ...parsed.data,
    vendorId: vendor.id,
    userId: user.id,
    userRole: user.role,
  });

  if (!result.ok) return fail(result.status, result.code, result.message);

  return ok({ reviewId: parsed.data.reviewId });
}
