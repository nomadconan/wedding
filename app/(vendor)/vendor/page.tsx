import type { Metadata } from "next";
import Link from "next/link";

import { MetricTile } from "@/components/domain/MetricTile";
import { AdminShell } from "@/components/layout/AdminShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { VENDOR_APPLICATION_STATUS_LABEL, type VendorApplicationStatus } from "@/lib/core/schemas/vendor";
import { isMeasured } from "@/lib/core/stats/metric";
import { requireUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";
import { loadVendorStats } from "@/lib/vendor/stats";

export const metadata: Metadata = {
  title: "대시보드 — 웨딩클리어",
};

/**
 * /vendor — 업체 대시보드 (F-V-12, §6.3)
 *
 * **지금 무엇을 해야 하는지가 먼저 보인다.** 숫자를 늘어놓는 화면이 아니라
 * 미완 항목을 액션으로 보여주는 화면이다. 심사 대기 중이면 그것이 최우선이다.
 *
 * 자기 업체 데이터는 세션 클라이언트로 읽는다 — RLS 가 경계다.
 */
type Todo = { label: string; href: string; cta: string; tone: "warning" | "muted" };

export default async function VendorDashboardPage() {
  const user = await requireUser("/vendor");
  const supabase = await createClient();

  const { data: vendor, error } = await supabase
    .from("vendors")
    .select("id, name, category, region_code, status")
    .limit(1)
    .maybeSingle();

  if (error) {
    return (
      <AdminShell role="vendor" title="대시보드">
        <ErrorState
          code="VENDOR_STATS_LOAD_FAILED"
          title="대시보드를 불러오지 못했어요"
          description="잠시 후 다시 시도해 주세요."
        />
      </AdminShell>
    );
  }

  if (!vendor) {
    return (
      <AdminShell role="vendor" title="대시보드">
        <Card>
          <CardContent className="pt-6">
            <EmptyState
              assetId="vendor.dashboard.empty"
              title="아직 등록된 업체가 없어요"
              description="입점 신청을 마치면 이곳에서 현황을 확인할 수 있습니다."
              action={
                <Button size="touch" asChild>
                  <Link href="/vendor/apply">입점 신청하러 가기</Link>
                </Button>
              }
            />
          </CardContent>
        </Card>
      </AdminShell>
    );
  }

  const { data: membership } = await supabase
    .from("vendor_members")
    .select("vendor_role")
    .eq("vendor_id", vendor.id)
    .eq("user_id", user.id)
    .maybeSingle();

  const stats = await loadVendorStats(
    supabase,
    {
      id: vendor.id,
      category: vendor.category,
      regionCode: vendor.region_code,
      status: vendor.status,
    },
    { canSeeFinancials: membership?.vendor_role === "owner" },
  );

  // ── 지금 할 일 ───────────────────────────────────────────────────────────
  const todos: Todo[] = [];
  const applicationStatus = stats.application.applicationStatus as VendorApplicationStatus | null;

  if (isMeasured(stats.products.total) && stats.products.total.value === 0) {
    todos.push({
      label: "등록된 상품이 없습니다. 총액과 포함 항목을 등록해 주세요.",
      href: "/vendor/products/new",
      cta: "상품 등록",
      tone: "warning",
    });
  }

  if (isMeasured(stats.products.addOnsUndeclared) && stats.products.addOnsUndeclared.value > 0) {
    todos.push({
      label: `추가금을 확정하지 않은 상품이 ${stats.products.addOnsUndeclared.value}개 있습니다. 확정 전에는 게시할 수 없습니다.`,
      href: "/vendor/products",
      cta: "상품 보기",
      tone: "warning",
    });
  }

  if (isMeasured(stats.inventory.slotsUpcoming) && stats.inventory.slotsUpcoming.value === 0) {
    todos.push({
      label: "앞으로 예약 가능한 날짜가 없습니다. 재고를 등록해 주세요.",
      href: "/vendor/inventory",
      cta: "재고 등록",
      tone: "warning",
    });
  }

  for (const gap of stats.profile.gaps) {
    todos.push({ label: gap.label, href: "/vendor/profile", cta: "프로필 수정", tone: "muted" });
  }

  const showReviewFirst = vendor.status !== "active";

  return (
    <AdminShell
      role="vendor"
      title="대시보드"
      description={vendor.name}
      action={
        <Badge variant={vendor.status === "active" ? "default" : "secondary"}>
          {vendor.status === "active" ? "공개 중" : "비공개"}
        </Badge>
      }
    >
      <div className="space-y-6">
        {/* 심사 대기 중이면 이것이 최우선이다. */}
        {showReviewFirst ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">입점 심사</CardTitle>
              <CardDescription>
                승인 전에는 상품이 고객에게 노출되지 않습니다. 미리 등록해 두면 승인 즉시
                공개할 수 있습니다.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={applicationStatus === "rejected" ? "destructive" : "secondary"}>
                  {applicationStatus
                    ? VENDOR_APPLICATION_STATUS_LABEL[applicationStatus]
                    : "신청 전"}
                </Badge>
                {stats.application.reviewNote ? (
                  <span className="text-caption text-muted-foreground">
                    심사 의견: {stats.application.reviewNote}
                  </span>
                ) : null}
              </div>

              <Button asChild>
                <Link href="/vendor/apply">신청 화면으로</Link>
              </Button>
            </CardContent>
          </Card>
        ) : null}

        <Card>
          <CardHeader>
            <CardTitle className="text-base">지금 할 일</CardTitle>
            <CardDescription>
              고객에게 노출되기까지 남은 항목입니다.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {todos.length === 0 ? (
              <p className="text-sm text-success" data-testid="todo-clear">
                · 필요한 항목을 모두 채웠습니다.
              </p>
            ) : (
              <ul className="space-y-2" data-testid="todo-list">
                {todos.map((todo) => (
                  <li
                    key={`${todo.href}-${todo.label}`}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3"
                  >
                    <span
                      className={
                        todo.tone === "warning" ? "text-sm text-warning-foreground" : "text-sm"
                      }
                    >
                      {todo.label}
                    </span>
                    <Button variant="outline" size="sm" asChild>
                      <Link href={todo.href}>{todo.cta}</Link>
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <div>
              <CardTitle className="text-base">현황 요약</CardTitle>
              <CardDescription>지금 집계할 수 있는 값만 보여줍니다.</CardDescription>
            </div>
            <Button variant="outline" asChild>
              <Link href="/vendor/stats">통계 자세히</Link>
            </Button>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <MetricTile label="게시 중인 상품" metric={stats.products.published} unit="개" />
              <MetricTile label="앞으로의 슬롯" metric={stats.inventory.slotsUpcoming} unit="개" />
              <MetricTile
                label="슬롯 소진율"
                metric={stats.inventory.utilizationBp}
                unit="%"
                asBar
                hint="앞으로의 슬롯 기준"
              />
              <MetricTile label="받은 문의" metric={stats.funnel.inquiries} unit="건" />
            </div>
          </CardContent>
        </Card>
      </div>
    </AdminShell>
  );
}
