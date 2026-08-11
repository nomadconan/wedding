import { recordEvent } from "@/lib/audit/record";
import {
  capViolations,
  slaDeadline,
  sumLines,
  type QuoteLine,
  type SlaThreshold,
} from "@/lib/core/inquiry/inquiry";
import type { CreateQuoteInput } from "@/lib/core/schemas/inquiry";
import { createAdminClient } from "@/lib/supabase/admin";

import { notifyCouple, notifyInquiryReceived } from "./notify";
import { quoteCapFor } from "./pricing";

/**
 * 문의·견적 쓰기 (S4-12)
 *
 * ── 어떤 손으로 쓰는가 ──────────────────────────────────────────────────────
 * 문의 생성·거두기는 **세션 클라이언트**다(0005 정책이 그대로 경계).
 * 견적 발송만 **서비스롤**이다 — 0024 가 `quotes`·`quote_items` 의 쓰기 권한을
 * 회수했기 때문이고, 회수한 이유는 상한 계산이 `lib/core/pricing` 의 순수 함수라
 * DB 가 스스로 검증할 수 없어서다.
 *
 * 그래서 이 파일이 **상한의 유일한 계산자**다. 권한은 여기서 새로 판정하지 않고
 * **RLS 에게 묻는다** — 세션 클라이언트로 `inquiry_targets` 를 읽어 보고, 읽히면
 * 그 업체 멤버다(CLAUDE.md §5.5: 경계를 두 벌로 만들지 않는다).
 */
type Client = Awaited<ReturnType<typeof import("@/lib/supabase/server").createClient>>;

export type ActionFailure = { status: number; code: string; message: string; details?: unknown };

export function isFailure(value: unknown): value is ActionFailure {
  return typeof value === "object" && value !== null && "status" in value && "code" in value;
}

// =============================================================================
// 문의 생성 (고객)
// =============================================================================

export async function createInquiry(
  supabase: Client,
  input: {
    coupleId: string;
    actorId: string;
    vendorIds: string[];
    eventDate: string;
    guestCount: number | null;
    regionCode: string | null;
    budgetTotal: number | null;
    categories: string[];
    note: string | null;
    requestJson: Record<string, unknown>;
    threshold: SlaThreshold | null;
  },
): Promise<{ inquiryId: string; targetCount: number } | ActionFailure> {
  // **승인된 업체에만 보낸다.** 심사 중·정지된 업체는 아직 거래 상대가 아니다.
  // 목록을 되읽어 걸러 내면 "고른 5곳 중 3곳만 갔다" 를 정직하게 말할 수 있다.
  const { data: vendorRows } = await supabase
    .from("vendors")
    .select("id")
    .in("id", input.vendorIds)
    .eq("status", "active");

  const activeIds = ((vendorRows ?? []) as { id: string }[]).map((row) => row.id);

  if (activeIds.length === 0) {
    return {
      status: 422,
      code: "INQUIRY_NO_ACTIVE_VENDOR",
      message: "문의할 수 있는 승인된 업체가 없어요.",
    };
  }

  const { data: created, error } = await supabase
    .from("inquiries")
    .insert({
      couple_id: input.coupleId,
      event_date: input.eventDate,
      guest_count: input.guestCount,
      region_code: input.regionCode,
      budget_total: input.budgetTotal,
      categories: input.categories,
      note: input.note,
      request_json: input.requestJson,
    })
    .select("id, created_at")
    .maybeSingle();

  if (error || !created) {
    return { status: 403, code: "INQUIRY_CREATE_FAILED", message: "문의를 보내지 못했어요." };
  }

  const inquiry = created as { id: string; created_at: string };
  const deadline = slaDeadline(inquiry.created_at, input.threshold);

  const { error: targetError } = await supabase.from("inquiry_targets").insert(
    activeIds.map((vendorId) => ({
      inquiry_id: inquiry.id,
      vendor_id: vendorId,
      sla_deadline: deadline,
    })),
  );

  if (targetError) {
    return {
      status: 403,
      code: "INQUIRY_TARGET_FAILED",
      message: "업체에 문의를 전달하지 못했어요.",
    };
  }

  await recordEvent({
    entityType: "inquiry",
    entityId: inquiry.id,
    eventType: "inquiry_created",
    actor: { id: input.actorId, role: "couple" },
    afterState: "open",
    // 본문·연락처를 넣지 않는다(§7.3). 셀 수 있는 사실만.
    memo: `targets=${activeIds.length}`,
  });

  // 어느 대상 행이 만들어졌는지 되읽어 알린다 — insert 응답에 id 를 요구하면
  // RLS 아래에서 select 권한이 또 필요해지고, 목록은 어차피 곧 다시 읽는다.
  const { data: createdTargets } = await supabase
    .from("inquiry_targets")
    .select("id, vendor_id")
    .eq("inquiry_id", inquiry.id);

  await notifyInquiryReceived({
    inquiryId: inquiry.id,
    targets: ((createdTargets ?? []) as { id: string; vendor_id: string }[]).map((row) => ({
      targetId: row.id,
      vendorId: row.vendor_id,
    })),
  });

  return { inquiryId: inquiry.id, targetCount: activeIds.length };
}

