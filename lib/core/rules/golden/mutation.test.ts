import { describe, expect, it } from "vitest";

import { maskText } from "../../masking";
import { DETECT_RULES } from "../detect-rules";
import type { DetectRule } from "../types";

import { MODEL_CASES } from "./model-cases";
import { runGoldenSet, runModelCase } from "./run";

/**
 * **골든셋이 헛돌지 않는지 잰다** (FIX-42)
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 통과하는 검사는 두 가지다 — **지켜서 통과하는 것**과 **아무것도 안 봐서 통과하는 것**.
 * 화면에서는 구분되지 않는다. 그래서 **일부러 망가뜨려 보고 빨개지는지** 확인한다.
 *
 * 방향마다 하나씩 본다. 룰 20종 각각을 망가뜨리지는 않는다 — 룰은 전부 같은 실행기
 * (`scanDocument`)를 타므로 **방향이 다르면 다른 코드가 돌고, 룰이 다르면 같은 코드가
 * 돈다.** 확인해야 하는 것은 전자다.
 *
 *   미탐        정규식을 못 맞추게 바꾼다 → 잡혀야 할 것이 안 잡힌다
 *   오탐        정규식을 아무거나 맞게 바꾼다 → 잡히면 안 되는 것이 잡힌다
 *   부재 룰     기대 조항 목록을 비운다 → 갖춰진 계약서에서도 '없다' 가 뜬다
 *   스냅샷      룰 하나를 넓힌다 → 옆 계약서에 번진 것이 잡힌다
 *   마스킹      과잉 마스킹을 주입한다 → 두 경로가 갈린다 (FIX-31 의 모양)
 *   커버리지    한 방향 케이스를 뺀다 → 표가 스스로 구멍을 신고한다
 *   빈 표       케이스를 0개로 준다 → '통과' 가 아니라 '검사 없음'
 *   모델 게이트 기대를 뒤집는다 → 문 검사가 실제로 값을 읽고 있다
 * ══════════════════════════════════════════════════════════════════════════
 */

/** 룰 하나만 바꾼 사본. 나머지는 그대로 둔다. */
function mutate(code: string, patch: (rule: DetectRule) => DetectRule): DetectRule[] {
  return DETECT_RULES.map((rule) => (rule.code === code ? patch(rule) : rule));
}

/** 어떤 문장에도 맞지 않는 패턴. */
const NEVER = /이 문장은 계약서에 나오지 않는다/;
/** 어떤 문장에나 맞는 패턴. */
const ALWAYS = /./;

