import { createHash } from "node:crypto";

import type { NextRequest } from "next/server";

import { failValidation, fail, ok } from "@/lib/api/response";
import { VendorApplicationInputSchema } from "@/lib/core/schemas/vendor";
import {
  maskBusinessNumber,
  normalizeMailOrderNumber,
} from "@/lib/core/vendor/business-number";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSessionUser } from "@/lib/supabase/auth";

/**
 * POST /api/vendor/apply — 입점 신청 (F-V-01, 명세서 §4.3)
 *
 * 서비스롤을 쓰는 이유: `vendors` 에는 INSERT 정책이 없다(§3.9 — "입점 심사·상태 변경은
 * 서비스롤"). 대신 **대상은 전부 세션에서 확인한 사용자로 좁힌다.**
 * 클라이언트가 보낸 vendor_id·applicant_id 를 신뢰하지 않는다.
 *
 * 개인정보 취급(§7.2·§7.3)
 *  - 사업자등록번호는 **평문으로 저장하지 않는다.** SHA-256 해시만 `vendors.biz_no_enc` 에
 *    남기고, 화면 표시는 마스킹 값을 쓴다. 평문 조회 API 를 만들지 않는다.
 *  - 업로드는 **비공개 버킷 + 서명 URL** 로만 한다. 응답의 서명 URL 은 업로드 전용이며
 *    Storage 경로를 로그에 남기지 않는다(CLAUDE.md §5.3).
 */
const DOCUMENT_BUCKET = "vendor-documents";

/** 파일명에서 경로 조작·비ASCII 를 제거한다. 사용자가 준 이름을 그대로 쓰지 않는다. */
function safeFileName(fileName: string): string {
  const ext = fileName.includes(".") ? fileName.split(".").pop()!.toLowerCase().slice(0, 8) : "bin";
  const stamp = Math.random().toString(36).slice(2, 10);

  return `${stamp}.${ext.replace(/[^a-z0-9]/g, "") || "bin"}`;
}

export async function POST(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) {
    return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "VENDOR_INVALID_BODY", "요청 본문을 읽을 수 없습니다.");
  }

  const parsed = VendorApplicationInputSchema.safeParse(body);
  if (!parsed.success) {
    return failValidation(parsed.error.issues);
  }

  const input = parsed.data;
  const admin = createAdminClient();

  // 사업자번호 원문은 여기서 해시로 바꾸고 이후 어디에도 남기지 않는다.
  const bizNoHash = createHash("sha256").update(input.businessNumber).digest("hex");
  const bizNoMasked = maskBusinessNumber(input.businessNumber);

  // 이미 신청한 업체가 있으면 새로 만들지 않고 갱신한다(재신청·보완 제출).
  const { data: existing, error: existingError } = await admin
    .from("vendor_applications")
    .select("id, vendor_id, status")
    .eq("applicant_id", user.id)
    .maybeSingle();

  if (existingError) {
    return fail(500, "VENDOR_APPLY_FAILED", "신청서를 불러오지 못했습니다.");
  }

  if (existing?.status === "approved") {
    return fail(409, "VENDOR_ALREADY_APPROVED", "이미 승인된 업체입니다.");
  }

  let vendorId = existing?.vendor_id ?? null;
  const beforeStatus = existing?.status ?? null;

  if (vendorId) {
    const { error } = await admin
      .from("vendors")
      .update({
        name: input.name,
        category: input.category,
        region_code: input.regionCode,
        biz_no_enc: bizNoHash,
      })
      .eq("id", vendorId);

    if (error) return fail(500, "VENDOR_APPLY_FAILED", "업체 정보를 저장하지 못했습니다.");
  } else {
    const { data: created, error } = await admin
      .from("vendors")
      .insert({
        name: input.name,
        category: input.category,
        region_code: input.regionCode,
        biz_no_enc: bizNoHash,
        status: "pending",
      })
      .select("id")
      .single();

    if (error || !created) {
      return fail(500, "VENDOR_APPLY_FAILED", "업체를 생성하지 못했습니다.");
    }

    vendorId = created.id;

    // 신청자를 owner 로 붙인다. 이 연결이 있어야 RLS 가 자기 업체를 알아본다.
    const { error: memberError } = await admin
      .from("vendor_members")
      .insert({ vendor_id: vendorId, user_id: user.id, vendor_role: "owner" });

    if (memberError) {
      return fail(500, "VENDOR_APPLY_FAILED", "업체 멤버를 등록하지 못했습니다.");
    }
  }

  const applicationRow = {
    vendor_id: vendorId,
    applicant_id: user.id,
    representative_name: input.representativeName,
    contact_phone: input.contactPhone,
    mail_order_no: input.mailOrderNumber
      ? normalizeMailOrderNumber(input.mailOrderNumber)
      : null,
    biz_no_masked: bizNoMasked,
    status: "submitted" as const,
    submitted_at: new Date().toISOString(),
    // 재제출이면 이전 심사 결과를 지운다 — 반려 사유가 남아 있으면 상태와 어긋난다.
    review_note: null,
    reviewed_by: null,
    reviewed_at: null,
  };

  const { data: application, error: applicationError } = await admin
    .from("vendor_applications")
    .upsert(applicationRow, { onConflict: "vendor_id" })
    .select("id, status, submitted_at")
    .single();

  if (applicationError || !application) {
    return fail(500, "VENDOR_APPLY_FAILED", "신청서를 저장하지 못했습니다.");
  }

  // 서류 업로드용 서명 URL. 파일은 클라이언트가 이 URL 로 직접 올린다.
  const uploads: { docType: string; path: string; token: string; signedUrl: string }[] = [];

  for (const doc of input.documents) {
    const path = `${vendorId}/${doc.docType}/${safeFileName(doc.fileName)}`;
    const { data: signed, error: signError } = await admin.storage
      .from(DOCUMENT_BUCKET)
      .createSignedUploadUrl(path);

    if (signError || !signed) {
      return fail(500, "VENDOR_UPLOAD_URL_FAILED", "서류 업로드 주소를 만들지 못했습니다.");
    }

    const { error: docError } = await admin.from("vendor_documents").insert({
      vendor_id: vendorId,
      doc_type: doc.docType,
      storage_path: path,
    });

    if (docError) {
      return fail(500, "VENDOR_APPLY_FAILED", "서류 정보를 저장하지 못했습니다.");
    }

    uploads.push({
      docType: doc.docType,
      path,
      token: signed.token,
      signedUrl: signed.signedUrl,
    });
  }

  // 상태 전이를 증적으로 남긴다(D-23). memo 에 원문·경로를 담지 않는다.
  await admin.from("entity_events").insert({
    entity_type: "vendor",
    entity_id: vendorId,
    event_type: "vendor_application_submitted",
    actor_id: user.id,
    actor_role: "vendor_owner",
    before_state: beforeStatus,
    after_state: "submitted",
    source: "web",
    memo: beforeStatus === null ? "최초 신청" : "재제출",
  });

  return ok(
    {
      vendorId,
      applicationId: application.id,
      status: application.status,
      submittedAt: application.submitted_at,
      businessNumberMasked: bizNoMasked,
      uploads,
    },
    { status: 201 },
  );
}
