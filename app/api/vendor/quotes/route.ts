import type { NextRequest } from "next/server";

import { fail, failValidation, ok } from "@/lib/api/response";
import { inboxOrder } from "@/lib/core/inquiry/inquiry";
import { VendorQuoteActionSchema } from "@/lib/core/schemas/inquiry";
import {
  declineInquiry,
  markViewed,
  sendQuote,
  withdrawQuote,
} from "@/lib/inquiry/actions";
import { loadQuotableProducts, loadSlaThreshold, loadVendorInbox } from "@/lib/inquiry/loader";
import { getSessionUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";
import { findMemberVendor } from "@/lib/vendor/products";

/**
 * GET/POST /api/vendor/quotes — 표준 견적서 응답 (F-V-07, §4.3)
 *
 * ── 이 라우트가 **받지 않는 것**이 요점이다 ─────────────────────────────────
 * 항목 이름·분류·상한을 입력으로 받지 않는다(스키마에 필드가 없다). 업체가 보낼 수
 * 있는 것은 **어떤 상품·추가금을 고를지와 얼마를 깎을지**뿐이다.
 *   · 이름·분류는 DB 트리거가 참조된 상품·추가금에서 덮어쓴다(0024).
 *   · 상한은 서버가 `price_rules` 를 평가해 계산한다(`lib/inquiry/pricing.ts`).
 *   · 상한 초과는 DB CHECK 가 마지막으로 막는다(`quotes_cap_chk`·`quote_items_cap_chk`).
 * 그래서 "표준 견적서 폼으로만 응답"(F-V-07)이 화면 약속이 아니라 **불변식**이 된다.
 *
 * **첨부를 받지 않는다.** PDF·이미지로 보내는 순간 플랫폼 밖 양식이 되고 위 셋이
 * 전부 무의미해진다. 견적용 Storage 버킷도 만들지 않았다.
 *
 * **staff 도 응대한다.** S2-07 이 막은 것은 가격 **등록**과 정산이다. 등록된 가격
 * 이하로 견적을 내는 것은 그 범위를 벗어나지 않으며, DB 정책도 `is_vendor_member`
 * 이지 `is_vendor_owner` 가 아니다.
 */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  const vendor = await findMemberVendor(user.id);
  if (!vendor) return fail(403, "VENDOR_NOT_FOUND", "등록된 업체가 없습니다.");

  const supabase = await createClient();

  try {
    const threshold = await loadSlaThreshold();
    const targets = await loadVendorInbox(supabase, {
      vendorId: vendor.id,
      threshold,
      now: new Date(),
    });

    return ok({
      // 미응답이 위다(F-V-07). 정렬 규칙은 lib/core 의 순수 함수가 갖는다.
      targets: inboxOrder(targets),
      // 견적 폼이 고를 수 있는 것 — 등록된 게시 상품과 그 추가금뿐이다.
      products: await loadQuotableProducts(supabase, vendor.id),
      slaConfigured: threshold !== null,
    });
  } catch {
    return fail(500, "INQUIRY_LOAD_FAILED", "문의를 불러오지 못했습니다.");
  }
}

export async function POST(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  const vendor = await findMemberVendor(user.id);
  if (!vendor) return fail(403, "VENDOR_NOT_FOUND", "등록된 업체가 없습니다.");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "INQUIRY_INVALID_BODY", "요청 본문을 읽을 수 없습니다.");
  }

  const parsed = VendorQuoteActionSchema.safeParse(body);
  if (!parsed.success) return failValidation(parsed.error.issues);

  const supabase = await createClient();
  const action = parsed.data;

  if (action.action === "view") {
    const result = await markViewed(supabase, action.inquiryTargetId);

    return "status" in result ? fail(result.status, result.code, result.message) : ok(result);
  }

  if (action.action === "decline") {
    const result = await declineInquiry(supabase, {
      targetId: action.inquiryTargetId,
      reasonCode: action.reasonCode,
      actorId: user.id,
    });

    return "status" in result ? fail(result.status, result.code, result.message) : ok(result);
  }

  if (action.action === "withdraw") {
    const result = await withdrawQuote(supabase, {
      quoteId: action.quoteId,
      actorId: user.id,
    });

    return "status" in result ? fail(result.status, result.code, result.message) : ok(result);
  }

  // ── 견적 발송 ─────────────────────────────────────────────────────────────
  // `asOf` 를 여기서 한 번 만들어 넘긴다 — 함수 안에서 시계를 읽으면 상한 계산과
  // 스냅샷 기록이 서로 다른 시각을 보게 된다(S2-06 규칙).
  const result = await sendQuote(supabase, {
    ...action,
    actorId: user.id,
    asOf: new Date().toISOString().slice(0, 10),
  });

  if ("status" in result) {
    return fail(result.status, result.code, result.message, result.details);
  }

  return ok(result, { status: 201 });
}
