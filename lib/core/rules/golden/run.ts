// AI 회귀 골든셋 — 실행기 (FIX-42 · 명세서 §7.5 'AI 회귀' 행)
//
// ══════════════════════════════════════════════════════════════════════════
// **프레임워크를 모르는 순수 함수다.** vitest 도, 화면도, 배치도 같은 함수를 부른다 —
// 검사 결과가 도구마다 다르면 게이트가 무엇을 말하는지 알 수 없다.
//
// **LLM 을 부르지 않는다.** 여기서 재는 것은 전부 결정적이다:
//   1) 룰 20종의 검출 결과 (정규식)
//   2) 마스킹이 그 결과를 바꾸는가 (FIX-31 이 깨뜨린 자리)
//   3) 모델 출력을 받는 **게이트의 동작** — 스키마 검증 · 인용 대조 · 폐기 사유
//
// **모델이 쓴 문장 자체는 재지 않는다.** 비결정적이라 스냅샷이 성립하지 않고, 억지로
// 고정하면 모델을 바꾸는 날 표가 통째로 빨개진다. 문장 품질은 **S8-07 의 품질 지표와
// 검수 큐**가 맡는다(`/admin/ai-quality`). **재지 않은 것을 0으로 적지 않는다** —
// `GOLDEN_UNMEASURED` 가 그 목록이고 화면이 그대로 읽는다.
// ══════════════════════════════════════════════════════════════════════════

import { maskText } from "../../masking";
import { mergeModelFindings } from "../../report/pipeline";
import { ReportSchema } from "../../schemas/report";
import { DETECT_RULES, DETECT_RULES_VERSION, DETECT_RULE_CODES } from "../detect-rules";
import { scanDocument, verifyCitation } from "../scan";
import type { DetectRule } from "../types";

import { CLAUSE_CASES } from "./clauses";
import { CONTRACT_CASES } from "./contracts";
import { MODEL_CASES, type ModelCase } from "./model-cases";
import { GOLDEN_PATHS, type GoldenCase, type GoldenCheck, type GoldenPath } from "./types";

/** 표에 실린 모든 계약서 케이스. 조항 + 계약서 한 통. */
export const GOLDEN_CASES: readonly GoldenCase[] = [...CLAUSE_CASES, ...CONTRACT_CASES];

/**
 * **이 골든셋이 재지 않는 것.**
 *
 * 화면이 이 목록을 그대로 읽는다. 게이트가 초록이라고 해서 아래까지 확인된 것이
 * 아니며, 그 사실을 적지 않으면 초록불이 실제보다 넓게 읽힌다.
 */
export const GOLDEN_UNMEASURED: readonly { what: string; why: string; where: string }[] = [
  {
    what: "모델이 쓴 설명·협상 문구의 품질",
    why: "같은 입력에 매번 다른 문장이 나온다. 스냅샷으로 고정하면 모델을 바꾸는 날 표가 통째로 빨개지고, 그러면 표를 지우게 된다.",
    where: "/admin/ai-quality (S8-07 품질 지표 · 샘플 검수 큐 · 오탐 신고)",
  },
  {
    what: "실제 계약서에서의 재현율",
    why: "여기 문구는 표준약관을 본떠 지어낸 것이다(CLAUDE.md §5.6 — 실제 계약서는 커밋할 수 없다). 표현이 다른 실제 조항을 얼마나 놓치는지는 이 표가 답하지 못한다.",
    where: "/admin/ai-quality 의 오탐 신고 · 샘플 검수 큐",
  },
  {
    what: "OCR·PDF 추출 품질",
    why: "지금 받는 형식은 .txt 하나이며(S7-03) 추출기가 붙는 날 그 단계의 회귀가 따로 필요하다.",
    where: "아직 없음 — 추출기를 붙이는 태스크가 함께 만든다",
  },
];

// =============================================================================
// 케이스 실행
// =============================================================================

function check(
  caseId: string,
  path: GoldenPath,
  kind: GoldenCheck["kind"],
  target: string,
  ok: boolean,
  detail: string,
): GoldenCheck {
  return { caseId, path, kind, target, ok, detail: ok ? "" : detail };
}

/** 한 입력에 룰을 돌려 **잡힌 코드 집합**을 만든다. */
function detectedCodes(text: string, rules: readonly DetectRule[]): Set<string> {
  return new Set(scanDocument(text, rules).map((match) => match.rule_code));
}

