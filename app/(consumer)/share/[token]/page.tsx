import type { Metadata } from "next";
import Link from "next/link";

import { AiDisclaimer } from "@/components/domain/AiDisclaimer";
import { formatKrw } from "@/components/domain/PriceDisplay";
import { ConsumerShell } from "@/components/layout/ConsumerShell";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { ESTIMATE_FLAG_LABEL, LOWEST_REASON_NOTE } from "@/lib/core/estimate/normalize";
import { SEVERITY_LABEL } from "@/lib/core/report/pipeline";
import { SHARE_STATE_LABEL, SHARE_STATE_NOTE, SHARE_VIEW_NOTICE } from "@/lib/core/share/share";
import { openShareLink, type SharedComparison, type SharedReport } from "@/lib/share/links";
import { cn } from "@/lib/utils";

/**
 * /share/[token] — 공유받은 화면 (F-C-20 · 명세서 §6.2)
 *
 * ── 받는 사람은 우리 사용자가 아니다 ────────────────────────────────────────
 * **로그인을 요구하지 않는다**(미들웨어 `PROTECTED_PREFIXES` 에도 없다). 링크는
 * **토큰을 가진 것이 곧 권한**이며, 판정은 `share_link_open()`(SECURITY DEFINER ·
 * 0046)이 만료·거둠까지 확인한다.
 *
 * **하단 탭을 숨긴다.** 탭은 전부 로그인 뒤 화면이라, 공유만 받은 사람에게는
 * **누르면 로그인 벽이 나오는 다섯 칸**이 된다 — 없는 화면으로 보내지 않는다는 규칙
 * (S3-11 · D-55)의 같은 얼굴이다. 대신 아래에 랜딩으로 가는 안내 하나만 둔다.
 *
 * ── 닫힌 링크를 404 하나로 답하지 않는다 ────────────────────────────────────
 * 만료·거둠·없음은 **다음에 할 일이 다르다.** 뭉뚱그리면 만료된 링크를 받은 사람이
 * 자기가 주소를 잘못 옮겼다고 생각한다.
 *
 * ── 뷰 전용·마스킹 상태 ─────────────────────────────────────────────────────
 * 고칠 수단을 두지 않는다. 리포트의 조항 인용은 `clause_excerpt_masked`(S7-03)이고
 * 원문은 분석 직후 파기됐다(D-58). **협상 문구는 아예 오지 않는다** — 로더가 벗겨
 * 낸다(S7-12). 비교표는 **저장한 스냅샷 그대로**이며 다시 계산하지 않는다(D-87 · S7-05).
 */
export const metadata: Metadata = {
  title: "공유받은 자료 — 웨딩클리어",
  // 공유 링크는 **색인 대상이 아니다.** 토큰이 검색에 걸리면 만료 전까지 누구나 연다.
  robots: { index: false, follow: false },
};

/**
 * **정적 렌더를 끈다.** 이 화면은 쿠키를 읽지 않아 빌드 시점에 굳을 수 있고, 그러면
 * 거둔 링크가 계속 열린다(FIX-22 계열 · S7-12 의 흐름 점검이 잡았다).
 */
export const dynamic = "force-dynamic";

export default async function SharePage({ params }: { params: { token: string } }) {
  const opened = await openShareLink(params.token);

  if (opened.state !== "live") {
    return (
      <ConsumerShell title="공유받은 자료" hideTabBar>
        <div className="space-y-4" data-testid="share-closed" data-state={opened.state}>
          <EmptyState
            title={SHARE_STATE_LABEL[opened.state]}
            description={SHARE_STATE_NOTE[opened.state]}
          />
          <LandingLink />
        </div>
      </ConsumerShell>
    );
  }

  const { resource } = opened;

  return (
    <ConsumerShell title="공유받은 자료" hideTabBar>
      <div className="space-y-4" data-testid="share-view" data-kind={resource.kind}>
        <p className="rounded-lg border border-border p-3 text-caption text-muted-foreground">
          {SHARE_VIEW_NOTICE}
        </p>

        {resource.kind === "report" ? (
          <SharedReportView resource={resource} />
        ) : (
          <SharedComparisonView resource={resource} />
        )}

        <p className="text-caption text-neutral-500" data-testid="share-expiry">
          이 링크는 {opened.expiresAt.slice(0, 10)}까지 열려 있어요.
        </p>

        <LandingLink />
      </div>
    </ConsumerShell>
  );
}

