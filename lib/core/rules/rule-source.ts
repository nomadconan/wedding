// 룰 출처 병합 (S7-01 · 명세서 §3.5 detect_rules · §5.2 4단계 · F-A-03)
//
// ── 진실이 둘인 것처럼 보이는 문제 ──────────────────────────────────────────
// 검출 룰은 **코드**(`detect-rules.ts`)와 **DB**(`detect_rules`) 양쪽에 있다.
// 같은 것이 두 곳에 있으면 언젠가 어긋나고, 어긋난 순간 어느 쪽이 맞는지 아무도
// 모른다. 그래서 **무엇을 누가 갖는지 먼저 나눈다.**
//
//   코드가 갖는 것   정규식(실행 주체) · 룰의 존재 자체
//   DB 가 갖는 것    켬/끔(`is_active`) · 운영자가 다듬는 문안(`prompt_fragment`)
//                    · 근거 출처(`basis_ref`) · 판본(`version`)
//
// **정규식을 DB 에서 가져와 컴파일하지 않는다.** 운영자가 한 글자 잘못 적으면
// 스캔이 통째로 멈추거나(SyntaxError) 최악의 경우 특정 문서에서 되돌아오지 않는다
// (파국적 백트래킹). 룰을 고치는 일은 배포로 한다 — 그 편이 리뷰를 거친다.
//
// **DB 를 못 읽어도 검출은 돈다.** 그때는 코드 그대로 쓰고 출처를 `code` 로 알린다.
// 운영자가 끈 룰이 살아날 수 있으므로 **그 사실을 삼키지 않는다**(`source` 를 반환).

import type { DetectRule } from "./types";

/** DB `detect_rules` 한 행에서 이 병합이 쓰는 부분. */
export type DetectRuleRow = {
  code: string;
  prompt_fragment: string | null;
  basis_ref: string | null;
  version: string;
  is_active: boolean;
};

export type RuleSetSource = "database" | "code";

/** 코드와 DB 가 어긋난 지점. 조용히 넘기지 않고 호출부로 올린다. */
export type RuleDrift = {
  /** DB 에만 있는 코드 — 정규식이 없어 **실행할 수 없다.** */
  unknownInDatabase: string[];
  /** DB 에 없는 코드 — 시드가 밀리지 않았다는 뜻이다. 코드 값을 그대로 쓴다. */
  missingInDatabase: string[];
  /** 판본이 다른 코드. 룰 내용이 달라졌을 수 있다. */
  versionMismatch: string[];
};

export type MergedRuleSet = {
  rules: DetectRule[];
  source: RuleSetSource;
  drift: RuleDrift;
  /** DB 가 끈 룰. 스캔에서 빠졌다는 사실을 리포트가 적을 수 있게 남긴다. */
  disabled: string[];
};

const EMPTY_DRIFT: RuleDrift = {
  unknownInDatabase: [],
  missingInDatabase: [],
  versionMismatch: [],
};

/** 코드만으로 룰 세트를 만든다. DB 를 못 읽었을 때의 경로다. */
export function codeOnlyRuleSet(codeRules: readonly DetectRule[]): MergedRuleSet {
  return {
    rules: codeRules.filter((rule) => rule.is_active).map((rule) => ({ ...rule })),
    source: "code",
    drift: { ...EMPTY_DRIFT },
    disabled: [],
  };
}

/**
 * 코드 룰과 DB 행을 병합한다.
 *
 * - 실행되는 룰의 목록은 **코드가 정한다.** DB 에만 있는 코드는 실행하지 않는다.
 * - 켬/끔·문안·근거·판본은 **DB 가 정한다.** 행이 없는 룰은 코드 값을 그대로 쓴다.
 * - 행이 하나도 없으면 시드 전이라는 뜻이므로 코드 경로로 되돌린다.
 */
export function mergeDetectRules(
  codeRules: readonly DetectRule[],
  rows: readonly DetectRuleRow[],
): MergedRuleSet {
  if (rows.length === 0) {
    const fallback = codeOnlyRuleSet(codeRules);

    return {
      ...fallback,
      drift: { ...EMPTY_DRIFT, missingInDatabase: codeRules.map((rule) => rule.code) },
    };
  }

  const byCode = new Map(rows.map((row) => [row.code, row]));
  const codes = new Set(codeRules.map((rule) => rule.code));

  const rules: DetectRule[] = [];
  const disabled: string[] = [];
  const missingInDatabase: string[] = [];
  const versionMismatch: string[] = [];

  for (const rule of codeRules) {
    const row = byCode.get(rule.code);

    if (!row) {
      missingInDatabase.push(rule.code);
      if (rule.is_active) rules.push({ ...rule });
      continue;
    }

    if (row.version !== rule.version) versionMismatch.push(rule.code);

    if (!row.is_active || !rule.is_active) {
      disabled.push(rule.code);
      continue;
    }

    rules.push({
      ...rule,
      // 빈 문자열은 "운영자가 지웠다" 가 아니라 대개 사고다. 코드 값을 남긴다.
      prompt_fragment: row.prompt_fragment?.trim() ? row.prompt_fragment : rule.prompt_fragment,
      basis_ref: row.basis_ref?.trim() ? row.basis_ref : rule.basis_ref,
      version: row.version,
    });
  }

  return {
    rules,
    source: "database",
    drift: {
      unknownInDatabase: rows.map((row) => row.code).filter((code) => !codes.has(code)),
      missingInDatabase,
      versionMismatch,
    },
    disabled,
  };
}

/** 어긋난 곳이 하나라도 있는가. 로깅·경보 판단에 쓴다. */
export function hasDrift(drift: RuleDrift): boolean {
  return (
    drift.unknownInDatabase.length > 0 ||
    drift.missingInDatabase.length > 0 ||
    drift.versionMismatch.length > 0
  );
}

/**
 * 룰 세트가 분석을 수행할 수 있는 상태인가.
 *
 * **0건이면 분석을 시작하지 않는다.** 룰 없이 돌린 결과는 "위험 없음" 처럼 보이지만
 * 실제로는 "아무것도 보지 않았다" 이며, 그 둘을 화면에서 구분할 방법이 없다.
 */
export function ruleSetUsable(merged: MergedRuleSet): boolean {
  return merged.rules.length > 0;
}

export const RULE_SET_EMPTY_MESSAGE =
  "검출 룰이 하나도 켜져 있지 않아 분석을 시작하지 않았어요.";