export async function closeInquiry(
  supabase: Client,
  input: { inquiryId: string; actorId: string },
): Promise<{ inquiryId: string } | ActionFailure> {
  const { data, error } = await supabase
    .from("inquiries")
    .update({ status: "closed", closed_at: new Date().toISOString() })
    .eq("id", input.inquiryId)
    .eq("status", "open")
    .select("id")
    .maybeSingle();

  if (error) {
    return { status: 403, code: "INQUIRY_CLOSE_FORBIDDEN", message: "문의를 마감하지 못했어요." };
  }

  if (!data) {
    return { status: 404, code: "INQUIRY_NOT_FOUND", message: "문의를 찾을 수 없어요." };
  }

  // 아직 기다리던 업체들의 시계를 멈춘다 — 고객이 거둔 요청에 SLA 를 물릴 수 없다.
  await createAdminClient()
    .from("inquiry_targets")
    .update({ status: "withdrawn" })
    .eq("inquiry_id", input.inquiryId)
    .eq("status", "pending");

  await recordEvent({
    entityType: "inquiry",
    entityId: input.inquiryId,
    eventType: "inquiry_closed",
    actor: { id: input.actorId, role: "couple" },
    beforeState: "open",
    afterState: "closed",
    memo: null,
  });

  return { inquiryId: input.inquiryId };
}

// =============================================================================
// 권한 판정 — RLS 에게 묻는다
// =============================================================================

/**
 * 이 사람이 이 문의 대상(업체 측)에 접근할 수 있는가.
 *
 * 세션 클라이언트로 읽어 본다 — **읽히면 그 업체 멤버다**(0005 정책). 견적 쓰기가
 * 서비스롤이라 RLS 가 관여하지 않으므로, 그 앞에 이 확인을 둔다.
 */
export async function loadTargetForVendor(
  supabase: Client,
  targetId: string,
): Promise<
  | { targetId: string; inquiryId: string; vendorId: string; status: string; eventDate: string | null }
  | null
> {
  const { data } = await supabase
    .from("inquiry_targets")
    .select("id, inquiry_id, vendor_id, status")
    .eq("id", targetId)
    .maybeSingle();

  if (!data) return null;

  const target = data as { id: string; inquiry_id: string; vendor_id: string; status: string };

  const { data: inquiry } = await supabase
    .from("inquiries")
    .select("event_date")
    .eq("id", target.inquiry_id)
    .maybeSingle();

  return {
    targetId: target.id,
    inquiryId: target.inquiry_id,
    vendorId: target.vendor_id,
    status: target.status,
    eventDate: (inquiry as { event_date?: string } | null)?.event_date ?? null,
  };
}

// =============================================================================
// 견적 발송 (업체) — 상한 계산과 자유 양식 차단의 핵심
// =============================================================================

