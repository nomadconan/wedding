import type { Metadata } from "next";
import Link from "next/link";

import { formatKrw } from "@/components/domain/PriceDisplay";
import { AdminShell } from "@/components/layout/AdminShell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { BOOKING_STATUS_LABEL, type BookingStatus } from "@/lib/core/booking/console";
import { dateTimeAttr, formatTimestamp } from "@/lib/core/format/timestamp";
import {
  CHAIN_STAGE_LABEL,
  loadAdminChain,
  loadAdminTransactions,
  progressLabel,
} from "@/lib/admin/transactions";
import { requireOperator } from "@/lib/supabase/auth";

export const metadata: Metadata = {
  title: "거래 조회 — 웨딩클리어",
};

/**
 * /admin/transactions — 운영자 거래 조회 (C-1 · §6.4)
 *
 * ══════════════════════════════════════════════════════════════════════════
 * **운영자는 거래를 집계 숫자로만 봤다** (B-1 조사 3)
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 문의·견적·상담·계약을 보는 유일한 경로가 대시보드의 건수였다. 조율 요청이 들어와도
 * "그 거래가 어디까지 왔나" 를 화면으로 답할 수 없었다.
 *
 * ── 목록과 상세를 한 라우트에 둔다 ─────────────────────────────────────────
 * `?id=` 로 고른다(`/cart?cart=N` 과 같은 방식). 링크를 그대로 공유하면 같은 거래가
 * 열리고 뒤로 가기가 선택을 되돌린다. 화면을 둘로 나누면 내비에 하나만 걸리고
 * 나머지 하나는 **URL 을 아는 사람만 여는 화면**이 된다(FIX-25 계열).
 *
 * ── 조회는 definer 함수 둘뿐이다 ───────────────────────────────────────────
 * 계약 정본·Storage 경로·고객 메모·업체 메모·상담 장소는 **함수 밖으로 나오지 않는다**
 * (0074 · D-120). 앱이 지울 것을 고르는 것이 아니라 **DB 가 안 준다.**
 *
 * ── 판정하지 않는다 (D-24) ─────────────────────────────────────────────────
 * 여기 있는 것은 시각과 상태뿐이다. '지연'·'문제' 같은 평가 어휘를 만들지 않는다 —
 * 플랫폼은 판정자가 아니라 조율자이고, 화면이 판정어를 쓰면 그 자체가 입장이 된다.
 *
 * **캐시하지 않는다**(FIX-22 계열).
 */
export const dynamic = "force-dynamic";

type PageProps = { searchParams: Promise<{ id?: string }> };

