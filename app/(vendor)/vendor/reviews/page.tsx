import type { Metadata } from "next";
import Link from "next/link";

import { MetricTile } from "@/components/domain/MetricTile";
import { AdminShell } from "@/components/layout/AdminShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { dateTimeAttr, formatTimestamp } from "@/lib/core/format/timestamp";
import { RATING_AXIS_LABEL, ratingCaption } from "@/lib/core/review/rating";
import type { ReviewReportReason } from "@/lib/core/review/report";
import { measured, notYet } from "@/lib/core/stats/metric";
import { loadVendorReviewBoard } from "@/lib/reviews/vendor";
import { requireUser } from "@/lib/supabase/auth";
import { findMemberVendor } from "@/lib/vendor/products";

import { ReplyPanel } from "./ReplyPanel";

export const metadata: Metadata = {
  title: "후기·평판 — 웨딩클리어",
};

/**
 * /vendor/reviews — 후기·평판 관리 (F-V-11, §6.3 — 8단계 · S8-11)
 *
 * ── 이 화면이 지키는 규칙 ───────────────────────────────────────────────────
 * 1. **평점 산정 기준을 값과 함께 보여준다**(F-V-11 명시 요구). 어떤 후기가 분모에
 *    들어갔고 축을 어떻게 가중했는지 화면에 적는다 — 광고를 받지 않는 대신 순서와
 *    점수의 근거를 밝히기로 한 서비스다(D-03 · CLAUDE.md §2.2).
 * 2. **평균만 크게 그리지 않는다.** 건수가 항상 붙는다 — 한 건짜리 5.0 을 백 건짜리
 *    4.6 보다 위에 놓는 화면을 만들지 않는다.
 * 3. **비공개 사유를 감추지 않는다.** 사유 없는 비공개는 조치가 아니라 사고처럼
 *    보이고, 업체가 무엇을 고쳐야 하는지 알 수 없다.
 * 4. **후기를 내리는 버튼이 없다.** 업체가 할 수 있는 일은 답변과 신고까지이며,
 *    내리는 것은 운영자다(F-A-13). S7-16 이 커뮤니티 태그에서 정한 것과 같은 선이다.
 */
export const dynamic = "force-dynamic";

