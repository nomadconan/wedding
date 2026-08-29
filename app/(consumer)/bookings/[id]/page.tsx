import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { ConsumerShell } from "@/components/layout/ConsumerShell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ErrorState } from "@/components/ui/ErrorState";
import { LoadingState } from "@/components/ui/LoadingState";
import { loadBookingDetail } from "@/lib/bookings/read";
import {
  BOOKING_DECISION_LABEL,
  BOOKING_STATUS_LABEL,
} from "@/lib/core/booking/console";
import { dateTimeAttr, formatTimestamp } from "@/lib/core/format/timestamp";
import { PAY_BLOCK_MESSAGE } from "@/lib/core/payment/checkout";
import { SCHEDULE_STATE_LABEL } from "@/lib/core/payment/payment";
import { requireUser } from "@/lib/supabase/auth";

export const metadata: Metadata = {
  title: "예약 상세 — 웨딩클리어",
};

/**
 * /bookings/[id] — 예약 상세 (F-C-14·15 · §6.2 · **S5-06 이 남긴 자리를 S5-10 이 채운다**)
 *
 * ── 이 화면이 없어서 벌어진 일 ─────────────────────────────────────────────
 * §6.2 가 이 화면을 **진입점으로 전제**하는 기능이 다섯이다 — 계약(`/contracts/[id]`)·
 * 결제(`/checkout/[bookingId]`)·해지(`/bookings/[id]/cancel`)·안전거래
 * (`/bookings/[id]/escrow`)·후기(`/reviews/new/[bookingId]`). 다섯 다 라우트는
 * **실재하는데 아무도 그리로 갈 수 없었다**(FIX-25 계열). S8-11 은 후기 하나만
 * `/me` 에 임시로 걸어 뒀고 나머지 넷은 URL 을 직접 쳐야 했다.
 *
 * ── 이 화면이 지키는 규칙 ───────────────────────────────────────────────────
 * 1. **막힌 문을 감추지 않는다.** 못 가는 이유를 함께 적는다 — 감추면 "그런 기능이
 *    없다" 로 읽히고, 실제로는 조건이 안 찼을 뿐이다.
 * 2. **승인과 확정을 한 얼굴로 그리지 않는다**(D-36). 업체 승인은 계약 확정이 아니다.
 * 3. **타임라인을 저장하지 않는다**(D-124). 이미 적혀 있는 시각들을 늘어놓을 뿐이다.
 * 4. **회차 금액·기한을 그대로 적는다**(§6.2 요구). 기한이 안 정해진 회차를 '오늘'
 *    로 그리지 않는다 — 모르는 것은 모른다고 적는다.
 * 5. **캐시하지 않는다.**
 */
export const dynamic = "force-dynamic";

export default async function BookingDetailPage({ params }: { params: { id: string } }) {
  await requireUser(`/bookings/${params.id}`);

  return (
    <ConsumerShell title="예약 상세">
      <Suspense fallback={<LoadingState label="예약을 불러오는 중" rows={4} variant="block" />}>
        <BookingDetailSection bookingId={params.id} />
      </Suspense>
    </ConsumerShell>
  );
}

