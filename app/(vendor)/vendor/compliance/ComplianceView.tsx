"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  BADGE_CRITERIA_NOTICE,
  BADGE_LABEL,
  BADGE_REASON_NOTE,
  BADGE_SCOPE_NOTICE,
  COMPLIANCE_DISCLAIMER,
  SELF_SCAN_NOTICE,
  TERMS_ISSUE_NOTE,
  TERMS_MIN_LENGTH,
  cleanScanNote,
  termsIssue,
  type BadgeDecision,
  type ComplianceFinding,
} from "@/lib/core/compliance/compliance";
import { VENDOR_SEVERITY_LABEL, VENDOR_SEVERITY_NOTE } from "@/lib/core/compliance/guides";
import type { RuleSeverity } from "@/lib/core/rules/types";

/**
 * /vendor/compliance — 약관 자가 진단 (F-V-10 · 명세서 §6.3)
 *
 * ── 이 화면이 지키는 것 ─────────────────────────────────────────────────────
 *  1. **진단한 적이 없는 것과 0건을 겹쳐 보이지 않는다.** 아직 안 돌렸으면 "0건" 이
 *     아니라 **"아직 세지 않았다"** 고 적는다(S7-04 가 위약금 기준에서 세운 규칙).
 *  2. **깨끗해도 "문제 없음" 이라고 하지 않는다.** 우리가 아는 것은 **룰 N종에 걸리지
 *     않았다**는 것뿐이고 그 밖은 보지 않았다.
 *  3. **배지가 무엇까지 참인지 배지 옆에 적는다.** 붙으면 고객이 신뢰의 근거로
 *     삼으므로, 자가 진단이라는 한계를 감추지 않는다.
 *  4. **법률 자문이 아님을 상시 노출**한다(§7.7 · CLAUDE.md §2.3). 접거나 툴팁으로
 *     숨기지 않는다.
 *  5. **원문을 저장하지 않는다는 사실을 넣기 전에 말한다.** 넣고 나서 알리면 늦다.
 *
 * 판정·문구는 전부 `lib/core/compliance` 가 갖는다.
 */
