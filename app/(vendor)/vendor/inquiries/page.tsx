import type { Metadata } from "next";
import Link from "next/link";

import { AdminShell } from "@/components/layout/AdminShell";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { SLA_UNSET_NOTE, inboxOrder } from "@/lib/core/inquiry/inquiry";
import { loadQuotableProducts, loadSlaThreshold, loadVendorInbox } from "@/lib/inquiry/loader";
import { requireUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";
import { findMemberVendor } from "@/lib/vendor/products";

import { VendorInquiriesView } from "./VendorInquiriesView";

export const metadata: Metadata = {
  title: "문의·견적 — 웨딩클리어",
};

/**
 * /vendor/inquiries (F-V-07, §6.3)
 *
 * **staff 도 들어온다.** S2-07 이 staff 에게서 막은 것은 가격 **등록**과 정산이다.
 * 등록된 가격 이하로 견적을 내는 일은 그 범위를 벗어나지 않으며, DB 정책도
 * `is_vendor_member` 이지 `is_vendor_owner` 가 아니다.
 *
 * 인박스는 **미응답이 위**다(F-V-07). 정렬 규칙은 `lib/core` 의 순수 함수가 갖고
 * 화면·API 가 같은 함수를 쓴다.
 */
export default async function VendorInquiriesPage() {
  const user = await requireUser("/vendor/inquiries");
  const vendor = await findMemberVendor(user.id);

  if (!vendor) {
    return (
      <AdminShell role="vendor" title="문의·견적">
        <Card>
          <CardContent className="pt-6">
            <EmptyState
              assetId="vendor.dashboard.empty"
              title="아직 등록된 업체가 없어요"
              description="입점 신청을 마치면 고객 문의를 받을 수 있습니다."
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
  const threshold = await loadSlaThreshold();

  try {
    const targets = inboxOrder(
      await loadVendorInbox(supabase, { vendorId: vendor.id, threshold, now: new Date() }),
    );

    // 견적 폼이 고를 수 있는 것 — 등록된 **게시** 상품과 그 추가금뿐이다.
    // 이 목록이 곧 자유 양식 금지의 화면 쪽 표현이다(스키마 쪽은 0024).
    const products = await loadQuotableProducts(supabase, vendor.id);

    return (
      <AdminShell
        role="vendor"
        title="문의·견적"
        description={
          threshold
            ? `응답 기준 ${Math.round(threshold.minutes / 60)}시간. 미응답 문의가 위에 옵니다.`
            : SLA_UNSET_NOTE
        }
      >
        <VendorInquiriesView
          initialTargets={targets}
          products={products}
          slaConfigured={threshold !== null}
        />
      </AdminShell>
    );
  } catch {
    return (
      <AdminShell role="vendor" title="문의·견적">
        <ErrorState
          code="INQUIRY_LOAD_FAILED"
          title="문의를 불러오지 못했어요"
          description="잠시 후 다시 시도해 주세요."
        />
      </AdminShell>
    );
  }
}
