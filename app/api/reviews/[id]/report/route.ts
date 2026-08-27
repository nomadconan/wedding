import type { NextRequest } from "next/server";

import { fail, failValidation, ok } from "@/lib/api/response";
import { ReviewReportSchema } from "@/lib/core/review/report";
import { reportReview } from "@/lib/reviews/write";
import { getSessionUser } from "@/lib/supabase/auth";

/**
 * POST /api/reviews/[id]/report — 부당 후기 신고 (S8-11 · F-V-11)
 *
 * **접수만 한다.** 처리 상태를 입력으로 받지 않으며(`ReviewReportSchema` 에 칸이
 * 없다) DB 도 신고자에게 `status`·`resolved_*` 칸의 쓰기 권한을 주지 않는다(0058).
 * 신고자가 자기 신고를 '처리 완료' 로 접수하면 그 신고는 **운영자 큐에 아예 뜨지
 * 않는다** — FIX-36 이 삭제 요청에서 똑같이 났던 자리다.
 *
 * **업체 전용 라우트로 두지 않았다.** §2.1 F-V-11 이 신고 주체로 업체를 적고 있지만
 * 개인정보 노출(`privacy`)처럼 **작성자 본인이나 제3자가 먼저 발견하는 사유**가 있고,
 * 그때 신고할 자리가 없으면 운영자에게 닿을 경로가 사라진다. 권한 경계는 여전히
 * RLS(`reporter_id = auth.uid()`)이며, 누가 신고했는지는 큐가 안다.
 */
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "REVIEW_INVALID_BODY", "요청 본문을 읽지 못했습니다.");
  }

  const parsed = ReviewReportSchema.safeParse({
    // 대상은 **경로가 정한다.** 본문의 id 를 신뢰하면 화면이 가리키는 후기와 다른
    // 후기를 신고하는 요청을 만들 수 있다.
    ...(typeof body === "object" && body !== null ? body : {}),
    reviewId: params.id,
  });
  if (!parsed.success) return failValidation(parsed.error.issues);

  const result = await reportReview(user.id, parsed.data);
  if (!result.ok) return fail(result.status, result.code, result.message);

  return ok({ reviewId: params.id, duplicated: result.duplicated }, { status: 201 });
}
