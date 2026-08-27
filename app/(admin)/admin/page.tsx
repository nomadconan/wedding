import type { Metadata } from "next";
import Link from "next/link";

import { FunnelBars } from "@/components/domain/FunnelBars";
import { MetricTile } from "@/components/domain/MetricTile";
import { AdminShell } from "@/components/layout/AdminShell";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { loadAdminMetrics } from "@/lib/admin/metrics";
import { MAU_DEFINITION, PERIOD_DAY_OPTIONS, resolvePeriod } from "@/lib/core/metrics/admin";
import { isMeasured } from "@/lib/core/stats/metric";
import { requireOperator } from "@/lib/supabase/auth";
import { cn } from "@/lib/utils";

export const metadata: Metadata = {
  title: "지표 대시보드 — 웨딩클리어",
};

/**
 * /admin — 지표 대시보드 (F-A-07, §6.4 — 8단계 · S8-01)
 *
 * **운영자 콘솔의 첫 화면**이다. `ADMIN_NAV` 가 오래전부터 이 경로를 가리키고 있었지만
 * 화면이 없어 죽은 링크였다(FIX-23 여덟 중 하나). 이번에 그 링크를 살린다.
 *
 * ── 이 화면이 지키는 규칙 ───────────────────────────────────────────────────
 * 1. **가짜 숫자를 만들지 않는다.** 셀 수 없는 지표는 0이 아니라 "집계 대상 없음" 이고
 *    어느 태스크가 채우는지를 함께 적는다. 기준이 미결인 지표(수수료 수익 · O-15)는
 *    "기준 미확정" 이며 **0원이 아니다** — 0원으로 적으면 미결정이 확정으로 읽힌다.
 * 2. **0에 근거를 붙인다.** 측정된 0과 "셀 수 없음" 이 화면에서 겹쳐 읽히면 운영자는
 *    멀쩡한 지표를 고장으로 보거나 그 반대를 한다. 모든 측정값에 "무엇을 세었나" 를 단다.
 * 3. **캐시하지 않는다.** 세션에 따라 내용이 달라지는 화면을 Next 가 정적으로 굳히면
 *    권한을 잃은 사람에게 캐시된 지표가 계속 나간다(FIX-22 계열).
 */
export const dynamic = "force-dynamic";

type PageProps = { searchParams: Promise<{ days?: string }> };

export default async function AdminDashboardPage({ searchParams }: PageProps) {
  await requireOperator("/admin");

  const { days } = await searchParams;
  const period = resolvePeriod(days, new Date());

  let payload: Awaited<ReturnType<typeof loadAdminMetrics>>;
  try {
    payload = await loadAdminMetrics(period);
  } catch {
    return (
      <AdminShell role="admin" title="지표 대시보드">
        <ErrorState
          code="ADMIN_METRICS_FAILED"
          title="지표를 집계하지 못했어요"
          description="잠시 후 다시 시도해 주세요. 계속되면 운영 담당자에게 알려 주세요."
        />
      </AdminShell>
    );
  }

  // 기간 안에 아무 일도 없었는지 판정한다. **"전부 0" 과 "집계 못 함" 은 다르다** —
  // 측정된 값이 하나도 없을 때만 빈 상태를 그린다.
  const measuredValues = payload.cards.filter(
    (card) => isMeasured(card.metric) && card.metric.value > 0,
  );
  const isEmptyPeriod = measuredValues.length === 0;

  return (
    <AdminShell
      role="admin"
      title="지표 대시보드"
      description={`최근 ${period.days}일. 지금 셀 수 있는 값만 표시하고, 나머지는 왜 없는지 적습니다.`}
      action={
        <nav aria-label="조회 기간" className="flex gap-1" data-testid="period-switch">
          {PERIOD_DAY_OPTIONS.map((option) => (
            <Link
              key={option}
              href={`/admin?days=${option}`}
              aria-current={option === period.days ? "page" : undefined}
              className={cn(
                "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                option === period.days
                  ? "bg-brand-50 text-brand-700"
                  : "text-neutral-600 hover:bg-secondary hover:text-foreground",
              )}
            >
              {option}일
            </Link>
          ))}
        </nav>
      }
    >
      <div className="space-y-6">
        {/* ── KPI 카드 ──────────────────────────────────────────────────── */}
        <section aria-labelledby="kpi-heading">
          <Card>
            <CardHeader>
              <CardTitle id="kpi-heading" className="text-base">
                핵심 지표
              </CardTitle>
              <CardDescription>
                <strong>0은 0으로, 못 세는 값은 못 센다고 적습니다.</strong> 두 가지를 같은
                얼굴로 그리면 &apos;아무 일도 없었다&apos;와 &apos;셀 수단이 없다&apos;를
                구분할 수 없습니다. MAU 는 {MAU_DEFINITION}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {isEmptyPeriod ? (
                <EmptyState
                  assetId="admin.dashboard.empty"
                  title={`최근 ${period.days}일에 집계된 활동이 없어요`}
                  description="기간을 넓혀 보거나, 시드 데이터를 넣은 뒤 다시 확인해 주세요. 집계 자체는 정상입니다."
                />
              ) : null}

              <div
                className={cn("grid gap-3 sm:grid-cols-2 lg:grid-cols-4", isEmptyPeriod && "mt-4")}
                data-testid="kpi-cards"
              >
                {payload.cards.map((card) => (
                  <MetricTile
                    key={card.key}
                    label={card.label}
                    metric={card.metric}
                    unit={card.unit}
                    asBar={card.asBar}
                    // 측정값에는 반드시 근거가 붙는다 — 근거 없는 0을 만들지 않는다.
                    hint={card.basis || undefined}
                  />
                ))}
              </div>
            </CardContent>
          </Card>
        </section>

        {/* ── 단계별 전환 퍼널 ──────────────────────────────────────────── */}
        <section aria-labelledby="funnel-heading">
          <Card>
            <CardHeader>
              <CardTitle id="funnel-heading" className="text-base">
                단계별 전환 퍼널
              </CardTitle>
              <CardDescription>
                소비자 가입 → 온보딩 → 장바구니 → 문의 → 상담 → 예약 → 계약. 막대는{" "}
                <strong>첫 단계 대비</strong> 길이입니다.{" "}
                <strong>같은 사람을 따라간 코호트가 아니라 기간 내 건수</strong>이므로, 석 달 전에
                가입한 사람이 이번 달에 예약하면 뒷 칸이 앞 칸보다 클 수 있습니다. 이탈 진단에
                그대로 쓰지 마세요.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <FunnelBars steps={payload.funnel} />
            </CardContent>
          </Card>
        </section>

        {/* ── 아직 못 세는 지표 ─────────────────────────────────────────── */}
        <section aria-labelledby="pending-heading">
          <Card>
            <CardHeader>
              <CardTitle id="pending-heading" className="text-base">
                아직 세지 못하는 지표
              </CardTitle>
              <CardDescription>
                <strong>이 칸을 비워 두지 않습니다.</strong> 비워 두면 다음 사람이 0을 넣고,
                0은 &apos;측정했더니 없었다&apos;로 읽힙니다. 어느 태스크가 채우는지 함께 적습니다.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" data-testid="pending-cards">
                {payload.pending.map((card) => (
                  <MetricTile key={card.key} label={card.label} metric={card.metric} unit={card.unit} />
                ))}
              </div>
            </CardContent>
          </Card>
        </section>
      </div>
    </AdminShell>
  );
}
