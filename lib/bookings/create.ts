import { recordEvent } from "@/lib/audit/record";
import {
  BRIDGE_BLOCK_MESSAGE,
  type BridgeBlockReason,
  bridgeGate,
  draftFromQuote,
} from "@/lib/core/booking/bridge";
import type { QuoteStatus } from "@/lib/core/inquiry/inquiry";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

/**
 * 견적 수락 → 예약 생성 (C-1 · 명세서 §3.4)
 *
 * ══════════════════════════════════════════════════════════════════════════
 * **자격은 서버가 판정하고, 쓰기는 서비스롤이 한다** (D-62 · FIX-44)
 * ══════════════════════════════════════════════════════════════════════════
 *
 * `bookings` 는 **당사자가 직접 쓸 수 없는 표**다. 0065 가 표에서 쓰기를 걷었고
 * (`revoke all` → `grant select`) 정책도 함께 지웠다. 그 이유가 FIX-44 다 —
 * 커플 구성원이 업체 동의 없이 `confirmed` 예약을 만들고 그것으로 '검증 후기' 를
 * 쓸 수 있었다. `reviews_insert` 가 `bookings.status` 를 후기 자격으로 삼기 때문이다.
 *
 * 그래서 이 함수는 두 클라이언트를 쓴다.
 *
 *   **읽기** 세션 클라이언트 — "이 견적이 내게 보이는가" 를 **RLS 에게 묻는다.**
 *            `quotes_select` 정책이 커플·업체를 가르므로, 읽히면 당사자다.
 *            앱이 `couple_id` 를 비교하는 대신 DB 가 답하게 한다(§5.5 최종 경계는 RLS).
 *   **쓰기** 서비스롤 — 표가 당사자에게 닫혀 있으므로 이 길뿐이다.
 *
 * **읽은 것으로만 쓴다.** `coupleId`·`vendorId`·`totalAmount` 를 전부 **DB 에서 읽은
 * 값**으로 채운다. 본문에서 받는 것은 `quoteId` 하나다 — FIX-53(업체가 `plannerId` 를
 * 본문으로 넘기던 구멍)과 FIX-45(쿠폰 금액을 입력으로 받던 자리)가 같은 교훈이다.
 *
 * ── 무엇을 만들고 무엇을 안 만드는가 ───────────────────────────────────────
 * 만드는 것: `status='hold'` 예약 하나 + 출처(`quote_id`).
 * 안 만드는 것: 업체 승인(`accepted_at`) · 자리(`slot_id`) · 요율 스냅샷 · 플래너.
 * 근거는 `lib/core/booking/bridge.ts` 머리글에 있다.
 */

export type CreateBookingFailure = {
  status: number;
  code: string;
  message: string;
  /** 다리가 막은 경우의 사유 코드. 화면이 문구를 그대로 쓴다. */
  reason?: BridgeBlockReason;
};

export type CreateBookingResult = { bookingId: string; quoteId: string };

export function isCreateFailure(
  value: CreateBookingResult | CreateBookingFailure,
): value is CreateBookingFailure {
  return "status" in value;
}

type QuoteRow = {
  id: string;
  status: QuoteStatus;
  valid_until: string | null;
  total_amount: number | null;
  product_id: string | null;
  inquiry_target_id: string;
};

