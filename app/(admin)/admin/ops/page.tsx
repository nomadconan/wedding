import type { Metadata } from "next";
import Link from "next/link";

import { MetricTile } from "@/components/domain/MetricTile";
import { AdminShell } from "@/components/layout/AdminShell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { dateTimeAttr, formatTimestamp } from "@/lib/core/format/timestamp";
import { BATCH_STATE_HINT, BATCH_STATE_LABEL } from "@/lib/core/ops/monitor";
import { READINESS_ALL_SET, READINESS_NOTICE } from "@/lib/core/ops/readiness";
import { measured } from "@/lib/core/stats/metric";
import { loadOpsConsole } from "@/lib/ops/admin";
import { requireOperator } from "@/lib/supabase/auth";

export const metadata: Metadata = {
  title: "운영 상태 — 웨딩클리어",
};

/**
 * /admin/ops — 모니터링·장애 대응 (§7.4 · S8-13 · **§6.4 신설 제안**)
 *
 * ── 이 화면이 지키는 규칙 ───────────────────────────────────────────────────
 * 1. **"만들었다"·"돈다"·"돌았다" 를 한 얼굴로 그리지 않는다.** 넷으로 갈라 적는다 —
 *    특히 '등록 안 됨' 과 '실행 기록 없음' 은 할 일이 다르다(설정 / 배포·인증).
 * 2. **측정하지 않은 것을 0으로 쓰지 않는다.** 로그인 실패는 클라이언트 신고분만
 *    보이며(FIX-32) 그 문장을 화면이 그대로 적는다.
 * 3. **경보를 보내는 시늉을 하지 않는다**(D-147). 외부 발송이 스텁이라(D-28) 보내면
 *    "경보가 안 온 것" 과 "스텁이라 안 온 것" 이 구분되지 않는다.
 * 4. **집행할 수 없는 조치를 만들지 않는다**(D-143). 여기서 배치를 손으로 돌리는
 *    버튼을 두지 않았다 — 실행 인증이 서버 비밀키라 브라우저가 부를 수 없고, 부를 수
 *    있게 만들면 그 키가 클라이언트로 나온다(§5.4).
 * 5. **캐시하지 않는다.** 장애 화면이 5분 전 상태를 보이면 장애 화면이 아니다.
 */
export const dynamic = "force-dynamic";

