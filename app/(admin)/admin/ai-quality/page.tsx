import type { Metadata } from "next";

import { MetricTile } from "@/components/domain/MetricTile";
import { AdminShell } from "@/components/layout/AdminShell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { dateTimeAttr, formatTimestamp } from "@/lib/core/format/timestamp";
import { VALIDATION_RESULT_LABEL, type Ratio } from "@/lib/core/quality/metrics";
import {
  FINDING_REPORT_STATUS_LABEL,
  REVIEW_VERDICT_LABEL,
  type ReviewVerdict,
} from "@/lib/core/quality/review";
import { measured, noBasis, undecided } from "@/lib/core/stats/metric";
import { AI_FEATURE_LABEL, loadQualityConsole } from "@/lib/quality/admin";
import { requireOperator } from "@/lib/supabase/auth";

import { ReviewPanel } from "./ReviewPanel";

export const metadata: Metadata = {
  title: "AI 품질·비용 — 웨딩클리어",
};

/**
 * /admin/ai-quality — AI 품질·비용 관리 (F-A-04, §6.4 · §5.8 — 8단계 · S8-07)
 *
 * ── 이 화면이 지키는 규칙 ───────────────────────────────────────────────────
 * 1. **측정값과 목표를 같은 얼굴로 그리지 않는다.** §5.8 표의 열 제목이 '목표(가정)'
 *    이고 문서 머리글이 "'(가정)' 표기 항목은 검증 전 목표치" 라고 적는다. 목표는
 *    **'가정' 이라는 말과 함께** 옆에 적고, **'초과'·'미달' 판정을 만들지 않는다** —
 *    가정치로 낸 판정은 곧 운영 기준으로 굳는다(D-123 이 물린 자리).
 * 2. **부르지 않은 것은 실패가 아니다.** 키가 없거나 상한에 막힌 호출을 실패율
 *    분모에 넣으면 로컬에서 실패율이 100% 가 되고, 스키마가 실제로 깨진 날과
 *    구분되지 않는다.
 * 3. **0건과 '안 셌다' 와 '그런 호출이 없다' 를 가른다**(함정 2). 기능 목록은 로그가
 *    없어도 남고, 계측 여부와 'AI 를 쓰지 않는 기능' 을 각각 적는다.
 * 4. **비용은 단가가 없으면 만들지 않는다**(O-21). 0원은 "비용이 없었다" 로 읽힌다.
 * 5. **검수 큐를 5% 로 자르지 않는다.** 5%는 가정치이고, 그 값으로 큐를 자르면
 *    가정이 작업 지시가 된다. 큐는 전부이고 5%는 달성률의 기준선으로만 쓴다.
 * 6. **`findings` 를 열지 않는다** — 조항 인용이 들어 있고, 마스킹본이라도 운영자가
 *    남의 계약 조항을 통째로 읽을 이유가 없다(0059).
 * 7. **캐시하지 않는다**(FIX-22 계열).
 */
export const dynamic = "force-dynamic";

/** 비율 한 칸을 타일로. **분모가 0이면 0% 가 아니라 근거 없음이다.** */
function ratioTile(label: string, ratio: Ratio, targetLabel: string, hint: string) {
  return (
    <MetricTile
      label={label}
      metric={
        ratio.bp === null
          ? noBasis(hint, `${ratio.denominator}건`)
          : measured(Math.round(ratio.bp / 100))
      }
      unit="%"
      hint={`${ratio.numerator} / ${ratio.denominator}건 · 목표 ${targetLabel}(가정)`}
    />
  );
}

