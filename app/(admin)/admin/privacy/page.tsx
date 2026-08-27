import type { Metadata } from "next";

import { MetricTile } from "@/components/domain/MetricTile";
import { AdminShell } from "@/components/layout/AdminShell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import {
  DELETION_SCOPE_LABEL,
  DELETION_STATUS_LABEL,
  isTerminal,
} from "@/lib/core/privacy/deletion";
import { dateTimeAttr, formatTimestamp } from "@/lib/core/format/timestamp";
import { measured, notYet, undecided } from "@/lib/core/stats/metric";
import { loadPrivacyAudit } from "@/lib/privacy/audit";
import { requireOperator } from "@/lib/supabase/auth";

import { ResolvePanel } from "./ResolvePanel";

export const metadata: Metadata = {
  title: "개인정보 감사 — 웨딩클리어",
};

/**
 * /admin/privacy — 개인정보 감사 (F-A-08, §6.4 — 8단계 · S8-04)
 *
 * §7.3 이 요구하는 넷을 한 화면에 세운다: **파기 배치 이력 · 파기 실패·잔존 건 경보 ·
 * 삭제 요청 SLA 추적 · 마스킹 실패 로그**.
 *
 * ── 이 화면이 지키는 규칙 ───────────────────────────────────────────────────
 * 1. **문서를 행으로 보여주지 않는다.** `storage_path` 가 §5.3 의 금지 항목이라
 *    집계만 낸다(`admin_purge_audit()`). 운영자가 알아야 하는 것은 "몇 건이 밀렸나"
 *    이고 지우는 것은 사람이 아니라 배치다.
 * 2. **기준이 없으면 판정하지 않는다.** 삭제 요청 처리 기한은 **O-18 미결**이라
 *    경과 시간만 보여주고 '지연' 이라 적지 않는다. 지어낸 기한은 곧 운영 기준으로 굳는다.
 * 3. **0 에 근거를 붙인다.** '잔존 0건' 과 '배치가 한 번도 안 돌았다' 는 다른 사실이라
 *    후자는 경보로 뜬다.
 * 4. **캐시하지 않는다**(FIX-22 계열).
 */
export const dynamic = "force-dynamic";

function shortId(id: string | null): string {
  return id ? id.slice(0, 8) : "—";
}

