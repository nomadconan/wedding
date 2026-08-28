import type { Metadata } from "next";
import Link from "next/link";

import { MetricTile } from "@/components/domain/MetricTile";
import { AdminShell } from "@/components/layout/AdminShell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ErrorState } from "@/components/ui/ErrorState";
import { dateTimeAttr, formatTimestamp } from "@/lib/core/format/timestamp";
import {
  CODE_OWNED_FIELDS,
  EDITABLE_RULE_FIELD_LABEL,
  EDITABLE_RULE_FIELDS,
  PROMPT_FEATURE_LABEL,
  RELEASE_GATE_FALLBACK,
} from "@/lib/core/rules/console";
import { measured, noBasis, undecided } from "@/lib/core/stats/metric";
import { loadRuleConsole } from "@/lib/rules/admin";
import { requireOperator } from "@/lib/supabase/auth";

import { RulePanel } from "./RulePanel";

export const metadata: Metadata = {
  title: "룰·프롬프트 — 웨딩클리어",
};

/**
 * /admin/rules — 검출 룰·프롬프트 관리 (F-A-03, §6.4 — 8단계 · S8-06)
 *
 * ── 명세보다 좁다. 그 사실을 화면이 적는다 ─────────────────────────────────
 * §2.3 은 'CRUD'·'프롬프트 배포·롤백'·'스테이징 A/B 검증' 을 적지만 이 리포의 실제와
 * 셋 다 어긋난다(D-140 · 07 §2.3 반영 제안). **기능을 뺀 것이 아니라 구현 형태가
 * 다르다** — 정규식과 프롬프트 본문은 코드 자산이고, 그것을 화면에서 고치면
 * 판본 태깅과 리뷰가 동시에 뜻을 잃는다.
 *
 * ── 이 화면이 지키는 규칙 ───────────────────────────────────────────────────
 * 1. **실행되는 값을 보여준다.** 코드와 DB 를 스캔이 쓰는 것과 **같은 병합 함수**로
 *    합쳐 보여준다 — 화면이 따로 계산하면 화면과 스캔이 갈린다.
 * 2. **어긋난 곳을 감추지 않는다.** DB 에만 있는 코드·판본 불일치·시드 누락을 전부
 *    적는다. DB 에만 있는 룰은 **실행되지 않는다**는 사실까지 함께.
 * 3. **없는 것을 있는 것처럼 적지 않는다.** 배포 게이트는 골든셋이 없어 `blocked`
 *    이고(FIX-42), 배포 이력 표는 비어 있다는 사실 자체가 상태다(O-22).
 * 4. **못 고치는 칸마다 왜 못 고치는지 적는다.** 목록에서 빼 버리면 운영자는 그 값이
 *    존재하는 줄도 모른다.
 * 5. **캐시하지 않는다**(FIX-22 계열).
 */
export const dynamic = "force-dynamic";