export function ComplianceView({
  initialScan,
  initialBadge,
  ruleCount,
}: {
  initialScan: {
    findings: ComplianceFinding[];
    counts: Record<RuleSeverity, number>;
    ruleCount: number;
    scannedAt: string;
  } | null;
  initialBadge: BadgeDecision;
  ruleCount: number;
}) {
  const router = useRouter();

  const [terms, setTerms] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [scan, setScan] = useState(initialScan);
  const [badge, setBadge] = useState(initialBadge);
  const [maskedKinds, setMaskedKinds] = useState<string[]>([]);

  const inputIssue = terms.length === 0 ? null : termsIssue(terms);

  async function run() {
    setBusy(true);
    setNotice(null);

    try {
      const response = await fetch("/api/vendor/compliance/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ terms }),
      });
      const payload = (await response.json()) as {
        ok: boolean;
        data?: {
          findings: ComplianceFinding[];
          counts: Record<RuleSeverity, number>;
          ruleCount: number;
          scannedAt: string;
          badge: BadgeDecision;
          maskedKinds: string[];
        };
        error?: { message: string };
      };

      if (!payload.ok || payload.data === undefined) {
        setNotice(payload.error?.message ?? "진단하지 못했어요.");
        return;
      }

      setScan(payload.data);
      setBadge(payload.data.badge);
      setMaskedKinds(payload.data.maskedKinds);
      // **붙여넣은 약관을 화면에서도 지운다.** 서버가 저장하지 않는데 화면에 남겨 두면
      // 자리를 뜬 사이 다른 사람이 본다(업체는 여러 명이 쓰는 계정이다).
      setTerms("");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5" data-testid="compliance">
      {/* ── 법적 고지 — 상시 노출 ────────────────────────────────────── */}
      <p className="rounded-lg border border-border p-3 text-caption text-muted-foreground">
        {COMPLIANCE_DISCLAIMER}
      </p>

      {/* ── 배지 상태 ────────────────────────────────────────────────── */}
      <Card>
        <CardContent className="space-y-2 pt-5" data-testid="compliance-badge">
          <div className="flex items-center gap-2">
            <Badge variant={badge.granted ? "default" : "outline"}>{BADGE_LABEL}</Badge>
            {badge.granted ? null : <span className="text-caption text-muted-foreground">미부여</span>}
          </div>

          <p className="text-sm text-foreground">{BADGE_REASON_NOTE[badge.reason]}</p>
          <p className="text-caption text-muted-foreground">{BADGE_CRITERIA_NOTICE}</p>
          {/* 배지가 무엇까지 참인지. 고객 화면에도 같은 문장이 나간다. */}
          <p className="text-caption text-muted-foreground">{BADGE_SCOPE_NOTICE}</p>
        </CardContent>
      </Card>

      {/* ── 진단 실행 ────────────────────────────────────────────────── */}
      <section className="space-y-2">
        <h2 className="text-base font-semibold text-foreground">약관 진단하기</h2>
        {/* 넣기 **전에** 말한다. */}
        <p className="text-caption text-muted-foreground">{SELF_SCAN_NOTICE}</p>

        <textarea
          value={terms}
          onChange={(event) => setTerms(event.target.value)}
          rows={10}
          placeholder={`고객에게 주는 약관·계약서 내용을 붙여넣어 주세요. (${TERMS_MIN_LENGTH}자 이상)`}
          className="w-full rounded-lg border border-border bg-background p-3 text-sm text-foreground"
          data-testid="compliance-input"
        />

        {inputIssue === null ? null : (
          <p className="text-caption text-muted-foreground">{TERMS_ISSUE_NOTE[inputIssue]}</p>
        )}

        <Button disabled={busy || terms.length === 0 || inputIssue !== null} onClick={run}>
          {busy ? "진단하는 중" : `검출 룰 ${ruleCount}종으로 진단하기`}
        </Button>

        {maskedKinds.length > 0 ? (
          <p className="text-caption text-muted-foreground" data-testid="compliance-masked">
            개인정보로 보이는 부분을 가린 뒤 검사했어요 ({maskedKinds.join(" · ")}).
          </p>
        ) : null}

        {notice === null ? null : (
          <p className="text-sm text-destructive" data-testid="compliance-notice">
            {notice}
          </p>
        )}
      </section>

      {/* ── 결과 ─────────────────────────────────────────────────────── */}
      <section className="space-y-2" data-testid="compliance-result">
        <h2 className="text-base font-semibold text-foreground">진단 결과</h2>

        {scan === null ? (
          /* **0건이 아니라 '아직'이다.** 둘을 겹쳐 보이면 통과한 것으로 읽힌다. */
          <p className="rounded-lg border border-border p-3 text-sm text-muted-foreground">
            {BADGE_REASON_NOTE.never_scanned}
          </p>
        ) : (
          <div className="space-y-3">
            <p className="text-caption text-muted-foreground">
              {scan.scannedAt.slice(0, 10)} 진단 · 검출 룰 {scan.ruleCount}종
            </p>

            {scan.findings.length === 0 ? (
              /* 깨끗해도 **무엇을 세어 0인지** 붙인다. */
              <p className="rounded-lg border border-border p-3 text-sm text-foreground">
                {cleanScanNote(scan.ruleCount)}
              </p>
            ) : (
              <>
                <div className="flex flex-wrap gap-1.5">
                  {(["high", "mid", "low"] as const).map((severity) =>
                    scan.counts[severity] === 0 ? null : (
                      <Badge key={severity} variant={severity === "high" ? "default" : "outline"}>
                        {VENDOR_SEVERITY_LABEL[severity]} {scan.counts[severity]}
                      </Badge>
                    ),
                  )}
                </div>

                <ul className="space-y-2">
                  {scan.findings.map((finding) => (
                    <li
                      key={finding.ruleCode}
                      className="space-y-2 rounded-lg border border-border p-3"
                      data-testid={`compliance-finding-${finding.ruleCode}`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <span className="text-sm font-medium text-foreground">{finding.title}</span>
                        <Badge variant="outline">{VENDOR_SEVERITY_LABEL[finding.severity]}</Badge>
                      </div>

                      <p className="text-caption text-muted-foreground">
                        {VENDOR_SEVERITY_NOTE[finding.severity]}
                      </p>

                      {/* 근거는 **기준의 이름**까지다. 조항 번호를 적지 않는다(T-04). */}
                      <p className="text-caption text-muted-foreground">근거: {finding.basisRef}</p>

                      {finding.kind === "absence" ? (
                        <p className="text-caption text-muted-foreground">
                          해당 내용이 약관에서 보이지 않았어요.
                        </p>
                      ) : finding.clauseExcerpt.length > 0 ? (
                        <p className="rounded border border-border bg-muted/40 p-2 text-caption text-foreground">
                          “{finding.clauseExcerpt}”
                        </p>
                      ) : null}

                      {finding.guide === null ? null : (
                        <div className="space-y-1">
                          <p className="text-caption text-foreground">{finding.guide.why}</p>
                          <p className="text-caption font-medium text-foreground">
                            이런 내용이 있으면 걸리지 않아요
                          </p>
                          <ul className="list-disc space-y-0.5 pl-4 text-caption text-muted-foreground">
                            {finding.guide.needs.map((need) => (
                              <li key={need}>{need}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
