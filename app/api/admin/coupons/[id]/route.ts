import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, failValidation, ok } from "@/lib/api/response";
import { updatePlatformCoupon } from "@/lib/coupons/admin";
import { COUPON_STATUSES, DISCOUNT_TYPES } from "@/lib/core/coupon/coupon";
import { COUPON_FORM_MESSAGE } from "@/lib/core/coupon/issue";
import { getSessionUser, isOperator } from "@/lib/supabase/auth";

/**
 * PATCH /api/admin/coupons/[id] — 플랫폼 쿠폰 수정·중단 (F-A-19 · §4.3 · S5-14)
 *
 * **업체 쿠폰은 이 경로로 고칠 수 없다**(T-00e). 로더가 `issuer_type='platform'`
 * 이 아니면 404 를 주고, 정책도 같은 것을 막는다 — 남의 정산에서 깎는 쿠폰을
 * 운영자가 손대면 부담 주체가 만든 사람과 갈린다.
 *
 * **발급이 시작되면 돈에 관한 조건은 얼어붙는다**(D-159) — 업체 면과 같은 규칙이다.
 * 한쪽만 느슨하면 그쪽이 우회로가 된다.
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
  if (!isOperator(user)) return fail(403, "ADMIN_FORBIDDEN", "권한이 없습니다.");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "COUPON_INVALID_BODY", "요청 본문을 읽지 못했습니다.");
  }

  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) return failValidation(parsed.error.issues);

  const { status, ...form } = parsed.data;

  const result = await updatePlatformCoupon({
    // **대상은 경로가 정한다.**
    couponId: params.id,
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
