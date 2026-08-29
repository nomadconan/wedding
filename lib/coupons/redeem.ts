import { recordEvent } from "@/lib/audit/record";
import type { CouponIssuer } from "@/lib/core/coupon/coupon";
import { type ApplyVerdict, applyVerdict } from "@/lib/core/coupon/wallet";
import { createAdminClient } from "@/lib/supabase/admin";

import { loadWalletEntry } from "./read";

/**
 * 쿠폰 사용 (S5-12 · **FIX-13**)
 *
 * ── 언제 쓰는가 ────────────────────────────────────────────────────────────
 *
 * **사용 기록은 결제가 성공한 뒤에 적는다.** 고를 때 적으면 결제가 실패했을 때
 * 쿠폰만 사라진다 — 고객은 돈도 안 냈는데 쿠폰을 잃는다. 반대로 아예 안 적으면
 * 할인만 받고 쿠폰이 남는다. **결제 성공과 같은 자리**가 유일하게 맞는 지점이다.
 *
 * ── 무엇을 믿지 않는가 ─────────────────────────────────────────────────────
 *
 * **화면이 보낸 할인액을 믿지 않는다.** 받는 것은 발급분 id 뿐이고 금액은 서버가
 * 다시 센다(`applyVerdict`). 클라이언트가 금액을 정할 수 있으면 그것이 곧
 * `borne_by='vendor'` 쿠폰에서 **남의 정산을 비우는 경로**가 된다.
 *
 * **`borne_by` 도 입력으로 받지 않는다.** 발행 주체를 그대로 따르며(D-27) 사용 시점에
 * 박아 둔다 — 발행자가 바뀌어도 이미 쓴 건의 부담이 소급 변경되면 안 된다.
 */

export type RedeemFailure = { ok: false; status: number; code: string; message: string };
export type RedeemSuccess = {
  ok: true;
  redemptionId: string;
  discountAmount: number;
  borneBy: CouponIssuer;
};

/**
 * 결제 직전 판정. **아무것도 쓰지 않는다.**
 *
 * 화면의 미리보기와 결제의 실제 판정이 **같은 함수**를 지나야 "화면엔 되는데 결제가
 * 막힌다" 가 생기지 않는다.
 */
export async function previewRedemption(input: {
  issueId: string;
  installmentAmount: number;
  appliedCount: number;
  stackingMode: "single" | "multiple";
  /** 이 결제가 속한 예약의 업체. **업체 발행 쿠폰은 그 업체와의 거래에만 쓴다.** */
  bookingVendorId: string | null;
  now: Date;
}): Promise<ApplyVerdict> {
  const entry = await loadWalletEntry(input.issueId);

  return applyVerdict({
    entry,
    installmentAmount: input.installmentAmount,
    appliedCount: input.appliedCount,
    stackingMode: input.stackingMode,
    bookingVendorId: input.bookingVendorId,
    now: input.now,
  });
}

/**
 * 사용을 확정한다. **결제가 승인된 뒤에만 부른다.**
 *
 * 실패해도 결제를 되돌리지 않는다 — 고객은 이미 냈고, 되돌리면 그 돈이 어디에도 없는
 * 상태가 된다(에스크로 예치와 같은 판단). 대신 증적을 남기고 운영이 본다.
 */
export async function commitRedemption(input: {
  issueId: string;
  bookingId: string;
  paymentId: string;
  discountAmount: number;
  borneBy: CouponIssuer;
  actorId: string;
}): Promise<RedeemSuccess | RedeemFailure> {
  const admin = createAdminClient();

  const { data, error } = await admin
    .from("coupon_redemptions")
    .insert({
      coupon_issue_id: input.issueId,
      booking_id: input.bookingId,
      payment_id: input.paymentId,
      discount_amount: input.discountAmount,
      borne_by: input.borneBy,
    })
    .select("id")
    .maybeSingle();

  if (error || !data) {
    // 유니크 충돌은 **이미 쓴 쿠폰**이다(0066 의 `uq_coupon_redemptions_issue`).
    // 같은 발급분으로 두 결제를 동시에 눌러도 여기서 하나만 남는다.
    const duplicate = (error as { code?: string } | null)?.code === "23505";

    await recordEvent({
      entityType: "coupon_issue",
      entityId: input.issueId,
      eventType: duplicate ? "coupon_redeem_duplicate" : "coupon_redeem_failed",
      actor: { id: input.actorId },
      beforeState: "issued",
      afterState: "issued",
      // **쿠폰 이름·코드를 담지 않는다**(§7.3). 남길 사실은 금액과 결과다.
      memo: `amount=${input.discountAmount}`,
    });

    return {
      ok: false,
      status: duplicate ? 409 : 500,
      code: duplicate ? "COUPON_ALREADY_USED" : "COUPON_REDEEM_FAILED",
      message: duplicate
        ? "이미 사용된 쿠폰이에요."
        : "쿠폰 사용을 기록하지 못했습니다. 결제는 완료됐습니다.",
    };
  }

  // **발급분 상태를 'used' 로 옮긴다.** 사용 기록이 진실이고 이 값은 읽기 편의지만,
  // 어긋나면 화면이 쓸 수 있다고 말한다 — 유니크 인덱스가 최종 경계이므로 여기서
  // 실패해도 이중 사용은 일어나지 않는다.
  await admin.from("coupon_issues").update({ status: "used" }).eq("id", input.issueId);

  await recordEvent({
    entityType: "coupon_issue",
    entityId: input.issueId,
    eventType: "coupon_redeemed",
    actor: { id: input.actorId },
    beforeState: "issued",
    afterState: "used",
    memo: `amount=${input.discountAmount} borne=${input.borneBy}`,
  });

  return {
    ok: true,
    redemptionId: (data as { id: string }).id,
    discountAmount: input.discountAmount,
    borneBy: input.borneBy,
  };
}

/**
 * 이 계약에서 이미 쓴 할인액의 합.
 *
 * **FIX-13 의 나머지 절반이다.** 계약 총액은 쿠폰 전 금액이고 `payments.amount` 는
 * 할인 뒤 실제로 낸 돈이라, 이 값을 빼지 않으면 **다 내고도 잔액이 남는다.**
 * 저장하지 않고 볼 때마다 다시 센다(D-124).
 */
export async function priorDiscountOf(bookingId: string): Promise<number> {
  const admin = createAdminClient();

  const { data } = await admin
    .from("coupon_redemptions")
    .select("discount_amount")
    .eq("booking_id", bookingId);

  return ((data ?? []) as { discount_amount: number }[]).reduce(
    (sum, row) => sum + row.discount_amount,
    0,
  );
}
