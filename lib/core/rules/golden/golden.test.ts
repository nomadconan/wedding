import { describe, expect, it } from "vitest";

import { DETECT_RULES } from "../detect-rules";

import { GOLDEN_UNMEASURED, runGoldenSet } from "./run";

/**
 * AI 회귀 골든셋 — **배포 전 게이트** (FIX-42 · 명세서 §7.5 'AI 회귀' 행)
 *
 * ══════════════════════════════════════════════════════════════════════════
 * §7.5 는 이 검사를 **"룰·프롬프트 배포 전 필수 실행"** 이라고 적는다. 그동안 그
 * 골든셋이 없었고, `/admin/rules` 의 게이트 자리는 `blocked` 로 서 있었다.
 *
 * **무엇이 이 검사를 강제하는가** — 문서가 아니다. 셋이다:
 *   1. `npm run test` 가 이 파일을 돈다 → CI `quality` 잡의 게이트다.
 *   2. `npm run ai:golden` 이 이 파일만 따로 돈다 → CI 에 **이름 붙은 step** 으로 서 있다.
 *      배포 전에 무엇을 돌렸는지 로그에서 한 줄로 보인다.
 *   3. `/admin/rules` 가 **같은 함수**를 불러 결과를 보여준다 → 운영자가 룰을 끄기 전에
 *      게이트 상태를 화면에서 본다.
 * 문서에만 적으면 아무것도 강제하지 않는다. 그래서 세 자리에 같은 함수를 걸었다.
 * ══════════════════════════════════════════════════════════════════════════
 */

const result = runGoldenSet();

/**
 * **결과를 한 번 적는다.**
 *
 * 초록불만 보이면 "무엇을 몇 개 쟀는지" 를 아무도 모른 채 통과한다 — 그 상태에서는
 * 케이스가 절반으로 줄어도 화면이 똑같다. 배포 전에 읽을 다섯 줄을 남긴다.
 */
console.log(
  [
    "",
    `[AI 회귀 골든셋 · FIX-42 · §7.5] 룰 판본 ${result.ruleVersion} · 활성 룰 ${result.activeRules}종`,
    `  케이스  조항 ${result.cases.clause} · 계약서 ${result.cases.contract} · 모델 출력 ${result.cases.model} (합 ${result.cases.total + result.cases.model})`,
    `  검사    ${result.checks.total}건 — 통과 ${result.checks.passed} · 실패 ${result.checks.failed}`,
    `  커버리지 룰 ${result.coverage.length}종 · 두 방향 미충족 ${result.coverageGaps.length}종`,
    `  게이트  ${result.passed ? "통과" : result.usable ? "실패" : "검사 없음(blocked)"}`,
    `  재지 않는 것 ${GOLDEN_UNMEASURED.length}가지 — ${GOLDEN_UNMEASURED.map((row) => row.what).join(" · ")}`,
    "",
  ].join("\n"),
);

describe("AI 회귀 골든셋 (FIX-42 · §7.5)", () => {
  it("**표를 실제로 읽었다** — 빈 표는 무엇이든 통과시킨다", () => {
    expect(result.usable).toBe(true);
    expect(result.activeRules).toBe(DETECT_RULES.filter((rule) => rule.is_active).length);
    expect(result.cases.clause).toBeGreaterThanOrEqual(40);
    expect(result.cases.contract).toBeGreaterThanOrEqual(4);
    expect(result.cases.model).toBeGreaterThanOrEqual(10);
    expect(result.checks.total).toBeGreaterThanOrEqual(200);
  });

  it("**룰 20종 전부에 두 방향이 다 있다** — 한 방향만 있으면 검사가 아니다", () => {
    expect(result.coverageGaps).toEqual([]);
    expect(result.coverage).toHaveLength(DETECT_RULES.length);

    for (const row of result.coverage) {
      expect(`${row.code} positive=${row.positive}`).not.toContain("positive=0");
      expect(`${row.code} negative=${row.negative}`).not.toContain("negative=0");
    }
  });

  it("**미탐 0 · 오탐 0** — 두 방향을 같은 표에서 잰다", () => {
    expect(result.failures.map((failure) => failure.line)).toEqual([]);
    expect(result.checks.failed).toBe(0);
    expect(result.passed).toBe(true);
  });

  it("**마스킹이 판정을 바꾸지 않는다** — FIX-31 이 실제로 뒤집은 자리", () => {
    // 두 경로가 갈리면 `runGoldenSet` 이 `masking_drift` 로 실패시킨다. 여기서는
    // 그 검사가 **정말 모든 케이스에 붙어 있는지**를 따로 확인한다.
    const drift = result.failures.filter((failure) => failure.line.includes("마스킹이 판정을 바꿨다"));

    expect(drift).toEqual([]);
  });

  it("**재지 않은 것을 목록으로 갖는다** — 초록불이 실제보다 넓게 읽히지 않게", () => {
    expect(GOLDEN_UNMEASURED.length).toBeGreaterThanOrEqual(3);

    for (const row of GOLDEN_UNMEASURED) {
      expect(row.why.length).toBeGreaterThan(20);
      expect(row.where.length).toBeGreaterThan(0);
    }
  });
});
