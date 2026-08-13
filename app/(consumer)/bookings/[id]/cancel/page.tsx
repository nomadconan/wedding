import type { Metadata } from "next";
import { Suspense } from "react";

import { ConsumerShell } from "@/components/layout/ConsumerShell";
import { ErrorState } from "@/components/ui/ErrorState";
import { LoadingState } from "@/components/ui/LoadingState";
import { loadCancellationView } from "@/lib/cancellation/loader";
import { CANCEL_TITLE } from "@/lib/core/cancellation/cancellation";
import { requireUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";

import { CancelView } from "./CancelView";

export const metadata: Metadata = {
  title: "계약 해지 — 웨딩클리어",
};

/**
 * /bookings/[id]/cancel (F-A-17 상대편 화면 · §6.2 보완 제안)
 *
 * §6.2 는 `/bookings/[id]` 까지만 적고 해지 화면 경로를 두지 않았다. 해지는 예약
 * 상세에서 들어가는 하위 단계라 그 아래에 둔다 — 명세 반영을 제안한다(§7.5).
 *
 * **커플 소유자만 보인다.** `contract_cancellations` 정책이 owner·업체 멤버에게만
 * 열려 있고(0031), 배우자에게는 계약은 보이지만 해지 절차는 보이지 않는다.
 * 앱에서 역할을 비교해 감추는 것이 아니라 **RLS 가 안 보여주는 것**이 경계다(§5.5).
 */
export default async function CancelPage({ params }: { params: { id: string } }) {
  await requireUser(`/bookings/${params.id}/cancel`);

  return (
    <ConsumerShell title={CANCEL_TITLE}>
      <Suspense fallback={<LoadingState label="해지 정보를 불러오는 중" rows={3} variant="block" />}>
        <CancelSection bookingId={params.id} />
      </Suspense>
    </ConsumerShell>
  );
}

async function CancelSection({ bookingId }: { bookingId: string }) {
  await requireUser(`/bookings/${bookingId}/cancel`);

  try {
    const view = await loadCancellationView(await createClient(), bookingId);

    if (!view) {
      return (
        <ErrorState
          code="CANCEL_CONTRACT_NOT_FOUND"
          title="해지할 계약을 찾지 못했어요"
          description="계약이 확정된 뒤에 이 화면에서 해지를 요청할 수 있어요."
        />
      );
    }

    return (
      <CancelView
        data={{
          bookingId,
          stageLabel: view.stageLabel,
          quote:
            view.quote === null
              ? null
              : {
                  settlement: {
                    penaltyAmount: view.quote.settlement.penaltyAmount,
                    refundAmount: view.quote.settlement.refundAmount,
                    balanceDue: view.quote.settlement.balanceDue,
                    appliedRule: view.quote.settlement.appliedRule,
                    notes: view.quote.settlement.notes,
                    disclaimer: view.quote.settlement.disclaimer,
                  },
                  penalty: {
                    bandLabel: view.quote.penalty.bandLabel,
                    basisRef: view.quote.penalty.basisRef,
                    isDraftRules: view.quote.penalty.isDraftRules,
                  },
                  daysBeforeEvent: view.quote.daysBeforeEvent,
                  paidAmount: view.quote.paidAmount,
                  totalAmount: view.quote.totalAmount,
                },
          cancellation:
            view.cancellation === null
              ? null
              : {
                  id: view.cancellation.id,
                  status: view.cancellation.status,
                  statusLabel: view.cancellation.statusLabel,
                  requesterSide: view.cancellation.requesterSide,
                  reasonLabel: view.cancellation.reasonLabel,
                  faultLabel: view.cancellation.faultLabel,
                  coupleAgreed: view.cancellation.coupleAgreed,
                  vendorAgreed: view.cancellation.vendorAgreed,
                  confirmDueAt: view.cancellation.confirmDueAt,
                  penaltyApplied: view.cancellation.penaltyApplied,
                  refundAmount: view.cancellation.refundAmount,
                  balanceDue: view.cancellation.balanceDue,
                  resolutionNote: view.cancellation.resolutionNote,
                },
        }}
      />
    );
  } catch {
    return (
      <ErrorState
        code="CANCEL_LOAD_FAILED"
        title="해지 정보를 불러오지 못했어요"
        description="잠시 후 다시 시도해 주세요."
      />
    );
  }
}
