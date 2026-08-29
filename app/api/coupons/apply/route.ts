import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, failValidation, ok } from "@/lib/api/response";
import { previewRedemption } from "@/lib/coupons/redeem";
import { readStackingMode } from "@/lib/coupons/settings";
import { loadCheckout } from "@/lib/payments/loader";
import { getSessionUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";

/**
 * POST /api/coupons/apply — 쿠폰 적용 미리보기 (F-C-36 · §4.2 · S5-12)
 *
 * ── **아무것도 쓰지 않는다** ────────────────────────────────────────────────
 *
 * 이름이 'apply' 지만 이 경로는 **판정만 한다.** 고를 때 사용 기록을 남기면 결제가
 * 실패했을 때 **돈은 안 냈는데 쿠폰만 사라진다.** 기록은 결제가 승인된 뒤
 * `chargeInstallment` 안에서 남긴다 — 성공과 같은 자리가 유일하게 맞는 지점이다.
 *
 * ── 화면이 보낸 금액을 믿지 않는다 ─────────────────────────────────────────
 *
 * 받는 것은 **예약 id 와 발급분 id 뿐**이다. 회차 금액은 서버가 계약에서 읽고 할인액도
 * 서버가 센다 — 클라이언트가 금액을 정할 수 있으면 `borne_by='vendor'` 쿠폰에서
 * **남의 정산을 비우는 경로**가 된다.
 *
 * **막힌 사유를 그대로 돌려준다.** "쓸 수 없다" 만 말하면 고객은 무엇을 하면 쓸 수
 * 있는지 모른다(F-C-36 이 요구하는 것이 그것이다).
 */
export const dynamic = "force-dynamic";

const ApplySchema = z.object({
  bookingId: z.string().uuid(),
  couponIssueId: z.string().uuid(),
});

export async function POST(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "COUPON_INVALID_BODY", "요청 본문을 읽지 못했습니다.");
  }

  const parsed = ApplySchema.safeParse(body);
  if (!parsed.success) return failValidation(parsed.error.issues);

  // **낼 회차를 서버가 정한다.** RLS 가 이 예약을 안 보여주면 여기서 끝난다.
  // **세션 클라이언트로 읽는다** — 경계는 RLS 이고, 서비스롤로 읽으면 남의 예약에
  // 내 쿠폰을 대 보는 계산을 해 준다.
  const checkout = await loadCheckout(await createClient(), parsed.data.bookingId, new Date());

  if (!checkout || checkout.next === null) {
    return fail(404, "COUPON_NO_PAYABLE_ROUND", "지금 결제할 회차가 없어요.");
  }

  const verdict = await previewRedemption({
    issueId: parsed.data.couponIssueId,
    installmentAmount: checkout.next.amounts.installmentAmount,
    appliedCount: 0,
    stackingMode: await readStackingMode(),
    bookingVendorId: checkout.vendorId,
    now: new Date(),
  });

  if (!verdict.ok) {
    // 422 다 — 요청은 올바르고 **지금 이 쿠폰이 이 결제에 안 맞는** 것이다.
    return fail(422, `COUPON_${verdict.reason.toUpperCase()}`, verdict.message);
  }

  // **할인 전 · 할인액 · 할인 후를 함께 돌려준다**(D-18). 하나만 주면 화면이
  // 나머지를 계산하게 되고, 그 계산이 서버와 갈리는 순간 금액이 두 개가 된다.
  return ok({
    couponIssueId: parsed.data.couponIssueId,
    installmentAmount: checkout.next.amounts.installmentAmount,
    discountAmount: verdict.discountAmount,
    payableAmount: verdict.payableAmount,
    borneBy: verdict.borneBy,
    // **아직 쓴 것이 아니라는 사실을 본문이 말한다**(함정 3).
    committed: false,
    note: "결제가 승인되는 순간에 사용 처리됩니다. 지금은 계산만 했습니다.",
  });
}
