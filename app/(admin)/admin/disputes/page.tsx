import type { Metadata } from "next";
import Link from "next/link";

import { AdminShell } from "@/components/layout/AdminShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import {
  DISPUTE_REASON_LABEL,
  DISPUTE_STATUS_LABEL,
  MEDIATOR_NOTICE,
  agreementState,
  type DisputeStatus,
} from "@/lib/core/dispute/mediation";
import {
  DISPUTE_SOURCES,
  SOURCE_LABEL,
  type DisputeSource,
  elapsedHours,
} from "@/lib/core/dispute/queue";
import { loadBookingDispute, loadDisputeQueue } from "@/lib/dispute/loader";
import { requireOperator } from "@/lib/supabase/auth";

import { MediatePanel } from "./MediatePanel";

export const metadata: Metadata = {
  title: "분쟁 조율 — 웨딩클리어",
};

/**
 * /admin/disputes — 분쟁 조율 콘솔 (F-A-12·F-A-16, §6.4 — 8단계 · S8-03)
 *
 * ── 읽기는 하나로, 집행은 각자 (D-121) ─────────────────────────────────────
 * 분쟁이 쌓이는 자리가 넷인데 화면이 넷이면 운영자가 그 중 하나를 안 본다 — 실제로
 * **안전거래 이의는 화면 자체가 없어서**(FIX-15) 이의를 받아 놓고 처리할 자리가 없었다.
 * 그래서 큐는 합쳤다. 다만 **상태 어휘는 수렴시키지 않는다**: 출처 배지와 원 상태
 * 라벨이 함께 뜨고, 집행은 각 도메인의 규칙이 한다. S5-09 가 경고한 대로 규칙을
 * 하나로 모으면 **어느 한쪽의 기본값이 조용히 바뀐다**(보증금 무응답 → 환불,
 * 에스크로 무응답 → 릴리즈. 정반대다).
 *
 * ── 플랫폼은 판정자가 아니라 조율자다 (D-24) ───────────────────────────────
 * 조치 넷은 전부 *제시하거나 기록하는* 일이고 '플랫폼이 정한다' 는 조치가 없다.
 * 합의는 **양측이 다 동의해야** 기록된다(화면·라우트·DB CHECK 세 층).
 * 합의가 안 된 뒤의 절차는 **약관 소관**이며 이 화면이 정하지 않는다.
 *
 * `force-dynamic` (FIX-22 계열).
 */
export const dynamic = "force-dynamic";

type PageProps = { searchParams: Promise<{ source?: string; open?: string }> };

function shortId(id: string | null): string {
  return id ? id.slice(0, 8) : "—";
}

function isSource(value: string | undefined): value is DisputeSource {
  return Boolean(value) && (DISPUTE_SOURCES as readonly string[]).includes(value as string);
}

