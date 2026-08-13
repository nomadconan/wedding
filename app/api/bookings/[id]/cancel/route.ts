import type { NextRequest } from "next/server";

import { fail, failValidation, ok } from "@/lib/api/response";
import { isCancellationFailure, requestCancellation } from "@/lib/cancellation/actions";
import { loadCancellationView } from "@/lib/cancellation/loader";
import { resolvePartySide } from "@/lib/cancellation/party";
import { CancelRequestSchema } from "@/lib/core/schemas/cancellation";
import { getSessionUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";

/**
 * 계약 해지 (S5-08 · F-A-17 · §4.2)
 *
 *  - `GET`  위약금 **예상액과 산정 근거**. 요청 전에 반드시 보여준다 — 모르고
 *           취소하게 두면 납득하지 못한 정산이 그대로 분쟁이 된다.
 *  - `POST` 해지 요청. **금액을 받지 않는다**(서버가 산정한다) 그리고 **귀책은 주장으로만
 *           받는다** — 요청자가 적은 값이 곧 정산 결과가 되면 사유 선택 하나로 위약금이
 *           0 이 된다.
 *
 * 어느 편인지는 **세션이 판정한다.** 커플은 **owner 만** 요청한다(§3.9 — 결제·계약
 * 서명과 같은 조건이며, 해지는 그 둘보다 되돌리기 어렵다).
 */
export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  const view = await loadCancellationView(await createClient(), params.id);

  if (!view) return fail(404, "CANCEL_CONTRACT_NOT_FOUND", "해지할 계약을 찾을 수 없습니다.");

  return ok(view);
}

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "CANCEL_INVALID_BODY", "요청 본문을 읽을 수 없습니다.");
  }

  const parsed = CancelRequestSchema.safeParse(body);
  if (!parsed.success) return failValidation(parsed.error.issues);

  const supabase = await createClient();

  // 이 예약이 내게 보이는가 — RLS 에게 묻는다. 그 다음 어느 편인지를 본다.
  const { data: bookingRow } = await supabase
    .from("bookings")
    .select("id, couple_id, vendor_id")
    .eq("id", params.id)
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
    return fail(403, "CANCEL_NOT_PARTY", "해지 요청은 계약 당사자만 할 수 있어요.");
  }

  const result = await requestCancellation({
    bookingId: params.id,
    actorId: user.id,
    side,
    reasonCode: parsed.data.reasonCode,
    reasonNote: parsed.data.reasonNote ?? null,
    claim: parsed.data.claim,
  });

  if (isCancellationFailure(result)) return fail(result.status, result.code, result.message);

  return ok(result, { status: 201 });
}