export async function createBookingFromQuote(input: {
  quoteId: string;
  actorId: string;
  now: Date;
}): Promise<CreateBookingResult | CreateBookingFailure> {
  const supabase = await createClient();

  // ── 1. 이 견적이 내게 보이는가 — RLS 에게 묻는다 ──────────────────────────
  const { data: quoteRow } = await supabase
    .from("quotes")
    .select("id, status, valid_until, total_amount, product_id, inquiry_target_id")
    .eq("id", input.quoteId)
    .maybeSingle();

  const quote = quoteRow as QuoteRow | null;

  // **없는 것과 못 보는 것을 같게 답한다.** 남의 견적의 존재 여부를 알려주지 않는다.
  if (!quote) {
    return { status: 404, code: "QUOTE_NOT_FOUND", message: "견적을 찾을 수 없어요." };
  }

  // ── 2. 문의·업체를 따라 올라간다 ──────────────────────────────────────────
  const { data: targetRow } = await supabase
    .from("inquiry_targets")
    .select("id, vendor_id, inquiry_id")
    .eq("id", quote.inquiry_target_id)
    .maybeSingle();

  const target = targetRow as { id: string; vendor_id: string; inquiry_id: string } | null;
  if (!target) {
    return { status: 404, code: "QUOTE_TARGET_NOT_FOUND", message: "문의를 찾을 수 없어요." };
  }

  const { data: inquiryRow } = await supabase
    .from("inquiries")
    .select("id, couple_id, closed_at")
    .eq("id", target.inquiry_id)
    .maybeSingle();

  const inquiry = inquiryRow as { id: string; couple_id: string; closed_at: string | null } | null;
  if (!inquiry) {
    return { status: 404, code: "QUOTE_INQUIRY_NOT_FOUND", message: "문의를 찾을 수 없어요." };
  }

  // ── 3. **예약을 만드는 것은 고객이다.** 업체가 아니다 ─────────────────────
  //
  // `quotes_select` 는 커플과 업체 **둘 다** 읽게 하므로 읽혔다는 사실만으로는
  // 누구인지 모른다. 업체가 자기 견적으로 예약을 만들면 고객이 신청한 적 없는
  // 예약이 생기고, 그것이 FIX-44 와 같은 모양이다 — **여기서 갈라야 한다.**
  const { data: memberRow } = await supabase
    .from("couple_members")
    .select("couple_id")
    .eq("couple_id", inquiry.couple_id)
    .eq("user_id", input.actorId)
    .maybeSingle();

  if (!memberRow) {
    return {
      status: 403,
      code: "BOOKING_NOT_COUPLE",
      message: "예약 신청은 고객이 합니다.",
    };
  }

  // ── 4. 이미 만든 예약이 있는가 ────────────────────────────────────────────
  //
  // **최종 경계는 DB 의 부분 유니크 인덱스**(`uq_bookings_quote`)다. 여기서 보는 이유는
  // 사용자에게 **왜 안 되는지**를 말하기 위해서다 — 유니크 위반은 코드만 돌려준다.
  const { data: existingRow } = await supabase
    .from("bookings")
    .select("id")
    .eq("quote_id", quote.id)
    .maybeSingle();

  const existing = existingRow as { id: string } | null;

  // ── 5. 다리 판정 ──────────────────────────────────────────────────────────
  const gate = bridgeGate(
    {
      quoteStatus: quote.status,
      validUntil: quote.valid_until,
      alreadyBooked: existing !== null,
      inquiryClosed: inquiry.closed_at !== null,
      totalAmount: quote.total_amount,
    },
    input.now,
  );

  if (!gate.allowed && gate.reason !== null) {
    return {
      status: gate.reason === "already_booked" ? 409 : 422,
      code: `BOOKING_${gate.reason.toUpperCase()}`,
      message: BRIDGE_BLOCK_MESSAGE[gate.reason],
      reason: gate.reason,
    };
  }

  // ── 6. 쓴다 — 서비스롤 ────────────────────────────────────────────────────
  const draft = draftFromQuote({
    coupleId: inquiry.couple_id,
    vendorId: target.vendor_id,
    productId: quote.product_id,
    quoteId: quote.id,
    // 위 게이트가 null·0 을 막았다. 여기 오는 값은 양수다.
    totalAmount: quote.total_amount as number,
  });

  const admin = createAdminClient();

  const { data: created, error } = await admin
    .from("bookings")
    .insert({
      couple_id: draft.coupleId,
      vendor_id: draft.vendorId,
      product_id: draft.productId,
      quote_id: draft.quoteId,
      status: draft.status,
      total_amount: draft.totalAmount,
      deposit_amount: draft.depositAmount,
    })
    .select("id")
    .maybeSingle();

  if (error || !created) {
    // 유니크 위반이면 그 사이 다른 요청이 만든 것이다 — 실패가 아니라 **이미 됐다** 로 답한다.
    if (error?.code === "23505") {
      const { data: raced } = await supabase
        .from("bookings")
        .select("id")
        .eq("quote_id", quote.id)
        .maybeSingle();

      const racedRow = raced as { id: string } | null;
      if (racedRow) return { bookingId: racedRow.id, quoteId: quote.id };
    }

    return { status: 500, code: "BOOKING_CREATE_FAILED", message: "예약을 만들지 못했어요." };
  }

  const bookingId = (created as { id: string }).id;

  // **증적을 남긴다.** 금액·본문을 담지 않는다(§7.3) — 참조와 상태만.
  await recordEvent({
    entityType: "booking",
    entityId: bookingId,
    eventType: "booking_requested",
    actor: { id: input.actorId, role: "couple" },
    afterState: "hold",
    source: "web",
    memo: `quote:${quote.id}`,
  });

  return { bookingId, quoteId: quote.id };
}
