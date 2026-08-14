import type { Metadata } from "next";
import Link from "next/link";

import { AdminShell } from "@/components/layout/AdminShell";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { SETTLEMENT_TITLE } from "@/lib/core/settlement/settlement";
import { loadSettlements } from "@/lib/settlements/loader";
import { resolvePayoutAdapterName } from "@/lib/settlements/payout-adapter";
import { requireUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";
import { findMemberVendor } from "@/lib/vendor/products";

import { SettlementsView } from "./SettlementsView";

export const metadata: Metadata = {
  title: "정산 — 웨딩클리어",
};

/**
 * /vendor/settlements (F-V-09, §6.3)
 *
 * **대표 전용이다.** `settlements` SELECT 정책이 `is_vendor_owner` 로 쓰여 있어
 * (0028) staff 에게는 **빈 목록**이 온다 — 403 화면을 그리지 않는 이유는, 권한
 * 판정을 앱이 하면 그것이 경계처럼 보이기 때문이다. 경계는 RLS 다(§5.5).
 * 대신 목록이 비었을 때의 문구가 그 상황을 함께 설명한다.
 *
 * S2-08 대시보드가 이 화면으로 링크하고 있었고, 화면이 없어 404 였다. 이번에 살아난다.
 */
export default async function VendorSettlementsPage() {
  const user = await requireUser("/vendor/settlements");
  const vendor = await findMemberVendor(user.id);

  if (!vendor) {
    return (
      <AdminShell role="vendor" title={SETTLEMENT_TITLE}>
        <Card>
          <CardContent className="pt-6">
            <EmptyState
              title="아직 등록된 업체가 없어요"
              description="입점 신청을 마치고 거래가 생기면 정산 명세가 만들어집니다."
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
    // RLS 가 대표/타 업체를 가른다 — 여기서 vendor_id 로 다시 거르지 않는다(§5.5).
    const payload = await loadSettlements(await createClient());

    return (
      <AdminShell
        role="vendor"
        title={SETTLEMENT_TITLE}
        description={
          payload.feeBasisResolved
            ? "기간별 정산 명세와 지급 상태를 확인할 수 있어요."
            : "수수료 기준이 정해지면 대기 중인 기간이 그대로 계산됩니다. 거래 내역은 이미 모여 있어요."
        }
      >
        <SettlementsView
          data={{
            settlements: payload.settlements,
            pendingAdjustments: payload.pendingAdjustments,
            feeBasisResolved: payload.feeBasisResolved,
            // 스텁으로 도는 동안 화면이 그 사실을 숨기지 않는다(D-28).
            stubMode: resolvePayoutAdapterName() === "stub",
          }}
        />
      </AdminShell>
    );
  } catch {
    return (
      <AdminShell role="vendor" title={SETTLEMENT_TITLE}>
        <ErrorState
          code="SETTLEMENT_LOAD_FAILED"
          title="정산 명세를 불러오지 못했어요"
          description="잠시 후 다시 시도해 주세요."
        />
      </AdminShell>
    );
  }
}
