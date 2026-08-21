import type { Metadata } from "next";
import Link from "next/link";

import { AdminShell } from "@/components/layout/AdminShell";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/EmptyState";
import { badgeMaxHigh, loadLatestScan } from "@/lib/compliance/scan";
import { activeRuleCount, decideBadge } from "@/lib/core/compliance/compliance";
import { requireUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";
import { findMemberVendor } from "@/lib/vendor/products";

import { ComplianceView } from "./ComplianceView";

export const metadata: Metadata = {
  title: "컴플라이언스 진단 — 웨딩클리어",
};

/**
 * /vendor/compliance (F-V-10, §6.3)
 *
 * **세션 클라이언트로 읽는다** — `vendor_compliance_scans` 는 업체 멤버만 볼 수 있고
 * (0050 [2]) 그 경계가 RLS 다. 진단 결과에는 업체가 아직 고치는 중인 자기 약관의
 * 약점이 인용까지 들어 있다. 쿠키를 읽으므로 이 페이지는 동적이다.
 *
 * **진입은 `AdminShell` 좌측 내비**다 — 이 태스크가 그 줄을 함께 넣었다. 화면만 만들고
 * 들어가는 자리를 안 만들면 아무도 못 찾는다(S7-10 의 `/guides` 와 같은 판단).
 */
export default async function VendorCompliancePage() {
  const user = await requireUser("/vendor/compliance");
  const vendor = await findMemberVendor(user.id);

  if (!vendor) {
    return (
      <AdminShell role="vendor" title="컴플라이언스 진단">
        <Card>
          <CardContent className="pt-6">
            <EmptyState
              assetId="vendor.dashboard.empty"
              title="아직 등록된 업체가 없어요"
              description="입점 신청을 마치면 약관을 진단하고 투명 계약 배지를 받을 수 있습니다."
              action={
                <Button size="touch" asChild>
                  <Link href="/vendor/apply">입점 신청하기</Link>
                </Button>
              }
            />
          </CardContent>
        </Card>
      </AdminShell>
    );
  }

  const supabase = await createClient();
  const scan = await loadLatestScan(supabase, { vendorId: vendor.id });

  return (
    <AdminShell role="vendor" title="컴플라이언스 진단">
      <ComplianceView
        initialScan={
          scan === null
            ? null
            : {
                findings: scan.findings,
                counts: scan.counts,
                ruleCount: scan.ruleCount,
                scannedAt: scan.scannedAt,
              }
        }
        // **진단한 적이 없어도 배지 판정은 낸다** — 그래야 화면이 "아직 세지 않았다" 를
        // 0건과 구분해 말할 수 있다.
        initialBadge={scan?.badge ?? decideBadge({ highCount: null, maxHigh: await badgeMaxHigh() })}
        ruleCount={activeRuleCount()}
      />
    </AdminShell>
  );
}
