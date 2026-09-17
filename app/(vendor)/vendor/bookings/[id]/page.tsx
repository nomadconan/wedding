import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { formatKrw } from "@/components/domain/PriceDisplay";
import { AdminShell } from "@/components/layout/AdminShell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ErrorState } from "@/components/ui/ErrorState";
import { VENDOR_LANE_LABEL } from "@/lib/core/booking/console";
import { dateTimeAttr, formatTimestamp } from "@/lib/core/format/timestamp";
import { loadVendorBookingDetail } from "@/lib/bookings/vendor-detail";
import { vendorOf } from "@/lib/bookings/vendor";
import { requireUser } from "@/lib/supabase/auth";

export const metadata: Metadata = {
  title: "거래 상세 — 웨딩클리어",
};

/**
 * /vendor/bookings/[id] — 업체 거래 상세 (C-1 · F-V-08 · §6.3)
 *
 * ── 이 화면이 없어서 벌어진 일 ─────────────────────────────────────────────
 * 업체가 한 거래를 처음부터 끝까지 따라가려면 **화면 일곱**을 오가야 했다(B-1 조사 2).
 * 소비자는 `/bookings/[id]` 하나로 봤다 — **같은 거래인데 한쪽만 한눈에 보였다.**
 *
 * ── 소비자판과 같은 사실을 읽는다 ──────────────────────────────────────────
 * `loadChainFacts` 하나가 사실을 모으고 면마다 접는 방식만 다르다. 조회를 따로 쓰면
 * 같은 예약이 두 화면에서 다른 상태로 보이는 날이 오고, 그때 어느 쪽이 맞는지
 * 답할 수 없다.
 *
 * ── 누를 수 없는 버튼을 그리지 않는다 (D-143) ──────────────────────────────
 * 결제·해지·후기는 **고객이 하는 행위**다. 업체 화면에 두면 눌러도 아무 일이 없는
 * 버튼이 된다. 대신 **진행 상태로 보여준다** — 업체가 알아야 하는 것은 "내가 눌러야
 * 하는가" 와 "지금 어디까지 왔는가" 둘이다.
 *
 * **승인·거절·계약 발행 버튼은 목록(`/vendor/bookings`)이 갖는다.** 여기서 또 만들면
 * 같은 조치가 두 곳에 서고, 한쪽만 고쳐지는 날이 온다. 이 화면은 **왜 지금 못 하는지**를
 * 적고 목록으로 보낸다.
 *
 * **캐시하지 않는다**(FIX-22 계열).
 */
export const dynamic = "force-dynamic";