export default async function AdminPrivacyPage() {
  await requireOperator("/admin/privacy");

  let payload: Awaited<ReturnType<typeof loadPrivacyAudit>>;
  try {
    payload = await loadPrivacyAudit(new Date());
  } catch {
    return (
      <AdminShell role="admin" title="개인정보 감사">
        <ErrorState
          code="PRIVACY_LOAD_FAILED"
          title="감사 정보를 불러오지 못했어요"
          description="잠시 후 다시 시도해 주세요. 계속되면 운영 담당자에게 알려 주세요."
        />
      </AdminShell>
    );
  }

  const { audit, alerts, runs, requests, slaLimitHours } = payload;
  const open = requests.filter((row) => !isTerminal(row.status));

  return (
    <AdminShell
      role="admin"
      title="개인정보 감사"
      description="원문 파기·삭제 요청·마스킹 차단을 한 화면에서 봅니다."
    >
      <div className="space-y-6">
        {/* ── 경보 ──────────────────────────────────────────────────────── */}
        <section aria-labelledby="alerts-heading">
          <Card>
            <CardHeader>
              <CardTitle id="alerts-heading" className="text-base">
                경보
              </CardTitle>
              <CardDescription>
                <strong>&apos;잔존 0건&apos;과 &apos;배치가 한 번도 안 돌았다&apos;는 다른
                사실입니다.</strong> 뒤쪽도 경보로 뜹니다 — 아무 일도 안 일어나는 것이 정상처럼
                보이는 것이 이 화면에서 가장 나쁜 실패입니다.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {alerts.length === 0 ? (
                <EmptyState
                  title="지금 올라온 경보가 없어요"
                  description="파기 기한을 넘긴 원문이 없고, 마지막 배치도 정상으로 끝났습니다."
                />
              ) : (
                <ul className="space-y-2" data-testid="privacy-alerts">
                  {alerts.map((alert) => (
                    <li
                      key={alert.code}
                      className="rounded-md border border-border p-3"
                      data-testid="privacy-alert"
                      data-code={alert.code}
                      data-severity={alert.severity}
                    >
                      <span className="flex items-center gap-2">
                        <Badge variant={alert.severity === "critical" ? "destructive" : "secondary"}>
                          {alert.severity === "critical" ? "즉시 확인" : "주의"}
                        </Badge>
                        <span className="text-sm font-medium text-foreground">{alert.message}</span>
                      </span>
                      <p className="mt-1 text-caption text-muted-foreground">{alert.action}</p>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </section>

        {/* ── 파기 현황 ─────────────────────────────────────────────────── */}
        <section aria-labelledby="purge-heading">
          <Card>
            <CardHeader>
              <CardTitle id="purge-heading" className="text-base">
                원문 파기 현황
              </CardTitle>
              <CardDescription>
                업로드 원문은 분석 뒤 <strong>24시간 내 파기</strong>합니다(§5.1).{" "}
                <strong>문서를 한 건씩 보여주지 않습니다</strong> — 저장 경로는 어떤 화면에도
                남기지 않기로 한 값이라(§5.3) 개수와 경과 시간만 냅니다.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" data-testid="purge-tiles">
                <MetricTile
                  label="파기 완료"
                  metric={measured(audit.purged)}
                  unit="건"
                  hint={`전체 문서 ${audit.documentsTotal.toLocaleString("en-US")}건 중`}
                />
                <MetricTile
                  label="잔존 (기한 초과)"
                  metric={measured(audit.overdue)}
                  unit="건"
                  hint="파기 예정 시각이 지났는데 아직 남아 있는 원문"
                />
                <MetricTile
                  label="파기 예정"
                  metric={measured(audit.scheduled)}
                  unit="건"
                  hint="아직 기한 전입니다. 잔존과 섞지 않습니다"
                />
                <MetricTile
                  label="가장 오래 밀린 건"
                  // **밀린 것이 없으면 0시간이 아니다.** 0시간은 "방금 밀리기
                  // 시작했다" 는 뜻이라 "밀린 것이 없다" 와 겹쳐 읽힌다(D-108).
                  metric={
                    audit.oldestOverdueHours === null
                      ? notYet("기한을 넘긴 원문이 없습니다.", "—")
                      : measured(audit.oldestOverdueHours)
                  }
                  unit="시간"
                  hint={audit.oldestOverdueHours === null ? undefined : "경과 시간"}
                />
              </div>

              <div className="mt-3 grid gap-3 sm:grid-cols-2" data-testid="masking-tiles">
                <MetricTile
                  label="마스킹 차단 (최근 24시간)"
                  metric={measured(audit.maskingFailures24h)}
                  unit="건"
                  hint="마스킹이 끝나지 않아 AI 호출을 중단한 건. 차단은 정상 동작입니다(§5.2)"
                />
                <MetricTile
                  label="마스킹 차단 (누적)"
                  metric={measured(audit.maskingFailures)}
                  unit="건"
                  hint="같은 유형이 반복되면 마스킹 패턴을 점검합니다"
                />
              </div>
            </CardContent>
          </Card>
        </section>

        {/* ── 배치 이력 ─────────────────────────────────────────────────── */}
        <section aria-labelledby="runs-heading">
          <Card>
            <CardHeader>
              <CardTitle id="runs-heading" className="text-base">
                파기 배치 이력
              </CardTitle>
              <CardDescription>
                오류 요약에는 <strong>사유별 개수만</strong> 담습니다 — 실패한 문서의 경로를
                적으면 그 로그가 곧 <strong>남아 있는 원문의 위치 목록</strong>이 됩니다.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {runs.length === 0 ? (
                <EmptyState
                  title="실행 이력이 없어요"
                  description="파기 배치가 아직 한 번도 돌지 않았습니다. 스케줄 등록을 확인해 주세요."
                />
              ) : (
                <ol className="space-y-2" data-testid="purge-runs">
                  {runs.map((run) => (
                    <li
                      key={run.id}
                      className="rounded-md border border-border p-3"
                      data-testid="purge-run"
                      data-status={run.status}
                    >
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <span className="flex items-center gap-2">
                          <Badge variant={run.status === "failed" ? "destructive" : "secondary"}>
                            {run.status === "failed"
                              ? "실패"
                              : run.status === "running"
                                ? "실행 중"
                                : "성공"}
                          </Badge>
                          <span className="text-sm text-foreground">
                            처리 {(run.processedCount ?? 0).toLocaleString("en-US")}건
                          </span>
                        </span>
                        <time className="text-caption text-muted-foreground" dateTime={dateTimeAttr(run.startedAt)}>
                          {formatTimestamp(run.startedAt)}
                        </time>
                      </div>
                      {run.errorSummary ? (
                        <p className="mt-1 text-caption text-danger">오류 {run.errorSummary}</p>
                      ) : null}
                    </li>
                  ))}
                </ol>
              )}
            </CardContent>
          </Card>
        </section>

        {/* ── 삭제 요청 SLA ─────────────────────────────────────────────── */}
        <section aria-labelledby="requests-heading">
          <Card>
            <CardHeader>
              <CardTitle id="requests-heading" className="text-base">
                삭제 요청 처리 ({open.length}건 대기)
              </CardTitle>
              <CardDescription>
                오래된 것부터입니다. 사유·범위별 가중치를 두지 않습니다 — 무엇이 더 급한지는
                운영 정책이지 코드의 판단이 아닙니다.{" "}
                {slaLimitHours === null ? (
                  <strong>
                    처리 기한이 아직 정해지지 않아(O-18) 경과 시간만 보여주고 지연 판정을 하지
                    않습니다.
                  </strong>
                ) : (
                  <>처리 기한은 {slaLimitHours}시간입니다.</>
                )}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {slaLimitHours === null ? (
                <div className="mb-4">
                  <MetricTile
                    label="처리 기한(SLA)"
                    metric={undecided(
                      "계정·데이터 삭제 요청의 법정 처리 기한은 관할·근거법 소관이라 코드가 고르지 않습니다. 값이 정해지면 같은 목록에서 그대로 판정합니다.",
                      "O-18",
                    )}
                    unit="시간"
                  />
                </div>
              ) : null}

              {requests.length === 0 ? (
                <EmptyState
                  title="접수된 삭제 요청이 없어요"
                  description="마이페이지에서 접수되면 여기에 쌓입니다. 조회는 정상입니다."
                />
              ) : (
                <ol className="space-y-3" data-testid="deletion-requests">
                  {requests.map((row) => (
                    <li
                      key={row.id}
                      className="rounded-lg border border-border p-4"
                      data-testid="deletion-request"
                      data-status={row.status}
                      data-sla={row.sla.status}
                    >
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <span className="flex items-center gap-2">
                          <Badge variant={isTerminal(row.status) ? "outline" : "secondary"}>
                            {DELETION_STATUS_LABEL[row.status]}
                          </Badge>
                          <span className="text-sm font-medium text-foreground">
                            {DELETION_SCOPE_LABEL[row.scope] ?? row.scope}
                          </span>
                        </span>
                        <time className="text-caption text-muted-foreground" dateTime={row.requestedAt}>
                          {formatTimestamp(row.requestedAt)}
                        </time>
                      </div>

                      <p className="mt-1 text-caption text-muted-foreground">
                        요청자 {shortId(row.userId)} · 접수 후 {row.sla.elapsedHours}시간 경과
                        {row.sla.status === "unknown" ? (
                          <> · <strong>기준 미확정({row.sla.openIssue})</strong></>
                        ) : row.sla.status === "overdue" ? (
                          <> · <span className="text-danger">기한 {row.sla.overHours}시간 초과</span></>
                        ) : (
                          <> · {row.sla.remainingHours}시간 남음</>
                        )}
                      </p>

                      {row.resolutionReason ? (
                        <p className="mt-1.5 text-sm text-foreground">
                          <span className="text-muted-foreground">처리 사유 · </span>
                          {row.resolutionReason}
                          {row.resolvedBy ? (
                            <span className="text-muted-foreground">
                              {" "}
                              ({shortId(row.resolvedBy)})
                            </span>
                          ) : null}
                        </p>
                      ) : null}

                      <ResolvePanel requestId={row.id} status={row.status} />
                    </li>
                  ))}
                </ol>
              )}
            </CardContent>
          </Card>
        </section>
      </div>
    </AdminShell>
  );
}
