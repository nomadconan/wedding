import type { Metadata } from "next";
import Link from "next/link";

import { AdminShell } from "@/components/layout/AdminShell";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { loadConsultationSettings, loadMyConsultations } from "@/lib/consultation/loader";
import { requireUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";
import { findMemberVendor } from "@/lib/vendor/products";

import { VendorConsultationsView } from "./VendorConsultationsView";

export const metadata: Metadata = {
  title: "상담 일정 — 웨딩클리어",
};

/**
 * /vendor/consultations (F-V-17, §6.3)
 *
 * 신청 승인·거절, 확정 일정, **이행 확인 응답**, 노쇼 신고.
 * 노쇼 신고를 따로 두지 않았다 — 그것은 이행 확인에 '고객 불참' 을 내는 것과 같은
 * 일이고, 별도 경로를 만들면 업체의 일방 주장이 §3.11 의 양측 대조를 건너뛴다.
 *
 * **staff 도 응대한다.** 일정은 가격·정산이 아니다(S2-07 경계).
 */
export default async function VendorConsultationsPage() {
  const user = await requireUser("/vendor/consultations");
  const vendor = await findMemberVendor(user.id);

  if (!vendor) {
    return (
      <AdminShell role="vendor" title="상담 일정">
        <Card>
          <CardContent className="pt-6">
            <EmptyState
              assetId="vendor.dashboard.empty"
              title="아직 등록된 업체가 없어요"
              description="입점 신청을 마치면 상담 예약을 받을 수 있습니다."
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

  const supabase = await createClient();

  try {
    const consultations = await loadMyConsultations(supabase, { vendorId: vendor.id });
    const waiting = consultations.filter((item) => item.status === "requested").length;

    return (
      <AdminShell
        role="vendor"
        title="상담 일정"
        description={
          waiting > 0
            ? `승인 대기 ${waiting}건. 승인하면 그 시각은 다른 예약을 받지 않아요.`
            : "승인 대기 중인 신청이 없어요."
        }
        action={
          <Button variant="outline" size="sm" asChild>
            <Link href="/vendor/availability">가능 시간 관리</Link>
          </Button>
        }
      >
        <VendorConsultationsView
          initialConsultations={consultations}
          settings={await loadConsultationSettings()}
        />
      </AdminShell>
    );
  } catch {
    return (
      <AdminShell role="vendor" title="상담 일정">
        <ErrorState
          code="CONSULTATION_LOAD_FAILED"
          title="예약을 불러오지 못했어요"
          description="잠시 후 다시 시도해 주세요."
        />
      </AdminShell>
    );
  }
}
