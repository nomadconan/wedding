import type { Metadata } from "next";
import Link from "next/link";

import { MetricTile } from "@/components/domain/MetricTile";
import { AdminShell } from "@/components/layout/AdminShell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { dateTimeAttr, formatTimestamp } from "@/lib/core/format/timestamp";
import { measured } from "@/lib/core/stats/metric";
import {
  SIBLING_QUEUES,
  TICKET_CATEGORY_LABEL,
  TICKET_STATUS_LABEL,
  USER_SANCTION_UNAVAILABLE,
  elapsedHours,
  isTerminal,
  type TicketStatus,
} from "@/lib/core/support/ticket";
import { loadSupportConsole } from "@/lib/support/admin";
import { requireOperator } from "@/lib/supabase/auth";

import { SanctionPanel } from "./SanctionPanel";
import { TicketPanel } from "./TicketPanel";

export const metadata: Metadata = {
  title: "CS·신고 — 웨딩클리어",
};

/**
 * /admin/tickets — CS·신고 처리 (F-A-06, §6.4 — 8단계 · S8-09)
 *
 * ── 이 화면이 지키는 규칙 ───────────────────────────────────────────────────
 * 1. **큐를 합치지 않는다**(D-142). 신고가 쌓이는 자리가 넷인데 대상도 조치도 달라,
 *    한 목록에 섞으면 처리 절차가 서로 다른 건이 같은 줄에 놓인다. 대신 **열린
 *    건수와 링크를 함께 보인다** — 합치지 않되 놓치지 않게 한다.
 * 2. **판정 어휘를 쓰지 않는다**(D-24). '조치함·조치하지 않음' 이며 뒤쪽이 "신고자가
 *    틀렸다" 는 뜻이 아니라는 것을 화면이 적는다.
 * 3. **집행할 수 있는 것만 버튼으로 둔다.** 업체 중지는 실제로 사라지게 하지만
 *    사용자 정지는 집행 수단이 없어 **만들지 않고 그 사실을 적는다**(O-14).
 * 4. **'지연' 이라고 적지 않는다.** CS 처리 기한이 정해지지 않았고 지어낸 기한은 곧
 *    운영 기준으로 굳는다(D-119 가 삭제 요청에서 정한 것과 같다). 경과 시간만 적는다.
 * 5. **캐시하지 않는다**(FIX-22 계열).
 */
export const dynamic = "force-dynamic";

