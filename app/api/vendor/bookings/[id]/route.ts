import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, failValidation, ok } from "@/lib/api/response";
import { decideBooking } from "@/lib/bookings/vendor";
import { getSessionUser } from "@/lib/supabase/auth";

/**
 * PATCH /api/vendor/bookings/[id] — 예약 승인·거절 (F-V-08 · §4.3 · S5-10)
 *
 * **승인은 상태를 바꾸지 않는다**(D-36). `status='confirmed'` 는 계약 확정이고,
 * 승인은 그보다 앞선 별개의 사건이라 `accepted_at` 짝 컬럼이 갖는다 — 같은 칸에
 * 적으면 서명 없는 계약이 확정된 것으로 읽힌다.
 *
 * **대상은 경로가 정한다.** 본문의 id 를 신뢰하면 화면이 가리키는 예약과 다른 예약을
 * 승인하는 요청을 만들 수 있다(S8-12 가 플래그에서 정한 것과 같은 자리).
 *
 * **업체 편인지는 서버가 세션으로 판정한다** — 입력으로 받지 않는다.
 */
export const dynamic = "force-dynamic";

const DecideSchema = z.object({
  decision: z.enum(["accept", "decline"]),
  // 거절 사유는 여기서 **모양만** 본다. 필수 여부는 결정 종류에 달렸으므로
  // `decideBooking` 이 판정하고, 최종 경계는 CHECK 이다.
  reason: z.string().trim().max(500).nullable().optional(),
});

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "BOOKING_INVALID_BODY", "요청 본문을 읽지 못했습니다.");
  }

  const parsed = DecideSchema.safeParse(body);
  if (!parsed.success) return failValidation(parsed.error.issues);

  const result = await decideBooking({
    bookingId: params.id,
    decision: parsed.data.decision,
    reason: parsed.data.reason ?? null,
    actorId: user.id,
    actorRole: user.role,
  });

  if (!result.ok) return fail(result.status, result.code, result.message);

  return ok({ bookingId: result.bookingId, decision: result.decision });
}
