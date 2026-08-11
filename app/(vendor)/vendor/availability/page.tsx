import type { Metadata } from "next";
import Link from "next/link";

import { AdminShell } from "@/components/layout/AdminShell";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { loadAvailability } from "@/lib/consultation/loader";
import { requireUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";
import { findMemberVendor } from "@/lib/vendor/products";

import { AvailabilityView } from "./AvailabilityView";

export const metadata: Metadata = {
  title: "상담 가능 시간 — 웨딩클리어",
};

/**
 * /vendor/availability (F-V-17 · S4-06, §6.3)
 *
 * **예약 흐름의 출발점이다.** 여기에 시간대가 없으면 고객은 아무것도 고를 수 없다.
 * 요일 단위 반복 규칙이며 특정 날짜의 예외는 재고 캘린더(`inventory_slots`)의 블록
 * 처리로 다룬다 — 날짜 예외를 두 곳에 두지 않는다는 0007 의 결정을 화면도 따른다.
 *
 * **staff 도 등록한다.** 0007 의 정책이 `is_vendor_member` 다.
 */
export default async function VendorAvailabilityPage() {
  const user = await requireUser("/vendor/availability");
  const vendor = await findMemberVendor(user.id);

  if (!vendor) {
    return (
      <AdminShell role="vendor" title="상담 가능 시간">
        <Card>
          <CardContent className="pt-6">
            <EmptyState
              assetId="vendor.dashboard.empty"
              title="아직 등록된 업체가 없어요"
              description="입점 신청을 마치면 상담 가능 시간을 등록할 수 있습니다."
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
    return (
      <AdminShell
        role="vendor"
        title="상담 가능 시간"
        description="요일과 시간대를 등록하면 고객이 그 안에서 골라 신청해요. 특정 날짜 휴무는 재고 캘린더에서 막습니다."
      >
        <AvailabilityView initialRules={await loadAvailability(supabase, vendor.id)} />
      </AdminShell>
    );
  } catch {
    return (
      <AdminShell role="vendor" title="상담 가능 시간">
        <ErrorState
          code="AVAILABILITY_LOAD_FAILED"
          title="시간대를 불러오지 못했어요"
          description="잠시 후 다시 시도해 주세요."
        />
      </AdminShell>
    );
  }
}