/**
 * 케이스 하나를 두 경로에서 잰다.
 *
 * **경로가 갈리는 것 자체가 실패다.** 마스킹은 개인정보를 지우는 도구이지 판정 대상을
 * 만드는 도구가 아니다(D-102) — 두 경로의 결과가 다르면 마스킹이 판정을 바꿨다는 뜻이고,
 * 그것이 FIX-31 이 실제로 일으킨 사고다.
 */
/**
 * 꺼진 룰의 기대는 **재지 않는다**.
 *
 * 운영자가 룰 하나를 끄는 것은 정당한 운영 판단이고(S8-06 `deactivationWarning`),
 * 그것 때문에 배포 게이트가 빨개지면 사람들은 빨간불을 무시하기 시작한다. 대신
 * **재지 못했다는 사실**을 결과에 남긴다 — 통과 건수에 슬쩍 섞지 않는다.
 */
function activeExpectations(
  codes: readonly string[],
  active: ReadonlySet<string>,
): readonly string[] {
  return codes.filter((code) => active.has(code));
}

export function runCase(
  goldenCase: GoldenCase,
  rules: readonly DetectRule[],
  /**
   * 마스킹 함수. 기본값은 **실제 파이프라인이 쓰는 것**이다.
   *
   * 갈아 끼울 수 있게 둔 이유는 하나뿐이다 — **이 검사가 헛돌지 않는지 확인하려고**
   * (`mutation.test.ts`). 과잉 마스킹을 일부러 주입했을 때 `masking_drift` 가 실제로
   * 빨개지는지 보지 않으면, 두 경로를 재고 있다는 말 자체가 근거 없는 주장이 된다.
   */
  mask: (text: string) => string = (text) => maskText(text).masked,
): GoldenCheck[] {
  const checks: GoldenCheck[] = [];
  const byPath: Record<GoldenPath, Set<string>> = {
    raw: detectedCodes(goldenCase.text, rules),
    // 소비자 리포트는 **마스킹본을** 스캔한다(`lib/reports/analyze.ts`).
    masked: detectedCodes(mask(goldenCase.text), rules),
  };

  const active = new Set(rules.map((rule) => rule.code));
  const expectDetected = activeExpectations(goldenCase.detected, active);

  for (const path of GOLDEN_PATHS) {
    const found = byPath[path];

    for (const code of expectDetected) {
      checks.push(
        check(
          goldenCase.id,
          path,
          "miss",
          code,
          found.has(code),
          `${code} 이 걸려야 하는데 걸리지 않았다 — 위험한 조항이 '없음' 으로 나간다`,
        ),
      );
    }

    for (const code of goldenCase.notDetected) {
      checks.push(
        check(
          goldenCase.id,
          path,
          "false_positive",
          code,
          !found.has(code),
          `${code} 이 걸리면 안 되는데 걸렸다 — 멀쩡한 조항이 위험으로 나간다`,
        ),
      );
    }

    if (goldenCase.exact) {
      const allowed = new Set(goldenCase.detected);
      for (const code of [...found].sort()) {
        checks.push(
          check(
            goldenCase.id,
            path,
            "unexpected",
            code,
            allowed.has(code),
            `스냅샷에 없는 ${code} 이 새로 걸렸다 — 룰을 넓힌 결과가 옆 계약서에 번졌거나, 스냅샷을 고쳐야 한다`,
          ),
        );
      }
    }
  }

  const rawOnly = [...byPath.raw].filter((code) => !byPath.masked.has(code)).sort();
  const maskedOnly = [...byPath.masked].filter((code) => !byPath.raw.has(code)).sort();
  const drifted = [...rawOnly, ...maskedOnly];

  checks.push(
    check(
      goldenCase.id,
      "masked",
      "masking_drift",
      drifted.join(",") || "-",
      drifted.length === 0,
      `마스킹이 판정을 바꿨다 — 원문에만: [${rawOnly.join(", ")}] · 마스킹본에만: [${maskedOnly.join(", ")}] (FIX-31 과 같은 모양)`,
    ),
  );

  return checks;
}

// =============================================================================
// 모델 출력 게이트 (§5.2 6·7단계)
// =============================================================================

export type ModelCheck = {
  caseId: string;
  kind: "schema" | "kept" | "discarded";
  target: string;
  ok: boolean;
  detail: string;
};

/**
 * 모델이 낸 것을 **받아들일지 버릴지** 정하는 문이 제대로 서 있는가.
 *
 * 문장은 재지 않는다 — **문이 열리고 닫히는 조건**을 잰다. 그것은 결정적이고, 깨지면
 * 지어낸 조항이 리포트에 실린다.
 */
