import { AdminShell } from "@/components/layout/AdminShell";
import { Card, CardContent } from "@/components/ui/card";
import { LoadingState } from "@/components/ui/LoadingState";

/** /admin/audit 로딩 상태 (§6 — 데이터 화면 3종 상태). */
export default function AdminAuditLoading() {
  return (
    <AdminShell role="admin" title="감사 로그">
      <div className="space-y-6">
        <Card>
          <CardContent className="pt-6">
            <LoadingState variant="block" rows={1} />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <LoadingState variant="block" rows={5} />
          </CardContent>
        </Card>
      </div>
    </AdminShell>
  );
}
