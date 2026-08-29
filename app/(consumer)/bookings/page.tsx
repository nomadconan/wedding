import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { ConsumerShell } from "@/components/layout/ConsumerShell";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { LoadingState } from "@/components/ui/LoadingState";
import { loadBookings } from "@/lib/bookings/read";
import {
  BOOKING_DECISION_LABEL,
  BOOKING_STATUS_LABEL,
  decisionOf,
} from "@/lib/core/booking/console";
import { dateTimeAttr, formatTimestamp } from "@/lib/core/format/timestamp";
import { requireUser } from "@/lib/supabase/auth";

export const metadata: Metadata = {
  title: "내 예약 — 웨딩클리어",
};

/**
 * /bookings — 소비자 예약 목록 (§6.2 **신설 제안** · S5-10)
 *
 * §6.2 는 `/bookings/[id]` 만 적고 **목록을 두지 않았다.** 상세만 있으면 그 상세로
 * 가는 길이 없다 — id 를 아는 사람만 열 수 있는 화면이 된다(S7-10 이 `/guides` 에서,
 * S8-09 가 `/support` 에서 만난 것과 같은 자리). 그래서 목록을 신설하고 반영을
 * 제안한다.
 *
 * **하단 탭을 늘리지 않는다.** 다섯 칸이 상한이고 이미 찼다(D-55). 진입은 `/me` 와
 * 홈에서 잇는다.
 *
 * **캐시하지 않는다** — 승인·결제 상태가 바뀌는 화면이라 5분 전 상태를 보이면 안 된다.
 */
export const dynamic = "force-dynamic";

export default async function BookingsPage() {
  await requireUser("/bookings");

  return (
    <ConsumerShell title="내 예약">
      <Suspense fallback={<LoadingState label="예약을 불러오는 중" rows={3} variant="block" />}>
        <BookingList />
      </Suspense>
    </ConsumerShell>
  );
}

async function BookingList() {
  let rows: Awaited<ReturnType<typeof loadBookings>>;
  try {
    rows = await loadBookings();
  } catch {
    return (
      <ErrorState
        code="BOOKING_LOAD_FAILED"
        title="예약을 불러오지 못했어요"
        description="잠시 후 다시 시도해 주세요."
      />
    );
  }

  if (rows.length === 0) {
    return (
      <EmptyState
        title="아직 예약이 없어요"
        description="탐색에서 마음에 드는 업체를 찾아 문의를 보내면, 업체가 예약을 만들어 드려요."
        action={
          <Link
            href="/explore"
            className="block rounded-md border border-border px-4 py-2 text-center text-sm font-medium text-foreground"
          >
            업체 탐색하기
          </Link>
        }
      />
    );
  }

  return (
    <ul className="space-y-3" data-testid="booking-list">
      {rows.map((row) => {
        const decision = decisionOf(row);

        return (
          <li key={row.id}>
            <Link
              href={`/bookings/${row.id}`}
              className="block rounded-lg border border-border p-4 transition-colors hover:bg-muted"
              data-testid="booking-row"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-foreground">{row.vendorName}</span>
                <Badge variant={row.status === "cancelled" ? "outline" : "secondary"}>
                  {BOOKING_STATUS_LABEL[row.status]}
                </Badge>
                {/* **승인과 확정을 한 배지로 합치지 않는다**(D-36) — 다른 사건이다. */}
                <Badge variant={decision === "declined" ? "default" : "outline"}>
                  {BOOKING_DECISION_LABEL[decision]}
                </Badge>
              </div>

              <p className="mt-1 text-caption text-muted-foreground">
                {row.totalAmount.toLocaleString("ko-KR")}원 ·{" "}
                <time dateTime={dateTimeAttr(row.createdAt)}>
                  {formatTimestamp(row.createdAt)}
                </time>{" "}
                신청
              </p>

              {row.declineReason !== null ? (
                <p className="mt-1 text-caption text-muted-foreground">
                  <strong>거절 사유</strong> {row.declineReason}
                </p>
              ) : null}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
