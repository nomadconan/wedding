import type { NextRequest } from "next/server";

import { fail, failValidation, ok } from "@/lib/api/response";
import { EscrowConfirmSchema, EscrowResolveSchema } from "@/lib/core/schemas/escrow";
import { confirmFulfillment, isEscrowFailure, resolveEscrow } from "@/lib/escrow/actions";
import { resolvePartySide } from "@/lib/cancellation/party";
import { getSessionUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";

/**
 * POST /api/escrow/release — 이행 확인 → 예치금 릴리즈 요청 (F-C-16 · §4.2)
 *
 * ── 한 라우트에 둘을 둔 이유 ────────────────────────────────────────────────
 * 명세가 정한 경로는 하나(`POST /api/escrow/release`)이고, 그 안에서 일어나는 일은
 * **당사자의 이행 확인**과 **운영자의 조율 결정** 둘이다. 둘 다 "이 보관을 어디로
 * 보낼지" 를 정하는 같은 사건이며, 무엇을 할 수 있는지는 **세션이 판정**한다.
 *
 * ── 어느 편인지 받지 않는다 ─────────────────────────────────────────────────
 * S4-07 이행 확인·S5-08 해지 확인과 같은 규칙이다. 받으면 고객이 업체 칸에 답하는
 * 요청을 만들 수 있고, 트리거가 막더라도 그런 모양의 API 를 두지 않는다.
 *
 * ── 릴리즈를 직접 명령하지 못한다 ───────────────────────────────────────────
 * 당사자가 보내는 것은 **"이행됐다/아니다"** 라는 사실 진술이고, 릴리즈 여부는
 * `decideRelease` 가 판정한다(D-24 — 플랫폼은 보관자이지 한쪽의 대리인이 아니다).
 * 운영자만 조율 결과로 방향을 정할 수 있고 **그때는 사유가 반드시 붙는다.**
 */
export async function POST(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "ESCROW_INVALID_BODY", "요청 본문을 읽을 수 없습니다.");
  }

  const isOperator = user.role === "admin" || user.role === "ops";

  // 운영자 조율 — 방향과 사유를 함께 받는다.
  if (isOperator && (body as { action?: string })?.action === "resolve") {
    const parsed = EscrowResolveSchema.safeParse(body);
    if (!parsed.success) return failValidation(parsed.error.issues);

    const result = await resolveEscrow({
      holdId: parsed.data.holdId,
      direction: parsed.data.direction,
      note: parsed.data.note,
      adminId: user.id,
    });

    return isEscrowFailure(result)
      ? fail(result.status, result.code, result.message)
      : ok(result);
  }

  const parsed = EscrowConfirmSchema.safeParse(body);
  if (!parsed.success) return failValidation(parsed.error.issues);

  // 이 홀드가 내게 보이는가 — RLS 에게 묻는다(0035 정책).
  const supabase = await createClient();
  const { data: holdRow } = await supabase
    .from("escrow_holds")
    .select("id, booking_id")
    .eq("id", parsed.data.holdId)
    .maybeSingle();

  const hold = holdRow as { booking_id: string | null } | null;
  if (!hold?.booking_id) return fail(404, "ESCROW_NOT_FOUND", "안전거래 기록을 찾을 수 없습니다.");

  const { data: bookingRow } = await supabase
    .from("bookings")
    .select("couple_id, vendor_id")
    .eq("id", hold.booking_id)
    .maybeSingle();

  const booking = bookingRow as { couple_id: string; vendor_id: string } | null;
  if (!booking) return fail(404, "ESCROW_BOOKING_NOT_FOUND", "예약을 찾을 수 없습니다.");

  const side = await resolvePartySide({
    userId: user.id,
    coupleId: booking.couple_id,
    vendorId: booking.vendor_id,
    supabase,
  });

  if (side === null) {
    return fail(403, "ESCROW_NOT_PARTY", "이행 확인은 거래 당사자만 할 수 있어요.");
  }

  const result = await confirmFulfillment({
    holdId: parsed.data.holdId,
    side,
    confirmed: parsed.data.confirmed,
    actorId: user.id,
  });

  return isEscrowFailure(result) ? fail(result.status, result.code, result.message) : ok(result);
}
