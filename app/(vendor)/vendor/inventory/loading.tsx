import { AdminShell } from "@/components/layout/AdminShell";
import { Card, CardContent } from "@/components/ui/card";
import { LoadingState } from "@/components/ui/LoadingState";

/** /vendor/inventory 로딩 상태 (§6 — 데이터 화면 3종 상태). */
export default function VendorInventoryLoading() {
  return (
    <AdminShell role="vendor" title="재고 캘린더">
      <Card>
        <CardContent className="pt-6">
          <LoadingState variant="block" rows={4} />
        </CardContent>
      </Card>
    </AdminShell>
  );
}