export async function sendQuote(
  supabase: Client,
  input: CreateQuoteInput & { actorId: string; asOf: string },
): Promise<{ quoteId: string; totalAmount: number; capTotal: number } | ActionFailure> {
  const target = await loadTargetForVendor(supabase, input.inquiryTargetId);
  if (!target) {
    return { status: 404, code: "INQUIRY_NOT_FOUND", message: "문의를 찾을 수 없어요." };
  }

  if (target.eventDate === null) {
    return {
      status: 422,
      code: "INQUIRY_NO_EVENT_DATE",
      message: "예식일이 없는 문의에는 견적을 낼 수 없어요.",
    };
  }

  if (target.status === "withdrawn") {
    return {
      status: 409,
      code: "INQUIRY_WITHDRAWN",
      message: "고객이 거둔 문의예요. 견적을 보낼 수 없어요.",
    };
  }

  // ── 1) 상품이 **이 업체의 게시된 상품**인지 확인한다 ───────────────────────
  // 세션 클라이언트로 읽으므로 남의 상품은 애초에 보이지 않는다.
  const { data: productRow } = await supabase
    .from("products")
    .select("id, name, category, base_price_total, status, vendor_id")
    .eq("id", input.productId)
    .maybeSingle();

  const product = productRow as {
    id: string;
    base_price_total: number;
    status: string;
    vendor_id: string;
  } | null;

  if (!product || product.vendor_id !== target.vendorId) {
    return {
      status: 422,
      code: "QUOTE_PRODUCT_NOT_OWNED",
      message: "등록하신 상품에서만 견적을 만들 수 있어요.",
    };
  }

  if (product.status !== "published") {
    return {
      status: 422,
      code: "QUOTE_PRODUCT_NOT_PUBLISHED",
      message: "게시된 상품만 견적에 쓸 수 있어요. 추가금 확정 후 게시해 주세요.",
    };
  }

  // ── 2) 상한을 **서버가 계산한다** ─────────────────────────────────────────
  // 업체가 보낸 값을 쓰지 않는다. 스키마에 그 필드가 아예 없다(0024 주석 4번).
  const cap = await quoteCapFor({
    vendorId: target.vendorId,
    productId: product.id,
    basePrice: product.base_price_total,
    eventDate: target.eventDate,
    asOf: input.asOf,
  });

  // ── 3) 옵션은 **이 상품에 등록된 것**만 ───────────────────────────────────
  const optionIds = input.lines
    .filter((line) => line.itemType === "option")
    .map((line) => line.productOptionId)
    .filter((id): id is string => id !== null);

  const optionPrices = new Map<string, number>();

  if (optionIds.length > 0) {
    const { data: optionRows } = await supabase
      .from("product_options")
      .select("id, price, product_id")
      .in("id", optionIds)
      .eq("product_id", product.id);

    for (const row of (optionRows ?? []) as { id: string; price: number }[]) {
      optionPrices.set(row.id, row.price);
    }

    const unknown = optionIds.filter((id) => !optionPrices.has(id));
    if (unknown.length > 0) {
      return {
        status: 422,
        code: "QUOTE_OPTION_NOT_REGISTERED",
        message: "이 상품에 등록되지 않은 추가금은 견적에 넣을 수 없어요.",
      };
    }
  }

  // ── 4) 줄을 만든다. 상한은 위에서 계산한 값만 쓴다 ────────────────────────
  const baseLines = input.lines.filter((line) => line.itemType === "base");
  if (baseLines.length !== 1) {
    return {
      status: 422,
      code: "QUOTE_BASE_LINE_REQUIRED",
      message: "상품 본체 항목이 정확히 하나 있어야 해요.",
    };
  }

  const lines: QuoteLine[] = input.lines.map((line) => {
    const capAmount =
      line.itemType === "base" ? cap.capPrice : (optionPrices.get(line.productOptionId!) ?? 0);

    return {
      itemType: line.itemType,
      productId: product.id,
      productOptionId: line.productOptionId,
      // 금액을 생략하면 상한 그대로 — 할인 없음이지 위반이 아니다.
      amount: line.amount ?? capAmount,
      capAmount,
    };
  });

  const violations = capViolations(lines);
  if (violations.length > 0) {
    return {
      status: 422,
      code: violations[0].code,
      message: violations[0].message,
      details: violations,
    };
  }

  const { total, capTotal } = sumLines(lines);
  const now = new Date().toISOString();

  // ── 5) 서비스롤로 쓴다. 위에서 권한·상품·옵션·상한을 전부 확인했다 ────────
  const admin = createAdminClient();

  const { data: quoteRow, error: quoteError } = await admin
    .from("quotes")
    .insert({
      inquiry_target_id: target.targetId,
      product_id: product.id,
      total_amount: total,
      cap_total: capTotal,
      base_price_snapshot: cap.basePrice,
      valid_until: input.validUntil,
      vendor_memo: input.vendorMemo,
      status: "sent",
      sent_at: now,
      // 재현 가능성 — 나중에 룰이 바뀌어도 그때의 계산을 되짚을 수 있다.
      pricing_context_json: cap.context,
      pricing_steps_json: cap.steps,
    })
    .select("id")
    .maybeSingle();

  if (quoteError || !quoteRow) {
    // DB CHECK(quotes_cap_chk)가 마지막 문이다. 여기 걸리면 서버 계산이 틀린 것이다.
    return { status: 422, code: "QUOTE_REJECTED", message: "견적을 저장하지 못했어요." };
  }

  const quoteId = (quoteRow as { id: string }).id;

  // 항목은 참조만 넣는다. 이름·분류·옵션 상한은 **DB 트리거가 채운다**(0024).
  const { error: itemError } = await admin.from("quote_items").insert(
    lines.map((line) => ({
      quote_id: quoteId,
      item_type: line.itemType,
      product_id: line.productId,
      product_option_id: line.productOptionId,
      amount: line.amount,
      cap_amount: line.capAmount,
      // NOT NULL 이라 자리만 채운다 — 트리거가 곧바로 덮어쓴다.
      label: "",
      category_code: "",
    })),
  );

  if (itemError) {
    // 항목이 없는 견적은 견적이 아니다. 되돌린다.
    await admin.from("quotes").delete().eq("id", quoteId);

    return {
      status: 422,
      code: "QUOTE_ITEM_REJECTED",
      message: "견적 항목을 저장하지 못했어요. 등록된 상품·추가금만 넣을 수 있어요.",
    };
  }

  await recordEvent({
    entityType: "quote",
    entityId: quoteId,
    eventType: "quote_sent",
    actor: { id: input.actorId, role: "vendor" },
    afterState: "sent",
    // 금액을 남긴다 — 견적서 자체가 불변 기록이라 중복이지만, 타임라인에서
    // "얼마를 제시했는가" 를 조인 없이 읽을 수 있어야 한다(D-23). 개인정보가 아니다.
    memo: `total=${total} cap=${capTotal}`,
  });

  await notifyCouple({
    inquiryId: target.inquiryId,
    templateKey: "inquiry.quote_arrived",
    subjectId: quoteId,
  });

  return { quoteId, totalAmount: total, capTotal };
}