describe("골든셋 자체 검사 — 망가뜨리면 빨개지는가 (FIX-42)", () => {
  it("**멀쩡한 룰 세트로는 초록이다** — 아래 비교의 기준선", () => {
    expect(runGoldenSet().passed).toBe(true);
  });

  it("미탐 — R-01 정규식을 못 맞추게 바꾸면 '걸려야 하는데 안 걸렸다'", () => {
    const result = runGoldenSet({
      rules: mutate("R-01", (rule) => ({ ...rule, detect: { presence: { patterns: [NEVER] } } })),
    });

    expect(result.passed).toBe(false);
    expect(result.failures.some((f) => f.line.includes("R-01 이 걸려야 하는데"))).toBe(true);
  });

  it("오탐 — R-01 정규식을 아무거나 맞게 바꾸면 '걸리면 안 되는데 걸렸다'", () => {
    const result = runGoldenSet({
      rules: mutate("R-01", (rule) => ({ ...rule, detect: { presence: { patterns: [ALWAYS] } } })),
    });

    expect(result.passed).toBe(false);
    expect(result.failures.some((f) => f.line.includes("R-01 이 걸리면 안 되는데"))).toBe(true);
  });

  it("부재 룰 — R-20 의 기대 조항을 비우면 갖춰진 계약서에서도 '없다' 가 뜬다", () => {
    const result = runGoldenSet({
      rules: mutate("R-20", (rule) => ({ ...rule, detect: { absence: { expected: [NEVER] } } })),
    });

    expect(result.passed).toBe(false);
    expect(result.failures.some((f) => f.line.includes("R-20 이 걸리면 안 되는데"))).toBe(true);
  });

  it("부재 룰의 `requires` — R-12 에서 빼면 앨범 없는 계약서까지 지적한다", () => {
    const result = runGoldenSet({
      rules: mutate("R-12", (rule) => ({
        ...rule,
        detect: { absence: { expected: rule.detect.absence?.expected ?? [NEVER] } },
      })),
    });

    expect(result.passed).toBe(false);
    expect(result.failures.some((f) => f.line.includes("G-R12-out-of-scope"))).toBe(true);
  });

  it("스냅샷 — R-05 를 넓히면 **옆 계약서**에 번진 것이 잡힌다", () => {
    const result = runGoldenSet({
      rules: mutate("R-05", (rule) => ({
        ...rule,
        detect: { presence: { patterns: [/추가|비용|원판/] } },
      })),
    });

    expect(result.passed).toBe(false);
    // 스냅샷 케이스는 **적어 두지 않은 룰이 새로 걸리는 것**을 잡는다.
    expect(result.failures.some((f) => f.line.includes("스냅샷에 없는 R-05"))).toBe(true);
  });

  it("마스킹 — 과잉 마스킹을 주입하면 두 경로가 갈린다 (FIX-31 의 모양)", () => {
    // FIX-31 이전 규칙이 하던 일을 그대로 재현한다: 라벨 뒤 2~4자를 **성씨 검사 없이**
    // 이름으로 집는다. `담당 작가 교체가` 의 "교체가" 가 지워지고 R-15 가 뒤집힌다.
    const overMask = (text: string): string =>
      maskText(text).masked.replace(
        /(작가|담당자|실장|고객|계약자)(\s+)([가-힣]{2,4})/g,
        (_match, label: string, gap: string) => `${label}${gap}[NAME_X]`,
      );

    const result = runGoldenSet({ mask: overMask });

    expect(result.passed).toBe(false);
    expect(result.failures.some((f) => f.line.includes("마스킹이 판정을 바꿨다"))).toBe(true);
    // 그리고 그 결과가 **FIX-31 이 실제로 뒤집은 케이스**에서 나온다.
    expect(result.failures.some((f) => f.line.includes("G-R15-clean-fix31"))).toBe(true);
  });

  it("커버리지 — 한 방향 케이스를 빼면 표가 스스로 구멍을 신고한다", () => {
    const result = runGoldenSet({
      // 잡혀야 하는 케이스만 남기면 **음성 방향이 0** 이 된다.
      cases: [
        {
          id: "only-positive",
          kind: "clause",
          focus: ["R-01"],
          title: "양성만 있는 표",
          text: "예식일 30일 이내 취소 시 총 계약금액의 80%를 위약금으로 청구합니다.",
          detected: ["R-01"],
          notDetected: [],
          exact: false,
          note: "검사용",
        },
      ],
    });

    expect(result.passed).toBe(false);
    expect(result.coverageGaps.length).toBeGreaterThan(0);
    expect(result.coverageGaps.some((gap) => gap.startsWith("R-01"))).toBe(true);
  });

  it("**빈 표는 '통과' 가 아니라 '검사 없음'** 이다", () => {
    const empty = runGoldenSet({ cases: [], modelCases: [] });

    expect(empty.usable).toBe(false);
    expect(empty.passed).toBe(false);

    // 룰이 0건이어도 마찬가지다 — 아무것도 안 돌고 아무것도 안 걸린다.
    const noRules = runGoldenSet({ rules: [] });

    expect(noRules.usable).toBe(false);
    expect(noRules.passed).toBe(false);
  });

  it("모델 게이트 — 기대를 뒤집으면 문 검사가 빨개진다", () => {
    const merge = MODEL_CASES.find((c) => c.id === "G-M-merge-invented-citation");
    if (merge === undefined || merge.stage !== "merge") throw new Error("케이스가 사라졌다");

    // 버려져야 하는 finding 을 "살아남아야 한다" 로 적으면 실패해야 한다.
    const flipped = runModelCase({ ...merge, expectKept: ["R-01", "R-10"] });

    expect(flipped.some((check) => !check.ok)).toBe(true);

    const schema = MODEL_CASES.find((c) => c.id === "G-M-schema-disclaimer-tampered");
    if (schema === undefined || schema.stage !== "schema") throw new Error("케이스가 사라졌다");

    // 고지가 망가진 출력을 "통과해야 한다" 로 적으면 실패해야 한다.
    expect(runModelCase({ ...schema, expect: "accept" }).some((check) => !check.ok)).toBe(true);
  });
});
