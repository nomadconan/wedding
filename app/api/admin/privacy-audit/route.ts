import type { NextRequest } from "next/server";

import { fail, failValidation, ok } from "@/lib/api/response";
import { DeletionActionSchema } from "@/lib/core/privacy/deletion";
import { loadPrivacyAudit } from "@/lib/privacy/audit";
import { resolveDeletionRequest } from "@/lib/privacy/resolve";
import { getSessionUser, isOperator } from "@/lib/supabase/auth";

/**
 * GET/PATCH /api/admin/privacy-audit — 파기 이력·잔존 건·삭제 요청 SLA (F-A-08, §4.3)
 *
 * **처리(PATCH)를 같은 경로에 둔다.** §4.3 은 이 기능에 경로 하나만 배정했고,
 * 삭제 요청 처리는 **이 화면 안에서만 일어나는 조치**라 경로를 새로 만들면 명세에 없는
 * 라우트가 하나 늘어난다. 조회와 변경의 경계가 다르다는 점은 코드가 말한다 —
 * GET 은 RLS 로 읽고 PATCH 는 서비스롤로 쓴다(D-62).
 *
 * **`force-dynamic` 을 못 박는다**(FIX-22 계열). 세션에 따라 갈리는 응답이 정적으로
 * 굳으면 권한을 잃은 사람에게 캐시된 삭제 요청 목록이 계속 나간다.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");
  if (!isOperator(user)) return fail(403, "ADMIN_FORBIDDEN", "권한이 없습니다.");

  try {
    const payload = await loadPrivacyAudit(new Date());

    return ok({
      audit: payload.audit,
      alerts: payload.alerts,
      runs: payload.runs,
      requests: payload.requests,
      // **미결 여부를 응답에도 싣는다**(함정 3) — 화면이 안 그리는 것만으로는 부족하다.
      // 이 값이 null 이면 SLA 판정이 없다는 뜻이고, 소비자가 이 API 를 직접 읽어도
      // "기준 없음" 과 "기준 안" 을 구분할 수 있어야 한다.
      slaLimitHours: payload.slaLimitHours,
      slaOpenIssue: payload.slaLimitHours === null ? "O-18" : null,
    });
  } catch (caught) {
    const code = caught instanceof Error ? caught.message : "PRIVACY_LOAD_FAILED";
    if (code === "PRIVACY_FORBIDDEN") return fail(403, "ADMIN_FORBIDDEN", "권한이 없습니다.");

    return fail(500, "PRIVACY_LOAD_FAILED", "개인정보 감사 정보를 불러오지 못했습니다.");
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
    return fail(400, "PRIVACY_INVALID_BODY", "요청 본문을 읽지 못했습니다.");
  }

  // 사유 필수는 여기서도 판정한다 — 화면·라우트·DB CHECK 세 층이 같은 말을 한다.
  const parsed = DeletionActionSchema.safeParse(body);
  if (!parsed.success) return failValidation(parsed.error.issues);

  const result = await resolveDeletionRequest({
    requestId: parsed.data.requestId,
    action: parsed.data.action,
    reason: parsed.data.reason,
    operatorId: user.id,
    operatorRole: user.role,
    now: new Date().toISOString(),
  });

  if (!result.ok) return fail(result.status, result.code, result.message);

  return ok({ requestId: parsed.data.requestId, status: result.status });
}
