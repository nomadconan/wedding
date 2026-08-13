import type { NextRequest } from "next/server";

import { fail, failValidation, ok } from "@/lib/api/response";
import { isFailure, issueContract } from "@/lib/contract/actions";
import { IssueContractRequestSchema } from "@/lib/core/schemas/payment";
import { getSessionUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";

/**
 * POST /api/contracts — 표준계약 발행 (F-C-15 · §4.2 · S5-04)
 *
 * **발행은 업체가 한다.** 계약서를 내미는 쪽은 공급자이고, 고객이 스스로 계약을
 * 발행할 수 있으면 업체가 동의하지 않은 조건의 문서가 생긴다. 어느 편인지는
 * **서버가 세션으로 판정한다** — 입력으로 받지 않는다(S4-07 이행 확인과 같은 규칙).
 *
 * 이 라우트가 S5-06 브랜치에 있는 이유는 `lib/contract/actions.ts` 머리말 참조 —
 * 결제 회차가 **발행 시점에** 만들어지므로 이 경로 없이는 결제를 부를 수 없다.
 */
export async function POST(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "CONTRACT_INVALID_BODY", "요청 본문을 읽을 수 없습니다.");
  }

  const parsed = IssueContractRequestSchema.safeParse(body);
  if (!parsed.success) return failValidation(parsed.error.issues);

  // 이 예약이 내게 보이는가 — RLS 에게 묻는다. 그 다음 **업체 편인지**를 본다.
  const supabase = await createClient();
  const { data: bookingRow } = await supabase
    .from("bookings")
    .select("id, vendor_id")
    .eq("id", parsed.data.bookingId)
    .maybeSingle();

  const booking = bookingRow as { id: string; vendor_id: string } | null;
  if (!booking) return fail(404, "CONTRACT_BOOKING_NOT_FOUND", "예약을 찾을 수 없습니다.");

  const { data: memberRow } = await supabase
    .from("vendor_members")
    .select("vendor_id")
    .eq("vendor_id", booking.vendor_id)
    .eq("user_id", user.id)
    .maybeSingle();

  if (!memberRow) {
    return fail(403, "CONTRACT_NOT_VENDOR", "계약 발행은 업체가 합니다.");
  }

  const result = await issueContract({
    bookingId: parsed.data.bookingId,
    actorId: user.id,
    quoteId: parsed.data.quoteId ?? null,
    plannerId: parsed.data.plannerId ?? null,
  });

  if (isFailure(result)) return fail(result.status, result.code, result.message);

  return ok(result, { status: 201 });
}
