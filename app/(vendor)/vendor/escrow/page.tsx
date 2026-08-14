import type { Metadata } from "next";
import Link from "next/link";

import { AdminShell } from "@/components/layout/AdminShell";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { ESCROW_TITLE } from "@/lib/core/escrow/escrow";
import { resolveEscrowAdapterName } from "@/lib/escrow/adapter";
import { loadEscrowHolds } from "@/lib/escrow/loader";
import { requireUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";
import { findMemberVendor } from "@/lib/vendor/products";

import { VendorEscrowPanel } from "./VendorEscrowPanel";

export const metadata: Metadata = {
  title: "안전거래 — 웨딩클리어",
};

/**
 * /vendor/escrow (F-C-16 의 업체 편 · §6.3 보완 제안)
 *
 * 업체도 **이행 확인의 당사자**다. 확인하지 않으면 릴리즈가 늦어지고, 그 지연의
 * 책임을 고객에게 물을 수 없다 — 그래서 업체에게도 같은 화면이 필요하다.
 *
 * **staff 도 응대한다.** 이행 확인은 가격·정산 편집이 아니라 **사실 확인**이다
 * (S2-07 경계 · S5-08 해지 회신과 같은 판단). 금액은 서버가 정하고 이 화면은
 * "이행됐다/아니다" 만 받는다.
 */
export default async function VendorEscrowPage() {
  const user = await requireUser("/vendor/escrow");
  const vendor = await findMemberVendor(user.id);

  if (!vendor) {
    return (
      <AdminShell role="vendor" title={ESCROW_TITLE}>
        <Card>
          <CardContent className="pt-6">
            <EmptyState
              title="아직 등록된 업체가 없어요"
              description="입점 신청을 마치고 거래가 생기면 안전거래 건이 여기에 나타납니다."
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
    const holds = await loadEscrowHolds(await createClient());
    const waiting = holds.filter((hold) => hold.status === "held" && hold.vendorConfirmed === null);

    return (
      <AdminShell
        role="vendor"
        title={ESCROW_TITLE}
        description={
          waiting.length > 0
            ? `이행 확인 대기 ${waiting.length}건. 확인이 늦어지면 정산도 함께 늦어집니다.`
            : "확인할 안전거래 건이 없어요."
        }
      >
        <VendorEscrowPanel
          holds={holds}
          stubMode={resolveEscrowAdapterName() === "stub"}
        />
      </AdminShell>
    );
  } catch {
    return (
      <AdminShell role="vendor" title={ESCROW_TITLE}>
        <ErrorState
          code="ESCROW_LOAD_FAILED"
          title="안전거래 정보를 불러오지 못했어요"
          description="잠시 후 다시 시도해 주세요."
        />
      </AdminShell>
    );
  }
}
