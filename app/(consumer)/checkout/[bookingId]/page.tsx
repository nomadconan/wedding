import type { Metadata } from "next";
import { Suspense } from "react";

import { ConsumerShell } from "@/components/layout/ConsumerShell";
import { ErrorState } from "@/components/ui/ErrorState";
import { LoadingState } from "@/components/ui/LoadingState";
import { CHECKOUT_TITLE } from "@/lib/core/payment/checkout";
import { loadCheckout } from "@/lib/payments/loader";
import { resolveChargeAdapterName } from "@/lib/payments/charge-adapter";
import { requireUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";

import { CheckoutView } from "./CheckoutView";

export const metadata: Metadata = {
  title: "결제 — 웨딩클리어",
};

/**
 * /checkout/[bookingId] (F-C-14, §6.2)
 *
 * 로그인이 필요하다. 미인증 차단은 미들웨어가 한다(S3-01).
 *
 * **커플 소유자만 결제한다.** §3.9 가 "결제·계약 서명은 owner 추가 조건" 이라 했고
 * `payment_schedules` 정책이 그렇게 쓰여 있다(0028) — 배우자에게는 이 화면이
 * 404 로 보인다. 앱에서 역할을 비교해 감추는 방식이 아니라 **RLS 가 안 보여주는
 * 것**이 경계다(§5.5).
 */
export default async function CheckoutPage({ params }: { params: { bookingId: string } }) {
  await requireUser(`/checkout/${params.bookingId}`);

  return (
    <ConsumerShell title={CHECKOUT_TITLE}>
      <Suspense fallback={<LoadingState label="결제 정보를 불러오는 중" rows={3} variant="block" />}>
        <CheckoutSection bookingId={params.bookingId} />
      </Suspense>
    </ConsumerShell>
  );
}

async function CheckoutSection({ bookingId }: { bookingId: string }) {
  await requireUser(`/checkout/${bookingId}`);

  try {
    const payload = await loadCheckout(await createClient(), bookingId);

    if (!payload) {
      return (
        <ErrorState
          code="PAY_CONTRACT_NOT_FOUND"
          title="결제할 계약을 찾지 못했어요"
          description="계약이 발행되면 회차별 금액과 기한이 여기에 나타납니다."
        />
      );
    }

    return (
      <CheckoutView
        data={{
          contract: {
            id: payload.contract.id,
            status: payload.contract.status,
            totalAmount: payload.contract.totalAmount,
          },
          schedules: payload.schedules,
          progress: payload.progress,
          next: payload.next,
          coupon: payload.coupon,
        }}
        // 스텁으로 도는 동안 화면이 그 사실을 숨기지 않는다(D-28).
        stubMode={resolveChargeAdapterName() === "stub"}
      />
    );
  } catch {
    return (
      <ErrorState
        code="PAY_LOAD_FAILED"
        title="결제 정보를 불러오지 못했어요"
        description="잠시 후 다시 시도해 주세요."
      />
    );
  }
}
