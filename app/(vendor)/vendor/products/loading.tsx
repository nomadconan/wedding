import { AdminShell } from "@/components/layout/AdminShell";
import { Card, CardContent } from "@/components/ui/card";
import { LoadingState } from "@/components/ui/LoadingState";

/** /vendor/products 로딩 상태 (§6 — 데이터 화면 3종 상태). 스켈레톤이다. */
export default function VendorProductsLoading() {
  return (
    <AdminShell role="vendor" title="상품·가격">
      <Card>
        <CardContent className="pt-6">
          <LoadingState variant="list" rows={3} />
        </CardContent>
      </Card>
    </AdminShell>
  );
}
