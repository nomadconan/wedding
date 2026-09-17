import type { NextRequest } from "next/server";

import { fail, failValidation, ok } from "@/lib/api/response";
import { findMyCouple } from "@/lib/couple/membership";
import {
  effectiveMaxTargets,
  isPastDate,
  requestProblem,
  targetCountProblem,
} from "@/lib/core/inquiry/inquiry";
import { InquiryActionSchema } from "@/lib/core/schemas/inquiry";
import { createBookingFromQuote, isCreateFailure } from "@/lib/bookings/create";
import { closeInquiry, createInquiry, decideQuote } from "@/lib/inquiry/actions";
import { loadMaxTargets, loadMyInquiries, loadSlaThreshold } from "@/lib/inquiry/loader";
import { getSessionUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";

/**
 * GET/POST /api/inquiries — 1:N 표준 문의 (F-C-13, §4.2)
 *
 * **커플 id 를 입력으로 받지 않는다** — 세션에서 찾는다. 받으면 남의 커플 id 로
 * 문의를 만드는 경로가 열리고, RLS 가 막더라도 그런 모양의 API 자체가 잘못이다.
 *
 * **동시 발송 상한을 코드에 박지 않는다**(§7.4). `app_settings.inquiry.max_targets`
 * 를 읽어 판정하고, 설정이 없으면 1곳으로 좁힌다 — 값을 지어내는 대신 가장 보수적으로
 * 군다(`effectiveMaxTargets`).
 *
 * 견적 응답은 이 라우트에 없다. 그건 업체의 일이고 `/api/vendor/quotes` 다.
 */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  const supabase = await createClient();

  try {
    // RLS 가 자기 커플의 문의만 보여준다.
    const inquiries = await loadMyInquiries(supabase, {
      threshold: await loadSlaThreshold(),
      now: new Date(),
    });

    return ok({ inquiries, maxTargets: effectiveMaxTargets(await loadMaxTargets()) });
  } catch {
    return fail(500, "INQUIRY_LOAD_FAILED", "문의를 불러오지 못했습니다.");
  }
}

export async function POST(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "INQUIRY_INVALID_BODY", "요청 본문을 읽을 수 없습니다.");
  }

  const parsed = InquiryActionSchema.safeParse(body);
  if (!parsed.success) return failValidation(parsed.error.issues);

  const supabase = await createClient();
  const action = parsed.data;

  if (action.action === "close") {
    const result = await closeInquiry(supabase, {
      inquiryId: action.inquiryId,
      actorId: user.id,
    });

    return "status" in result ? fail(result.status, result.code, result.message) : ok(result);
  }

  if (action.action === "decide_quote") {
    const now = new Date();
    const result = await decideQuote(supabase, {
      quoteId: action.quoteId,
      decision: action.decision,
      actorId: user.id,
      now,
    });

    if ("status" in result) return fail(result.status, result.code, result.message);

    // **수락하면 예약을 함께 만든다**(C-1). 여기가 B-1 이 찾은 끊긴 칸이다 —
    // 예전에는 상태만 바꾸고 끝나 계약을 발행할 `bookingId` 가 영영 없었다.
    //
    // **실패해도 수락을 되돌리지 않는다.** 되돌리면 업체가 본 '수락' 이 사라지고,
    // 고객은 자기가 누른 것이 없던 일이 된다. 대신 **왜 안 됐는지를 함께 돌려주고**
    // 화면이 다시 시도할 자리를 준다(`POST /api/bookings`).
    if (action.decision !== "accepted") return ok(result);

    const created = await createBookingFromQuote({
      quoteId: action.quoteId,
      actorId: user.id,
      now,
    });

    return isCreateFailure(created)
      ? ok({ ...result, bookingId: null, blocked: { code: created.code, message: created.message } })
      : ok({ ...result, bookingId: created.bookingId, blocked: null });
  }

  // ── 문의 생성 ─────────────────────────────────────────────────────────────
  const membership = await findMyCouple(user.id);
  if (!membership) {
    return fail(403, "INQUIRY_COUPLE_REQUIRED", "온보딩을 먼저 마쳐야 문의를 보낼 수 있어요.");
  }

  const problem = requestProblem({
    eventDate: action.eventDate,
    guestCount: action.guestCount,
    categories: action.categories,
    note: action.note,
  });

  if (problem) return fail(422, "INQUIRY_INVALID_REQUEST", problem);

  // 지난 날짜로는 견적을 받을 수 없다. `today` 는 여기서 한 번 만들어 쓴다.
  const today = new Date().toISOString().slice(0, 10);
  if (isPastDate(action.eventDate, today)) {
    return fail(422, "INQUIRY_PAST_DATE", "지난 날짜로는 견적을 요청할 수 없어요.");
  }

  const max = effectiveMaxTargets(await loadMaxTargets());
  const unique = [...new Set(action.vendorIds)];
  const countProblem = targetCountProblem(unique.length, max);

  if (countProblem) return fail(422, "INQUIRY_TARGET_COUNT", countProblem);

  const result = await createInquiry(supabase, {
    coupleId: membership.coupleId,
    actorId: user.id,
    vendorIds: unique,
    eventDate: action.eventDate,
    guestCount: action.guestCount,
    regionCode: action.regionCode,
    budgetTotal: action.budgetTotal,
    categories: action.categories,
    note: action.note,
    requestJson: action.requestJson,
    threshold: await loadSlaThreshold(),
  });

  return "status" in result
    ? fail(result.status, result.code, result.message)
    : ok(result, { status: 201 });
}
