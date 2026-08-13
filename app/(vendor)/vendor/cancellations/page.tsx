import type { Metadata } from "next";
import Link from "next/link";

import { AdminShell } from "@/components/layout/AdminShell";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { loadVendorCancellations } from "@/lib/cancellation/loader";
import { requireUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";
import { findMemberVendor } from "@/lib/vendor/products";

import { CancellationPanel } from "./CancellationPanel";

export const metadata: Metadata = {
  title: "해지 요청 — 웨딩클리어",
};

/**
 * /vendor/cancellations (S5-08 · F-V-08 인접 · §6.3 보완 제안)
 *
 * F-V-08 의 예약 보드(`/vendor/bookings`, S5-10)와 **다른 화면**이다. 보드는 진행
 * 중인 거래를 보는 곳이고 여기는 **끝내는 절차**를 응대하는 곳이다 — 응답 기한이
 * 있고 회신이 증적으로 남는다는 점에서 성격이 다르다(상담 보드와 이행 확인이
 * 나뉘어 있는 것과 같은 이유 · S4-07).
 *
 * **staff 도 응대한다.** 해지 회신은 가격·정산 편집이 아니라 사실 확인이다(S2-07 경계).
 * 실제 정산 금액은 서버가 산정하고 이 화면은 **동의 여부와 귀책 의견**만 받는다.
 */
export default async function VendorCancellationsPage() {
  const user = await requireUser("/vendor/cancellations");
  const vendor = await findMemberVendor(user.id);

  if (!vendor) {
    return (
      <AdminShell role="vendor" title="해지 요청">
        <Card>
          <CardContent className="pt-6">
            <EmptyState
              title="아직 등록된 업체가 없어요"
              description="입점 신청을 마치면 계약과 해지 요청을 받을 수 있습니다."
              action={
                <Button size="touch" asChild>
                  <Link href="/vendor/apply">입점 신청하러 가기</Link>
                </Button>
              }
            />
          </CardContent>
        </Card>
      </AdminShell>
    );
  }

  try {
    // RLS 가 업체를 가른다 — 여기서 vendor_id 로 다시 거르지 않는다(§5.5).
    const items = await loadVendorCancellations(await createClient());
    const waiting = items.filter((item) => item.vendorAgreed === null && item.status === "requested");

    return (
      <AdminShell
        role="vendor"
        title="해지 요청"
        description={
          waiting.length > 0
            ? `회신 대기 ${waiting.length}건. 기한 안에 회신하지 않으면 운영자 조율로 넘어갑니다.`
            : "회신할 해지 요청이 없어요."
        }
      >
        <CancellationPanel
          items={items.map((item) => ({
            id: item.id,
            bookingId: item.bookingId,
            status: item.status,
            statusLabel: item.statusLabel,
            requesterSide: item.requesterSide,
            reasonLabel: item.reasonLabel,
            reasonNote: item.reasonNote,
            faultLabel: item.faultLabel,
            coupleClaim: item.coupleClaim,
            vendorAgreed: item.vendorAgreed,
            confirmDueAt: item.confirmDueAt,
            bandLabel: item.bandLabel,
            basisRef: item.basisRef,
            isDraftRules: item.isDraftRules,
            paidAmount: item.paidAmount,
            penaltyApplied: item.penaltyApplied,
            refundAmount: item.refundAmount,
          }))}
        />
      </AdminShell>
    );
  } catch {
    return (
      <AdminShell role="vendor" title="해지 요청">
        <ErrorState
          code="CANCEL_LOAD_FAILED"
          title="해지 요청을 불러오지 못했어요"
          description="잠시 후 다시 시도해 주세요."
        />
      </AdminShell>
    );
  }
}
