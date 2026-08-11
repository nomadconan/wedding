import type { NextRequest } from "next/server";

import { fail, failValidation, ok } from "@/lib/api/response";
import {
  approveConsultation,
  rejectConsultation,
  submitConfirmation,
} from "@/lib/consultation/actions";
import { loadConsultationSettings, loadMyConsultations } from "@/lib/consultation/loader";
import type { ConsultationOutcome } from "@/lib/core/consultation/consultation";
import { VendorConsultationActionSchema } from "@/lib/core/schemas/consultation";
import { getSessionUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";
import { findMemberVendor } from "@/lib/vendor/products";

/**
 * GET/PATCH /api/vendor/consultations — 예약 승인·거절·이행 확인 (F-V-17, §4.3)
 *
 * §4.3 이 든 것 — "예약 **승인·거절**, 이행 확인 응답, **노쇼 신고**·보증금 처리 요청".
 *
 * ── 노쇼 신고를 별도 동작으로 두지 않았다 ───────────────────────────────────
 * 업체의 노쇼 신고는 이행 확인에 `no_show_couple` 을 내는 것과 같은 일이다. 별도
 * 경로를 만들면 업체의 **일방 주장이 양측 대조를 건너뛰는 길**이 생기고, §3.11 은
 * 정확히 그것을 막으려고 대조를 요구한다. 그래서 `confirm` 하나로 받는다.
 *
 * ── staff 도 응대한다 ───────────────────────────────────────────────────────
 * S2-07 이 막은 것은 가격·정산이다. 일정은 그 둘이 아니고, 0007 이 `vendor_availability`
 * 정책을 `is_vendor_member` 로 쓴 것과 같은 판단이다.
 *
 * `vendor_id` 를 입력으로 받지 않는다 — 세션에서 찾는다.
 */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  const vendor = await findMemberVendor(user.id);
  if (!vendor) return fail(403, "VENDOR_NOT_FOUND", "등록된 업체가 없습니다.");

  const supabase = await createClient();

  try {
    return ok({
      consultations: await loadMyConsultations(supabase, { vendorId: vendor.id }),
      settings: await loadConsultationSettings(),
    });
  } catch {
    return fail(500, "CONSULTATION_LOAD_FAILED", "예약을 불러오지 못했습니다.");
  }
}

/**
 * §4.3 이 `PATCH` 로 적었다. 동작을 본문에 실어 보낸다 — 승인·거절·확인이 전부
 * 같은 자원의 상태 전이라 라우트를 셋으로 나눌 이유가 없다.
 */
export async function PATCH(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  const vendor = await findMemberVendor(user.id);
  if (!vendor) return fail(403, "VENDOR_NOT_FOUND", "등록된 업체가 없습니다.");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "CONSULTATION_INVALID_BODY", "요청 본문을 읽을 수 없습니다.");
  }

  const parsed = VendorConsultationActionSchema.safeParse(body);
  if (!parsed.success) return failValidation(parsed.error.issues);

  const supabase = await createClient();
  const action = parsed.data;

  if (action.action === "approve") {
    const result = await approveConsultation(supabase, {
      consultationId: action.consultationId,
      actorId: user.id,
    });

    return "status" in result ? fail(result.status, result.code, result.message) : ok(result);
  }

  if (action.action === "reject") {
    const result = await rejectConsultation(supabase, {
      consultationId: action.consultationId,
      reason: action.reason,
      actorId: user.id,
    });

    return "status" in result ? fail(result.status, result.code, result.message) : ok(result);
  }

  // 이행 확인(= 노쇼 신고). 편은 세션이 정한다 — 이 라우트는 업체용이다.
  const result = await submitConfirmation(supabase, {
    consultationId: action.consultationId,
    side: "vendor",
    outcome: action.outcome as ConsultationOutcome,
    actorId: user.id,
    now: new Date(),
  });

  return "status" in result
    ? fail(result.status, result.code, result.message)
    : ok({ consultationId: result.consultationId, verdict: result.verdict });
}
