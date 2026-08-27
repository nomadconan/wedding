import type { Metadata } from "next";

import { MetricTile } from "@/components/domain/MetricTile";
import { AdminShell } from "@/components/layout/AdminShell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { dateTimeAttr, formatTimestamp } from "@/lib/core/format/timestamp";
import { ABUSE_SIGNAL_LABEL } from "@/lib/core/review/abuse";
import { REVIEW_REPORT_STATUS_LABEL } from "@/lib/core/review/report";
import { measured, undecided } from "@/lib/core/stats/metric";
import { loadReviewQueue } from "@/lib/reviews/admin";
import { requireOperator } from "@/lib/supabase/auth";

import { ModeratePanel } from "./ModeratePanel";

export const metadata: Metadata = {
  title: "후기 관리 — 웨딩클리어",
};

/**
 * /admin/reviews — 후기 관리 (F-A-13, §6.4 — 8단계 · S8-11)
 *
 * ── 이 화면이 지키는 규칙 ───────────────────────────────────────────────────
 * 1. **탐지는 판정이 아니라 큐다**(D-24). 플래그가 붙었다고 아무 일도 자동으로
 *    일어나지 않는다 — 자동 비공개도 자동 제재도 없다. 후기를 내리는 유일한 경로는
 *    운영자가 사유를 적는 것이다.
 * 2. **기준이 없는 신호는 세지 않는다**(O-20). 몰아쓰기 임계가 미결이면 '해당 없음'
 *    이 아니라 **'보지 않음'** 이라고 적는다. 웨딩 준비는 여러 계약이 몇 달 안에
 *    몰리는 일이라 임계를 지어내면 큐가 곧 정상 사용자 목록이 된다.
 * 3. **업체·작성자에 대한 판단을 적지 않는다**(§7.7). 신고 처리 어휘는 '허위·사실'
 *    이 아니라 **'후기를 내림·내리지 않음'** 이다.
 * 4. **검증 상태를 칸에서 읽지 않는다.** 후기가 존재한다는 것 자체가 확정·이행된
 *    예약이 있었다는 뜻이다(`reviews_insert` 정책). 같은 사실을 칸에 또 적으면
 *    그 칸이 진실인 척하게 된다(FIX-38 이 타입에서 물린 것과 같은 결).
 * 5. **캐시하지 않는다**(FIX-22 계열).
 */
export const dynamic = "force-dynamic";

function scoreLine(row: {
  scorePrice: number | null;
  scoreResponse: number | null;
  scoreFulfillment: number | null;
}): string {
  const parts = [
    ["가격", row.scorePrice],
    ["응대", row.scoreResponse],
    ["이행", row.scoreFulfillment],
  ] as const;

  const given = parts.filter(([, value]) => value !== null);
  if (given.length === 0) return "점수 없음";

  return given.map(([label, value]) => `${label} ${value}`).join(" · ");
}