export default async function AdminAiQualityPage() {
  await requireOperator("/admin/ai-quality");

  let payload: Awaited<ReturnType<typeof loadQualityConsole>>;
  try {
    payload = await loadQualityConsole(new Date());
  } catch {
    return (
      <AdminShell role="admin" title="AI 품질·비용">
        <ErrorState
          code="AI_QUALITY_LOAD_FAILED"
          title="품질 지표를 불러오지 못했어요"
          description="잠시 후 다시 시도해 주세요. 계속되면 운영 담당자에게 알려 주세요."
        />
      </AdminShell>
    );
  }

  const { summary, progress, queue, reports, ruleCounts, featuresWithoutCalls } = payload;
  const openReports = reports.filter((row) => row.status === "open");
  const pendingQueue = queue.filter((row) => row.reviews.length === 0);

  return (
    <AdminShell
      role="admin"
      title="AI 품질·비용"
      description={`최근 ${summary.windowDays}일 · 호출 ${summary.totalCalls}건`}
    >
      <div className="space-y-6">
        {/* ── §5.8 지표 넷 ──────────────────────────────────────────────── */}
        <section aria-labelledby="metrics-heading">
          <Card>
            <CardHeader>
              <CardTitle id="metrics-heading" className="text-base">
                품질 지표
              </CardTitle>
              <CardDescription>
                <strong>목표는 전부 명세가 &apos;(가정)&apos;이라 밝힌 값입니다.</strong> 측정값
                옆에 함께 적되 초과·미달을 판정하지 않습니다 — 가정치로 낸 판정은 곧 운영
                기준으로 굳습니다.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {ratioTile(
                  "zod 검증 실패율",
                  summary.validationFailure,
                  summary.targets.validationFailureBp.label,
                  "실제로 호출한 건이 없어 실패율을 낼 수 없습니다.",
                )}
                {ratioTile(
                  "인용 대조 폐기율",
                  summary.discard,
                  summary.targets.discardBp.label,
                  "모델이 만들어 낸 항목이 없어 폐기율을 낼 수 없습니다.",
                )}
                <MetricTile
                  label="리포트 처리 시간 p95"
                  metric={
                    summary.latencyP95Ms === null
                      ? noBasis("지연이 기록된 호출이 없습니다.", "0건")
                      : measured(Math.round(summary.latencyP95Ms / 1_000))
                  }
                  unit="초"
                  hint={`표본 ${summary.latencySamples}건 · 목표 ${summary.targets.latencyP95Ms.label}(가정) · 보간하지 않습니다`}
                />
                <MetricTile
                  label="건당 AI 비용"
                  metric={
                    summary.cost.status === "blocked"
                      ? undecided(
                          "토큰 단가가 정해지지 않아 금액을 계산하지 않습니다.",
                          summary.cost.openIssue,
                        )
                      : measured(
                          summary.cost.calls === 0
                            ? 0
                            : Math.round(summary.cost.krw / summary.cost.calls),
                        )
                  }
                  unit="원"
                  hint={`입력 ${summary.cost.tokenIn.toLocaleString("ko-KR")} · 출력 ${summary.cost.tokenOut.toLocaleString("ko-KR")} 토큰`}
                />
              </div>

              {summary.cost.status === "blocked" ? (
                <p className="rounded-md border border-border bg-muted p-3 text-caption text-muted-foreground">
                  <strong>&apos;비용 0원&apos;이 아니라 &apos;단가를 모름&apos;입니다.</strong>{" "}
                  토큰은 실측으로 쌓이고 있고 단가만 비어 있습니다({summary.cost.openIssue}).
                  모델·계약·환율에 따라 달라지는 값이라 코드가 고르지 않습니다 — 지어낸 단가로
                  낸 금액은 곧 예산 근거로 쓰이고, 그때 그 숫자가 어디서 왔는지 아무도 답할 수
                  없습니다.
                </p>
              ) : null}

              <p className="text-caption text-muted-foreground">
                호출 {summary.totalCalls}건 중 <strong>{summary.notAttempted}건은 부르지
                않았습니다</strong> (키 없음·넘길 것 없음·마스킹 차단·상한 도달). 실패가 아니라
                시도가 아니므로 실패율 분모에서 빠집니다.
              </p>
            </CardContent>
          </Card>
        </section>

        {/* ── 기능별 ────────────────────────────────────────────────────── */}
        <section aria-labelledby="feature-heading">
          <Card>
            <CardHeader>
              <CardTitle id="feature-heading" className="text-base">
                기능별
              </CardTitle>
              <CardDescription>
                <strong>0건과 &apos;안 셌다&apos;와 &apos;그런 호출이 없다&apos;는 다른
                사실입니다.</strong> 로그가 없는 기능도 목록에 남습니다.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="space-y-2">
                {summary.byFeature.map((row) => {
                  const noCalls = featuresWithoutCalls.includes(row.feature);

                  return (
                    <li
                      key={row.feature}
                      className="flex flex-wrap items-center gap-2 rounded-md border border-border p-3"
                    >
                      <span className="font-medium text-foreground">
                        {AI_FEATURE_LABEL[row.feature] ?? row.feature}
                      </span>
                      {noCalls ? (
                        <Badge variant="outline">AI 를 쓰지 않는 기능</Badge>
                      ) : row.instrumented ? (
                        <Badge variant="secondary">
                          시도 {row.attempted}건 · 실패 {row.failed}건
                          {row.failureRate.bp === null
                            ? ""
                            : ` (${Math.round(row.failureRate.bp / 100)}%)`}
                        </Badge>
                      ) : (
                        <Badge variant="default">기록 없음 — 아직 호출된 적이 없습니다</Badge>
                      )}
                    </li>
                  );
                })}
              </ul>
            </CardContent>
          </Card>
        </section>

        {/* ── 샘플 검수 큐 ──────────────────────────────────────────────── */}
        <section aria-labelledby="queue-heading">
          <Card>
            <CardHeader>
              <CardTitle id="queue-heading" className="text-base">
                샘플 검수 {progress.reviewed}/{progress.completedAnalyses}건
              </CardTitle>
              <CardDescription>
                <strong>큐를 5%로 자르지 않았습니다.</strong> 5%는 명세가 가정이라 밝힌
                목표치이고, 그 값으로 큐를 자르면 가정이 작업 지시가 됩니다. 아래는 아직
                검수되지 않은 분석 전부이고, 목표는 기준선으로만 적습니다 —{" "}
                <strong>목표 {progress.targetBp / 100}%(가정) 기준 {progress.targetCount}건</strong>.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="mb-3 grid gap-3 sm:grid-cols-3">
                <MetricTile label="완료된 분석" metric={measured(progress.completedAnalyses)} unit="건" />
                <MetricTile
                  label="검수율"
                  metric={
                    progress.reviewedBp === null
                      ? noBasis("완료된 분석이 없습니다.", "0건")
                      : measured(Math.round(progress.reviewedBp / 100))
                  }
                  unit="%"
                />
                <MetricTile label="검수 대기" metric={measured(progress.pending)} unit="건" />
              </div>

              {pendingQueue.length === 0 ? (
                <EmptyState
                  title={
                    progress.completedAnalyses === 0
                      ? "아직 완료된 분석이 없습니다"
                      : "검수 대기가 없습니다"
                  }
                  description="계약서 분석이 완료되면 여기에 쌓입니다. 조항 인용은 이 화면에 실리지 않습니다."
                />
              ) : (
                <ul className="space-y-3">
                  {queue.map((row) => (
                    <li key={row.analysisId} className="rounded-lg border border-border p-4">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-caption text-muted-foreground">
                          {row.analysisId.slice(0, 8)}
                        </span>
                        {row.riskScore !== null ? (
                          <Badge variant="outline">위험 점수 {row.riskScore}</Badge>
                        ) : null}
                        {row.reviews.length > 0 ? (
                          <Badge variant="secondary">
                            검수됨 ·{" "}
                            {REVIEW_VERDICT_LABEL[row.reviews[0].verdict as ReviewVerdict] ??
                              row.reviews[0].verdict}
                          </Badge>
                        ) : (
                          <Badge variant="default">검수 대기</Badge>
                        )}
                      </div>

                      <p className="mt-2 text-caption text-muted-foreground">
                        룰 {row.ruleVersion ?? "판본 없음"} · 프롬프트{" "}
                        {row.promptVersion ?? "판본 없음"} · {row.model ?? "모델 미사용"}
                        {row.latencyMs === null ? "" : ` · ${Math.round(row.latencyMs / 1_000)}초`}
                        {" · "}
                        <time dateTime={dateTimeAttr(row.createdAt)}>
                          {formatTimestamp(row.createdAt)}
                        </time>
                      </p>

                      {row.reviews.map((review) => (
                        <p
                          key={review.reviewerId}
                          className="mt-2 rounded-md bg-muted p-2 text-sm text-foreground"
                        >
                          {REVIEW_VERDICT_LABEL[review.verdict as ReviewVerdict] ?? review.verdict}{" "}
                          — {review.note}
                        </p>
                      ))}

                      <ReviewPanel
                        kind="analysis"
                        analysisId={row.analysisId}
                        current={
                          row.reviews.length > 0
                            ? { verdict: row.reviews[0].verdict, note: row.reviews[0].note }
                            : null
                        }
                      />
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </section>

        {/* ── 오탐 신고 ─────────────────────────────────────────────────── */}
        <section aria-labelledby="reports-heading">
          <Card>
            <CardHeader>
              <CardTitle id="reports-heading" className="text-base">
                오탐 신고 · 처리 대기 {openReports.length}건
              </CardTitle>
              <CardDescription>
                <strong>판정 대상은 사용자가 아니라 우리 룰입니다.</strong> 받아들이면 &apos;룰을
                손볼 자리&apos;로 남고, 받아들이지 않으면 &apos;지금 룰대로 나온 결과&apos;로
                남습니다. 룰을 고치는 것은 배포로 하며 그 콘솔은 F-A-03(S8-06) 몫입니다.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {ruleCounts.length > 0 ? (
                <div>
                  <p className="text-caption font-medium text-foreground">룰별 누적</p>
                  <ul className="mt-1 flex flex-wrap gap-2">
                    {ruleCounts.map((row) => (
                      <li key={row.ruleCode}>
                        <Badge variant="outline">
                          {row.ruleCode} · 받음 {row.upheld} / 대기 {row.open} / 전체 {row.total}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {reports.length === 0 ? (
                <EmptyState
                  title="접수된 오탐 신고가 없습니다"
                  description="리포트 화면에서 사용자가 '이 항목이 잘못됐어요'를 누르면 여기에 쌓입니다."
                />
              ) : (
                <ul className="space-y-3">
                  {reports.map((row) => (
                    <li key={row.id} className="rounded-lg border border-border p-4">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="outline">{row.ruleCode}</Badge>
                        <span className="text-sm text-foreground">{row.reasonLabel}</span>
                        <Badge
                          variant={row.status === "open" ? "default" : "secondary"}
                        >
                          {FINDING_REPORT_STATUS_LABEL[
                            row.status as keyof typeof FINDING_REPORT_STATUS_LABEL
                          ] ?? row.status}
                        </Badge>
                        {row.findingId === null ? (
                          <span className="text-caption text-muted-foreground">
                            원본 항목은 재분석·문서 삭제로 사라졌습니다 (룰 코드는 남습니다)
                          </span>
                        ) : null}
                      </div>

                      {row.resolutionNote ? (
                        <p className="mt-2 text-caption text-muted-foreground">
                          처리 — {row.resolutionNote}
                        </p>
                      ) : null}

                      <p className="mt-2 text-caption text-muted-foreground">
                        <time dateTime={dateTimeAttr(row.createdAt)}>
                          {formatTimestamp(row.createdAt)}
                        </time>
                      </p>

                      {row.status === "open" ? (
                        <ReviewPanel kind="report" reportId={row.id} />
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </section>

        {/* ── 검증 결과 어휘 ────────────────────────────────────────────── */}
        <section aria-labelledby="vocab-heading">
          <Card>
            <CardHeader>
              <CardTitle id="vocab-heading" className="text-base">
                검증 결과가 뜻하는 것
              </CardTitle>
              <CardDescription>
                어휘는 코드가 갖고 DB CHECK 이 강제합니다 — 오타가 섞이면 실패율이 조용히
                틀립니다.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="space-y-0.5">
                {Object.entries(VALIDATION_RESULT_LABEL).map(([code, label]) => (
                  <li key={code} className="text-caption text-muted-foreground">
                    <span className="font-mono">{code}</span> — {label}
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </section>
      </div>
    </AdminShell>
  );
}
