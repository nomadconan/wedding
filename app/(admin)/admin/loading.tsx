import { AdminShell } from "@/components/layout/AdminShell";
import { Card, CardContent } from "@/components/ui/card";
import { LoadingState } from "@/components/ui/LoadingState";

/**
 * /admin 로딩 상태 (§6 — 데이터 화면 3종 상태).
 *
 * 미인증 접근은 여기까지 오지 않는다 — `middleware.ts` 의 `PROTECTED_PREFIXES` 가
 * `/admin` 을 **상태 코드로** 끊는다. `loading.tsx` 가 있으면 응답이 200 으로 확정된
 * 뒤에 스트리밍되므로 서버 컴포넌트의 `redirect()` 만으로는 막을 수 없다(S3-01 주석).
 */
export default function AdminDashboardLoading() {
  return (
    <AdminShell role="admin" title="지표 대시보드">
      <div className="space-y-6">
        <Card>
          <CardContent className="pt-6">
            <LoadingState variant="block" rows={4} />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <LoadingState variant="block" rows={4} />
          </CardContent>
        </Card>
      </div>
    </AdminShell>
  );
}