export default async function AdminTicketsPage() {
  await requireOperator("/admin/tickets");

  const now = new Date();

  let payload: Awaited<ReturnType<typeof loadSupportConsole>>;
  try {
    payload = await loadSupportConsole();
  } catch {
    return (
      <AdminShell role="admin" title="CS·신고">
        <ErrorState
          code="SUPPORT_LOAD_FAILED"
          title="티켓을 불러오지 못했어요"
          description="잠시 후 다시 시도해 주세요. 계속되면 운영 담당자에게 알려 주세요."
        />
      </AdminShell>
    );
  }

  const { tickets, summary, siblings, suspendedVendors } = payload;
  const openTickets = tickets.filter((ticket) => !isTerminal(ticket.status));

  return (
    <AdminShell
      role="admin"
      title="CS·신고"
      description="계정·결제·업체 관련 문의와 신고를 받습니다."
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
                처리 기한이 정해져 있지 않아 <strong>&apos;지연&apos;이라고 적지
                않습니다.</strong> 경과 시간만 보여드립니다 — 지어낸 기한은 곧 운영 기준으로
                굳습니다.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <MetricTile
                  label="담당자 없는 티켓"
                  metric={measured(summary.unassigned)}
                  unit="건"
                  hint="가장 먼저 봐야 하는 값입니다."
                />
                <MetricTile label="접수" metric={measured(summary.open)} unit="건" />
                <MetricTile label="담당 배정" metric={measured(summary.assigned)} unit="건" />
                <MetricTile
                  label="종결"
                  metric={measured(summary.resolved + summary.rejected)}
                  unit="건"
                  hint={`조치함 ${summary.resolved} · 조치하지 않음 ${summary.rejected}`}
                />
              </div>
            </CardContent>
          </Card>
        </section>

        {/* ── 옆 큐 ─────────────────────────────────────────────────────── */}
        <section aria-labelledby="siblings-heading">
          <Card>
            <CardHeader>
              <CardTitle id="siblings-heading" className="text-base">
                다른 신고 큐
              </CardTitle>
              <CardDescription>
                <strong>여기로 합치지 않았습니다.</strong> 대상도 조치도 달라 한 목록에
                섞으면 처리 절차가 서로 다른 건이 같은 줄에 놓입니다. 대신 열린 건수를 함께
                보여드립니다 — 합치지 않되 놓치지 않게.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="space-y-2">
                {SIBLING_QUEUES.map((queue) => {
                  const count = siblings.find((row) => row.key === queue.key)?.open ?? 0;

                  return (
                    <li
                      key={queue.key}
                      className="flex flex-wrap items-center gap-2 rounded-md border border-border p-3"
                    >
                      <Link href={queue.href} className="font-medium text-brand-600 underline">
                        {queue.label}
                      </Link>
                      <Badge variant={count > 0 ? "default" : "outline"}>대기 {count}건</Badge>
                      <span className="text-caption text-muted-foreground">{queue.action}</span>
                    </li>
                  );
                })}
              </ul>
            </CardContent>
          </Card>
        </section>

        {/* ── 티켓 ──────────────────────────────────────────────────────── */}
        <section aria-labelledby="tickets-heading">
          <Card>
            <CardHeader>
              <CardTitle id="tickets-heading" className="text-base">
                티켓 {tickets.length}건 · 처리 대기 {openTickets.length}건
              </CardTitle>
              <CardDescription>
                <strong>&apos;조치하지 않음&apos;은 신고자가 틀렸다는 뜻이 아닙니다.</strong>{" "}
                우리가 조치하지 않기로 했다는 뜻이며, 그 사유는 신고자에게 그대로 보입니다.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {tickets.length === 0 ? (
                <EmptyState
                  title="접수된 티켓이 없습니다"
                  description="회원이 마이페이지의 '문의·신고'에서 접수하면 여기에 쌓입니다."
                />
              ) : (
                <ul className="space-y-3">
                  {tickets.map((ticket) => (
                    <li key={ticket.id} className="rounded-lg border border-border p-4">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-foreground">{ticket.subject}</span>
                        <Badge
                          variant={
                            ticket.status === "open"
                              ? "default"
                              : ticket.status === "assigned"
                                ? "secondary"
                                : "outline"
                          }
                        >
                          {TICKET_STATUS_LABEL[ticket.status as TicketStatus] ?? ticket.status}
                        </Badge>
                        <Badge variant="outline">
                          {TICKET_CATEGORY_LABEL[ticket.category] ?? ticket.category}
                        </Badge>
                        {ticket.assigneeName !== null ? (
                          <span className="text-caption text-muted-foreground">
                            담당 {ticket.assigneeName}
                          </span>
                        ) : null}
                      </div>

                      {ticket.body ? (
                        <p className="mt-2 whitespace-pre-wrap text-sm text-foreground">
                          {ticket.body}
                        </p>
                      ) : null}

                      <p className="mt-2 text-caption text-muted-foreground">
                        <time dateTime={dateTimeAttr(ticket.createdAt)}>
                          {formatTimestamp(ticket.createdAt)}
                        </time>
                        {" 접수 · 경과 "}
                        {elapsedHours(ticket.createdAt, now)}시간
                        {" · "}
                        <Link href="/admin/audit?targetType=ticket" className="underline">
                          증적 타임라인
                        </Link>
                      </p>

                      {ticket.resolution !== null ? (
                        <p className="mt-2 rounded-md bg-muted p-2 text-sm text-foreground">
                          처리 — {ticket.resolution}
                        </p>
                      ) : null}

                      <TicketPanel ticketId={ticket.id} status={ticket.status} />
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </section>

        {/* ── 제재 ──────────────────────────────────────────────────────── */}
        <section aria-labelledby="sanction-heading">
          <Card>
            <CardHeader>
              <CardTitle id="sanction-heading" className="text-base">
                제재 조치
              </CardTitle>
              <CardDescription>
                <strong>집행할 수 있는 것만 버튼으로 둡니다.</strong> 업체 공개 중지는 탐색·검색·
                상세에서 즉시 사라지게 합니다. <strong>사용자 계정 정지는 없습니다</strong> —{" "}
                {USER_SANCTION_UNAVAILABLE.message} ({USER_SANCTION_UNAVAILABLE.openIssue})
              </CardDescription>
            </CardHeader>
            <CardContent>
              {suspendedVendors.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  지금 공개 중지된 업체가 없습니다. 중지는 업체 관련 티켓에서 실행합니다 —
                  입점 심사(`/admin/vendors`)의 승인·반려와는 다른 조치입니다.
                </p>
              ) : (
                <ul className="space-y-2">
                  {suspendedVendors.map((vendor) => (
                    <li key={vendor.id} className="rounded-md border border-border p-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-foreground">{vendor.name}</span>
                        <Badge variant="secondary">공개 중지됨</Badge>
                      </div>
                      <SanctionPanel
                        vendorId={vendor.id}
                        vendorName={vendor.name}
                        suspended
                        ticketId={null}
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
