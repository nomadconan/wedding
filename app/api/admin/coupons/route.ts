import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, failValidation, ok } from "@/lib/api/response";
import { createPlatformCoupon, loadPlatformCoupons } from "@/lib/coupons/admin";
import { DISCOUNT_TYPES } from "@/lib/core/coupon/coupon";
import { COUPON_FORM_MESSAGE } from "@/lib/core/coupon/issue";
import { getSessionUser, isOperator } from "@/lib/supabase/auth";

/**
 * GET/POST /api/admin/coupons — 플랫폼 쿠폰 관리 (F-A-19 · §4.3 · S5-14)
 *
 * **`issuer_type` 을 입력으로 받지 않는다.** 여기서 만드는 것은 언제나 플랫폼
 * 쿠폰이다 — 받으면 운영자가 `vendor` 로 적어 **남의 정산에서 깎는 쿠폰**을 만들 수
 * 있고, 그것이 T-00e 가 업체 화면과 이 화면을 가른 이유다(FIX-45 와 같은 자리).
 * 정책(`coupons_write_platform`)도 같은 것을 못 박는다.
 *
 * **비용이 전액 플랫폼 손익이라는 사실을 본문에 싣는다**(F-A-19 · 함정 3) —
 * 화면에서만 적으면 이 API 를 쓰는 다음 사람은 업체 정산에도 닿는 줄 안다.
 *
 * **대상 세그먼트를 만들지 않았다는 사실도 싣는다**(D-143 계열).
 */
export const dynamic = "force-dynamic";

const FormSchema = z.object({
  name: z.string().trim().min(1).max(120),
  discountType: z.enum(DISCOUNT_TYPES),
  discountValue: z.number().int().min(1),
  maxDiscountAmount: z.number().int().min(1).nullable(),
  minOrderAmount: z.number().int().min(0),
  issueCondition: z.string().trim().min(1).max(40),
  validFrom: z.string().datetime().nullable(),
  validTo: z.string().datetime().nullable(),
  totalQuantity: z.number().int().min(1).nullable(),
});

export async function GET() {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");
  if (!isOperator(user)) return fail(403, "ADMIN_FORBIDDEN", "권한이 없습니다.");

  try {
    return ok(await loadPlatformCoupons(new Date()));
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : "";

    if (message === "ADMIN_COUPON_FORBIDDEN") {
      return fail(403, "ADMIN_FORBIDDEN", "권한이 없습니다.");
    }

    return fail(500, "ADMIN_COUPON_LOAD_FAILED", "쿠폰을 불러오지 못했습니다.");
  }
}

export async function POST(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");
  if (!isOperator(user)) return fail(403, "ADMIN_FORBIDDEN", "권한이 없습니다.");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "COUPON_INVALID_BODY", "요청 본문을 읽지 못했습니다.");
  }

  const parsed = FormSchema.safeParse(body);
  if (!parsed.success) return failValidation(parsed.error.issues);

  const result = await createPlatformCoupon({
    form: parsed.data,
    actorId: user.id,
    actorRole: user.role,
  });

  if (!result.ok) {
    return fail(result.status, result.code, result.message, {
      reasons: (result.errors ?? []).map((code) => ({ code, message: COUPON_FORM_MESSAGE[code] })),
    });
  }

  return ok({ couponId: result.couponId }, { status: 201 });
}
