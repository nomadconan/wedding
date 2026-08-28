import { fail, ok } from "@/lib/api/response";
import { loadOpsConsole } from "@/lib/ops/admin";
import { getSessionUser, isOperator } from "@/lib/supabase/auth";

/**
 * GET /api/admin/ops — 모니터링 (S8-13 · §7.4)
 *
 * **응답 본문에 '보내지 않는다' 를 싣는다**(함정 3). 화면에서만 적으면 이 API 를
 * 쓰는 다음 사람이 경보가 발송되는 줄 안다 — 그리고 그 오해는 경보가 안 왔을 때
 * "장애가 없었나 보다" 로 이어진다.
 *
 * **로그인 실패 집계의 불완전성도 본문에 싣는다**(FIX-32). 숫자만 내보내면 그 숫자가
 * 전수로 읽힌다.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");
  if (!isOperator(user)) return fail(403, "ADMIN_FORBIDDEN", "권한이 없습니다.");

  try {
    return ok(await loadOpsConsole(new Date()));
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : "";

    if (message === "OPS_FORBIDDEN") return fail(403, "ADMIN_FORBIDDEN", "권한이 없습니다.");

    return fail(500, "OPS_LOAD_FAILED", "운영 상태를 불러오지 못했습니다.");
  }
}
