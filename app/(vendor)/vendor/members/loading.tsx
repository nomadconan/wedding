import { AdminShell } from "@/components/layout/AdminShell";
import { Card, CardContent } from "@/components/ui/card";
import { LoadingState } from "@/components/ui/LoadingState";

/** /vendor/members 로딩 상태 (§6 — 데이터 화면 3종 상태). */
export default function VendorMembersLoading() {
  return (
    <AdminShell role="vendor" title="멤버 관리">
      <Card>
        <CardContent className="pt-6">
          <LoadingState variant="list" rows={3} />
        </CardContent>
      </Card>
    </AdminShell>
  );
}