export function runModelCase(modelCase: ModelCase): ModelCheck[] {
  if (modelCase.stage === "schema") {
    const parsed = ReportSchema.safeParse(modelCase.output);
    const actual = parsed.success ? "accept" : "reject";

    return [
      {
        caseId: modelCase.id,
        kind: "schema",
        target: modelCase.expect,
        ok: actual === modelCase.expect,
        detail: parsed.success
          ? "스키마가 통과시켰는데 거절해야 하는 출력이다 — 6단계 검증이 느슨해졌다"
          : `스키마가 거절했는데 통과해야 하는 출력이다: ${parsed.error.issues[0]?.message ?? ""}`,
      },
    ];
  }

  const checks: ModelCheck[] = [];
  const merged = mergeModelFindings({
    findings: modelCase.findings,
    maskedText: modelCase.maskedText,
    verifyCitation,
    knownRuleCodes: DETECT_RULE_CODES,
  });

  const kept = merged.findings.map((finding) => finding.rule_code).sort();
  const wanted = [...modelCase.expectKept].sort();

  checks.push({
    caseId: modelCase.id,
    kind: "kept",
    target: wanted.join(",") || "-",
    ok: kept.join(",") === wanted.join(","),
    detail: `살아남아야 할 finding 이 다르다 — 기대: [${wanted.join(", ")}] · 실제: [${kept.join(", ")}]`,
  });

  for (const expected of modelCase.expectDiscarded) {
    const hit = merged.discarded.find(
      (row) => row.rule_code === expected.ruleCode && row.reason === expected.reason,
    );

    checks.push({
      caseId: modelCase.id,
      kind: "discarded",
      target: `${expected.ruleCode}:${expected.reason}`,
      ok: hit !== undefined,
      detail: `${expected.ruleCode} 이 ${expected.reason} 로 버려져야 하는데 그러지 않았다 — 실제: [${merged.discarded.map((row) => `${row.rule_code}:${row.reason}`).join(", ")}]`,
    });
  }

  return checks;
}

// =============================================================================
// 커버리지 — **빈 표가 통과하지 못하게 한다**
// =============================================================================

export type RuleCoverage = {
  code: string;
  title: string;
  /** 이 룰을 **잡아야 한다**고 적은 케이스 수. */
  positive: number;
  /** 이 룰이 **잡히면 안 된다**고 적은 케이스 수. */
  negative: number;
  /** 이 룰을 겨냥한 케이스 수(`focus`). */
  cases: number;
  /**
   * 이번 실행에서 **실제로 돌았는가**.
   *
   * 꺼진 룰은 케이스가 있어도 재지 못한다. **그 사실을 표에서 지우지 않는다** —
   * 지우면 룰 19종을 끈 상태에서도 "전부 통과" 로 읽힌다.
   */
  active: boolean;
};

/**
 * 룰마다 두 방향이 다 있는가.
 *
 * **한 방향만 있으면 검사가 아니다.** 양성만 있으면 정규식을 `/./` 로 바꿔도 통과하고,
 * 음성만 있으면 룰을 통째로 꺼도 통과한다.
 *
 * 표는 **언제나 코드가 가진 룰 20종 전부**로 만든다. `activeCodes` 는 그중 이번에
 * 실제로 돈 것이며, 여기 없는 룰은 `active: false` 로 남아 화면이 "재지 못했다" 고 적는다.
 */
export function ruleCoverage(
  cases: readonly GoldenCase[] = GOLDEN_CASES,
  rules: readonly DetectRule[] = DETECT_RULES,
  activeCodes?: ReadonlySet<string>,
): RuleCoverage[] {
  return rules.map((rule) => {
    const positive = cases.filter((c) => c.detected.includes(rule.code)).length;
    const negative = cases.filter(
      (c) => c.notDetected.includes(rule.code) || (c.exact && !c.detected.includes(rule.code)),
    ).length;

    return {
      code: rule.code,
      title: rule.title,
      positive,
      negative,
      cases: cases.filter((c) => c.focus.includes(rule.code)).length,
      active: activeCodes === undefined ? rule.is_active : activeCodes.has(rule.code),
    };
  });
}

/**
 * 두 방향이 다 차지 않은 룰. **비어 있어야 통과**다.
 *
 * **꺼진 룰은 세지 않는다** — 재지 못한 것이지 표가 비어 있는 것이 아니고, 그 사실은
 * `GoldenResult.unmeasuredRules` 가 따로 들고 있다.
 */
