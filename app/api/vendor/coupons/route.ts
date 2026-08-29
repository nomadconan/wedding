import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, failValidation, ok } from "@/lib/api/response";
import { createVendorCoupon, loadVendorCoupons, vendorContext } from "@/lib/coupons/vendor";
import { DISCOUNT_TYPES } from "@/lib/core/coupon/coupon";
import { COUPON_FORM_MESSAGE } from "@/lib/core/coupon/issue";
import { getSessionUser } from "@/lib/supabase/auth";

/**
 * GET/POST /api/vendor/coupons — 자사 쿠폰 발행·현황 (F-V-19 · §4.3 · S5-13)
 *
 * **`issuer_id` 를 입력으로 받지 않는다.** 세션이 정한다 — 받으면 남의 업체 이름으로
 * 쿠폰을 만들 수 있고, 그 할인액은 **그 업체 정산에서 나간다**(FIX-45 가 드러낸 것과
 * 같은 자리: 비용이 엉뚱한 쪽으로 간다).
 *
 * **리뷰 관련 조건은 422 다.** 화면 선택지에 없고(첫 층), 여기서 거절하며(둘째),
 * DB CHECK 이 최종 경계다(§7.7 · D-03). 세 층이 같은 목록을 본다.
 *
 * **발급 실행 경로가 없다는 사실을 본문에 싣는다**(함정 3 · FIX-46) — 화면에서만
 * 적으면 이 API 를 쓰는 다음 사람은 만든 쿠폰이 고객에게 간다고 읽는다.
 */
export const dynamic = "force-dynamic";

const FormSchema = z.object({
  name: z.string().trim().min(1).max(120),
  discountType: z.enum(DISCOUNT_TYPES),
  discountValue: z.number().int().min(1),
  maxDiscountAmount: z.number().int().min(1).nullable(),
  minOrderAmount: z.number().int().min(0),
  // 어휘 판정은 순수 함수가 한다 — 여기서는 문자열 모양만 본다.
  issueCondition: z.string().trim().min(1).max(40),
  validFrom: z.string().datetime().nullable(),
  validTo: z.string().datetime().nullable(),
  totalQuantity: z.number().int().min(1).nullable(),
});

export async function GET() {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  const context = await vendorContext(user.id);
  if (!context) return fail(403, "VENDOR_NOT_MEMBER", "업체 계정이 아닙니다.");

  try {
    const payload = await loadVendorCoupons({ ...context, now: new Date() });

    return ok(payload);
  } catch {
    return fail(500, "VENDOR_COUPON_LOAD_FAILED", "쿠폰을 불러오지 못했습니다.");
  }
}

export async function POST(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  const context = await vendorContext(user.id);
  if (!context) return fail(403, "VENDOR_NOT_MEMBER", "업체 계정이 아닙니다.");

  // **대표만 발행한다**(§3.9 · `coupons_write_vendor` 가 `is_vendor_owner` 다).
  // RLS 가 최종 경계지만 여기서 먼저 답해야 화면이 이유를 적을 수 있다.
  if (!context.isOwner) {
    return fail(403, "VENDOR_NOT_OWNER", "쿠폰 발행은 대표만 할 수 있습니다.");
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "COUPON_INVALID_BODY", "요청 본문을 읽지 못했습니다.");
  }

  const parsed = FormSchema.safeParse(body);
  if (!parsed.success) return failValidation(parsed.error.issues);

  const result = await createVendorCoupon({
    vendorId: context.vendorId,
    form: parsed.data,
    actorId: user.id,
    actorRole: user.role,
  });

  if (!result.ok) {
    return fail(result.status, result.code, result.message, {
      // **막은 이유를 전부 싣는다** — 하나씩 알려 주면 고치고 저장하기를 반복한다.
      reasons: (result.errors ?? []).map((code) => ({ code, message: COUPON_FORM_MESSAGE[code] })),
    });
  }

  return ok({ couponId: result.couponId }, { status: 201 });
}
