import type { Metadata } from "next";
import Link from "next/link";

import { MetricTile } from "@/components/domain/MetricTile";
import { AdminShell } from "@/components/layout/AdminShell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import {
  PRICE_POSITION_MIN_SAMPLE,
  isMeasured,
  measured,
  type MetricValue,
} from "@/lib/core/stats/metric";
import { requireUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";
import { loadVendorStats } from "@/lib/vendor/stats";

export const metadata: Metadata = {
  title: "성과 통계 — 웨딩클리어",
};

/**
 * /vendor/stats — 성과 통계 (F-V-12, §6.3)
 *
 * **staff 도 본다.** 정산 금액만 owner 전용이라 가려서 표시한다(§3.9).
 *
 * 차트 라이브러리를 쓰지 않는다 — `docs/DESIGN.md` §5 가 차트 색을 범위 밖으로 두었고,
 * 여기서 필요한 것은 숫자와 한 줄 막대뿐이다. 퍼널이 실제 데이터로 채워지는 시점(4~5단계)에
 * 색 팔레트와 함께 다시 판단한다.
 */
export default async function VendorStatsPage() {
  const user = await requireUser("/vendor/stats");
  const supabase = await createClient();

  const { data: vendor, error } = await supabase
    .from("vendors")
    .select("id, name, category, region_code, status")
    .limit(1)
    .maybeSingle();

  if (error) {
    return (
      <AdminShell role="vendor" title="성과 통계">
        <ErrorState
          code="VENDOR_STATS_LOAD_FAILED"
          title="통계를 불러오지 못했어요"
          description="잠시 후 다시 시도해 주세요."
        />
      </AdminShell>
    );
  }

  if (!vendor) {
    return (
      <AdminShell role="vendor" title="성과 통계">
        <Card>
          <CardContent className="pt-6">
            <EmptyState
              assetId="vendor.dashboard.empty"
              title="아직 등록된 업체가 없어요"
              description="입점 신청을 마치면 통계를 볼 수 있습니다."
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

  const canSeeFinancials = membership?.vendor_role === "owner";

  const stats = await loadVendorStats(
    supabase,
    {
      id: vendor.id,
      category: vendor.category,
      regionCode: vendor.region_code,
      status: vendor.status,
    },
    { canSeeFinancials },
  );

  const position = stats.market.pricePosition;

  return (
    <AdminShell
      role="vendor"
      title="성과 통계"
      description="지금 집계 가능한 값만 표시합니다. 나머지는 어느 단계에서 채워지는지 함께 적어 뒀습니다."
    >
      <div className="space-y-6">
        {/* ── 퍼널 ─────────────────────────────────────────────────────── */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">노출 → 문의 → 상담 → 계약</CardTitle>
            <CardDescription>
              아직 셀 수단이 없는 단계는 <strong>0으로 적지 않습니다.</strong> &apos;0건 왔다&apos;와
              &apos;아직 받을 수단이 없다&apos;는 다른 사실입니다.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5" data-testid="funnel">
              <MetricTile label="노출" metric={stats.funnel.impressions} unit="회" />
              <MetricTile label="문의" metric={stats.funnel.inquiries} unit="건" />
              <MetricTile label="상담·탐방" metric={stats.funnel.consultations} unit="건" />
              <MetricTile label="예약" metric={stats.funnel.bookings} unit="건" />
              <MetricTile label="계약" metric={stats.funnel.contracts} unit="건" />
            </div>
          </CardContent>
        </Card>

        {/* ── 재고 ─────────────────────────────────────────────────────── */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">재고</CardTitle>
            <CardDescription>소진율은 앞으로의 슬롯만 봅니다. 막은 슬롯은 분모에서 뺍니다.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <MetricTile label="전체 슬롯" metric={stats.inventory.slotsTotal} unit="개" />
              <MetricTile label="앞으로의 슬롯" metric={stats.inventory.slotsUpcoming} unit="개" />
              <MetricTile label="막은 슬롯" metric={stats.inventory.blocked} unit="개" />
              <MetricTile label="소진율" metric={stats.inventory.utilizationBp} unit="%" asBar />
            </div>
          </CardContent>
        </Card>

        {/* ── 상품·가격 ────────────────────────────────────────────────── */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">상품·가격</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <MetricTile label="전체 상품" metric={stats.products.total} unit="개" />
              <MetricTile label="게시 중" metric={stats.products.published} unit="개" />
              <MetricTile
                label="추가금 미확정"
                metric={stats.products.addOnsUndeclared}
                unit="개"
                hint="확정 전에는 게시할 수 없습니다."
              />
              <MetricTile label="켜진 가격 룰" metric={stats.pricing.rulesActive} unit="개" />
            </div>
          </CardContent>
        </Card>

        {/* ── 지역 내 가격 포지션 ──────────────────────────────────────── */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">지역 내 가격 포지션</CardTitle>
            <CardDescription>
              같은 지역·카테고리의 <strong>익명 분포</strong>에서 내 위치만 보여줍니다. 다른 업체의
              이름도 금액도 표시하지 않으며, 비교 대상이 {PRICE_POSITION_MIN_SAMPLE}곳 미만이면
              아예 표시하지 않습니다(§7.7).
            </CardDescription>
          </CardHeader>
          <CardContent>
            {isMeasured(position) ? (
              <div className="space-y-2" data-testid="price-position">
                <MetricTile
                  label="내 가격보다 저렴한 업체 비율"
                  metric={measured(position.value.percentileBp)}
                  unit="%"
                  asBar
                  hint={`표본 ${position.value.sampleSize}곳 · 업체당 대표가 1건 기준`}
                />
                <p className="text-caption text-muted-foreground">
                  값이 클수록 지역 평균보다 비싼 편입니다. 이 수치는 사실 비교이며 등급이나
                  평가가 아닙니다.
                </p>
              </div>
            ) : (
              // 측정되지 않은 값은 숫자 타입이 의미가 없다. 상태와 사유만 그대로 넘긴다.
              <MetricTile label="내 가격 위치" metric={position as MetricValue<number>} />
            )}
          </CardContent>
        </Card>

        {/* ── 정산·후기 ────────────────────────────────────────────────── */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">정산·후기</CardTitle>
            <CardDescription>
              정산 금액은 업체 대표 계정만 볼 수 있습니다(§3.9).
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 sm:grid-cols-2">
              <MetricTile label="이번 달 정산 예정액" metric={stats.settlement.thisMonthNet} unit="원" />
              <MetricTile label="평균 평점" metric={stats.reviews.ratingAvg} />
            </div>
          </CardContent>
        </Card>
      </div>
    </AdminShell>
  );
}
