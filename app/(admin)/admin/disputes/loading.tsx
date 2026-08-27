import { AdminShell } from "@/components/layout/AdminShell";
import { Card, CardContent } from "@/components/ui/card";
import { LoadingState } from "@/components/ui/LoadingState";

/** /admin/disputes 로딩 상태 (§6 — 데이터 화면 3종 상태). */
export default function AdminDisputesLoading() {
  return (
    <AdminShell role="admin" title="분쟁 조율">
      <div className="space-y-6">
        {[1, 2].map((row) => (
          <Card key={row}>
            <CardContent className="pt-6">
              <LoadingState variant="block" rows={3} />
            </CardContent>
          </Card>
        ))}
      </div>
    </AdminShell>
  );
}
