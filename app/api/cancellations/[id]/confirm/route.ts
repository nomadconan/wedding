import type { NextRequest } from "next/server";

import { fail, failValidation, ok } from "@/lib/api/response";
import { confirmCancellation, isCancellationFailure } from "@/lib/cancellation/actions";
import { resolvePartySide } from "@/lib/cancellation/party";
import { CancelConfirmSchema } from "@/lib/core/schemas/cancellation";
import { getSessionUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";

/**
 * POST /api/cancellations/[id]/confirm — 해지 양측 확인 (S5-08 · §4.2 · D-24)
 *
 * S4-07 의 이행 확인과 **같은 모양**이다 — 라우트 하나로 양측을 받되 **무엇을 쓸지는
 * 세션이 정한다.** 받으면 고객이 업체 칸에 답하는 요청을 만들 수 있고, 트리거가
 * 막더라도 그런 모양의 API 를 두지 않는다.
 *
 * **동의와 귀책을 따로 받는다.** "해지에는 동의하지만 누구 잘못인지는 다르다" 가
 * 실제로 흔한 상태이고, 하나로 합치면 그 상태를 표현할 수 없어 한쪽 주장이 그대로
 * 정산이 된다. 둘이 갈리면 조율 큐로 간다.
 */
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "CANCEL_INVALID_BODY", "요청 본문을 읽을 수 없습니다.");
  }

  const parsed = CancelConfirmSchema.safeParse(body);
  if (!parsed.success) return failValidation(parsed.error.issues);

  const supabase = await createClient();

  // 이 해지 절차가 내게 보이는가 — RLS 에게 묻는다(0031 정책: 커플 owner·업체 멤버).
  const { data: row } = await supabase
    .from("contract_cancellations")
    .select("id, booking_id")
    .eq("id", params.id)
    .maybeSingle();

  const cancellation = row as { booking_id: string } | null;
  if (!cancellation) return fail(404, "CANCEL_NOT_FOUND", "해지 절차를 찾을 수 없습니다.");

  const { data: bookingRow } = await supabase
    .from("bookings")
    .select("couple_id, vendor_id")
    .eq("id", cancellation.booking_id)
    .maybeSingle();

  const booking = bookingRow as { couple_id: string; vendor_id: string } | null;
  if (!booking) return fail(404, "CANCEL_BOOKING_NOT_FOUND", "예약을 찾을 수 없습니다.");

  const side = await resolvePartySide({
    userId: user.id,
    coupleId: booking.couple_id,
    vendorId: booking.vendor_id,
    supabase,
  });

  if (side === null) {
    return fail(403, "CANCEL_NOT_PARTY", "해지 확인은 계약 당사자만 할 수 있어요.");
  }

  const result = await confirmCancellation({
    cancellationId: params.id,
    side,
    agreed: parsed.data.agreed,
    claim: parsed.data.claim,
    actorId: user.id,
  });

  if (isCancellationFailure(result)) return fail(result.status, result.code, result.message);

  return ok(result);
}
