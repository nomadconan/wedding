import type { NextRequest } from "next/server";

import { fail, failValidation, ok } from "@/lib/api/response";
import { ReportReviewSchema } from "@/lib/core/quality/review";
import { recordReportReview } from "@/lib/quality/admin";
import { getSessionUser, isOperator } from "@/lib/supabase/auth";

/**
 * POST /api/admin/ai-reviews — 샘플 검수 기록 (S8-07 · F-A-04 · §4.3 신설 제안)
 *
 * **`reviewer_id` 를 입력으로 받지 않는다.** 세션이 정한다 — 받으면 남의 이름으로
 * 검수 기록을 만들 수 있고, 이 기록의 요점이 "누가 봤나" 다.
 *
 * **'근거와 맞음' 에도 메모가 필수다.** 예외를 두면 기록 대부분이 빈칸이 되고
 * 나중에 "무엇을 보고 통과시켰나" 를 답할 수 없다. 스키마·라우트·DB CHECK 세 층이
 * 같은 말을 한다(0059).
 *
 * **이 기록이 리포트를 바꾸지 않는다.** 사용자에게 "당신 리포트가 부정확으로
 * 표시됐다" 를 보여 주는 것은 전혀 다른 결정이며 지금 그 결정이 없다.
 */
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");
  if (!isOperator(user)) return fail(403, "ADMIN_FORBIDDEN", "권한이 없습니다.");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "AI_QUALITY_INVALID_BODY", "요청 본문을 읽지 못했습니다.");
  }

  const parsed = ReportReviewSchema.safeParse(body);
  if (!parsed.success) return failValidation(parsed.error.issues);

  const result = await recordReportReview({
    ...parsed.data,
    reviewerId: user.id,
    reviewerRole: user.role,
  });

  if (!result.ok) return fail(result.status, result.code, result.message);

  return ok({ analysisId: parsed.data.analysisId, verdict: parsed.data.verdict }, { status: 201 });
}
