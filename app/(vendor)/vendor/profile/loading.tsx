import { AdminShell } from "@/components/layout/AdminShell";
import { Card, CardContent } from "@/components/ui/card";
import { LoadingState } from "@/components/ui/LoadingState";

/**
 * /vendor/profile 로딩 상태 (§6 — 데이터 화면은 로딩·빈 상태·에러 3종을 갖춘다)
 * 스피너가 아니라 스켈레톤이다(docs/DESIGN.md §2).
 */
export default function VendorProfileLoading() {
  return (
    <AdminShell role="vendor" title="업체 프로필">
      <Card>
        <CardContent className="pt-6">
          <LoadingState variant="block" rows={4} />
        </CardContent>
      </Card>
    </AdminShell>
  );
}
