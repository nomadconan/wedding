import type { Metadata } from "next";
import Link from "next/link";

import { MetricTile } from "@/components/domain/MetricTile";
import { AdminShell } from "@/components/layout/AdminShell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import {
  ANOMALY_KIND_LABEL,
  ANOMALY_OPEN_ISSUE,
  NO_INDEX_NOTICE,
  THRESHOLD_UNDECIDED_NOTICE,
} from "@/lib/core/pricing/anomaly";
import { PRICE_INDEX_MIN_SAMPLE } from "@/lib/core/pricing/price-index";
import { measured, undecided } from "@/lib/core/stats/metric";
import { loadAnomalies, loadCurationCell, loadIndexCells } from "@/lib/pricing/curation";
import { requireOperator } from "@/lib/supabase/auth";

import { CurationPanel } from "./CurationPanel";
import { RecalculatePanel } from "./RecalculatePanel";

export const metadata: Metadata = {
  title: "가격 큐레이션 — 웨딩클리어",
};

/**
 * /admin/prices — 가격 큐레이션·이상 탐지 (F-A-02·F-A-14, §6.4 — 8단계 · S8-10)
 *
 * ── 이 화면이 지키는 규칙 ───────────────────────────────────────────────────
 * 1. **표본이 안 모인 구간을 "가격이 없다" 로 말하지 않는다.** 사분위가 없으면
 *    `측정 대상 없음` 과 표본 수를 함께 적는다 — 아직 세지 않은 것이지 시세가 0인 것이 아니다.
 * 2. **기준이 없으면 탐지하지 않는다**(O-19). §5.7 의 40%·25% 는 본문이 "(가정)" 이라
 *    밝힌 자리표시다. 없는 기준으로 업체를 의심 목록에 올리지 않는다.
 * 3. **탐지 결과는 판정이 아니라 큐다**(D-24). 자동 제재·자동 비공개가 없다 —
 *    운영자가 보고 정하고, 그 결정이 기록으로 남는다.
 * 4. **지워진 값은 왜 지워졌는지 답할 수 있다**(F-A-02). 제외에는 사유와 처리자가 필수다.
 * 5. **캐시하지 않는다**(FIX-22 계열).
 */
export const dynamic = "force-dynamic";

type PageProps = { searchParams: Promise<{ cell?: string }> };

