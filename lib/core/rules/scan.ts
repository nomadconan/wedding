// 룰 스캔 (명세서 §5.2 4단계)
//
//  * 입력은 **마스킹이 끝난 텍스트**다. 원문을 넣지 않는다.
//  * LLM 을 사용하지 않는 결정적 매칭이다. 같은 입력이면 항상 같은 결과가 나온다.
//  * 매칭 0건이어도 5단계(LLM 분석)로 진행한다 — 여기서 예외를 던지지 않는다.

import { DETECT_RULES } from "./detect-rules";
import type { DetectRule, RuleMatch } from "./types";

/** 문서를 문장 단위로 자른 조각. */
export type TextSegment = {
  text: string;
  /** 원본 텍스트에서의 시작 위치. */
  index: number;
};

/** 인용 조각의 최대 길이. 너무 길면 리포트 화면이 무너진다. */
const MAX_EXCERPT_LENGTH = 300;

/** 한 룰이 같은 문서에서 만들어낼 수 있는 최대 후보 수. */
const MAX_MATCHES_PER_RULE = 5;

/**
 * 텍스트를 문장 단위로 자른다.
 *
 * 줄바꿈으로 먼저 나누고, 각 줄을 종결 부호(., !, ?) 기준으로 다시 나눈다.
 * 조항 번호("제3조", "1.")로 시작하는 줄이 많은 계약서 특성상
 * 줄바꿈을 1차 경계로 두는 편이 인용 품질이 좋다.
 */
export function segmentText(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
  let cursor = 0;

  for (const line of text.split("\n")) {
    const lineStart = cursor;
    cursor += line.length + 1; // '\n' 포함

    if (line.trim() === "") continue;

    // 종결 부호 뒤에서 자른다. 소수점·번호 매김은 뒤에 공백이 없으므로 살아남는다.
    const parts = line.split(/(?<=[.!?])\s+/);
    let offset = 0;

    for (const part of parts) {
      const trimmedStart = part.length - part.trimStart().length;
      const value = part.trim();

      if (value !== "") {
        segments.push({ text: value, index: lineStart + offset + trimmedStart });
      }

      // split 이 제거한 공백까지 정확히 세기는 어렵다. 근사치로 누적하되
      // index 는 인용 위치 표시용이므로 문자 단위 정확도까지는 요구하지 않는다.
      offset += part.length + 1;
    }
  }

  return segments;
}

function excerpt(value: string): string {
  return value.length <= MAX_EXCERPT_LENGTH ? value : `${value.slice(0, MAX_EXCERPT_LENGTH)}…`;
}

function matchesAny(patterns: readonly RegExp[], value: string): boolean {
  return patterns.some((pattern) => pattern.test(value));
}

function scanPresence(rule: DetectRule, segments: readonly TextSegment[]): RuleMatch[] {
  const condition = rule.detect.presence;
  if (!condition) return [];

  const matches: RuleMatch[] = [];

  for (const segment of segments) {
    if (matches.length >= MAX_MATCHES_PER_RULE) break;
    if (!matchesAny(condition.patterns, segment.text)) continue;
    if (condition.excludes && matchesAny(condition.excludes, segment.text)) continue;

    matches.push({
      rule_code: rule.code,
      title: rule.title,
      category: rule.category,
      severity: rule.severity_default,
      basis_ref: rule.basis_ref,
      kind: "presence",
      clause_excerpt: excerpt(segment.text),
      index: segment.index,
    });
  }

  return matches;
}

function scanAbsence(rule: DetectRule, text: string): RuleMatch[] {
  const condition = rule.detect.absence;
  if (!condition) return [];

  // requires 가 있는데 문서가 그 주제를 다루지 않으면 '부재' 를 문제 삼지 않는다.
  if (condition.requires && !matchesAny(condition.requires, text)) return [];

  // 기대 조항이 하나라도 있으면 통과.
  if (matchesAny(condition.expected, text)) return [];

  return [
    {
      rule_code: rule.code,
      title: rule.title,
      category: rule.category,
      severity: rule.severity_default,
      basis_ref: rule.basis_ref,
      kind: "absence",
      clause_excerpt: "",
      index: -1,
    },
  ];
}

/**
 * 마스킹된 문서에 룰 20종을 적용해 후보 finding 을 만든다.
 *
 * @param maskedText 마스킹이 끝난 계약서 텍스트
 * @param rules 적용할 룰. 기본값은 활성 룰 전체.
 */
export function scanDocument(
  maskedText: string,
  rules: readonly DetectRule[] = DETECT_RULES,
): RuleMatch[] {
  const segments = segmentText(maskedText);
  const results: RuleMatch[] = [];

  for (const rule of rules) {
    if (!rule.is_active) continue;

    results.push(...scanPresence(rule, segments));
    results.push(...scanAbsence(rule, maskedText));
  }

  return results;
}

/** 스캔 결과에서 룰 코드만 추린다(중복 제거). */
export function matchedRuleCodes(matches: readonly RuleMatch[]): string[] {
  return [...new Set(matches.map((m) => m.rule_code))].sort();
}

/**
 * 인용 대조(§5.2 7단계).
 *
 * finding 의 clause_excerpt 가 마스킹 원문에 실재하는지 문자열 대조한다.
 * 공백 차이는 허용하되 내용이 다르면 불일치로 본다.
 */
export function verifyCitation(maskedText: string, clauseExcerpt: string): boolean {
  const normalize = (value: string) => value.replace(/\s+/g, "").replace(/…$/, "");

  const needle = normalize(clauseExcerpt);
  if (needle === "") return false;

  return normalize(maskedText).includes(needle);
}