// =============================================================================
// 거절 · 열람 · 회수
// =============================================================================

export async function declineInquiry(
  supabase: Client,
  input: { targetId: string; reasonCode: string; actorId: string },
): Promise<{ targetId: string } | ActionFailure> {
  const { data, error } = await supabase
    .from("inquiry_targets")
    .update({
      status: "declined",
      declined_at: new Date().toISOString(),
      decline_reason_code: input.reasonCode,
    })
    .eq("id", input.targetId)
    .eq("status", "pending")
    .select("id")
    .maybeSingle();

  if (error) {
    return { status: 403, code: "INQUIRY_DECLINE_FORBIDDEN", message: "거절 처리하지 못했어요." };
  }

  if (!data) {
    return {
      status: 409,
      code: "INQUIRY_NOT_PENDING",
      message: "이미 응답했거나 거둔 문의예요.",
    };
  }

  await recordEvent({
    entityType: "inquiry_target",
    entityId: input.targetId,
    eventType: "inquiry_declined",
    actor: { id: input.actorId, role: "vendor" },
    beforeState: "pending",
    afterState: "declined",
    // 사유는 **코드**라 개인정보가 아니고, 분쟁에서 "왜 거절했나" 의 근거가 된다.
    memo: input.reasonCode,
  });

  const target = await loadTargetForVendor(supabase, input.targetId);
  if (target) {
    await notifyCouple({
      inquiryId: target.inquiryId,
      templateKey: "inquiry.declined",
      subjectId: input.targetId,
    });
  }

  return { targetId: input.targetId };
}

/** 업체가 문의를 처음 연 시각. "못 봤다" 와 "보고도 안 답했다" 를 가른다(D-23). */
export async function markViewed(
  supabase: Client,
  targetId: string,
): Promise<{ targetId: string } | ActionFailure> {
  const { error } = await supabase
    .from("inquiry_targets")
    .update({ first_viewed_at: new Date().toISOString() })
    .eq("id", targetId)
    .is("first_viewed_at", null);

  if (error) {
    return { status: 403, code: "INQUIRY_VIEW_FORBIDDEN", message: "처리하지 못했어요." };
  }

  return { targetId };
}