export default async function AdminPricesPage({ searchParams }: PageProps) {
  await requireOperator("/admin/prices");

  const { cell: cellId } = await searchParams;

  let cells: Awaited<ReturnType<typeof loadIndexCells>>;
  let anomalies: Awaited<ReturnType<typeof loadAnomalies>>;
  try {
    [cells, anomalies] = await Promise.all([loadIndexCells(), loadAnomalies()]);
  } catch {
    return (
      <AdminShell role="admin" title="가격 큐레이션">
        <ErrorState
          code="PRICE_LOAD_FAILED"
          title="가격 데이터를 불러오지 못했어요"
          description="잠시 후 다시 시도해 주세요. 계속되면 운영 담당자에게 알려 주세요."
        />
      </AdminShell>
    );
  }

  const selected = cellId ? await loadCurationCell(cellId) : null;
  const withIndex = cells.filter((row) => row.p50 !== null).length;
  const blocked = anomalies.bait.status === "blocked" && anomalies.addon.status === "blocked";

  return (
    <AdminShell
      role="admin"
      title="가격 큐레이션"
      description="참가격 지수의 원천 데이터를 검증하고, 이상 신호를 큐로 봅니다."
    >
      <div className="space-y-6">
        {/* ── 지수 현황 ─────────────────────────────────────────────────── */}
        <section aria-labelledby="index-heading">
          <Card>
            <CardHeader>
              <CardTitle id="index-heading" className="text-base">
                참가격 지수 현황
              </CardTitle>
              <CardDescription>
                업체 {PRICE_INDEX_MIN_SAMPLE}곳이 모여야 사분위를 냅니다.{" "}
                <strong>표본이 안 모인 구간을 &apos;가격이 없다&apos;로 읽지 마세요</strong> —
                아직 세지 않은 것입니다. 업체당 한 건만 세므로 상품을 많이 올린 업체가 분포를
                지배하지 않습니다.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid gap-3 sm:grid-cols-3" data-testid="index-summary">
                <MetricTile
                  label="지수 칸"
                  metric={measured(cells.length)}
                  unit="개"
                  hint="지역·카테고리 조합"
                />
                <MetricTile
                  label="사분위가 나온 칸"
                  metric={measured(withIndex)}
                  unit="개"
                  hint={`업체 ${PRICE_INDEX_MIN_SAMPLE}곳 이상 모인 구간`}
                />
                <MetricTile
                  label="표본 부족"
                  metric={measured(cells.length - withIndex)}
                  unit="개"
                  hint="값을 만들지 않은 구간. 0원이 아니라 '아직 없음'입니다"
                />
              </div>

              {cells.length === 0 ? (
                <div className="mt-4">
                  <EmptyState
                    title="아직 지수 칸이 없어요"
                    description="공개된 상품이 있는 지역·카테고리에서 재계산을 돌리면 만들어집니다. 조회는 정상입니다."
                  />
                </div>
              ) : (
                <ul className="mt-4 space-y-2" data-testid="index-cells">
                  {cells.map((row) => (
                    <li
                      key={row.id}
                      className="rounded-md border border-border p-3"
                      data-testid="index-cell"
                      data-has-index={row.p50 !== null}
                    >
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <span className="flex items-center gap-2">
                          <span className="text-sm font-medium text-foreground">
                            {row.regionCode} · {row.category}
                          </span>
                          <Badge variant={row.p50 === null ? "outline" : "secondary"}>
                            {row.p50 === null ? "표본 부족" : "지수 있음"}
                          </Badge>
                        </span>
                        <Link
                          href={`/admin/prices?cell=${row.id}`}
                          className="text-caption font-medium text-brand-700 hover:underline"
                        >
                          원천 데이터 보기
                        </Link>
                      </div>
                      <p className="mt-1 text-caption text-muted-foreground">
                        {/* **표본이 모자라면 금액을 적지 않는다.** */}
                        {row.p50 === null
                          ? `표본 ${row.sampleSize ?? 0}곳 · 사분위를 만들지 않았습니다`
                          : `p25 ${row.p25?.toLocaleString("en-US")} · p50 ${row.p50.toLocaleString("en-US")} · p75 ${row.p75?.toLocaleString("en-US")}원 · 표본 ${row.sampleSize}곳`}
                        {row.collectedAt ? ` · 수집 ${row.collectedAt.slice(0, 10)}` : " · 수집일 없음"}
                        {row.sourceType ? ` · ${row.sourceType}` : " · 출처 미상"}
                      </p>
                    </li>
                  ))}
                </ul>
              )}

              <div className="mt-4">
                <RecalculatePanel />
              </div>
            </CardContent>
          </Card>
        </section>

        {/* ── 원천 데이터 (선택한 칸) ───────────────────────────────────── */}
        {selected ? (
          <section aria-labelledby="sources-heading">
            <Card>
              <CardHeader>
                <CardTitle id="sources-heading" className="text-base">
                  원천 데이터 · {selected.regionCode} · {selected.category}
                </CardTitle>
                <CardDescription>
                  <strong>지워진 값은 왜 지워졌는지 답할 수 있어야 합니다</strong> — 제외에는
                  사유와 처리자가 필수입니다(DB 제약이 한 번 더 봅니다). 아래 미리보기는 지금
                  제외 상태로 다시 셌을 때의 값입니다.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid gap-3 sm:grid-cols-3" data-testid="curation-preview">
                  <MetricTile
                    label="계산에 들어간 업체"
                    metric={measured(selected.preview.vendorCount)}
                    unit="곳"
                    hint={`하한 ${selected.preview.minSample}곳`}
                  />
                  <MetricTile
                    label="제외한 표본"
                    metric={measured(selected.preview.excludedCount)}
                    unit="건"
                    hint="사유가 기록돼 있습니다"
                  />
                  <MetricTile
                    label="다시 셌을 때 중앙값"
                    metric={
                      selected.preview.p50 === null
                        ? undecided(
                            selected.preview.blockedReason ?? "표본이 모자랍니다.",
                            "표본 부족",
                          )
                        : measured(selected.preview.p50)
                    }
                    unit="원"
                    hint={selected.preview.p50 === null ? undefined : "재계산을 눌러야 반영됩니다"}
                  />
                </div>

                {selected.sources.length === 0 ? (
                  <div className="mt-4">
                    <EmptyState
                      title="이 칸에는 원천 표본이 없어요"
                      description="재계산을 돌리면 공개된 상품의 등록가가 표본으로 쌓입니다."
                    />
                  </div>
                ) : (
                  <ul className="mt-4 space-y-2" data-testid="source-rows">
                    {selected.sources.map((source) => (
                      <li
                        key={source.id}
                        className="rounded-md border border-border p-3"
                        data-testid="source-row"
                        data-excluded={source.excludedReason !== null}
                      >
                        <div className="flex flex-wrap items-baseline justify-between gap-2">
                          <span className="flex items-center gap-2">
                            <Badge variant={source.excludedReason ? "outline" : "secondary"}>
                              {source.excludedReason ? "제외됨" : "계산에 포함"}
                            </Badge>
                            <span data-amount="" className="text-amount-sm text-foreground">
                              {source.rawValue.toLocaleString("en-US")}
                            </span>
                            <span className="text-unit text-muted-foreground">원</span>
                          </span>
                          <span className="text-caption text-muted-foreground">
                            {source.sourceName}
                          </span>
                        </div>
                        {source.excludedReason ? (
                          <p className="mt-1 text-caption text-muted-foreground">
                            제외 사유 · {source.excludedReason}
                          </p>
                        ) : null}
                        <CurationPanel
                          sourceId={source.id}
                          excluded={source.excludedReason !== null}
                        />
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </section>
        ) : null}

        {/* ── 이상 탐지 큐 ──────────────────────────────────────────────── */}
        <section aria-labelledby="anomaly-heading">
          <Card>
            <CardHeader>
              <CardTitle id="anomaly-heading" className="text-base">
                가격 이상 탐지 큐
              </CardTitle>
              <CardDescription>
                <strong>여기 오른 것은 판정이 아니라 &apos;봐 달라&apos;는 표시입니다.</strong>{" "}
                자동으로 제재하거나 비공개로 돌리지 않습니다 — 운영자가 보고 정하고 그 결정이
                기록으로 남습니다.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {blocked ? (
                <div data-testid="anomaly-blocked">
                  <MetricTile
                    label="이상 탐지"
                    metric={undecided(THRESHOLD_UNDECIDED_NOTICE, ANOMALY_OPEN_ISSUE)}
                    unit="건"
                  />
                  <p className="mt-2 text-caption text-muted-foreground">
                    명세 §5.7 이 적어 둔 40%·25% 는 본문이 <strong>&apos;(가정)&apos;</strong>이라
                    밝힌 자리표시입니다. 표본이 쌓인 뒤 {ANOMALY_OPEN_ISSUE}가 값을 정하면 같은
                    큐가 그대로 돕니다.
                  </p>
                </div>
              ) : anomalies.flags.length === 0 ? (
                <EmptyState
                  title="지금 올라온 이상 신호가 없어요"
                  description="임계값 기준으로 검사했고 걸린 건이 없습니다. 탐지는 정상 동작 중입니다."
                />
              ) : (
                <ol className="space-y-3" data-testid="anomaly-queue">
                  {anomalies.flags.map((flag) => (
                    <li
                      key={`${flag.kind}-${flag.targetId}`}
                      className="rounded-lg border border-border p-4"
                      data-testid="anomaly-flag"
                      data-kind={flag.kind}
                    >
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <span className="flex items-center gap-2">
                          <Badge variant="secondary">{ANOMALY_KIND_LABEL[flag.kind]}</Badge>
                          <span className="text-sm font-medium text-foreground">
                            {Math.round(flag.gapBp / 100)}% (임계 {Math.round(flag.thresholdBp / 100)}%)
                          </span>
                        </span>
                        <span className="text-caption text-muted-foreground">
                          {flag.targetType} · {flag.targetId.slice(0, 8)}
                        </span>
                      </div>
                      <p className="mt-1 text-caption text-muted-foreground">{flag.basis}</p>
                    </li>
                  ))}
                </ol>
              )}

              {anomalies.bait.status === "blocked" &&
              anomalies.bait.blocked.reason === "no_index" ? (
                <p className="mt-3 text-caption text-muted-foreground">{NO_INDEX_NOTICE}</p>
              ) : null}
            </CardContent>
          </Card>
        </section>
      </div>
    </AdminShell>
  );
}