export default async function VendorReviewsPage() {
  const user = await requireUser("/vendor/reviews");
  const vendor = await findMemberVendor(user.id);

  if (!vendor) {
    return (
      <AdminShell role="vendor" title="후기·평판">
        <Card>
          <CardContent className="pt-6">
            <EmptyState
              title="아직 등록된 업체가 없어요"
              description="입점 신청을 마치면 고객이 남긴 검증 후기를 보고 답변할 수 있습니다."
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

  let board: Awaited<ReturnType<typeof loadVendorReviewBoard>>;
  try {
    board = await loadVendorReviewBoard(vendor.id);
  } catch {
    return (
      <AdminShell role="vendor" title="후기·평판">
        <ErrorState
          code="REVIEW_LOAD_FAILED"
          title="후기를 불러오지 못했어요"
          description="잠시 후 다시 시도해 주세요."
        />
      </AdminShell>
    );
  }

  const { rows, rating, visibleCount, hiddenCount, retractedCount, unansweredCount } = board;

  return (
    <AdminShell
      role="vendor"
      title="후기·평판"
      description="거래가 확인된 고객만 남길 수 있는 검증 후기입니다."
    >
      <div className="space-y-6">
        {/* ── 평점과 그 산정 기준 ───────────────────────────────────────── */}
        <section aria-labelledby="rating-heading">
          <Card>
            <CardHeader>
              <CardTitle id="rating-heading" className="text-base">
                평점
              </CardTitle>
              <CardDescription>{ratingCaption(rating)}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <MetricTile
                  label="종합"
                  metric={
                    rating.overall === null
                      ? notYet("후기가 쌓이면 계산합니다.", "S8-11")
                      : measured(rating.overall)
                  }
                  hint={`검증 후기 ${rating.reviewCount}건`}
                />
                {rating.axes.map((axis) => (
                  <MetricTile
                    key={axis.axis}
                    label={RATING_AXIS_LABEL[axis.axis]}
                    metric={
                      axis.average === null
                        ? notYet("이 항목에 점수를 남긴 후기가 아직 없습니다.", "S8-11")
                        : measured(axis.average)
                    }
                    hint={`${axis.sampleSize}건`}
                  />
                ))}
              </div>

              {/* F-V-11 "평점 산정 기준 공개" — 값 옆에 기준을 둔다. */}
              <div className="rounded-md border border-border bg-muted p-3">
                <p className="text-caption font-medium text-foreground">
                  산정 기준 · {rating.basis.label}{" "}
                  <span className="font-normal text-muted-foreground">({rating.basis.code})</span>
                </p>
                <ul className="mt-1 space-y-0.5">
                  {rating.basis.rules.map((rule) => (
                    <li key={rule} className="text-caption text-muted-foreground">
                      · {rule}
                    </li>
                  ))}
                </ul>
              </div>

              <div className="grid gap-3 sm:grid-cols-3">
                <MetricTile label="공개 중" metric={measured(visibleCount)} unit="건" />
                <MetricTile
                  label="답변하지 않은 후기"
                  metric={measured(unansweredCount)}
                  unit="건"
                />
                <MetricTile
                  label="공개되지 않는 후기"
                  metric={measured(hiddenCount + retractedCount)}
                  unit="건"
                  hint={`운영자 비공개 ${hiddenCount}건 · 작성자 철회 ${retractedCount}건`}
                />
              </div>
            </CardContent>
          </Card>
        </section>

        {/* ── 후기 목록 ─────────────────────────────────────────────────── */}
        <section aria-labelledby="list-heading">
          <Card>
            <CardHeader>
              <CardTitle id="list-heading" className="text-base">
                후기 {rows.length}건
              </CardTitle>
              <CardDescription>
                <strong>후기를 내리는 버튼은 없습니다.</strong> 여기서 할 수 있는 일은 답변과
                신고까지이고, 게시 여부는 운영자가 정합니다. 신고 사유 중 &apos;거래 사실이
                없습니다&apos;만 저희가 예약 기록으로 확인할 수 있습니다.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {rows.length === 0 ? (
                <EmptyState
                  title="아직 후기가 없어요"
                  description="계약이 확정·이행된 고객이 후기를 남기면 여기에 보입니다."
                />
              ) : (
                <ul className="space-y-3">
                  {rows.map((row) => {
                    const answerable = row.status === "published" && row.retractedAt === null;

                    return (
                      <li key={row.id} className="rounded-lg border border-border p-4">
                        <div className="flex flex-wrap items-center gap-2">
                          {row.retractedAt !== null ? (
                            <Badge variant="outline">작성자가 거둠</Badge>
                          ) : null}
                          {row.status === "hidden" ? (
                            <Badge variant="secondary">운영자 비공개</Badge>
                          ) : null}
                          {answerable && row.vendorReply === null ? (
                            <Badge variant="default">답변 없음</Badge>
                          ) : null}
                          {row.disclosedAmount !== null ? (
                            <Badge variant="outline">
                              실지출 공개 {row.disclosedAmount.toLocaleString("ko-KR")}원
                            </Badge>
                          ) : null}
                          <span className="text-caption text-muted-foreground">
                            <time dateTime={dateTimeAttr(row.createdAt)}>
                              {formatTimestamp(row.createdAt)}
                            </time>
                          </span>
                        </div>

                        <p className="mt-2 text-caption text-muted-foreground">
                          {[
                            ["가격 투명성", row.scorePrice],
                            ["응대", row.scoreResponse],
                            ["이행", row.scoreFulfillment],
                          ]
                            .filter(([, value]) => value !== null)
                            .map(([label, value]) => `${label} ${value}`)
                            .join(" · ") || "점수 없음"}
                        </p>

                        {row.body ? (
                          <p className="mt-2 whitespace-pre-wrap text-sm text-foreground">
                            {row.body}
                          </p>
                        ) : null}

                        {row.vendorReply ? (
                          <p className="mt-2 rounded-md bg-muted p-2 text-sm text-foreground">
                            내 답변 — {row.vendorReply}
                            {row.vendorRepliedAt ? (
                              <span className="ml-2 text-caption text-muted-foreground">
                                <time dateTime={dateTimeAttr(row.vendorRepliedAt)}>
                                  {formatTimestamp(row.vendorRepliedAt)}
                                </time>
                              </span>
                            ) : null}
                          </p>
                        ) : null}

                        {row.hiddenReason !== null ? (
                          <p className="mt-2 text-caption text-muted-foreground">
                            비공개 사유 — {row.hiddenReason}
                          </p>
                        ) : null}

                        {row.reports.length > 0 ? (
                          <ul className="mt-2 space-y-0.5">
                            {row.reports.map((report) => (
                              <li key={report.id} className="text-caption text-muted-foreground">
                                내 신고 · {report.reasonLabel} —{" "}
                                {report.status === "open" ? "처리 대기" : "처리됨"}
                              </li>
                            ))}
                          </ul>
                        ) : null}

                        <ReplyPanel
                          reviewId={row.id}
                          currentReply={row.vendorReply}
                          answerable={answerable}
                          reportedReasons={row.reports.map(
                            (report) => report.reason as ReviewReportReason,
                          )}
                        />
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardContent>
          </Card>
        </section>
      </div>
    </AdminShell>
  );
}