/** 리포트 공유 화면. **협상 문구는 오지 않는다** — 로더가 벗겨 낸다(S7-12). */
function SharedReportView({ resource }: { resource: SharedReport }) {
  return (
    <>
      {/* 고지는 **상시 고정**이다. 접거나 툴팁으로 만들지 않는다. */}
      <AiDisclaimer basisRef={resource.basisRefs} />

      <section className="space-y-2" data-testid="share-summary">
        <div className="flex flex-wrap items-center gap-2">
          {resource.riskScore === null ? (
            // **점수가 없으면 0으로 그리지 않는다** — 계산되지 않은 것과 0점은 다르다.
            <Badge variant="outline">위험 점수 없음</Badge>
          ) : (
            <Badge variant="secondary">위험 점수 {resource.riskScore}</Badge>
          )}

          {(["high", "mid", "low"] as const).map((severity) =>
            resource.counts[severity] === 0 ? null : (
              <Badge key={severity} variant={severity === "high" ? "destructive" : "secondary"}>
                {SEVERITY_LABEL[severity]} {resource.counts[severity]}건
              </Badge>
            ),
          )}
        </div>
        <p className="text-caption text-neutral-500">
          {resource.createdAt.slice(0, 10)}에 검토한 결과예요.
        </p>
      </section>

      {resource.findings.length === 0 ? (
        <EmptyState
          title="눈에 띄는 조항이 없었어요"
          description="검출 룰에 걸린 조항이 없습니다. 계약 전 전문가 확인은 별도로 권해요."
        />
      ) : (
        <ul className="space-y-2" data-testid="share-findings">
          {resource.findings.map((finding) => (
            <li
              key={finding.id}
              className={cn(
                "space-y-2 rounded-lg border p-4",
                finding.severity === "high" ? "border-danger/40" : "border-border",
              )}
              data-testid="share-finding"
              data-severity={finding.severity}
            >
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={finding.severity === "high" ? "destructive" : "secondary"}>
                  {SEVERITY_LABEL[finding.severity]}
                </Badge>
                <span className="text-caption text-muted-foreground">{finding.rule_code}</span>
              </div>

              {finding.clauseExcerpt === null ? null : (
                <blockquote className="border-l-2 border-border pl-3 text-caption text-muted-foreground">
                  {finding.clauseExcerpt}
                </blockquote>
              )}

              {finding.explanation === null ? null : (
                <p className="text-sm text-foreground">{finding.explanation}</p>
              )}

              {finding.basisRef === null ? null : (
                <p className="text-caption text-neutral-500">근거 {finding.basisRef}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/**
 * 비교표 공유 화면 (S7-05 가 연 유형).
 *
 * **저장한 스냅샷을 그대로 그린다** — 다시 계산하지 않는다(D-87). 견적이 만료·변경돼도
 * 받은 사람은 **보낸 사람이 만든 그 표**를 본다. **빈 칸은 0이 아니고**(공유본에서도
 * 그렇다) 우열을 정할 수 없으면 사유를 적는다.
 */
function SharedComparisonView({ resource }: { resource: SharedComparison }) {
  const { comparison } = resource;
  const lowest = comparison.lowest;
  const lowestName =
    lowest.kind === "lowest"
      ? (comparison.columns.find((column) => column.quoteId === lowest.quoteId)?.vendorName ??
        "고른 견적")
      : null;

  return (
    <div className="space-y-3" data-testid="share-comparison">
      <p className="text-caption text-neutral-500">
        {resource.createdAt.slice(0, 10)}에 만든 비교표예요. 그때의 값을 그대로 보여드려요.
      </p>

      {lowest.kind === "lowest" ? (
        <p className="text-sm text-success" data-testid="share-comparison-lowest">
          실총액이 가장 낮은 것은 {lowestName} — {formatKrw(lowest.amount)}원이에요.
        </p>
      ) : (
        <p className="text-sm text-muted-foreground" data-testid="share-comparison-note">
          {LOWEST_REASON_NOTE[lowest.reason]}
        </p>
      )}

      <p className="text-caption text-neutral-500">{comparison.plannerNote}</p>

      {/* 좁은 화면에서 표가 넘치면 가로로 민다. 줄바꿈으로 뭉개지 않는다. */}
      <div className="-mx-gutter overflow-x-auto px-gutter">
        <table className="w-full min-w-[520px] border-collapse text-caption">
          <thead>
            <tr>
              <th className="border-b border-border p-2 text-left text-muted-foreground">항목</th>
              {comparison.columns.map((column) => (
                <th key={column.quoteId} className="border-b border-border p-2 text-left">
                  <span className="block text-sm font-medium text-foreground">
                    {column.vendorName}
                  </span>
                  <span className="block text-muted-foreground">
                    {column.productName ?? "상품 미정"}
                  </span>
                </th>
              ))}
            </tr>
          </thead>

          <tbody>
            {comparison.rows.map((row) => (
              <tr key={row.category} data-testid="share-comparison-row">
                <th className="border-b border-border p-2 text-left font-normal text-muted-foreground">
                  {row.label}
                </th>
                {row.amounts.map((amount, index) => (
                  <td
                    key={comparison.columns[index].quoteId}
                    className="border-b border-border p-2 text-foreground"
                  >
                    {/* **빈 칸은 0이 아니다.** '0원에 해 준다' 로 읽히면 안 된다. */}
                    {amount === null ? (
                      <span className="text-neutral-500">없음</span>
                    ) : (
                      `${formatKrw(amount)}원`
                    )}
                  </td>
                ))}
              </tr>
            ))}

            <tr>
              <th className="p-2 text-left text-foreground">실총액</th>
              {comparison.columns.map((column) => (
                <td key={column.quoteId} className="p-2 text-sm font-semibold text-foreground">
                  {formatKrw(column.realTotal)}원
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>

      <ul className="space-y-1" data-testid="share-comparison-flags">
        {comparison.columns.flatMap((column) =>
          column.flags.map((flag) => (
            <li key={`${column.quoteId}-${flag.kind}`} className="text-caption text-warning">
              {column.vendorName} — {ESTIMATE_FLAG_LABEL[flag.kind]}
            </li>
          )),
        )}
      </ul>
    </div>
  );
}

/** 공유만 받은 사람이 갈 수 있는 유일한 곳. 로그인 벽 뒤로 보내지 않는다. */
function LandingLink() {
  return (
    <Link
      href="/"
      className="block rounded-lg border border-border px-4 py-3 text-center text-sm font-medium text-brand-600"
      data-testid="share-landing-link"
    >
      웨딩클리어가 뭔가요?
    </Link>
  );
}