export default async function AdminOpsPage() {
  await requireOperator("/admin/ops");

  let payload: Awaited<ReturnType<typeof loadOpsConsole>>;
  try {
    payload = await loadOpsConsole(new Date());
  } catch {
    return (
      <AdminShell role="admin" title="운영 상태">
        <ErrorState
          code="OPS_LOAD_FAILED"
          title="운영 상태를 불러오지 못했어요"
          description="잠시 후 다시 시도해 주세요. 계속되면 운영 담당자에게 알려 주세요."
        />
      </AdminShell>
    );
  }

  const {
    batches,
    alerts,
    readiness,
    purgeOverdue,
    loginFailures,
    loginWindowHours,
    loginObservability,
    alertDelivery,
    cronSecretConfigured,
    observedAt,
  } = payload;

  const running = batches.filter((batch) => batch.state === "ran").length;
  const loginTotal = loginFailures.reduce((sum, row) => sum + row.count, 0);

  return (
    <AdminShell
      role="admin"
      title="운영 상태"
      description="배치가 실제로 도는지, 무엇이 실패했는지. 경보는 이 화면까지입니다."
    >
      <div className="space-y-6">
        {/* ── 경보 ──────────────────────────────────────────────────────── */}
        <section aria-labelledby="alerts-heading">
          <Card>
            <CardHeader>
              <CardTitle id="alerts-heading" className="text-base">
                경보 {alerts.length}건
              </CardTitle>
              <CardDescription data-testid="ops-delivery-note">
                <strong>경보는 발송되지 않습니다.</strong> {alertDelivery.reason}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {alerts.length === 0 ? (
                <EmptyState
                  title="지금 올라온 경보가 없습니다"
                  description="배치 상태와 파기 잔존, 인프라 계열 로그인 실패에서 계산합니다. 저장하지 않고 볼 때마다 다시 셉니다."
                />
              ) : (
                <ul className="space-y-2">
                  {alerts.map((alert) => (
                    <li
                      key={alert.key}
                      className="rounded-lg border border-border p-3"
                      data-testid="ops-alert"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant={alert.severity === "critical" ? "default" : "outline"}>
                          {alert.severity === "critical" ? "즉시" : "확인"}
                        </Badge>
                        <span className="font-medium text-foreground">{alert.title}</span>
                      </div>
                      <p className="mt-1 text-caption text-muted-foreground">{alert.detail}</p>
                      {alert.href !== null ? (
                        <Link href={alert.href} className="text-caption underline">
                          관련 화면 열기
                        </Link>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </section>

        {/* ── 오픈 준비 (FIX-11) ────────────────────────────────────────
            **첫 거래가 실패하기 전에 말한다.** 요율이 0행이면 계약 발행이 통째로
            막히는데(CONTRACT_RATE_UNRESOLVED) 그 사실을 아는 자리가 없었다 —
            업체는 "운영자에게 문의해 주세요" 를 보고, 운영자는 문의를 받을 때까지
            몰랐다. 재현해 확인했다: 요율을 없애도 `job_runs`·`client_events`
            어디에도 신호가 없다. */}
        <section aria-labelledby="readiness-heading">
          <Card>
            <CardHeader>
              <CardTitle id="readiness-heading" className="text-base">
                오픈 준비
              </CardTitle>
              <CardDescription>{READINESS_NOTICE}</CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="space-y-2" data-testid="ops-readiness">
                {readiness.map((row) => (
                  <li
                    key={row.key}
                    className="flex flex-wrap items-start justify-between gap-2 rounded-lg border border-border p-3 text-sm"
                  >
                    <div className="min-w-0 space-y-1">
                      <p className="font-medium text-foreground">
                        {row.label}{" "}
                        <Badge variant={row.ready ? "secondary" : "destructive"}>
                          {row.ready ? `${row.liveCount}건` : "없음"}
                        </Badge>
                      </p>
                      {/* **갖춰졌을 때는 결과를 말하지 않는다** — 없을 때만 무슨 일이
                          나는지 적는다. 늘 적으면 경고가 배경이 된다. */}
                      {row.ready ? null : (
                        <p className="text-caption text-neutral-600">{row.consequence}</p>
                      )}
                      {row.openIssue ? (
                        <p className="text-caption text-neutral-500">
                          값은 운영 결정입니다({row.openIssue}) — 이 화면이 고르지 않습니다.
                        </p>
                      ) : null}
                    </div>
                    <Link href={row.href} className="text-caption font-medium text-brand-600">
                      값 넣기
                    </Link>
                  </li>
                ))}
              </ul>
              {readiness.every((row) => row.ready) ? (
                <p className="mt-3 text-caption text-neutral-500">{READINESS_ALL_SET}</p>
              ) : null}
            </CardContent>
          </Card>
        </section>

        {/* ── 요약 ──────────────────────────────────────────────────────── */}
        <section aria-labelledby="summary-heading">
          <Card>
            <CardHeader>
              <CardTitle id="summary-heading" className="text-base">
                지금 상태
              </CardTitle>
              <CardDescription>
                기준 시각{" "}
                <time dateTime={dateTimeAttr(observedAt)}>{formatTimestamp(observedAt)}</time>
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-3">
                <MetricTile
                  label="실행 기록이 있는 배치"
                  metric={measured(running)}
                  unit={`/ ${batches.length}개`}
                  hint="'등록됨'이 아니라 '실제로 남은 기록'을 셉니다."
                />
                <MetricTile
                  label="파기 기한 초과 문서"
                  metric={measured(purgeOverdue)}
                  unit="건"
                  hint="배치가 성공으로 남아도 남은 문서가 있으면 그것이 사실입니다(§5.1)."
                />
                <MetricTile
                  label={`로그인 실패 (${loginWindowHours}시간)`}
                  metric={measured(loginTotal)}
                  unit="건"
                  hint="브라우저가 보내 준 것만 셉니다. 전수가 아닙니다."
                />
              </div>

              <p
                className="rounded-md border border-border bg-muted p-3 text-caption text-muted-foreground"
                data-testid="ops-cron-secret"
              >
                {cronSecretConfigured ? (
                  <>
                    <strong>스케줄러 전용 키가 설정돼 있습니다.</strong> 배치는{" "}
                    <code>CRON_SECRET</code> 또는 서비스롤 키로 실행됩니다.
                  </>
                ) : (
                  <>
                    <strong>
                      스케줄러 전용 키(<code>CRON_SECRET</code>)가 설정돼 있지 않습니다.
                    </strong>{" "}
                    이 값이 없으면 스케줄러가 인증 헤더를 아예 보내지 않아 배치가 매번 401 로
                    끝나고, <strong>기록이 남지 않아 화면에는 &apos;실행 기록 없음&apos;으로만 보입니다</strong>{" "}
                    — 원인이 가려집니다. 로컬에서는 서비스롤 키로 부를 수 있으므로 이 경고가
                    정상입니다.
                  </>
                )}
              </p>
            </CardContent>
          </Card>
        </section>

        {/* ── 배치 ──────────────────────────────────────────────────────── */}
        <section aria-labelledby="batches-heading">
          <Card>
            <CardHeader>
              <CardTitle id="batches-heading" className="text-base">
                배치 {batches.length}종
              </CardTitle>
              <CardDescription>
                <strong>
                  &apos;만들었다&apos;와 &apos;돈다&apos;와 &apos;돌았다&apos;는 다른 상태입니다.
                </strong>{" "}
                셋을 한 얼굴로 그리면 없는 배치가 있는 것처럼 보입니다. 등록 상태는{" "}
                <code>vercel.json</code> 이 진실이며 DB 에 사본을 두지 않습니다.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full text-caption">
                  <thead>
                    <tr className="border-b border-border text-left text-muted-foreground">
                      <th scope="col" className="py-2 pr-3 font-medium">
                        배치
                      </th>
                      <th scope="col" className="py-2 pr-3 font-medium">
                        주기
                      </th>
                      <th scope="col" className="py-2 pr-3 font-medium">
                        상태
                      </th>
                      <th scope="col" className="py-2 pr-3 font-medium">
                        마지막 실행
                      </th>
                      <th scope="col" className="py-2 font-medium">
                        안 돌면
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {batches.map((batch) => (
                      <tr
                        key={batch.name}
                        className="border-b border-border align-top"
                        data-testid="ops-batch-row"
                      >
                        <td className="py-2 pr-3">
                          <code className="font-medium text-foreground">{batch.name}</code>
                          {batch.legalDuty ? (
                            <Badge variant="default" className="ml-1">
                              법적 의무
                            </Badge>
                          ) : null}
                          <span className="mt-0.5 block text-muted-foreground">{batch.purpose}</span>
                        </td>
                        <td className="py-2 pr-3 text-muted-foreground">
                          {batch.schedule}
                          {batch.cron !== null ? (
                            <code className="mt-0.5 block">{batch.cron}</code>
                          ) : null}
                        </td>
                        <td className="py-2 pr-3">
                          <Badge variant={batch.state === "ran" ? "secondary" : "outline"}>
                            {BATCH_STATE_LABEL[batch.state]}
                          </Badge>
                          <span className="mt-0.5 block text-muted-foreground">
                            {BATCH_STATE_HINT[batch.state]}
                          </span>
                        </td>
                        <td className="py-2 pr-3 text-muted-foreground">
                          {batch.lastRun === null ? (
                            // **0회라고 쓰지 않는다.** 기록이 없는 것이다.
                            "기록 없음"
                          ) : (
                            <>
                              <time dateTime={dateTimeAttr(batch.lastRun.startedAt)}>
                                {formatTimestamp(batch.lastRun.startedAt)}
                              </time>
                              <span className="mt-0.5 block">
                                {batch.lastRun.status} · {batch.lastRun.processedCount}건
                                {batch.lastRun.errorSummary !== null
                                  ? ` · ${batch.lastRun.errorSummary}`
                                  : ""}
                              </span>
                              {batch.recentFailures > 0 ? (
                                <span className="block text-warning">
                                  최근 실패 {batch.recentFailures}회
                                </span>
                              ) : null}
                            </>
                          )}
                        </td>
                        <td className="py-2 text-muted-foreground">{batch.consequence}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </section>

        {/* ── 로그인 실패 (FIX-32) ──────────────────────────────────────── */}
        <section aria-labelledby="login-heading">
          <Card>
            <CardHeader>
              <CardTitle id="login-heading" className="text-base">
                로그인 실패 · 최근 {loginWindowHours}시간
              </CardTitle>
              <CardDescription data-testid="ops-login-note">
                {loginObservability.reason}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {loginFailures.length === 0 ? (
                <EmptyState
                  title="신고된 실패가 없습니다"
                  description="실패가 없었다는 뜻일 수도, 신고가 도달하지 않았다는 뜻일 수도 있습니다. 이 화면은 그 둘을 구분하지 못합니다."
                />
              ) : (
                <ul className="space-y-1">
                  {loginFailures.map((row) => (
                    <li
                      key={row.code}
                      className="flex items-center justify-between rounded-md border border-border px-3 py-2"
                      data-testid="ops-login-row"
                    >
                      <code className="text-caption text-foreground">{row.code}</code>
                      <span className="text-caption text-muted-foreground">{row.count}건</span>
                    </li>
                  ))}
                </ul>
              )}

              <p className="mt-3 text-caption text-muted-foreground">
                <strong>자격증명 오류는 경보로 올리지 않습니다.</strong> 비밀번호를 틀리는 것은
                정상이고, 그것을 경보로 올리면 경보가 소음이 되어 아무도 보지 않게 됩니다. 인프라
                계열(타임아웃·설정·서비스 불가)만 위에 올립니다.
              </p>
            </CardContent>
          </Card>
        </section>
      </div>
    </AdminShell>
  );
}
