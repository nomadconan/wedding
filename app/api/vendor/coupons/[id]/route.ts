import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, failValidation, ok } from "@/lib/api/response";
import { updateVendorCoupon, vendorContext } from "@/lib/coupons/vendor";
import { COUPON_STATUSES, DISCOUNT_TYPES } from "@/lib/core/coupon/coupon";
import { COUPON_FORM_MESSAGE } from "@/lib/core/coupon/issue";
import { getSessionUser } from "@/lib/supabase/auth";

/**
 * PATCH /api/vendor/coupons/[id] — 자사 쿠폰 수정·중단 (F-V-19 · §4.3 · S5-13)
 *
 * **대상은 경로가 정한다.** 본문의 id 를 신뢰하면 화면이 가리키는 쿠폰과 다른 쿠폰을
 * 고치는 요청을 만들 수 있다.
 *
 * **발급이 시작되면 돈에 관한 조건은 얼어붙는다**(0067). 여기서 먼저 판정해 **어느
 * 칸이 막혔는지**를 알려 주고, 트리거가 최종 경계로 한 번 더 본다 — 트리거 메시지만
 * 올려보내면 화면이 무엇을 되돌려야 하는지 말할 수 없다.
 */
export const dynamic = "force-dynamic";

const PatchSchema = z.object({
  name: z.string().trim().min(1).max(120),
  discountType: z.enum(DISCOUNT_TYPES),
  discountValue: z.number().int().min(1),
  maxDiscountAmount: z.number().int().min(1).nullable(),
  minOrderAmount: z.number().int().min(0),
  issueCondition: z.string().trim().min(1).max(40),
  validFrom: z.string().datetime().nullable(),
  validTo: z.string().datetime().nullable(),
  totalQuantity: z.number().int().min(1).nullable(),
  status: z.enum(COUPON_STATUSES),
});

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  const context = await vendorContext(user.id);
  if (!context) return fail(403, "VENDOR_NOT_MEMBER", "업체 계정이 아닙니다.");
  if (!context.isOwner) {
    return fail(403, "VENDOR_NOT_OWNER", "쿠폰 수정은 대표만 할 수 있습니다.");
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "COUPON_INVALID_BODY", "요청 본문을 읽지 못했습니다.");
  }

  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) return failValidation(parsed.error.issues);

  const { status, ...form } = parsed.data;

  const result = await updateVendorCoupon({
    couponId: params.id,
    vendorId: context.vendorId,
    form,
    status,
    actorId: user.id,
    actorRole: user.role,
  });

  if (!result.ok) {
    return fail(result.status, result.code, result.message, {
      reasons: (result.errors ?? []).map((code) => ({ code, message: COUPON_FORM_MESSAGE[code] })),
    });
  }

  return ok({ couponId: result.couponId, status });
}
