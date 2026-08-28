import type { NextRequest } from "next/server";

import { fail, failValidation, ok } from "@/lib/api/response";
import { FindingReportResolveSchema } from "@/lib/core/quality/review";
import { resolveFindingReport } from "@/lib/quality/admin";
import { getSessionUser, isOperator } from "@/lib/supabase/auth";

/**
 * PATCH /api/admin/finding-reports — 오탐 신고 처리 (S8-07 · F-A-04)
 *
 * **어휘가 사용자가 아니라 룰을 가리킨다.** `upheld` 는 "사용자 말이 옳다" 가 아니라
 * **"룰을 손볼 자리로 받아들였다"** 이고, `rejected` 는 "사용자가 틀렸다" 가 아니라
 * **"지금 룰대로 나온 결과다"** 이다 — 우리가 판정하는 것은 우리 룰이다(D-24 의 결).
 *
 * **'지금 룰대로 나온 결과' 에도 사유가 필수다.** 사유 없는 거절은 처리가 아니라
 * 무시다(S8-04·S8-11 이 정한 것과 같은 규칙).
 *
 * **룰을 여기서 고치지 않는다** — 룰 수정은 배포로 하고(S7-01) 그 콘솔은 F-A-03
 * (S8-06) 소관이다. 여기서 하는 일은 신호를 남기는 것까지다.
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
    return fail(400, "AI_QUALITY_INVALID_BODY", "요청 본문을 읽지 못했습니다.");
  }

  const parsed = FindingReportResolveSchema.safeParse(body);
  if (!parsed.success) return failValidation(parsed.error.issues);

  const result = await resolveFindingReport({
    ...parsed.data,
    operatorId: user.id,
    operatorRole: user.role,
  });

  if (!result.ok) return fail(result.status, result.code, result.message);

  return ok({ reportId: parsed.data.reportId, status: parsed.data.status });
}
