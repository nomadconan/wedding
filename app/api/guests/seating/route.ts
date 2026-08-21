import type { NextRequest } from "next/server";

import { fail, failValidation, ok } from "@/lib/api/response";
import { SEATING_DRAFT_NOTICE, seatingIssues } from "@/lib/core/guest/guest";
import { SeatingSaveSchema } from "@/lib/core/schemas/guest";
import { findMyCouple } from "@/lib/couple/membership";
import { loadGuests, saveSeating } from "@/lib/guest/loader";
import { getSessionUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";

/**
 * PUT /api/guests/seating — 좌석 배치 초안 (F-C-22 · §4.2 신설)
 *
 * **문서 하나를 통째로 쓴다.** 테이블을 하나씩 고치는 경로를 두면 화면이 여러 번
 * 부르는 동안 중간 상태가 저장되고, 그 상태에서 **같은 하객이 두 테이블에 앉는**
 * 순간이 실제로 생긴다. 배치는 한 번에 맞아야 하는 값이라 통째로 받는다.
 *
 * ── 막지 않고 알린다 ────────────────────────────────────────────────────────
 * 정원 초과는 **거절하지 않는다** — 넘겨 두고 조정하는 것이 실제 준비 과정이라
 * 저장을 막으면 작업이 끊긴다(D-78 계열 — 순서를 보이되 잠그지 않는다). 대신
 * 점검 결과를 **응답에 함께 실어** 화면이 그대로 적는다.
 */
export const dynamic = "force-dynamic";

export async function PUT(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  const membership = await findMyCouple(user.id);
  if (!membership) return fail(404, "GUEST_COUPLE_NOT_FOUND", "먼저 온보딩을 마쳐 주세요.");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "SEATING_INVALID_BODY", "요청 본문을 읽지 못했습니다.");
  }

  const parsed = SeatingSaveSchema.safeParse(body);
  if (!parsed.success) return failValidation(parsed.error.issues);

  const supabase = await createClient();
  const before = await loadGuests(supabase, {
    coupleId: membership.coupleId,
    today: new Date().toISOString().slice(0, 10),
  });

  const result = await saveSeating(supabase, {
    coupleId: membership.coupleId,
    userId: user.id,
    layout: parsed.data,
  });

  if ("status" in result) return fail(result.status, result.code, result.message);

  return ok({
    ...result,
    // 저장한 배치를 **저장한 명단으로** 다시 점검한다 — 응답이 곧 화면의 근거다.
    issues: seatingIssues({
      layout: parsed.data,
      guestIds: before.guests.map((guest) => guest.id),
    }),
    notice: SEATING_DRAFT_NOTICE,
  });
}
