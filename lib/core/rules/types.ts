// 검출 룰 타입 정의 (명세서 §3.5 detect_rules, 부록 A, §5.2 4단계)
//
// DB 의 detect_rules 테이블과 같은 code 로 존재하며 seed.sql 로 동기화한다.
// severity 값은 types/database.ts 의 finding_severity enum(high|mid|low)과 일치해야 한다.

/** finding_severity enum 과 동일. */
export const RULE_SEVERITIES = ["high", "mid", "low"] as const;
export type RuleSeverity = (typeof RULE_SEVERITIES)[number];

/**
 * 룰 카테고리.
 *
 * 부록 A 는 카테고리를 한글(위약·해지 / 가격 / 이행 / 스드메 / 법적)로 적고 있다.
 * DB·API 를 오가는 값이므로 코드는 ASCII 로 두고 표시용 한글은 라벨로 분리한다.
 * seed.sql 은 여기 코드값을 그대로 detect_rules.category 에 넣는다.
 */
export const RULE_CATEGORIES = ["penalty", "price", "performance", "sdm", "legal"] as const;
export type RuleCategory = (typeof RULE_CATEGORIES)[number];

export const RULE_CATEGORY_LABEL: Readonly<Record<RuleCategory, string>> = {
  penalty: "위약·해지",
  price: "가격",
  performance: "이행",
  sdm: "스드메",
  legal: "법적",
};

/**
 * 위험 문구가 **존재하면** 검출하는 조건.
 */
export type PresenceCondition = {
  /** 하나라도 매칭되면 후보로 본다. g 플래그 금지. */
  patterns: readonly RegExp[];
  /** 같은 문장에 이 패턴이 있으면 오탐으로 보고 제외한다. */
  excludes?: readonly RegExp[];
};

/**
 * 있어야 할 조항이 **없으면** 검출하는 조건.
 */
export type AbsenceCondition = {
  /** 이 중 하나라도 문서에 있으면 조항이 갖춰진 것으로 본다. g 플래그 금지. */
  expected: readonly RegExp[];
  /**
   * 이 패턴이 문서에 있을 때만 '부재'를 문제 삼는다.
   * 예: 앨범 사양 미기재(R-12)는 애초에 앨범을 다루지 않는 계약서엔 해당하지 않는다.
   * 미지정이면 모든 문서에 적용한다.
   */
  requires?: readonly RegExp[];
};

export type DetectRule = {
  /** 'R-01' ~ 'R-20'. detect_rules.code 와 일치. */
  code: string;
  title: string;
  category: RuleCategory;
  severity_default: RuleSeverity;
  /**
   * 근거 조항 참조.
   * 정확한 조항 번호는 법무 검수(부록 D ②) 전까지 확정하지 않는다.
   * 여기에는 출처 수준까지만 적는다.
   */
  basis_ref: string;
  /** AI 분석 단계(§5.2 5단계)에 함께 넘기는 지시문 조각. */
  prompt_fragment: string;
  detect: {
    presence?: PresenceCondition;
    absence?: AbsenceCondition;
  };
  version: string;
  is_active: boolean;
};

/** 룰 스캔 결과 후보. LLM 분석 단계의 입력이 된다. */
export type RuleMatch = {
  rule_code: string;
  title: string;
  category: RuleCategory;
  severity: RuleSeverity;
  basis_ref: string;
  /** 'presence' 는 문장 매칭, 'absence' 는 조항 부재. */
  kind: "presence" | "absence";
  /**
   * 매칭된 문장(마스킹본). absence 는 인용할 문장이 없으므로 빈 문자열이다.
   * 원문이 아니라 **마스킹된 텍스트**에서 잘라낸 조각이다.
   */
  clause_excerpt: string;
  /** 문서 내 매칭 위치. absence 는 -1. */
  index: number;
};