export function coverageGaps(coverage: readonly RuleCoverage[]): string[] {
  return coverage
    .filter((row) => row.active && (row.positive === 0 || row.negative === 0))
    .map(
      (row) =>
        `${row.code} — 잡아야 하는 케이스 ${row.positive}건 · 잡히면 안 되는 케이스 ${row.negative}건 (둘 다 1건 이상이어야 한다)`,
    );
}

// =============================================================================
// 전체 실행
// =============================================================================

export type GoldenFailure = {
  caseId: string;
  /** 사람이 읽는 한 줄. 화면·콘솔·테스트가 같은 문장을 쓴다. */
  line: string;
};

export type GoldenResult = {
  /** 룰 판본. 결과를 읽는 사람이 **무엇을 잰 결과인지** 알아야 한다. */
  ruleVersion: string;
  /** 돌아간 룰 수. 0이면 아래 `blocked` 다. */
  activeRules: number;
  cases: { total: number; clause: number; contract: number; model: number };
  checks: { total: number; passed: number; failed: number };
  failures: GoldenFailure[];
  coverage: RuleCoverage[];
  coverageGaps: string[];
  /**
   * 케이스는 있는데 **꺼져 있어 재지 못한** 룰.
   *
   * **0으로 적지 않는다.** "통과 242건" 옆에 이 목록이 비어 있지 않으면, 초록불이
   * 룰 20종 전부를 확인한 결과가 아니라는 뜻이다.
   */
  unmeasuredRules: string[];
  /**
   * 게이트가 설 수 있는가.
   *
   * **케이스가 0이거나 룰이 0이면 '통과' 가 아니라 '검사 없음'** 이다. 빈 표를 초록으로
   * 적는 것이 이 게이트에서 가장 나쁜 실패다(FIX-42 가 기록된 이유).
   */
  usable: boolean;
  passed: boolean;
};

export function runGoldenSet(input?: {
  cases?: readonly GoldenCase[];
  modelCases?: readonly ModelCase[];
  rules?: readonly DetectRule[];
  ruleVersion?: string;
  /** `runCase` 와 같은 이유로만 갈아 끼운다 — 검사가 헛돌지 않는지 확인할 때. */
  mask?: (text: string) => string;
}): GoldenResult {
  const cases = input?.cases ?? GOLDEN_CASES;
  const modelCases = input?.modelCases ?? MODEL_CASES;
  const rules = (input?.rules ?? DETECT_RULES).filter((rule) => rule.is_active);

  const checks: GoldenCheck[] = [];
  for (const goldenCase of cases) checks.push(...runCase(goldenCase, rules, input?.mask));

  const modelChecks: ModelCheck[] = [];
  for (const modelCase of modelCases) modelChecks.push(...runModelCase(modelCase));

  // 표는 **코드가 가진 룰 20종 전부**로 만든다. 꺼진 룰도 행으로 남아야 화면이
  // "재지 못했다" 고 적을 수 있다.
  const coverage = ruleCoverage(cases, DETECT_RULES, new Set(rules.map((rule) => rule.code)));
  const gaps = coverageGaps(coverage);
  const unmeasuredRules = coverage
    .filter((row) => !row.active && row.cases > 0)
    .map((row) => row.code);

  const failures: GoldenFailure[] = [
    ...checks
      .filter((c) => !c.ok)
      .map((c) => ({ caseId: c.caseId, line: `[${c.path}] ${c.caseId} — ${c.detail}` })),
    ...modelChecks
      .filter((c) => !c.ok)
      .map((c) => ({ caseId: c.caseId, line: `[model] ${c.caseId} — ${c.detail}` })),
    ...gaps.map((gap) => ({ caseId: "coverage", line: `[coverage] ${gap}` })),
  ];

  const total = checks.length + modelChecks.length;
  const failed = checks.filter((c) => !c.ok).length + modelChecks.filter((c) => !c.ok).length;
  const usable = cases.length > 0 && modelCases.length > 0 && rules.length > 0 && total > 0;

  return {
    ruleVersion: input?.ruleVersion ?? DETECT_RULES_VERSION,
    activeRules: rules.length,
    cases: {
      total: cases.length,
      clause: cases.filter((c) => c.kind === "clause").length,
      contract: cases.filter((c) => c.kind === "contract").length,
      model: modelCases.length,
    },
    checks: { total, passed: total - failed, failed },
    failures,
    unmeasuredRules,
    coverage,
    coverageGaps: gaps,
    usable,
    passed: usable && failures.length === 0,
  };
}