export default async function AdminDisputesPage({ searchParams }: PageProps) {
  await requireOperator("/admin/disputes");

  const params = await searchParams;
  // 모르는 값은 **거절하지 않고 버린다** — 분쟁 큐는 사고가 났을 때 여는 화면이고,
  // 조건 하나가 틀렸다고 안 열리는 것이 가장 나쁘다(S8-02 와 같은 판단).
  const source = isSource(params.source) ? params.source : null;

  let payload: Awaited<ReturnType<typeof loadDisputeQueue>>;
  try {
    payload = await loadDisputeQueue();
  } catch {
    return (
      <AdminShell role="admin" title="분쟁 조율">
        <ErrorState
          code="DISPUTE_LOAD_FAILED"
          title="분쟁 큐를 불러오지 못했어요"
          description="잠시 후 다시 시도해 주세요. 계속되면 운영 담당자에게 알려 주세요."
        />
      </AdminShell>
    );
  }

  const now = new Date();
  const shown = source ? payload.items.filter((item) => item.source === source) : payload.items;

  // 예약 분쟁만 이 화면에서 조율한다. 상세(조율안·합의 상태)를 함께 싣는다.
  const bookingDetails = new Map(
    (
      await Promise.all(
        shown
          .filter((item) => item.source === "booking")
          .slice(0, 50)
          .map((item) => loadBookingDispute(item.id)),
      )
    )
      .filter((row): row is NonNullable<typeof row> => row !== null)
      .map((row) => [row.id, row]),
  );

  return (
    <AdminShell
      role="admin"
      title="분쟁 조율"
      description="네 곳에 쌓이는 분쟁을 한 목록에서 봅니다. 집행 규칙은 각 도메인이 그대로 갖습니다."
    >
      <div className="space-y-6">
        {/* ── D-24 고지 ─────────────────────────────────────────────────── */}
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm font-medium text-foreground">{MEDIATOR_NOTICE}</p>
          </CardContent>
        </Card>

        {payload.failedSources.length > 0 ? (
          <ErrorState
            code="DISPUTE_SOURCE_UNAVAILABLE"
            title="일부 출처를 읽지 못했어요"
            description={`${payload.failedSources
              .map((item) => SOURCE_LABEL[item])
              .join(" · ")} 를 불러오지 못했습니다. 목록이 비어 보이는 것과 다릅니다 — 아래 개수는 실제보다 적을 수 있습니다.`}
          />
        ) : null}

        {/* ── 출처별 개수 ───────────────────────────────────────────────── */}
        <section aria-labelledby="summary-heading">
          <Card>
            <CardHeader>
              <CardTitle id="summary-heading" className="text-base">
                출처별 현황
              </CardTitle>
              <CardDescription>
                <strong>0건인 출처도 줄을 남깁니다.</strong> 빼 버리면 &apos;이 종류는 분쟁이
                없다&apos;와 &apos;이 종류는 큐에 안 붙어 있다&apos;가 겹쳐 읽힙니다 — 안전거래
                이의가 정확히 후자였고, 줄이 없어서 아무도 눈치채지 못했습니다.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" data-testid="dispute-summary">
                {payload.summary.map((row) => (
                  <Link
                    key={row.source}
                    href={row.source === source ? "/admin/disputes" : `/admin/disputes?source=${row.source}`}
                    className={`rounded-lg border p-4 transition-colors ${
                      row.source === source
                        ? "border-brand-500 bg-brand-50"
                        : "border-border hover:bg-secondary"
                    }`}
                    data-testid="summary-tile"
                    data-source={row.source}
                  >
                    <p className="text-unit text-muted-foreground">{row.label}</p>
                    <p className="mt-1 flex items-baseline gap-1">
                      <span data-amount="" className="text-amount-sm text-foreground">
                        {row.open}
                      </span>
                      <span className="text-unit text-muted-foreground">건 대기</span>
                    </p>
                    <p className="mt-1 text-caption text-muted-foreground">
                      전체 {row.total}건
                      {row.source === "cancellation" ? " · /admin/penalties 에서 처리" : null}
                    </p>
                  </Link>
                ))}
              </div>
            </CardContent>
          </Card>
        </section>

        {/* ── 큐 ────────────────────────────────────────────────────────── */}
        <section aria-labelledby="queue-heading">
          <Card>
            <CardHeader>
              <CardTitle id="queue-heading" className="text-base">
                조율 큐{source ? ` · ${SOURCE_LABEL[source]}` : ""}
              </CardTitle>
              <CardDescription>
                열린 것이 먼저, 그 안에서 오래된 것부터입니다.{" "}
                <strong>금액으로 줄을 세우지 않습니다</strong> — 작은 건이 오래 방치되는 것이
                분쟁에서는 더 나쁩니다.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {shown.length === 0 ? (
                <EmptyState
                  title={source ? "이 출처에는 분쟁이 없어요" : "지금 조율할 분쟁이 없어요"}
                  description="접수되면 여기에 쌓입니다. 조회는 정상입니다."
                />
              ) : (
                <ol className="space-y-3" data-testid="dispute-queue">
                  {shown.map((item) => {
                    const detail = bookingDetails.get(item.id);

                    return (
                      <li
                        key={`${item.source}-${item.id}`}
                        className="rounded-lg border border-border p-4"
                        data-testid="dispute-item"
                        data-source={item.source}
                        data-open={item.isOpen}
                      >
                        <div className="flex flex-wrap items-baseline justify-between gap-2">
                          <span className="flex flex-wrap items-center gap-2">
                            <Badge variant={item.isOpen ? "secondary" : "outline"}>
                              {SOURCE_LABEL[item.source]}
                            </Badge>
                            {/* **원 상태를 번역하지 않는다.** 출처마다 뜻이 다르다. */}
                            <span className="text-sm font-medium text-foreground">
                              {item.source === "booking"
                                ? DISPUTE_STATUS_LABEL[item.status as DisputeStatus] ?? item.status
                                : item.status}
                            </span>
                            {item.reasonCode ? (
                              <span className="text-caption text-muted-foreground">
                                {DISPUTE_REASON_LABEL[item.reasonCode] ?? item.reasonCode}
                              </span>
                            ) : null}
                          </span>
                          <time className="text-caption text-muted-foreground" dateTime={item.openedAt}>
                            {elapsedHours(item.openedAt, now)}시간 경과
                          </time>
                        </div>

                        <p className="mt-1 text-caption text-muted-foreground">
                          {shortId(item.id)}
                          {item.bookingId ? ` · 예약 ${shortId(item.bookingId)}` : " · 예약 정보 없음"}
                          {/* 금액을 모르면 **0원이 아니라 '금액 없음'** 이다. */}
                          {item.amountKrw === null
                            ? " · 걸린 금액 없음"
                            : ` · ${item.amountKrw.toLocaleString("en-US")}원`}
                        </p>

                        {detail ? (
                          <>
                            <p className="mt-1.5 text-caption text-muted-foreground">
                              합의 진행 · <strong>{agreementState(detail.coupleAgreed, detail.vendorAgreed)}</strong>
                              {detail.evidenceCount > 0
                                ? ` · 증빙 ${detail.evidenceCount}건(열람 경로는 아직 없습니다)`
                                : " · 증빙 없음"}
                            </p>
                            {detail.proposalNote ? (
                              <p className="mt-1 text-sm text-foreground">
                                <span className="text-muted-foreground">조율안 · </span>
                                {detail.proposalNote}
                              </p>
                            ) : null}
                            {detail.resolutionNote ? (
                              <p className="mt-1 text-sm text-foreground">
                                <span className="text-muted-foreground">종결 사유 · </span>
                                {detail.resolutionNote}
                              </p>
                            ) : null}
                          </>
                        ) : null}

                        <div className="mt-2 flex flex-wrap gap-2">
                          {/* 증적 타임라인 — S8-02 가 만든 것을 그대로 쓴다. */}
                          {item.bookingId ? (
                            <Button asChild size="sm" variant="outline">
                              <Link
                                href={`/admin/audit?targetType=booking&targetId=${item.bookingId}`}
                              >
                                증적 타임라인
                              </Link>
                            </Button>
                          ) : null}
                          {item.handledAt === "penalties" ? (
                            <Button asChild size="sm" variant="outline">
                              <Link href="/admin/penalties">위약금 화면에서 처리</Link>
                            </Button>
                          ) : null}
                        </div>

                        {detail ? (
                          <MediatePanel
                            disputeId={detail.id}
                            status={detail.status as DisputeStatus}
                            coupleAgreed={detail.coupleAgreed}
                            vendorAgreed={detail.vendorAgreed}
                          />
                        ) : null}

                        {item.source === "consultation" || item.source === "escrow" ? (
                          <p className="mt-2 text-caption text-muted-foreground">
                            이 건의 집행(환불·몰취·릴리즈)은 해당 도메인의 규칙이 정합니다 — 무응답
                            기본값이 서로 달라 조율 콘솔이 대신 정하지 않습니다.
                          </p>
                        ) : null}
                      </li>
                    );
                  })}
                </ol>
              )}
            </CardContent>
          </Card>
        </section>
      </div>
    </AdminShell>
  );
}
