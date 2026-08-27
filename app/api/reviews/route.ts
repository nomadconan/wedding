import type { NextRequest } from "next/server";

import { fail, failValidation, ok } from "@/lib/api/response";
import { ReviewCreateSchema } from "@/lib/core/review/write";
import { loadVendorRating, loadVendorReviews } from "@/lib/reviews/read";
import { createReview } from "@/lib/reviews/write";
import { getSessionUser } from "@/lib/supabase/auth";

/**
 * GET/POST /api/reviews — 검증 후기 (S8-11 · F-C-17 · §4.2)
 *
 * **GET 은 비로그인도 읽는다** — 후기는 공개 데이터이고, `reviews_select_public`
 * 정책이 비공개·철회된 것을 걸러낸다.
 *
 * **평점을 후기 목록과 함께 낸다.** 평균만 따로 꺼내 쓸 수 있는 응답을 만들지 않는다 —
 * 건수 없는 평균은 한 건짜리 5.0 을 백 건짜리 4.6 보다 위에 놓는다(`rateVendor`).
 * 산정 기준(`basis`)도 함께 실린다(F-V-11 "평점 산정 기준 공개").
 *
 * **POST 는 세션 롤로 쓴다.** 작성 자격의 경계는 `reviews_insert` RLS 정책이며
 * 앱이 그 조건을 다시 구현하지 않는다(CLAUDE.md §5.5).
 */
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const vendorId = request.nextUrl.searchParams.get("vendorId");
  if (!vendorId) return fail(400, "REVIEW_VENDOR_REQUIRED", "업체를 지정해 주세요.");

  try {
    const [reviews, rating] = await Promise.all([
      loadVendorReviews(vendorId),
      loadVendorRating(vendorId),
    ]);

    return ok({ vendorId, rating, reviews });
  } catch {
    return fail(500, "REVIEW_LOAD_FAILED", "후기를 불러오지 못했습니다.");
  }
}

export async function POST(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "REVIEW_INVALID_BODY", "요청 본문을 읽지 못했습니다.");
  }

  const parsed = ReviewCreateSchema.safeParse(body);
  if (!parsed.success) return failValidation(parsed.error.issues);

  const result = await createReview(user.id, parsed.data);
  if (!result.ok) return fail(result.status, result.code, result.message);

  return ok({ reviewId: result.reviewId }, { status: 201 });
}