async function BookingDetailSection({ bookingId }: { bookingId: string }) {
  let detail: Awaited<ReturnType<typeof loadBookingDetail>>;
  try {
    detail = await loadBookingDetail(bookingId, new Date());
  } catch {
    return (
      <ErrorState
        code="BOOKING_LOAD_FAILED"
        title="예약을 불러오지 못했어요"
        description="잠시 후 다시 시도해 주세요."
      />
    );
  }

  // **없는 것과 남의 것을 같게 답한다** — 남의 예약의 존재 여부를 알려주지 않는다.
  if (detail === null) notFound();

  const { booking, decision, timeline, entries, schedules } = detail;

  return (
    <div className="space-y-5">
      {/* ── 요약 ──────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{booking.vendorName}</CardTitle>
          <CardDescription>
            총 {booking.totalAmount.toLocaleString("ko-KR")}원
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="flex flex-wrap gap-2">
            <Badge variant={booking.status === "cancelled" ? "outline" : "secondary"}>
              {BOOKING_STATUS_LABEL[booking.status]}
            </Badge>
            <Badge variant={decision === "declined" ? "default" : "outline"}>
              {BOOKING_DECISION_LABEL[decision]}
            </Badge>
          </div>

          {/* 승인과 확정이 다르다는 것을 화면이 말한다 — 배지 둘만 두면 왜 둘인지 모른다. */}
          <p className="text-caption text-muted-foreground">
            <strong>업체 승인</strong>은 업체가 이 예약을 받겠다고 한 것이고,{" "}
            <strong>계약 확정</strong>은 계약서에 서명이 끝난 것입니다. 결제는 계약이 확정된
            뒤에 시작됩니다.
          </p>

          {booking.declineReason !== null ? (
            <p
              className="rounded-md border border-border bg-muted p-3 text-caption text-muted-foreground"
              data-testid="booking-decline-reason"
            >
              <strong>업체가 거절했어요.</strong> {booking.declineReason}
            </p>
          ) : null}
        </CardContent>
      </Card>

      {/* ── 진입점 ────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">할 수 있는 일</CardTitle>
          <CardDescription>
            지금 할 수 없는 것도 함께 보여드립니다 — <strong>왜 아직인지</strong>를 알아야
            다음에 무엇을 기다릴지 알 수 있습니다.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="space-y-2" data-testid="booking-entries">
            {entries.map((entry) =>
              entry.open ? (
                <li key={entry.key}>
                  <Link
                    href={entry.href}
                    className="block rounded-md border border-border px-4 py-3 font-medium text-foreground transition-colors hover:bg-muted"
                    data-testid={`booking-entry-${entry.key}`}
                  >
                    {entry.label}
                  </Link>
                </li>
              ) : (
                <li
                  key={entry.key}
                  className="rounded-md border border-dashed border-border px-4 py-3"
                  data-testid={`booking-entry-${entry.key}`}
                >
                  <span className="font-medium text-muted-foreground">{entry.label}</span>
                  <span className="mt-0.5 block text-caption text-muted-foreground">
                    {entry.blocked}
                  </span>
                </li>
              ),
            )}
          </ul>
        </CardContent>
      </Card>

      {/* ── 분할 결제 회차 (§6.2 요구) ────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">결제 회차</CardTitle>
          <CardDescription>
            회차별 금액과 기한입니다. <strong>기한이 정해지지 않은 회차는 그렇게 적습니다</strong>
            {" "}— 임의로 날짜를 만들면 그 날짜가 사실처럼 굳습니다.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {schedules.length === 0 ? (
            <p className="text-caption text-muted-foreground">
              아직 결제 회차가 없어요. 계약서가 발행되면 회차가 만들어집니다.
            </p>
          ) : (
            <ul className="space-y-2" data-testid="booking-schedules">
              {schedules.map((schedule) => (
                <li
                  key={schedule.id}
                  className="flex flex-wrap items-baseline justify-between gap-2 rounded-md border border-border px-3 py-2"
                >
                  <span className="font-medium text-foreground">
                    {schedule.seq}회차 {schedule.amount.toLocaleString("ko-KR")}원
                  </span>
                  <span className="text-caption text-muted-foreground">
                    <Badge variant="outline">{SCHEDULE_STATE_LABEL[schedule.state]}</Badge>{" "}
                    {schedule.dueAt === null ? (
                      "기한 미정"
                    ) : (
                      <time dateTime={dateTimeAttr(schedule.dueAt)}>
                        {formatTimestamp(schedule.dueAt)}
                      </time>
                    )}
                    {schedule.blockedReason !== null
                      ? ` · ${PAY_BLOCK_MESSAGE[schedule.blockedReason]}`
                      : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* ── 상태 타임라인 (§6.2 요구) ─────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">진행 기록</CardTitle>
          <CardDescription>
            일어난 일만 적습니다. <strong>아직 안 일어난 단계는 줄을 만들지 않습니다</strong> —
            빈 줄은 실패로 읽힙니다.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ol className="space-y-2" data-testid="booking-timeline">
            {timeline.map((step, index) => (
              <li key={`${step.at}-${index}`} className="border-l-2 border-border pl-3">
                <span className="font-medium text-foreground">{step.label}</span>
                <span className="mt-0.5 block text-caption text-muted-foreground">
                  <time dateTime={dateTimeAttr(step.at)}>{formatTimestamp(step.at)}</time>
                  {step.detail === null ? "" : ` · ${step.detail}`}
                </span>
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>

      {/* ── 환불 규정 (§6.2 요구) ─────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">환불 규정</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="text-caption text-muted-foreground">
            취소 시점에 따라 위약금이 달라집니다. 실제 금액은 해지 화면에서{" "}
            <strong>표준약관·소비자분쟁해결기준 대비 비교값</strong>으로 보여드립니다.
          </p>
          <p className="text-caption text-muted-foreground">
            <strong>참고 정보이며 법률 자문이 아닙니다.</strong> 최종 판단은 계약서 조항과
            관계 법령을 따릅니다.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
