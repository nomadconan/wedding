import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { BrokerNotice } from "@/components/domain/BrokerNotice";
import { formatKrw } from "@/components/domain/PriceDisplay";
import { ConsumerShell } from "@/components/layout/ConsumerShell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { COUPLE_SIGNER_NOTICE } from "@/lib/core/contract/contract";
import { dateTimeAttr, formatTimestamp } from "@/lib/core/format/timestamp";
import { loadContract } from "@/lib/contract/read";
import { requireUser } from "@/lib/supabase/auth";

import { SignPanel } from "./SignPanel";

export const metadata: Metadata = {
  title: "계약서 — 웨딩클리어",
};

/**
 * /contracts/[id] — 전자계약 열람·서명 (FIX-57 해소 · F-C-15 · §6.2)
 *
 * ══════════════════════════════════════════════════════════════════════════
 * **리포의 유일한 죽은 링크였다**
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 소비자 예약 상세(`entryPoints`)와 `/vendor/bookings` **둘 다** 이 경로로 링크하는데
 * 화면이 없었다. `docs/ROUTES.md` 가 "실재하는 화면 라우트가 없다" 로 세고 있었고
 * FIX-57 로 기록돼 있었다 — 데이터·서명 API·정본 해시는 전부 있고 **볼 자리만** 없었다.
 *
 * ── 소비자 라우트 그룹에 둔다 ──────────────────────────────────────────────
 * 경로가 `/contracts/[id]` 이고 **세 당사자가 같은 URL 을 연다**(커플·업체·플래너).
 * 업체 셸로 감싸면 고객이 업체 화면을 보게 되므로 소비자 셸로 두고, 업체는
 * `/vendor/bookings/[id]` 의 참조 링크로 들어온다.
 *
 * ── 조항 번호를 지어내지 않는다 (§7.7 · T-04) ──────────────────────────────
 * 문안은 법무 검수(O-03) 전까지 비어 있다. **빈 칸을 그리지 않고 비어 있다고 적는다** —
 * 빈 칸은 "조항이 없는 계약" 으로 읽힌다.
 *
 * **캐시하지 않는다** — 서명 상태가 굳으면 이미 서명한 사람에게 버튼이 남는다.
 */
export const dynamic = "force-dynamic";

export default async function ContractPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const user = await requireUser(`/contracts/${params.id}`);

  const contract = await loadContract(params.id, new Date(), user.id);

  // **없는 것과 못 보는 것을 같게 답한다** — 남의 계약의 존재 여부를 알려주지 않는다.
  if (contract === null) notFound();

  return (
    <ConsumerShell title="계약서">
      <div className="space-y-4">
        <p className="text-caption">
          <Link href={`/bookings/${contract.bookingId}`} className="text-brand-600 underline">
            ← 예약 상세
          </Link>
        </p>

        {/* ── 지금 상태 ─────────────────────────────────────────────────── */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{contract.stateLabel}</CardTitle>
            <CardDescription>
              총액 <span data-amount="">{formatKrw(contract.totalAmount)}</span>
              {contract.issuedAt !== null ? (
                <>
                  {" · "}
                  <time dateTime={dateTimeAttr(contract.issuedAt)}>
                    {formatTimestamp(contract.issuedAt)}
                  </time>{" "}
                  발행
                </>
              ) : null}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="flex flex-wrap gap-2">
              <Badge>{contract.statusLabel}</Badge>
              <Badge variant="secondary" data-testid="contract-progress">
                서명 {contract.signedCount}/{contract.requiredCount}
              </Badge>
            </div>

            {contract.signingDeadlineAt !== null && contract.state === "awaiting" ? (
              <p className="text-caption text-muted-foreground">
                서명 기한{" "}
                <time dateTime={dateTimeAttr(contract.signingDeadlineAt)}>
                  {formatTimestamp(contract.signingDeadlineAt)}
                </time>
              </p>
            ) : null}

            {contract.cancelReason !== null ? (
              <p className="rounded-md border border-border bg-muted p-3 text-caption text-muted-foreground">
                해지 사유 — {contract.cancelReason}
              </p>
            ) : null}
          </CardContent>
        </Card>

        {/* ── 서명 ─────────────────────────────────────────────────────── */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">서명</CardTitle>
            <CardDescription>{COUPLE_SIGNER_NOTICE}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <ul className="space-y-1" data-testid="contract-signatures">
              {contract.signatures.map((signature) => (
                <li key={signature.role} className="flex justify-between text-sm">
                  <span className="text-foreground">{signature.roleLabel}</span>
                  {signature.signedAt === null ? (
                    <span className="text-caption text-muted-foreground">서명 전</span>
                  ) : (
                    <time
                      dateTime={dateTimeAttr(signature.signedAt)}
                      className="text-caption text-muted-foreground"
                    >
                      {formatTimestamp(signature.signedAt)} 서명
                    </time>
                  )}
                </li>
              ))}
            </ul>

            {contract.canISign ? (
              <SignPanel contractId={contract.id} contentHash={contract.contentHash} />
            ) : (
              // **막힌 이유를 적는다.** 감추면 "서명 기능이 없다" 로 읽힌다.
              <p className="text-caption text-muted-foreground" data-testid="contract-sign-blocked">
                {contract.signBlockedReason}
              </p>
            )}
          </CardContent>
        </Card>

        {/* ── 조항 ─────────────────────────────────────────────────────── */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">계약 조항</CardTitle>
            <CardDescription>
              판본 {contract.templateVersion ?? "알 수 없음"} ·{" "}
              <strong>문안은 법무 검수 전이라 비어 있습니다</strong>(O-03). 조항 번호는
              검수 전까지 어디에도 적지 않습니다.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {contract.clauses.length === 0 ? (
              <p className="text-caption text-muted-foreground">
                이 계약에 등록된 조항 항목이 없어요.
              </p>
            ) : (
              <ol className="space-y-3" data-testid="contract-clauses">
                {contract.clauses.map((clause) => (
                  <li key={clause.code}>
                    <p className="text-sm font-medium text-foreground">{clause.title}</p>
                    {clause.body === null ? (
                      <p className="text-caption text-muted-foreground">
                        문안 미확정 — 근거 {clause.basisNote}
                      </p>
                    ) : (
                      <p className="whitespace-pre-line text-sm text-foreground">{clause.body}</p>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </CardContent>
        </Card>

        {/* ── 정본 ─────────────────────────────────────────────────────── */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">정본 확인</CardTitle>
            <CardDescription>
              서명은 <strong>이 해시의 내용에</strong> 붙습니다. 내용이 바뀌면 해시가
              달라지고 기존 서명은 그 내용에 붙지 않습니다(D-23).
            </CardDescription>
          </CardHeader>
          <CardContent>
            <p className="break-all text-caption text-muted-foreground" data-testid="contract-hash">
              <code>{contract.contentHash}</code>
            </p>
          </CardContent>
        </Card>

        {/* 플랫폼 지위 고지 — 거래 화면에 상시(§7.7 · D-24). */}
        <BrokerNotice />
      </div>
    </ConsumerShell>
  );
}
