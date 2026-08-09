import { AdminShell } from "@/components/layout/AdminShell";
import { Card, CardContent } from "@/components/ui/card";
import { LoadingState } from "@/components/ui/LoadingState";

/** /vendor/pricing 로딩 상태 (§6 — 데이터 화면 3종 상태). */
export default function VendorPricingLoading() {
  return (
    <AdminShell role="vendor" title="다이내믹 프라이싱">
      <Card>
        <CardContent className="pt-6">
          <LoadingState variant="list" rows={3} />
        </CardContent>
      </Card>
    </AdminShell>
  );
}
