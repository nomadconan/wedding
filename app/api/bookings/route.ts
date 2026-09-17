import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, failValidation, ok } from "@/lib/api/response";
import { createBookingFromQuote, isCreateFailure } from "@/lib/bookings/create";
import { getSessionUser } from "@/lib/supabase/auth";

/**
 * POST /api/bookings — 견적 수락 → 예약 생성 (C-1 · §4.2)
 *
 * **리포에서 `bookings` 에 행을 만드는 유일한 경로다.** 그전까지는 경로가 없었고
 * (B-1: INSERT 0건) 그래서 `POST /api/contracts` 가 요구하는 `bookingId` 를 아무도
 * 만들 수 없었다.
 *
 * **본문으로 받는 것은 `quoteId` 하나다.** 금액·업체·커플을 받지 않는다 —
 * 전부 DB 에서 읽는다(FIX-45·FIX-53 이 가르친 것: 돈과 당사자를 입력으로 받지 않는다).
 *
 * **표는 열지 않았다.** `bookings` 는 여전히 당사자에게 SELECT 뿐이고 쓰기는
 * 서비스롤이다(0065 · FIX-44). 자격은 `lib/bookings/create.ts` 가 판정한다.
 *
 * `/api/inquiries` 의 `decide_quote` 도 수락 시 같은 함수를 부른다. 이 라우트는
 * **그때 막혔던 경우의 재시도**를 위해 따로 열어 둔다 — 견적은 수락됐는데 예약이
 * 안 생긴 상태로 남으면 사용자가 되돌릴 방법이 없다.
 */
export const dynamic = "force-dynamic";

const CreateBookingSchema = z.object({
  quoteId: z.string().uuid("견적 id 형식이 아닙니다."),
});

export async function POST(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "BOOKING_INVALID_BODY", "요청 본문을 읽지 못했습니다.");
  }

  const parsed = CreateBookingSchema.safeParse(body);
  if (!parsed.success) return failValidation(parsed.error.issues);

  const result = await createBookingFromQuote({
    quoteId: parsed.data.quoteId,
    actorId: user.id,
    now: new Date(),
  });

  if (isCreateFailure(result)) return fail(result.status, result.code, result.message);

  return ok(result, { status: 201 });
}