export default async function AdminReviewsPage() {
  await requireOperator("/admin/reviews");

  let queue: Awaited<ReturnType<typeof loadReviewQueue>>;
  try {
    queue = await loadReviewQueue();
  } catch {
    return (
      <AdminShell role="admin" title="후기 관리">
        <ErrorState
          code="REVIEW_QUEUE_FAILED"
          title="후기 큐를 불러오지 못했어요"
          description="잠시 후 다시 시도해 주세요. 계속되면 운영 담당자에게 알려 주세요."
        />
      </AdminShell>
    );
  }

  const { rows, openReportCount, burst, threshold } = queue;
  const flagged = rows.filter((row) => row.flags.length > 0);
  const visible = rows.filter((row) => row.status === "published" && row.retractedAt === null);

  return (
    <AdminShell
      role="admin"
      title="후기 관리"
      description="검증 후기의 상태·어뷰징 큐·비공개 처리를 한 화면에서 봅니다."
    >
      <div className="space-y-6">
        {/* ── 요약 ──────────────────────────────────────────────────────── */}
        <section aria-labelledby="summary-heading">
          <Card>
            <CardHeader>
              <CardTitle id="summary-heading" className="text-base">
                지금 상태
              </CardTitle>
              <CardDescription>
                후기는 <strong>확정·이행된 예약에만</strong> 달립니다. 그 조건은 DB 가
                강제하므로 여기 보이는 모든 후기에는 거래가 있었습니다.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <MetricTile label="공개 중인 후기" metric={measured(visible.length)} unit="건" />
                <MetricTile
                  label="처리 대기 신고"
                  metric={measured(openReportCount)}
                  unit="건"
                  hint="신고가 하나라도 열려 있으면 그 후기는 아래 큐에 뜹니다."
                />
                <MetricTile
                  label="큐에 오른 후기"
                  metric={measured(flagged.length)}
                  unit="건"
                  hint="'봐 달라'는 표시입니다. 자동으로 내려가는 후기는 없습니다."
                />
                <MetricTile
                  label="몰아쓰기 신호"
                  metric={
                    burst.status === "scanned"
                      ? measured(burst.count)
                      : undecided(
                          "판정 기준(창 시간·건수)이 정해지지 않아 이 신호는 세지 않습니다.",
                          burst.openIssue,
                        )
                  }
                  unit="건"
                  hint={
                    burst.status === "scanned"
                      ? `기준: ${threshold.windowHours}시간 안에 ${threshold.minCount}건 이상`
                      : undefined
                  }
                />
              </div>

              {burst.status === "blocked" ? (
                <p className="mt-3 rounded-md border border-border bg-muted p-3 text-caption text-muted-foreground">
                  <strong>&apos;몰아쓰기 없음&apos;이 아니라 &apos;보지 않음&apos;입니다.</strong>{" "}
                  웨딩 준비는 홀·스드메·사진 계약이 몇 달 안에 몰리는 일이라, 기준을 임의로
                  잡으면 큐가 곧 정상 사용자 목록이 됩니다({burst.openIssue}). 신고와 &apos;본문
                  없는 극단 점수&apos;는 기준이 필요 없어 지금도 세고 있습니다.
                </p>
              ) : null}
            </CardContent>
          </Card>
        </section>

        {/* ── 큐 ────────────────────────────────────────────────────────── */}
        <section aria-labelledby="queue-heading">
          <Card>
            <CardHeader>
              <CardTitle id="queue-heading" className="text-base">
                살펴볼 후기 {flagged.length}건
              </CardTitle>
              <CardDescription>
                <strong>탐지는 판정이 아닙니다.</strong> 아래 표시는 근거와 함께 놓여 있을
                뿐이고, 후기를 내리는 유일한 경로는 사유를 적어 조치하는 것입니다.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {flagged.length === 0 ? (
                <EmptyState
                  title="큐가 비어 있습니다"
                  description="신고도, 본문 없는 극단 점수도 없습니다. 전체 목록은 아래에서 볼 수 있습니다."
                />
              ) : (
                <ul className="space-y-3">
                  {flagged.map((row) => (
                    <li key={row.id} className="rounded-lg border border-border p-4">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-foreground">{row.vendorName}</span>
                        {row.flags.map((flag) => (
                          <Badge key={`${flag.signal}-${flag.reviewId}`} variant="default">
                            {ABUSE_SIGNAL_LABEL[flag.signal]}
                          </Badge>
                        ))}
                        <span className="text-caption text-muted-foreground">
                          {scoreLine(row)}
                        </span>
                      </div>

                      <ul className="mt-2 space-y-0.5">
                        {row.flags.map((flag) => (
                          <li
                            key={`${flag.signal}-basis`}
                            className="text-caption text-muted-foreground"
                          >
                            {ABUSE_SIGNAL_LABEL[flag.signal]} — {flag.basis}
                          </li>
                        ))}
                      </ul>

                      {row.body ? (
                        <p className="mt-2 whitespace-pre-wrap text-sm text-foreground">
                          {row.body}
                        </p>
                      ) : (
                        <p className="mt-2 text-sm text-muted-foreground">본문 없음</p>
                      )}

                      <p className="mt-2 text-caption text-muted-foreground">
                        <time dateTime={dateTimeAttr(row.createdAt)}>
                          {formatTimestamp(row.createdAt)}
                        </time>
                      </p>

                      <ModeratePanel
                        reviewId={row.id}
                        status={row.status}
                        retracted={row.retractedAt !== null}
                        openReports={row.reports
                          .filter((report) => report.status === "open")
                          .map((report) => ({
                            id: report.id,
                            reasonLabel: report.reasonLabel,
                            verifiable: report.verifiable,
                          }))}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </section>

        {/* ── 전체 목록 ─────────────────────────────────────────────────── */}
        <section aria-labelledby="all-heading">
          <Card>
            <CardHeader>
              <CardTitle id="all-heading" className="text-base">
                전체 후기 {rows.length}건
              </CardTitle>
              <CardDescription>
                내려간 후기도 여기 있습니다 — <strong>다시 찾을 수 없으면 복구할 수
                없습니다.</strong> 비공개 사유는 업체 화면에도 그대로 보입니다.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {rows.length === 0 ? (
                <EmptyState
                  title="아직 후기가 없습니다"
                  description="확정·이행된 예약이 생기면 그 커플이 후기를 쓸 수 있습니다."
                />
              ) : (
                <ul className="space-y-3">
                  {rows.map((row) => (
                    <li key={row.id} className="rounded-lg border border-border p-4">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-foreground">{row.vendorName}</span>
                        {row.retractedAt !== null ? (
                          <Badge variant="outline">작성자가 거둠</Badge>
                        ) : null}
                        {row.status === "hidden" ? <Badge variant="secondary">비공개</Badge> : null}
                        {row.disclosedAmount !== null ? (
                          <Badge variant="outline">
                            실지출 공개 {row.disclosedAmount.toLocaleString("ko-KR")}원
                          </Badge>
                        ) : null}
                        <span className="text-caption text-muted-foreground">{scoreLine(row)}</span>
                      </div>

                      {row.body ? (
                        <p className="mt-2 whitespace-pre-wrap text-sm text-foreground">{row.body}</p>
                      ) : null}

                      {row.vendorReply ? (
                        <p className="mt-2 rounded-md bg-muted p-2 text-sm text-foreground">
                          업체 답변 — {row.vendorReply}
                        </p>
                      ) : null}

                      {row.hiddenReason !== null ? (
                        <p className="mt-2 text-caption text-muted-foreground">
                          비공개 사유 — {row.hiddenReason}
                          {row.hiddenAt ? (
                            <>
                              {" · "}
                              <time dateTime={dateTimeAttr(row.hiddenAt)}>
                                {formatTimestamp(row.hiddenAt)}
                              </time>
                            </>
                          ) : null}
                        </p>
                      ) : null}

                      {row.reports.length > 0 ? (
                        <ul className="mt-2 space-y-0.5">
                          {row.reports.map((report) => (
                            <li key={report.id} className="text-caption text-muted-foreground">
                              <Badge variant="outline">
                                {REVIEW_REPORT_STATUS_LABEL[
                                  report.status as keyof typeof REVIEW_REPORT_STATUS_LABEL
                                ] ?? report.status}
                              </Badge>{" "}
                              {report.reasonLabel}
                              {report.resolutionNote ? ` — ${report.resolutionNote}` : ""}
                            </li>
                          ))}
                        </ul>
                      ) : null}

                      <p className="mt-2 text-caption text-muted-foreground">
                        <time dateTime={dateTimeAttr(row.createdAt)}>
                          {formatTimestamp(row.createdAt)}
                        </time>
                        {" · "}
                        <a className="underline" href={`/admin/audit?targetType=review`}>
                          증적 타임라인
                        </a>
                      </p>

                      <ModeratePanel
                        reviewId={row.id}
                        status={row.status}
                        retracted={row.retractedAt !== null}
                        openReports={row.reports
                          .filter((report) => report.status === "open")
                          .map((report) => ({
                            id: report.id,
                            reasonLabel: report.reasonLabel,
                            verifiable: report.verifiable,
                          }))}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </section>
      </div>
    </AdminShell>
  );
}