export default async function AdminRulesPage() {
  await requireOperator("/admin/rules");

  let payload: Awaited<ReturnType<typeof loadRuleConsole>>;
  try {
    payload = await loadRuleConsole();
  } catch {
    return (
      <AdminShell role="admin" title="룰·프롬프트">
        <ErrorState
          code="RULE_CONSOLE_LOAD_FAILED"
          title="룰 목록을 불러오지 못했어요"
          description="잠시 후 다시 시도해 주세요. 계속되면 운영 담당자에게 알려 주세요."
        />
      </AdminShell>
    );
  }

  const { rules, prompts, ledger, gate, penaltyBands } = payload;
  const driftCount =
    rules.drift.unknownInDatabase.length +
    rules.drift.missingInDatabase.length +
    rules.drift.versionMismatch.length;

  return (
    <AdminShell
      role="admin"
      title="룰·프롬프트"
      description="지금 무엇이 계약서를 검사하고 어떤 프롬프트가 도는지 봅니다."
    >
      <div className="space-y-6">
        {/* ── 이 화면이 할 수 있는 일 ───────────────────────────────────── */}
        <section aria-labelledby="scope-heading">
          <Card>
            <CardHeader>
              <CardTitle id="scope-heading" className="text-base">
                여기서 고칠 수 있는 것
              </CardTitle>
              <CardDescription>
                <strong>정규식과 프롬프트 본문은 코드가 갖습니다.</strong> 화면에서 고치지
                않습니다 — 오타 하나가 스캔을 멈추거나(SyntaxError) 특정 문서에서 되돌아오지
                않게 만듭니다. 룰을 고치는 일은 배포로 하고, 그 편이 리뷰를 거칩니다.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div>
                <p className="text-caption font-medium text-foreground">고칠 수 있음 (DB 자산)</p>
                <ul className="mt-1 flex flex-wrap gap-2">
                  {EDITABLE_RULE_FIELDS.map((field) => (
                    <li key={field}>
                      <Badge variant="secondary">{EDITABLE_RULE_FIELD_LABEL[field]}</Badge>
                    </li>
                  ))}
                </ul>
              </div>

              <div>
                <p className="text-caption font-medium text-foreground">
                  배포로만 바뀜 (코드 자산)
                </p>
                <ul className="mt-1 space-y-0.5">
                  {CODE_OWNED_FIELDS.map((field) => (
                    <li key={field.field} className="text-caption text-muted-foreground">
                      <strong>{field.label}</strong> — {field.reason}
                    </li>
                  ))}
                </ul>
              </div>
            </CardContent>
          </Card>
        </section>

        {/* ── 배포 전 검증 게이트 (§7.5) ────────────────────────────────── */}
        <section aria-labelledby="gate-heading">
          <Card>
            <CardHeader>
              <CardTitle id="gate-heading" className="text-base">
                배포 전 검증
              </CardTitle>
              <CardDescription>
                명세 §7.5 는 룰·프롬프트를 배포하기 전에 <strong>AI 회귀(골든셋 스냅샷
                비교)</strong>를 반드시 돌리라고 적습니다.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <MetricTile
                  label="AI 회귀 게이트"
                  metric={
                    gate.status === "blocked"
                      ? noBasis("골든셋이 아직 없어 배포 전 회귀를 돌릴 수 없습니다.", gate.fix)
                      : measured(gate.cases)
                  }
                  unit="건"
                />
                <MetricTile
                  label="스테이징 A/B"
                  metric={undecided(
                    "스테이징 환경이 이 리포에 없습니다. 만들지 않고 그 사실을 적습니다.",
                    "O-22",
                  )}
                />
              </div>

              {gate.status === "blocked" ? (
                <p className="rounded-md border border-border bg-muted p-3 text-caption text-muted-foreground">
                  <strong>&apos;통과&apos;도 &apos;해당 없음&apos;도 아닙니다 — 검사 자체가
                  없습니다({gate.fix}).</strong> {gate.message}{" "}
                  <Link href={RELEASE_GATE_FALLBACK.href} className="underline">
                    {RELEASE_GATE_FALLBACK.label}
                  </Link>
                </p>
              ) : null}
            </CardContent>
          </Card>
        </section>

        {/* ── 검출 룰 ───────────────────────────────────────────────────── */}
        <section aria-labelledby="rules-heading">
          <Card>
            <CardHeader>
              <CardTitle id="rules-heading" className="text-base">
                검출 룰 {rules.activeCount}/{rules.totalCount}건 실행 중
              </CardTitle>
              <CardDescription>
                <strong>전부 끄면 분석이 &apos;위험 없음&apos;을 내는 것이 아니라 아예
                서지 않습니다.</strong> &apos;위험 없음&apos;과 &apos;아무것도 보지
                않았다&apos;는 화면에서 구분되지 않기 때문입니다(S7-01).
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-3">
                <MetricTile label="실행 중인 룰" metric={measured(rules.activeCount)} unit="건" />
                <MetricTile
                  label="코드↔DB 어긋남"
                  metric={measured(driftCount)}
                  unit="건"
                  hint={rules.source === "code" ? "DB 행이 없어 코드 값으로 돌고 있습니다." : undefined}
                />
                <MetricTile
                  label="위약금 밴드"
                  metric={
                    penaltyBands.total === 0
                      ? noBasis(
                          "밴드를 시드하지 않았습니다 — 가정치가 운영 기준처럼 굳는 것을 막기 위해서입니다(S5-08).",
                          "0건",
                        )
                      : measured(penaltyBands.total)
                  }
                  unit="건"
                  hint={penaltyBands.total > 0 ? `초안 ${penaltyBands.draft}건` : undefined}
                />
              </div>

              {driftCount > 0 ? (
                <ul className="space-y-0.5 rounded-md border border-border bg-muted p-3">
                  {rules.drift.unknownInDatabase.length > 0 ? (
                    <li className="text-caption text-muted-foreground">
                      <strong>DB 에만 있음 {rules.drift.unknownInDatabase.join(", ")}</strong> —
                      정규식이 없어 실행되지 않습니다.
                    </li>
                  ) : null}
                  {rules.drift.missingInDatabase.length > 0 ? (
                    <li className="text-caption text-muted-foreground">
                      <strong>DB 에 없음 {rules.drift.missingInDatabase.join(", ")}</strong> —
                      시드가 밀렸습니다. 코드 값으로 돕니다.
                    </li>
                  ) : null}
                  {rules.drift.versionMismatch.length > 0 ? (
                    <li className="text-caption text-muted-foreground">
                      <strong>판본 불일치 {rules.drift.versionMismatch.join(", ")}</strong> —
                      룰 내용이 달라졌을 수 있습니다.
                    </li>
                  ) : null}
                </ul>
              ) : null}

              <ul className="space-y-3">
                {rules.rows.map((row) => (
                  <li key={row.code} className="rounded-lg border border-border p-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <code className="text-caption font-medium text-foreground">{row.code}</code>
                      <span className="font-medium text-foreground">{row.title}</span>
                      <Badge variant={row.active ? "secondary" : "outline"}>
                        {row.active ? "실행 중" : "꺼짐"}
                      </Badge>
                      <Badge variant="outline">{row.severity}</Badge>
                      <Badge variant="outline">{row.category}</Badge>
                      <span className="text-caption text-muted-foreground">{row.version}</span>
                      {row.orphaned ? <Badge variant="default">코드에 없음</Badge> : null}
                      {row.versionMismatch ? <Badge variant="default">판본 불일치</Badge> : null}
                      {!row.inDatabase ? <Badge variant="default">DB 행 없음</Badge> : null}
                    </div>

                    <p className="mt-2 text-caption text-muted-foreground">
                      근거 — {row.basisRef || "없음"}
                    </p>
                    {row.promptFragment ? (
                      <p className="mt-1 whitespace-pre-wrap rounded-md bg-muted p-2 text-caption text-foreground">
                        {row.promptFragment}
                      </p>
                    ) : null}

                    <div className="mt-3">
                      <RulePanel
                        code={row.code}
                        active={row.active}
                        promptFragment={row.promptFragment}
                        basisRef={row.basisRef}
                        activeCount={rules.activeCount}
                        orphaned={row.orphaned}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </section>

        {/* ── 프롬프트 ──────────────────────────────────────────────────── */}
        <section aria-labelledby="prompts-heading">
          <Card>
            <CardHeader>
              <CardTitle id="prompts-heading" className="text-base">
                프롬프트 판본
              </CardTitle>
              <CardDescription>
                <strong>본문은 코드가 갖습니다.</strong> 화면에서 고치면 판본 태깅이 뜻을
                잃습니다 — 결과가 달라졌을 때 모델이 바뀐 건지 문구가 바뀐 건지 구분하려고
                판본을 붙였는데, 문구가 배포 밖에서 바뀌면 그 구분이 불가능해집니다.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <ul className="space-y-3">
                {prompts.map((prompt) => (
                  <li key={prompt.feature} className="rounded-lg border border-border p-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-foreground">
                        {PROMPT_FEATURE_LABEL[prompt.feature]}
                      </span>
                      <Badge variant="secondary">{prompt.version}</Badge>
                      <span className="text-caption text-muted-foreground">
                        {prompt.bodyLength.toLocaleString("ko-KR")}자
                      </span>
                    </div>

                    <p className="mt-1 text-caption text-muted-foreground">
                      {prompt.usage === null ? (
                        <>
                          <strong>호출 기록 없음</strong> — 아직 한 번도 불리지 않았습니다.
                          0회가 아니라 기록이 없다는 뜻입니다.
                        </>
                      ) : (
                        <>
                          호출 {prompt.usage.calls.toLocaleString("ko-KR")}회 ·{" "}
                          <time dateTime={dateTimeAttr(prompt.usage.firstSeen)}>
                            {formatTimestamp(prompt.usage.firstSeen)}
                          </time>
                          {" 부터 "}
                          <time dateTime={dateTimeAttr(prompt.usage.lastSeen)}>
                            {formatTimestamp(prompt.usage.lastSeen)}
                          </time>
                          {" 까지 (호출 로그에서 셉니다 — 저장된 값이 아닙니다)"}
                        </>
                      )}
                    </p>

                    {prompt.orphanedVersions.length > 0 ? (
                      <p className="mt-1 text-caption text-warning">
                        로그에만 있는 판본 {prompt.orphanedVersions.join(", ")} — 되돌린 흔적이거나
                        낡은 로그입니다. 어느 기능의 것인지 추측하지 않습니다.
                      </p>
                    ) : null}

                    <details className="mt-2 rounded-md border border-border p-2">
                      <summary className="cursor-pointer text-caption font-medium text-foreground">
                        본문 보기 (읽기 전용)
                      </summary>
                      <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap text-caption text-muted-foreground">
                        {prompt.body}
                      </pre>
                    </details>
                  </li>
                ))}
              </ul>

              <p className="rounded-md border border-border bg-muted p-3 text-caption text-muted-foreground">
                {ledger.status === "empty" ? (
                  <>
                    <strong>배포 이력 표가 비어 있습니다({ledger.openIssue}).</strong>{" "}
                    {ledger.reason}
                  </>
                ) : (
                  <>배포 이력 {ledger.rows}건이 기록돼 있습니다.</>
                )}
              </p>
            </CardContent>
          </Card>
        </section>
      </div>
    </AdminShell>
  );
}