export async function withdrawQuote(
  supabase: Client,
  input: { quoteId: string; actorId: string },
): Promise<{ quoteId: string } | ActionFailure> {
  // 세션으로 읽어 본다 — 읽히면 그 업체 멤버다(0005 quotes_select).
  const { data } = await supabase
    .from("quotes")
    .select("id, status, inquiry_target_id")
    .eq("id", input.quoteId)
    .maybeSingle();

  if (!data) return { status: 404, code: "QUOTE_NOT_FOUND", message: "견적을 찾을 수 없어요." };

  const quote = data as { id: string; status: string; inquiry_target_id: string };

  // 고객이 이미 수락한 견적은 거둘 수 없다. 받아들여진 제안을 일방적으로 물릴 수 없다.
  if (quote.status === "accepted") {
    return {
      status: 409,
      code: "QUOTE_ALREADY_ACCEPTED",
      message: "고객이 수락한 견적은 거둘 수 없어요.",
    };
  }

  // 그 업체 멤버인지 다시 확인한다 — 아래 쓰기가 서비스롤이라 RLS 가 없다.
  const target = await loadTargetForVendor(supabase, quote.inquiry_target_id);
  if (!target) {
    return { status: 404, code: "QUOTE_NOT_FOUND", message: "견적을 찾을 수 없어요." };
  }

  const { error } = await createAdminClient()
    .from("quotes")
    .update({ status: "withdrawn", decided_at: new Date().toISOString() })
    .eq("id", input.quoteId);

  if (error) {
    return { status: 500, code: "QUOTE_WITHDRAW_FAILED", message: "견적을 거두지 못했어요." };
  }

  await recordEvent({
    entityType: "quote",
    entityId: input.quoteId,
    eventType: "quote_withdrawn",
    actor: { id: input.actorId, role: "vendor" },
    beforeState: quote.status,
    afterState: "withdrawn",
    memo: null,
  });

  return { quoteId: input.quoteId };
}

// =============================================================================
// 고객의 견적 결정
// =============================================================================

/**
 * 견적 수락·거절.
 *
 * **계약 전환은 5단계다**(S5-04·S5-06). 여기서는 상태만 바꾼다 — 수락이 곧 계약이
 * 되면 되돌릴 수 없는 행위를 이 화면이 하게 되고, 그건 이 태스크의 범위가 아니다.
 */
export async function decideQuote(
  supabase: Client,
  input: { quoteId: string; decision: "accepted" | "declined"; actorId: string; now: Date },
  // 성공 반환에 `status` 를 쓰지 않는다 — ActionFailure.status 와 이름이 겹치면
  // 호출부의 `"status" in result` 판별이 무너진다(빌드가 잡아 줬다).
): Promise<{ quoteId: string; decision: string } | ActionFailure> {
  const { data } = await supabase
    .from("quotes")
    .select("id, status, valid_until")
    .eq("id", input.quoteId)
    .maybeSingle();

  if (!data) return { status: 404, code: "QUOTE_NOT_FOUND", message: "견적을 찾을 수 없어요." };

  const quote = data as { id: string; status: string; valid_until: string | null };

  if (quote.status !== "sent") {
    return {
      status: 409,
      code: "QUOTE_NOT_ACTIONABLE",
      message: "지금 답할 수 있는 견적이 아니에요.",
    };
  }

  // 만료 판정은 화면이 아니라 서버가 한다. 만료된 견적을 수락하면 업체가 지킬 수
  // 없는 가격에 묶인다.
  if (
    quote.valid_until !== null &&
    new Date(quote.valid_until).getTime() <= input.now.getTime()
  ) {
    await createAdminClient().from("quotes").update({ status: "expired" }).eq("id", quote.id);

    return {
      status: 409,
      code: "QUOTE_EXPIRED",
      message: "유효기간이 지난 견적이에요. 업체에 다시 요청해 주세요.",
    };
  }

  const { error } = await createAdminClient()
    .from("quotes")
    .update({ status: input.decision, decided_at: input.now.toISOString() })
    .eq("id", quote.id);

  if (error) {
    return { status: 500, code: "QUOTE_DECIDE_FAILED", message: "처리하지 못했어요." };
  }

  await recordEvent({
    entityType: "quote",
    entityId: quote.id,
    eventType: input.decision === "accepted" ? "quote_accepted" : "quote_declined",
    actor: { id: input.actorId, role: "couple" },
    beforeState: "sent",
    afterState: input.decision,
    memo: null,
  });

  return { quoteId: quote.id, decision: input.decision };
}
