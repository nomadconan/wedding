import type { NextRequest } from "next/server";

import { fail, failValidation, ok } from "@/lib/api/response";
import { CurationActionSchema, RecalculateSchema } from "@/lib/core/pricing/curation";
import { applyCuration, recalculateIndex } from "@/lib/pricing/curation";
import { getSessionUser, isOperator } from "@/lib/supabase/auth";

/**
 * POST /api/admin/prices/recalculate — 참가격 지수 재계산·이상치 제외 (F-A-02, §4.3)
 *
 * 두 가지를 받는다. §4.3 이 이 경로에 "재계산·이상치 제외" 를 함께 적어 두었고,
 * 둘은 **같은 화면의 한 흐름**이다(빼고 → 다시 센다). 경로를 나누면 명세에 없는
 * 라우트가 하나 늘고, 무엇보다 **제외만 하고 재계산을 안 하는 상태**가 생긴다.
 *
 *   `{ regionCode, category, reason }`   → 그 칸을 다시 센다
 *   `{ sourceId, action, reason }`       → 표본 하나를 빼거나 되돌리거나 확인 표시한다
 *
 * **둘 다 사유가 필수다.** 지수를 움직이는 일이라 **왜 그랬는지 답할 수 있어야 한다**
 * (F-A-02). 화면·라우트·DB CHECK 세 층이 같은 말을 한다.
 *
 * `force-dynamic` (FIX-22 계열).
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
    return fail(400, "PRICE_INVALID_BODY", "요청 본문을 읽지 못했습니다.");
  }

  // **의도를 키로 먼저 가른 뒤에 검증한다.** 처음엔 "큐레이션으로 파싱해 보고 실패하면
  // 재계산" 으로 썼는데, 그러면 사유를 빠뜨린 **제외 요청이 재계산 스키마의 오류**
  // (`regionCode Required`)를 돌려받는다 — 운영자는 자기가 무엇을 잘못했는지 알 수 없다.
  // 어느 쪽을 하려던 것인지는 `sourceId` 하나로 분명하다.
  const wantsCuration =
    typeof body === "object" && body !== null && "sourceId" in (body as Record<string, unknown>);

  if (wantsCuration) {
    const curation = CurationActionSchema.safeParse(body);
    if (!curation.success) return failValidation(curation.error.issues);

    const result = await applyCuration({
      sourceId: curation.data.sourceId,
      action: curation.data.action,
      reason: curation.data.reason,
      operatorId: user.id,
      operatorRole: user.role,
    });

    if (!result.ok) return fail(result.status, result.code, result.message);

    return ok({ sourceId: curation.data.sourceId, action: curation.data.action });
  }

  const recalc = RecalculateSchema.safeParse(body);
  if (!recalc.success) return failValidation(recalc.error.issues);

  const result = await recalculateIndex({
    regionCode: recalc.data.regionCode,
    category: recalc.data.category,
    reason: recalc.data.reason,
    operatorId: user.id,
    operatorRole: user.role,
  });

  if (!result.ok) return fail(result.status, result.code, result.message);

  return ok({
    indexId: result.indexId,
    sampleSize: result.sampleSize,
    // **표본이 모자라면 p50 이 null 이다 — 0 이 아니다.**
    p50: result.p50,
    blocked: result.blocked,
  });
}
