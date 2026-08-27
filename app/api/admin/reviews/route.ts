import type { NextRequest } from "next/server";

import { fail, failValidation, ok } from "@/lib/api/response";
import { ReviewModerationSchema } from "@/lib/core/review/write";
import { loadReviewQueue, moderateReview } from "@/lib/reviews/admin";
import { getSessionUser, isOperator } from "@/lib/supabase/auth";

/**
 * GET/PATCH /api/admin/reviews — 후기 관리 (S8-11 · F-A-13 · §4.3 신설 제안)
 *
 * **GET 은 저장된 큐를 읽는 것이 아니라 지금 센다**(D-124 와 같은 판단). 어뷰징
 * 신호는 후기와 신고에서 계산되는 값이라 저장하면 낡는다.
 *
 * **몰아쓰기 임계가 미결이면 빈 목록이 아니라 `blocked` 를 낸다**(O-20 · 함정 2).
 * 화면이 안 그리는 것만으로는 부족하다 — 이 API 를 직접 읽는 사람도 "몰아쓰기
 * 없음" 과 "기준이 없어 보지 않음" 을 구분할 수 있어야 한다.
 *
 * **PATCH 는 판정이 아니라 조치의 기록이다**(D-24). 자동 비공개가 없으므로 이
 * 기록이 조치의 전부이며, 비공개도 복구도 사유가 필수다.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");
  if (!isOperator(user)) return fail(403, "ADMIN_FORBIDDEN", "권한이 없습니다.");

  try {
    const queue = await loadReviewQueue();

    return ok(queue);
  } catch {
    return fail(500, "REVIEW_QUEUE_FAILED", "후기 큐를 불러오지 못했습니다.");
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
    return fail(400, "REVIEW_INVALID_BODY", "요청 본문을 읽지 못했습니다.");
  }

  const parsed = ReviewModerationSchema.safeParse(body);
  if (!parsed.success) return failValidation(parsed.error.issues);

  const result = await moderateReview({
    ...parsed.data,
    operatorId: user.id,
    operatorRole: user.role,
  });

  if (!result.ok) return fail(result.status, result.code, result.message);

  return ok({ reviewId: parsed.data.reviewId, action: parsed.data.action });
}
