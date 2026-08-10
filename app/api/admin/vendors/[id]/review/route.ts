import type { NextRequest } from "next/server";

import { recordEvent } from "@/lib/audit/record";
import { failValidation, fail, ok } from "@/lib/api/response";
import { VendorReviewInputSchema } from "@/lib/core/schemas/vendor";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSessionUser, isOperator } from "@/lib/supabase/auth";

/**
 * PATCH /api/admin/vendors/[id]/review — 입점 승인·반려 (F-A-01, 명세서 §4.4)
 *
 *  * **사유 없는 반려·보완 요청은 422 다.** zod 와 DB CHECK 양쪽에서 막는다.
 *  * 모든 심사 액션을 `audit_logs` 에 남긴다(§7.2). 상태 전이는 `entity_events` 에도
 *    남겨 분쟁 조사 타임라인(F-A-12·F-A-16)이 나중에 이어 읽을 수 있게 한다(D-23).
 *  * 승인 시에만 `vendors.status` 를 `active` 로 바꾼다. 반려·보완은 `pending` 그대로다 —
 *    공개 카탈로그에 노출되면 안 되기 때문이다.
 */
const ACTION_TO_APPLICATION_STATUS = {
  approve: "approved",
  request_revision: "revision_requested",
  reject: "rejected",
} as const;

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) {
    return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");
  }

  // 운영자 판정은 서버에서만 한다. 클라이언트가 보낸 역할 값을 믿지 않는다.
  if (!isOperator(user)) {
    return fail(403, "ADMIN_FORBIDDEN", "운영자만 심사할 수 있습니다.");
  }

  const { id: vendorId } = await context.params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "ADMIN_INVALID_BODY", "요청 본문을 읽을 수 없습니다.");
  }

  const parsed = VendorReviewInputSchema.safeParse(body);
  if (!parsed.success) {
    return failValidation(parsed.error.issues);
  }

  const { action, note, businessNumberVerified } = parsed.data;
  const admin = createAdminClient();

  const { data: application, error: loadError } = await admin
    .from("vendor_applications")
    .select("id, status, vendor_id")
    .eq("vendor_id", vendorId)
    .maybeSingle();

  if (loadError) {
    return fail(500, "ADMIN_REVIEW_FAILED", "신청서를 불러오지 못했습니다.");
  }

  if (!application) {
    return fail(404, "ADMIN_APPLICATION_NOT_FOUND", "신청서를 찾을 수 없습니다.");
  }

  if (application.status === "approved") {
    return fail(409, "ADMIN_ALREADY_APPROVED", "이미 승인된 신청서입니다.");
  }

  const nextStatus = ACTION_TO_APPLICATION_STATUS[action];
  const reviewedAt = new Date().toISOString();

  const { error: updateError } = await admin
    .from("vendor_applications")
    .update({
      status: nextStatus,
      review_note: note ?? null,
      reviewed_by: user.id,
      reviewed_at: reviewedAt,
      ...(businessNumberVerified
        ? { biz_no_verified_at: reviewedAt, biz_no_verified_by: user.id }
        : {}),
    })
    .eq("id", application.id);

  if (updateError) {
    return fail(500, "ADMIN_REVIEW_FAILED", "심사 결과를 저장하지 못했습니다.");
  }

  if (action === "approve") {
    const { error: vendorError } = await admin
      .from("vendors")
      .update({ status: "active" })
      .eq("id", vendorId);

    if (vendorError) {
      return fail(500, "ADMIN_REVIEW_FAILED", "업체 상태를 바꾸지 못했습니다.");
    }
  }

  // 심사 액션 감사 로그(§7.2). before/after 는 상태값만 담는다 — 서류 내용을 넣지 않는다.
  await admin.from("audit_logs").insert({
    actor_id: user.id,
    actor_role: user.role,
    action: `vendor_review_${action}`,
    target_type: "vendor",
    target_id: vendorId,
    before_json: { application_status: application.status },
    after_json: { application_status: nextStatus, business_number_verified: businessNumberVerified },
  });

  await recordEvent({
    entityType: "vendor",
    entityId: vendorId,
    eventType: `vendor_review_${action}`,
    beforeState: application.status,
    afterState: nextStatus,
    source: "admin",
    memo: note ?? null,
    actor: { id: user.id, role: user.role },
  });

  return ok({
    vendorId,
    applicationStatus: nextStatus,
    vendorStatus: action === "approve" ? "active" : "pending",
    reviewedAt,
  });
}
