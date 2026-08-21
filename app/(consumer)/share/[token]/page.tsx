import type { Metadata } from "next";
import Link from "next/link";

import { AiDisclaimer } from "@/components/domain/AiDisclaimer";
import { ConsumerShell } from "@/components/layout/ConsumerShell";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { SEVERITY_LABEL } from "@/lib/core/report/pipeline";
import {
  SHARE_STATE_LABEL,
  SHARE_STATE_NOTE,
  SHARE_VIEW_NOTICE,
} from "@/lib/core/share/share";
import { openShareLink } from "@/lib/share/links";
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
 * 고칠 수단을 두지 않는다. 조항 인용은 `clause_excerpt_masked`(S7-03)이고 원문은
 * 분석 직후 파기됐다(D-58) — **링크로도 원문에 닿을 수 없다.**
 */
export const metadata: Metadata = {
  title: "공유받은 검토 결과 — 웨딩클리어",
  // 공유 링크는 **색인 대상이 아니다.** 토큰이 검색에 걸리면 만료 전까지 누구나 연다.
  robots: { index: false, follow: false },
};

/**
 * **정적 렌더를 끈다.** 이 화면도 쿠키를 읽지 않아 빌드 시점에 굳을 수 있고, 그러면
 * 거둔 링크가 계속 열린다(위 라우트와 같은 이유 · FIX-22 계열).
 */
export const dynamic = "force-dynamic";

export default async function SharePage({ params }: { params: { token: string } }) {
  const opened = await openShareLink(params.token);

  return (
    <ConsumerShell title="공유받은 검토 결과" hideTabBar>
      {opened.state !== "live" ? (
        <div className="space-y-4" data-testid="share-closed" data-state={opened.state}>
          <EmptyState
            title={SHARE_STATE_LABEL[opened.state]}
            description={SHARE_STATE_NOTE[opened.state]}
          />
          <LandingLink />
        </div>
      ) : (
        <div className="space-y-4" data-testid="share-view">
          <p className="rounded-lg border border-border p-3 text-caption text-muted-foreground">
            {SHARE_VIEW_NOTICE}
          </p>

          <AiDisclaimer basisRef={opened.resource.basisRefs} />

          <section className="space-y-2" data-testid="share-summary">
            <div className="flex flex-wrap items-center gap-2">
              {opened.resource.riskScore === null ? (
                // **점수가 없으면 0으로 그리지 않는다** — 계산되지 않은 것과 0점은 다르다.
                <Badge variant="outline">위험 점수 없음</Badge>
              ) : (
                <Badge variant="secondary">위험 점수 {opened.resource.riskScore}</Badge>
              )}

              {(["high", "mid", "low"] as const).map((severity) =>
                opened.resource.counts[severity] === 0 ? null : (
                  <Badge
                    key={severity}
                    variant={severity === "high" ? "destructive" : "secondary"}
                  >
                    {SEVERITY_LABEL[severity]} {opened.resource.counts[severity]}건
                  </Badge>
                ),
              )}
            </div>
            <p className="text-caption text-neutral-500">
              {opened.resource.createdAt.slice(0, 10)}에 검토한 결과예요.
            </p>
          </section>

          {opened.resource.findings.length === 0 ? (
            <EmptyState
              title="눈에 띄는 조항이 없었어요"
              description="검출 룰에 걸린 조항이 없습니다. 계약 전 전문가 확인은 별도로 권해요."
            />
          ) : (
            <ul className="space-y-2" data-testid="share-findings">
              {opened.resource.findings.map((finding) => (
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

                  {/* **협상 문구를 넣지 않는다.** 그것은 계약 당사자가 쓸 말이고,
                      공유받은 사람은 당사자가 아니다 — 보여 줄 이유가 없다. */}
                </li>
              ))}
            </ul>
          )}

          <p className="text-caption text-neutral-500" data-testid="share-expiry">
            이 링크는 {opened.expiresAt.slice(0, 10)}까지 열려 있어요.
          </p>

          <LandingLink />
        </div>
      )}
    </ConsumerShell>
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
