import type { Metadata } from "next";

import { AdminShell } from "@/components/layout/AdminShell";
import { ErrorState } from "@/components/ui/ErrorState";
import { loadAdminPlannerPayouts } from "@/lib/planners/payouts";
import { loadSettlements } from "@/lib/settlements/loader";
import { requireOperator } from "@/lib/supabase/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import { PlannerPayoutPanel } from "./PlannerPayoutPanel";
import { RunPanel } from "./RunPanel";

export const metadata: Metadata = {
  title: "정산 집행 — 웨딩클리어",
};

/**
 * /admin/settlements (F-A-11, §6.4 — **5단계**)
 *
 * 배치 실행·보류·조정·대사와 **스냅샷 요율 표시**. §6.4 가 이 화면을 5단계로 적어
 * 두었으므로 S5-07 의 범위다(다른 운영자 화면 대부분은 8단계다).
 *
 * **정산서는 세션 클라이언트로 읽는다** — 0033 이 `is_operator()` 정책을 만들었고,
 * 경계는 앱 코드가 아니라 RLS 여야 한다(§5.5). 업체 **이름**만 서비스롤로 읽는다:
 * `vendors` 는 공개 데이터라 열람이 문제되지 않지만, 승인 전 업체까지 집계 대상으로
 * 보여야 하므로 목록 조회를 세션에 의존하지 않는다.
 */
export default async function AdminSettlementsPage() {
  await requireOperator("/admin/settlements");

  try {
    const payload = await loadSettlements(await createClient());

    const { data: vendorRows } = await createAdminClient()
      .from("vendors")
      .select("id, name")
      .eq("status", "active")
      .order("name");

    const vendors = (vendorRows ?? []) as { id: string; name: string }[];

    const { data: ownerRows } = await createAdminClient()
      .from("settlements")
      .select("id, vendor_id");

    const vendorOf = new Map(
      ((ownerRows ?? []) as { id: string; vendor_id: string }[]).map((row) => [
        row.id,
        row.vendor_id,
      ]),
    );

    const nameOf = new Map(vendors.map((vendor) => [vendor.id, vendor.name]));

    const blocked = payload.settlements.filter((row) => row.status === "blocked").length;

    // S6-05. **이번에 나갈 돈을 한 화면이 든다.** 플래너 지급을 다른 화면에 두면
    // 운영자가 마감할 때 한쪽만 보고 끝내고, 안 본 쪽은 아무도 모르게 밀린다.
    const plannerPayouts = await loadAdminPlannerPayouts({ now: new Date() });

    return (
      <AdminShell
        role="admin"
        title="정산 집행"
        description={
          blocked > 0
            ? `설정 대기 ${blocked}건. 수수료 기준(O-15)이 정해지면 그대로 계산됩니다 — 장애가 아닙니다.`
            : "기간별 집계·확정·지급을 여기서 실행합니다."
        }
      >
        <RunPanel
          vendors={vendors}
          items={payload.settlements.map((row) => ({
            ...row,
            vendorId: vendorOf.get(row.id) ?? "",
            vendorName: nameOf.get(vendorOf.get(row.id) ?? "") ?? "업체",
          }))}
        />

        <div className="mt-8 border-t border-border pt-6">
          <PlannerPayoutPanel
            rows={plannerPayouts.rows}
            plannerNames={plannerPayouts.plannerNames}
          />
        </div>
      </AdminShell>
    );
  } catch {
    return (
      <AdminShell role="admin" title="정산 집행">
        <ErrorState
          code="SETTLEMENT_ADMIN_LOAD_FAILED"
          title="정산 목록을 불러오지 못했어요"
          description="잠시 후 다시 시도해 주세요."
        />
      </AdminShell>
    );
  }
}
