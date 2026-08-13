import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/response";
import { loadCheckout } from "@/lib/payments/loader";
import { getSessionUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";

/**
 * GET /api/payments/schedules?bookingId=… — 분할 결제 회차 조회 (§4.2 · F-C-14)
 *
 * ── 인가는 RLS 가 한다 ──────────────────────────────────────────────────────
 * **세션 클라이언트로 읽는다.** `payment_schedules` 의 SELECT 정책은 커플 **owner**
 * 와 업체 멤버에게만 열려 있다(0028) — 읽히면 당사자이고, 안 읽히면 404 다.
 * 앱에서 커플 id 를 비교하는 방식은 보조 수단일 뿐 경계가 아니다(§5.5).
 *
 * ── 화면과 같은 함수를 쓴다 ─────────────────────────────────────────────────
 * `loadCheckout` 을 `/checkout/[bookingId]` 페이지도 부른다. 판정 규칙을 두 벌
 * 만들면 언젠가 화면과 API 의 답이 갈린다.
 */
export async function GET(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  const bookingId = request.nextUrl.searchParams.get("bookingId");
  if (!bookingId) return fail(400, "PAY_BOOKING_REQUIRED", "예약 식별자가 필요합니다.");

  const payload = await loadCheckout(await createClient(), bookingId);

  if (!payload) return fail(404, "PAY_CONTRACT_NOT_FOUND", "계약을 찾을 수 없습니다.");

  return ok(payload);
}
