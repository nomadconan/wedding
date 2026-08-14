import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/response";
import { SIMULATION_EMPTY_NOTICE } from "@/lib/core/pricing/rate-admin";
import { simulateRate } from "@/lib/rates/admin";
import { getSessionUser } from "@/lib/supabase/auth";

/**
 * GET /api/admin/commission-rates/resolve — 적용 요율 확인 (F-A-15 · §4.3)
 *
 * `?vendor=&category=&at=&type=commission|planner&level=`
 *
 * ── 왜 시뮬레이터가 필요한가 ────────────────────────────────────────────────
 * 요율은 **업체 → 카테고리 → 전역** 순으로 해석되고 기간까지 겹친다(§3.8). 목록만
 * 보고 "이 업체에 지금 무엇이 적용되나" 를 사람이 계산하면 틀린다 — 그리고 그 계산이
 * 틀린 채 계약이 확정되면 요율은 **스냅샷으로 박혀** 되돌릴 수 없다(D-16).
 *
 * ── 해석은 S5-02 한 곳이다 ──────────────────────────────────────────────────
 * 이 라우트는 `resolveRate` 를 그대로 부른다. 화면용 계산을 따로 만들면 언젠가
 * 시뮬레이터와 실제 계약이 다른 요율을 말한다.
 */
export async function GET(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  if (user.role !== "admin" && user.role !== "ops") {
    return fail(403, "ADMIN_FORBIDDEN", "운영자만 조회할 수 있어요.");
  }

  const params = request.nextUrl.searchParams;
  const type = params.get("type") === "planner" ? "planner" : "commission";
  const at = params.get("at") ?? new Date().toISOString();

  if (Number.isNaN(Date.parse(at))) {
    return fail(422, "RATE_INVALID_AT", "조회 시점을 읽을 수 없습니다.");
  }

  const result = await simulateRate({
    type,
    vendorId: params.get("vendor"),
    plannerId: params.get("planner"),
    category: params.get("category"),
    serviceLevel: params.get("level"),
    at,
  });

  if (!result.ok) {
    // **404 가 아니다.** 요청은 정상이고 "적용되는 요율이 없다" 는 것이 답이다.
    // 그 상태로는 계약을 발행할 수 없다는 사실을 함께 적는다(S5-06).
    return ok({ resolved: null, reason: result.reason, detail: result.detail, notice: SIMULATION_EMPTY_NOTICE });
  }

  return ok({ resolved: result, notice: null });
}