export default async function AdminTransactionsPage(props: PageProps) {
  await requireOperator("/admin/transactions");
  const searchParams = await props.searchParams;

  let rows: Awaited<ReturnType<typeof loadAdminTransactions>>;
  try {
    rows = await loadAdminTransactions();
  } catch {
    return (
      <AdminShell role="admin" title="거래 조회">
        <ErrorState
          code="ADMIN_TRANSACTIONS_LOAD_FAILED"
          title="거래를 불러오지 못했어요"
          description="잠시 후 다시 시도해 주세요."
        />
      </AdminShell>
    );
  }

  const selectedId = searchParams.id ?? null;
  const selected = selectedId === null ? null : rows.find((row) => row.bookingId === selectedId);
  const chain = selected ? await loadAdminChain(selected.bookingId) : [];

  return (
    <AdminShell
      role="admin"
      title="거래 조회"
      description="문의부터 정산까지 한 거래가 어디까지 왔는지 봅니다. 내부 관리용입니다."
    >
      <div className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">이 화면이 보여주는 것</CardTitle>
            <CardDescription>
              <strong>시각과 상태뿐입니다.</strong> 계약 정본·고객 메모·업체 메모·상담
              장소는 조회 함수가 내보내지 않습니다 — 화면이 가리는 것이 아니라 DB 가
              주지 않습니다. <strong>여기서 집행하지 않습니다</strong> — 조율은
              분쟁·위약금·정산 화면이 각자 합니다.
            </CardDescription>
          </CardHeader>
        </Card>

        {rows.length === 0 ? (
          <EmptyState
            assetId="admin.dashboard.empty"
            title="거래가 아직 없어요"
            description="고객이 견적을 수락하면 예약이 생기고 여기에 나옵니다."
          />
        ) : (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">거래 {rows.length}건</CardTitle>
              <CardDescription>최근 신청 순입니다.</CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="space-y-2" data-testid="admin-transactions">
                {rows.map((row) => (
                  <li
                    key={row.bookingId}
                    className={`rounded-lg border p-3 ${
                      row.bookingId === selectedId ? "border-brand-600" : "border-border"
                    }`}
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <p className="text-sm font-medium text-foreground">{row.vendorName}</p>
                      <p className="text-sm" data-amount="">
                        {formatKrw(row.totalAmount)}
                      </p>
                    </div>

                    <div className="mt-1 flex flex-wrap gap-1.5">
                      <Badge variant="secondary">
                        {BOOKING_STATUS_LABEL[row.bookingStatus as BookingStatus] ??
                          row.bookingStatus}
                      </Badge>
                      {row.contractStatus !== null ? (
                        <Badge variant="secondary">계약 {row.contractStatus}</Badge>
                      ) : null}
                      <Badge variant="secondary">{progressLabel(row)}</Badge>
                    </div>

                    <p className="mt-1 text-caption text-muted-foreground">
                      <time dateTime={dateTimeAttr(row.createdAt)}>
                        {formatTimestamp(row.createdAt)}
                      </time>{" "}
                      신청
                      {row.acceptedAt !== null ? " · 업체 승인" : ""}
                      {row.declinedAt !== null ? " · 업체 거절" : ""}
                    </p>

                    <p className="mt-1 text-caption">
                      <Link
                        href={`/admin/transactions?id=${row.bookingId}`}
                        className="text-brand-600 underline"
                        data-testid="admin-transaction-open"
                      >
                        진행 기록 보기
                      </Link>
                    </p>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}

        {selectedId !== null && selected === undefined ? (
          <Card>
            <CardContent className="pt-6">
              <p className="text-caption text-muted-foreground">
                고른 거래를 목록에서 찾지 못했어요. 목록이 100건까지만 실립니다.
              </p>
            </CardContent>
          </Card>
        ) : null}

        {selected ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">진행 기록 — {selected.vendorName}</CardTitle>
              <CardDescription>
                <strong>새 표를 만들지 않았습니다</strong> — 전부 이미 어딘가에 시각으로
                적혀 있는 사실을 시간순으로 늘어놓습니다(D-124).
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {chain.length === 0 ? (
                <p className="text-caption text-muted-foreground">
                  기록이 없어요. 예약이 방금 만들어졌거나 조회 권한이 없습니다.
                </p>
              ) : (
                <ol className="space-y-2" data-testid="admin-transaction-chain">
                  {chain.map((step) => (
                    <li key={`${step.stage}-${step.occurredAt}`} className="text-sm">
                      <time
                        dateTime={dateTimeAttr(step.occurredAt)}
                        className="text-caption text-muted-foreground"
                      >
                        {formatTimestamp(step.occurredAt)}
                      </time>
                      <span className="ml-2 text-foreground">
                        {CHAIN_STAGE_LABEL[step.stage] ?? step.stage}
                      </span>
                      {step.detail !== null ? (
                        <span className="ml-1 text-caption text-muted-foreground">
                          — {step.detail}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ol>
              )}

              <div className="rounded-md border border-border p-3">
                <p className="text-caption font-medium text-foreground">참조</p>
                <p className="text-caption text-muted-foreground">
                  예약 <code>{selected.bookingId}</code>
                </p>
                <p className="text-caption text-muted-foreground">
                  업체 <code>{selected.vendorId}</code> · 커플 <code>{selected.coupleId}</code>
                </p>
                {selected.quoteId !== null ? (
                  <p className="text-caption text-muted-foreground">
                    견적 <code>{selected.quoteId}</code>
                  </p>
                ) : null}
              </div>
            </CardContent>
          </Card>
        ) : null}
      </div>
    </AdminShell>
  );
}
