import { AI_DISCLAIMER } from "../legal";
import { RULE_SEVERITIES } from "../rules/types";
import type { RuleMatch } from "../rules/types";

/**
 * 계약서 분석 프롬프트 (S7-03 · 명세서 §5.2 5단계 · CLAUDE.md §8)
 *
 * **프롬프트는 코드로 관리하고 판본을 붙인다.** 결과가 달라졌을 때 모델이 바뀐
 * 것인지 문구가 바뀐 것인지 구분할 수 있어야 하고, 그 판본은
 * `document_analyses.prompt_version` 에 남는다.
 *
 * **모델에게 문서를 처음부터 읽으라고 하지 않는다.** 룰 스캔(4단계)이 이미 후보
 * 조항과 `rule_code` 를 뽑아 두었고, 모델이 하는 일은 그 후보에 **설명과 요청 문구를
 * 붙이는 것**이다. 그래야 (가) 같은 문서가 같은 룰로 걸리고 (나) `rule_code` 가
 * 정의된 20종 밖으로 나가지 않으며 (다) 인용 대조가 성립한다.
 *
 * **조항 번호를 만들지 못하게 한다.** `basis_ref` 는 룰이 가진 값을 그대로 쓰게 하고,
 * 모델이 "제 15 조" 같은 번호를 지어내면 그 finding 은 버린다 — 법무 검수(부록 D ②)
 * 전까지 우리는 조항 번호를 말하지 않는다(S7-01 이 시드에서 세운 규칙과 같다).
 */

export const REPORT_PROMPT_VERSION = "report@1";

/** 리포트 한 편의 상한. 조항 20종 × 설명이라 넉넉히 잡되 무한하지 않다. */
export const REPORT_MAX_TOKENS = 4_096;

export const REPORT_SYSTEM = [
  "당신은 한국 웨딩 계약서를 검토해 **구조화된 결과만** 내는 분석기다.",
  "",
  "규칙:",
  "1. JSON 객체 하나만 출력한다. 코드펜스·머리말·꼬리말을 붙이지 않는다.",
  '2. 모양은 {"summary":"...","findings":[...],"missing_clauses":["..."],"negotiation_points":["..."]} 이다.',
  "3. findings 의 각 항목은 다음 필드를 갖는다:",
  "   - rule_code: **주어진 후보 목록에 있는 코드만** 쓴다. 새 코드를 만들지 않는다.",
  `   - severity: ${RULE_SEVERITIES.join(" | ")}`,
  "   - clause_excerpt: **문서에서 그대로 잘라 온 부분 문자열**이어야 한다. 요약하거나 다듬지 않는다.",
  "     문서에 없는 문구를 적으면 그 항목은 폐기된다.",
  "   - issue: 무엇이 문제인지 한두 문장.",
  "   - basis_ref: **후보에 적힌 근거 문자열을 그대로** 옮긴다. 조항 번호를 만들지 않는다.",
  "   - negotiation_script: 사용자가 업체에 그대로 보낼 수 있는 요청 문구.",
  "4. **확정적 법적 결론을 내리지 않는다.** '무효다'·'승소한다'·'위법이다' 라고 쓰지 않고,",
  "   기준 대비 차이로만 서술한다.",
  "5. 위험 점수를 쓰지 않는다 — 점수는 코드가 계산한다.",
  "6. 문서에 없는 사실을 만들지 않는다. 후보가 비어 있으면 findings 도 비운다.",
  "7. 개인정보 토큰(NAME_1 · PHONE_1 같은 형태)은 **그대로 둔다.** 되돌리려 하지 않는다.",
  "",
  `이 결과에는 다음 고지가 항상 함께 나간다: ${AI_DISCLAIMER}`,
].join("\n");

/**
 * 사용자 메시지.
 *
 * **마스킹된 문서와 룰 후보를 함께 준다.** 후보만 주면 앞뒤 맥락을 몰라 설명이
 * 헛돌고, 문서만 주면 룰이 이미 내린 결정을 모델이 다시 내려 결과가 흔들린다.
 */
export function buildReportUserMessage(input: {
  maskedText: string;
  matches: readonly RuleMatch[];
  /** 룰이 가진 분석 지시문. 운영자가 DB 에서 고칠 수 있는 값이다(F-A-03). */
  fragments: Readonly<Record<string, string | null>>;
}): string {
  const candidates =
    input.matches.length === 0
      ? "(없음)"
      : input.matches
          .map((match) => {
            const fragment = input.fragments[match.rule_code] ?? "";

            return [
              `- ${match.rule_code} (${match.severity}) ${match.title}`,
              `  근거: ${match.basis_ref}`,
              match.kind === "absence"
                ? "  형태: 있어야 할 조항이 없음(인용할 문장이 없으면 관련 문장을 인용한다)"
                : `  걸린 문장: ${match.clause_excerpt}`,
              fragment === "" ? null : `  지시: ${fragment}`,
            ]
              .filter((line) => line !== null)
              .join("\n");
          })
          .join("\n");

  return [
    "다음은 개인정보가 토큰으로 치환된 계약서 본문이다.",
    "---",
    input.maskedText,
    "---",
    "",
    "검출 룰이 찾은 후보:",
    candidates,
    "",
    "위 후보에 설명과 요청 문구를 붙여 JSON 으로 답한다.",
  ].join("\n");
}

/** 스키마 검증 실패 시 1회 재시도에 붙이는 피드백(CLAUDE.md §8). */
export function buildReportRetryMessage(error: string): string {
  return [
    "직전 응답이 형식을 벗어났다.",
    `오류: ${error}`,
    "JSON 객체 하나만, 위 규칙 그대로 다시 출력한다.",
  ].join("\n");
}
