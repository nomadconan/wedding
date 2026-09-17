import Link from "next/link";

import { MetricTile } from "@/components/domain/MetricTile";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { RELEASE_GATE_FALLBACK, type ReleaseGate } from "@/lib/core/rules/console";
import { measured, noBasis, undecided } from "@/lib/core/stats/metric";

/**
 * 배포 전 검증 게이트 (§7.5 · FIX-42 · S8-06 이 `blocked` 로 세워 둔 자리)
 *
 * ── 세 상태가 각각 다른 얼굴을 갖는다 ───────────────────────────────────────
 *   passed   골든셋이 돌았고 전부 통과했다 — **무엇을 몇 건 쟀는지 함께 적는다**
 *   failed   골든셋이 돌았고 깨졌다 — **무엇이 깨졌는지 줄로 적는다**(건수만으로는 못 고친다)
 *   blocked  **검사가 서지 않았다** — 통과도 실패도 아니다
 *
 * 셋을 둘로 접으면 "검사 없음" 과 "검사 실패" 가 같은 색이 되고, 그러면 골든셋을
 * 지워 버린 날에도 화면이 똑같아 보인다. FIX-42 가 기록된 이유가 정확히 그것이다.
 *
 * ── 통과 옆에 '재지 않은 것' 을 붙인다 ──────────────────────────────────────
 * 초록불은 **이 표가 재는 범위 안에서만** 초록이다. 모델이 쓴 문장의 품질도, 실제
 * 계약서에서의 재현율도 여기서 재지 않는다 — 그 사실을 적지 않으면 초록불이 실제보다
 * 넓게 읽힌다(CLAUDE.md — 측정하지 않은 것을 0으로 표시하지 않는다).
 *
 * 컴포넌트로 뽑은 이유는 **이 규칙들을 테스트가 붙잡게 하기 위해서**다. 페이지 안에
 * 두면 로그인·DB 가 있어야만 확인할 수 있고, 그러면 아무도 확인하지 않는다.
 */
export type ReleaseGateCardProps = {
  gate: ReleaseGate;
  /** 게이트가 재지 않는 것. `lib/core/rules/golden` 의 `GOLDEN_UNMEASURED`. */
  unmeasured: readonly { what: string; why: string; where: string }[];
};

export function ReleaseGateCard({ gate, unmeasured }: ReleaseGateCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle id="gate-heading" className="text-base">
          배포 전 검증
        </CardTitle>
        <CardDescription>
          명세 §7.5 는 룰·프롬프트를 배포하기 전에{" "}
          <strong>AI 회귀(골든셋 스냅샷 비교)</strong>를 반드시 돌리라고 적습니다.{" "}
          <strong>이 결과는 저장된 값이 아니라 이 화면을 열 때 실제로 돌린 것</strong>입니다 —
          룰을 고친 뒤에도 어제 결과가 보이면 그것은 게이트가 아닙니다.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-3" data-testid="gate-metrics" data-status={gate.status}>
          <MetricTile
            label="AI 회귀 — 검사"
            metric={
              gate.status === "blocked"
                ? noBasis("돌릴 케이스가 없어 회귀를 시작하지 못했습니다.", gate.fix)
                : measured(gate.checks)
            }
            unit="건"
            hint={gate.status === "blocked" ? undefined : `케이스 ${gate.cases}건`}
          />
          <MetricTile
            label="실패"
            metric={
              gate.status === "blocked"
                ? noBasis("검사를 돌리지 못해 실패 건수를 셀 수 없습니다.", gate.fix)
                : measured(gate.status === "failed" ? gate.failed : 0)
            }
            unit="건"
            hint={gate.status === "blocked" ? undefined : `룰 판본 ${gate.ruleVersion}`}
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
            <strong>
              &apos;통과&apos;도 &apos;해당 없음&apos;도 아닙니다 — 검사가 서지 않았습니다(
              {gate.fix}).
            </strong>{" "}
            {gate.message}
          </p>
        ) : null}

        {gate.status === "failed" ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3">
            <p className="text-caption font-medium text-foreground">
              회귀가 깨졌습니다 — <strong>지금 룰·프롬프트를 배포하지 마세요.</strong>
            </p>
            <ul className="mt-1 space-y-0.5">
              {gate.lines.map((line) => (
                <li key={line} className="text-caption text-muted-foreground">
                  {line}
                </li>
              ))}
            </ul>
            <p className="mt-1 text-caption text-muted-foreground">
              전체 목록은 <code>npm run ai:golden</code> 이 출력합니다.
            </p>
          </div>
        ) : null}

        {gate.status === "passed" ? (
          <p className="rounded-md border border-border bg-muted p-3 text-caption text-muted-foreground">
            검출 룰 {gate.rules}종에 대해 케이스 {gate.cases}건 · 검사 {gate.checks}건이
            통과했습니다(판본 {gate.ruleVersion}).{" "}
            {gate.unmeasuredRules.length > 0 ? (
              <strong>
                다만 꺼져 있어 재지 못한 룰이 {gate.unmeasuredRules.length}종 있습니다(
                {gate.unmeasuredRules.join(", ")}) — 이 통과는 그 룰들을 확인한 결과가 아닙니다.
              </strong>
            ) : null}
          </p>
        ) : null}

        <div className="rounded-md border border-border p-3" data-testid="gate-unmeasured">
          <p className="text-caption font-medium text-foreground">
            이 게이트가 <strong>재지 않는 것</strong>
          </p>
          <ul className="mt-1 space-y-0.5">
            {unmeasured.map((row) => (
              <li key={row.what} className="text-caption text-muted-foreground">
                <strong>{row.what}</strong> — {row.why} ({row.where})
              </li>
            ))}
          </ul>
          <p className="mt-1 text-caption text-muted-foreground">
            <Link href={RELEASE_GATE_FALLBACK.href} className="underline">
              {RELEASE_GATE_FALLBACK.label}
            </Link>
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
