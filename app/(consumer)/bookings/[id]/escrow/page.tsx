import type { Metadata } from "next";
import { Suspense } from "react";

import { ConsumerShell } from "@/components/layout/ConsumerShell";
import { ErrorState } from "@/components/ui/ErrorState";
import { LoadingState } from "@/components/ui/LoadingState";
import { ESCROW_TITLE } from "@/lib/core/escrow/escrow";
import { resolveEscrowAdapterName } from "@/lib/escrow/adapter";
import { loadEscrowHolds } from "@/lib/escrow/loader";
import { requireUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";

import { EscrowView } from "./EscrowView";

export const metadata: Metadata = {
  title: "안전거래 — 웨딩클리어",
};

/**
 * /bookings/[id]/escrow (F-C-16, §6.2 보완 제안)
 *
 * §6.2 는 `/bookings/[id]` 까지만 적고 안전거래 화면 경로를 두지 않았다. 해지
 * (`/bookings/[id]/cancel` · S5-08)와 같은 자리에 둔다 — 명세 반영을 제안한다(§7.5).
 *
 * **커플 소유자만 보인다.** `escrow_holds` 정책이 owner·업체 멤버·운영자에게만 열려
 * 있고(0035), 배우자에게는 보이지 않는다 — 결제·계약 서명과 같은 조건이며 이것은
 * 그 돈이다. 앱에서 역할을 비교해 감추는 것이 아니라 **RLS 가 안 보여주는 것**이
 * 경계다(§5.5).
 */
export default async function EscrowPage({ params }: { params: { id: string } }) {
  await requireUser(`/bookings/${params.id}/escrow`);

  return (
    <ConsumerShell title={ESCROW_TITLE}>
      <Suspense fallback={<LoadingState label="안전거래 정보를 불러오는 중" rows={3} variant="block" />}>
        <EscrowSection bookingId={params.id} />
      </Suspense>
    </ConsumerShell>
  );
}

async function EscrowSection({ bookingId }: { bookingId: string }) {
  await requireUser(`/bookings/${bookingId}/escrow`);

  try {
    const holds = await loadEscrowHolds(await createClient(), { bookingId });

    return (
      <EscrowView
        data={{
          holds,
          // 스텁으로 도는 동안 화면이 그 사실을 숨기지 않는다(D-28).
          stubMode: resolveEscrowAdapterName() === "stub",
        }}
      />
    );
  } catch {
    return (
      <ErrorState
        code="ESCROW_LOAD_FAILED"
        title="안전거래 정보를 불러오지 못했어요"
        description="잠시 후 다시 시도해 주세요."
      />
    );
  }
}