export default async function VendorBookingDetailPage(props: {
  params: Promise<{ id: string }>;
}) {
  const params = await props.params;
  const user = await requireUser(`/vendor/bookings/${params.id}`);
  const vendorId = await vendorOf(user.id);

  if (vendorId === null) {
    return (
      <AdminShell role="vendor" title="거래 상세">
        <ErrorState
          code="VENDOR_NOT_MEMBER"
          title="업체 계정이 아니에요"
          description="업체로 등록하고 승인을 받은 뒤에 거래를 볼 수 있어요."
        />
      </AdminShell>
    );
  }

  const detail = await loadVendorBookingDetail({ bookingId: params.id, vendorId });

  // **없는 것과 못 보는 것을 같게 답한다** — 남의 거래의 존재 여부를 알려주지 않는다.
  if (detail === null) notFound();

  return (
    <AdminShell
      role="vendor"
      title="거래 상세"
      description="이 거래가 지금 어디까지 왔는지 한 화면에서 봅니다."
    >
      <div className="space-y-4">
        <p className="text-caption">
          <Link href="/vendor/bookings" className="text-brand-600 underline">
            ← 예약·계약 목록
          </Link>
        </p>

        {/* ── 지금 상태 ─────────────────────────────────────────────────── */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {detail.productName ?? "상품 정보 없음"}
            </CardTitle>
            <CardDescription>
              <span data-amount="">{formatKrw(detail.totalAmount)}</span> ·{" "}
              <time dateTime={dateTimeAttr(detail.createdAt)}>
                {formatTimestamp(detail.createdAt)}
              </time>{" "}
              신청
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="flex flex-wrap gap-2" data-testid="vendor-booking-status">
              <Badge>{detail.statusLabel}</Badge>
              <Badge variant="secondary">{detail.decisionLabel}</Badge>
              <Badge variant="secondary">{VENDOR_LANE_LABEL[detail.lane]}</Badge>
            </div>

            <p className="text-caption text-muted-foreground" data-testid="vendor-booking-settled">
              {detail.settledLabel}
            </p>

            {detail.declineReason !== null ? (
              // **거절 사유를 그대로 싣는다**(D-24) — 사유 없는 거절은 조율의 근거가 못 된다.
              <p className="rounded-md border border-border bg-muted p-3 text-caption text-muted-foreground">
                거절 사유 — {detail.declineReason}
              </p>
            ) : null}
          </CardContent>
        </Card>

        {/* ── 지금 내가 할 일 ───────────────────────────────────────────── */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">지금 할 일</CardTitle>
            <CardDescription>
              <strong>버튼은 목록 화면이 갖습니다.</strong> 같은 조치를 두 곳에 두면
              한쪽만 고쳐지는 날이 옵니다 — 여기서는 지금 할 수 있는지와 왜 못 하는지를
              적습니다.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <ActionLine
              label="예약 승인·거절"
              open={detail.canDecide}
              blocked={detail.decideBlockedReason}
            />
            <ActionLine
              label="계약서 발행"
              open={detail.canIssue}
              blocked={detail.issueBlockedReason}
            />

            {detail.canDecide || detail.canIssue ? (
              <Link
                href="/vendor/bookings"
                className="inline-block text-sm font-medium text-brand-600 underline"
                data-testid="vendor-booking-act"
              >
                목록에서 처리하기
              </Link>
            ) : null}
          </CardContent>
        </Card>

        {/* ── 사슬 ─────────────────────────────────────────────────────── */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">진행 기록</CardTitle>
            <CardDescription>
              <strong>새 표를 만들지 않았습니다</strong> — 전부 이미 어딘가에 시각으로
              적혀 있는 사실이고 여기서는 시간순으로 늘어놓기만 합니다(D-124).
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ol className="space-y-2" data-testid="vendor-booking-timeline">
              {detail.timeline.map((step) => (
                <li key={`${step.at}-${step.label}`} className="text-sm">
                  <time
                    dateTime={dateTimeAttr(step.at)}
                    className="text-caption text-muted-foreground"
                  >
                    {formatTimestamp(step.at)}
                  </time>
                  <span className="ml-2 text-foreground">{step.label}</span>
                  {step.detail !== null ? (
                    <span className="ml-1 text-caption text-muted-foreground">
                      — {step.detail}
                    </span>
                  ) : null}
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>

        {/* ── 회차 ─────────────────────────────────────────────────────── */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">결제 회차</CardTitle>
            <CardDescription>
              회차는 계약에 달립니다. <strong>계약 발행 전에는 회차가 없습니다</strong> —
              0건과 완납은 다른 뜻입니다.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {detail.schedules.length === 0 ? (
              <p className="text-caption text-muted-foreground">
                아직 회차가 없어요. 계약을 발행하면 여기에 나옵니다.
              </p>
            ) : (
              <ul className="space-y-1" data-testid="vendor-booking-schedules">
                {detail.schedules.map((schedule) => (
                  <li key={schedule.seq} className="flex justify-between text-sm">
                    <span className="text-muted-foreground">{schedule.seq}회차</span>
                    <span>
                      <span data-amount="">{formatKrw(schedule.amount)}</span>
                      <span className="ml-2 text-caption text-muted-foreground">
                        {schedule.status}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* ── 출처·참조 ─────────────────────────────────────────────────── */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">참조</CardTitle>
            <CardDescription>
              조율 문의가 들어올 때 운영자에게 알려 줄 값입니다.{" "}
              <strong>고객 식별정보는 싣지 않습니다.</strong>
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-1">
            <Reference label="예약" value={detail.id} />
            <Reference label="견적" value={detail.quoteId} empty="견적을 거치지 않은 예약" />
            <Reference
              label="계약"
              value={detail.contractId}
              empty="아직 발행되지 않음"
              href={detail.contractId === null ? null : `/contracts/${detail.contractId}`}
            />
          </CardContent>
        </Card>
      </div>
    </AdminShell>
  );
}

function ActionLine({
  label,
  open,
  blocked,
}: {
  label: string;
  open: boolean;
  blocked: string | null;
}) {
  return (
    <div className="rounded-md border border-border p-3" data-testid="vendor-booking-action">
      <p className="text-sm font-medium text-foreground">
        {label} {open ? <Badge className="ml-1">지금 가능</Badge> : null}
      </p>
      {/* **막힌 문을 감추지 않는다.** 감추면 "그런 기능이 없다" 로 읽힌다. */}
      {!open && blocked !== null ? (
        <p className="mt-1 text-caption text-muted-foreground">{blocked}</p>
      ) : null}
    </div>
  );
}

function Reference({
  label,
  value,
  empty,
  href,
}: {
  label: string;
  value: string | null;
  empty?: string;
  href?: string | null;
}) {
  return (
    <p className="text-caption text-muted-foreground">
      <span className="text-foreground">{label}</span>{" "}
      {value === null ? (
        (empty ?? "없음")
      ) : href ? (
        <Link href={href} className="underline">
          <code>{value}</code>
        </Link>
      ) : (
        <code>{value}</code>
      )}
    </p>
  );
}
