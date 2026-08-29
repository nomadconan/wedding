import type { Metadata } from "next";
import Link from "next/link";

import { AdminShell } from "@/components/layout/AdminShell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { loadVendorBookings, vendorOf } from "@/lib/bookings/vendor";
import { BOOKING_STATUS_LABEL, ISSUE_BLOCK_MESSAGE } from "@/lib/core/booking/console";
import { dateTimeAttr, formatTimestamp } from "@/lib/core/format/timestamp";
import { requireUser } from "@/lib/supabase/auth";

import { DecidePanel } from "./DecidePanel";

export const metadata: Metadata = {
  title: "예약·계약 — 웨딩클리어",
};

/**
 * /vendor/bookings — 업체 예약·계약 관리 (F-V-08 · §6.3 · S5-10)
 *
 * ── 이 화면이 없어서 벌어진 일 ─────────────────────────────────────────────
 * `VENDOR_NAV` 가 이 경로를 **가리키고 있었는데 화면이 없었다**(FIX-23 이 세던 죽은
 * 링크 중 하나). 그리고 더 나쁜 것은 **승인이라는 절차 자체가 없었다**는 점이다 —
 * 예약 표에 당사자 쓰기가 열려 있어(FIX-44) 고객이 스스로 확정 예약을 만들 수
 * 있었고, 업체가 받겠다고 말할 자리가 어디에도 없었다.
 *
 * ── 이 화면이 지키는 규칙 ───────────────────────────────────────────────────
 * 1. **갈래를 넷으로 나눈다.** 특히 '승인 대기' 와 '계약 발행 대기' 를 가른다 —
 *    앞은 업체가 아직 결정하지 않은 것이고 뒤는 결정해 놓고 발행을 잊은 것이라,
 *    할 일이 다르다. **0건인 갈래도 줄을 남긴다**(갈래가 사라진 것과 0건은 다른 뜻).
 * 2. **누를 수 없는 버튼을 그리지 않는다**(D-143). 왜 못 누르는지는 적는다.
 * 3. **거절에는 사유가 필수다**(D-24) — 화면과 API 와 CHECK 셋이 같은 것을 요구한다.
 * 4. **고객 식별정보를 그리지 않는다.** 여기 필요한 것은 금액·일시·상태다.
 * 5. **캐시하지 않는다.**
 */
export const dynamic = "force-dynamic";

export default async function VendorBookingsPage() {
  const user = await requireUser("/vendor/bookings");
  const vendorId = await vendorOf(user.id);

  if (vendorId === null) {
    return (
      <AdminShell role="vendor" title="예약·계약">
        <ErrorState
          code="VENDOR_NOT_MEMBER"
          title="업체 계정이 아니에요"
          description="업체로 등록하고 승인을 받은 뒤에 예약을 관리할 수 있어요."
        />
      </AdminShell>
    );
  }

  let board: Awaited<ReturnType<typeof loadVendorBookings>>;
  try {
    board = await loadVendorBookings(vendorId);
  } catch {
    return (
      <AdminShell role="vendor" title="예약·계약">
        <ErrorState
          code="VENDOR_BOOKING_LOAD_FAILED"
          title="예약을 불러오지 못했어요"
          description="잠시 후 다시 시도해 주세요."
        />
      </AdminShell>
    );
  }

  return (
    <AdminShell
      role="vendor"
      title="예약·계약"
      description="승인·거절과 계약 발행. 승인은 계약 확정과 다른 사건입니다."
    >
      <div className="space-y-6">
        {board.total === 0 ? (
          <EmptyState
            title="아직 예약이 없어요"
            description="고객 문의에 견적을 보내고 예약이 만들어지면 여기에 나타납니다."
          />
        ) : null}

        {board.lanes.map((lane) => (
          <section key={lane.lane} aria-labelledby={`lane-${lane.lane}`}>
            <Card>
              <CardHeader>
                <CardTitle id={`lane-${lane.lane}`} className="text-base">
                  {lane.label} {lane.rows.length}건
                </CardTitle>
                <CardDescription>{lane.hint}</CardDescription>
              </CardHeader>
              <CardContent>
                {lane.rows.length === 0 ? (
                  // **0건도 줄을 남긴다.** 갈래가 사라지면 "그런 상태가 없다" 로 읽힌다.
                  <p className="text-caption text-muted-foreground">
                    해당하는 예약이 없습니다.
                  </p>
                ) : (
                  <ul className="space-y-3" data-testid={`vendor-lane-${lane.lane}`}>
                    {lane.rows.map((row) => (
                      <li
                        key={row.id}
                        className="rounded-lg border border-border p-4"
                        data-testid="vendor-booking-row"
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium text-foreground">
                            {row.totalAmount.toLocaleString("ko-KR")}원
                          </span>
                          <Badge variant="outline">{BOOKING_STATUS_LABEL[row.status]}</Badge>
                          {row.productName !== null ? (
                            <span className="text-caption text-muted-foreground">
                              {row.productName}
                            </span>
                          ) : (
                            <span className="text-caption text-muted-foreground">
                              상품 없이 만든 예약
                            </span>
                          )}
                        </div>

                        <p className="mt-1 text-caption text-muted-foreground">
                          계약금 {row.depositAmount.toLocaleString("ko-KR")}원 ·{" "}
                          <time dateTime={dateTimeAttr(row.createdAt)}>
                            {formatTimestamp(row.createdAt)}
                          </time>{" "}
                          신청
                          {row.acceptedAt !== null ? (
                            <>
                              {" · 승인 "}
                              <time dateTime={dateTimeAttr(row.acceptedAt)}>
                                {formatTimestamp(row.acceptedAt)}
                              </time>
                            </>
                          ) : null}
                        </p>

                        {row.declineReason !== null ? (
                          <p className="mt-1 text-caption text-muted-foreground">
                            <strong>거절 사유</strong> {row.declineReason}
                          </p>
                        ) : null}

                        {/* 계약 — 발행할 수 있는가, 없다면 왜인가 */}
                        <p className="mt-2 text-caption text-muted-foreground">
                          {row.contractId !== null ? (
                            <Link href={`/contracts/${row.contractId}`} className="underline">
                              계약서 보기 ({row.contractStatus})
                            </Link>
                          ) : row.canIssue ? (
                            <strong>계약서를 발행할 수 있습니다.</strong>
                          ) : (
                            (row.issueBlockedReason && ISSUE_BLOCK_MESSAGE[row.issueBlockedReason]) ??
                            ""
                          )}
                        </p>

                        <div className="mt-3">
                          {row.canDecide ? (
                            <DecidePanel bookingId={row.id} />
                          ) : (
                            <p className="text-caption text-muted-foreground">
                              {row.decideBlockedReason}
                            </p>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </section>
        ))}
      </div>
    </AdminShell>
  );
}
