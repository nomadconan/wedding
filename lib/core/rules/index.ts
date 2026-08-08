// 검출 룰 진입점 (명세서 부록 A, §3.5 detect_rules, §5.2 4단계)
//
// 룰 20종은 supabase seed(detect_rules)와 코드에서 동기 관리한다.
// 프레임워크 의존 금지 — React/Next 를 import 하지 않는다(CLAUDE.md §3.1).

export {
  DETECT_RULES,
  DETECT_RULES_VERSION,
  DETECT_RULE_CODES,
  getDetectRule,
} from "./detect-rules";

export {
  matchedRuleCodes,
  scanDocument,
  segmentText,
  verifyCitation,
  type TextSegment,
} from "./scan";

export {
  RULE_CATEGORIES,
  RULE_CATEGORY_LABEL,
  RULE_SEVERITIES,
  type AbsenceCondition,
  type DetectRule,
  type PresenceCondition,
  type RuleCategory,
  type RuleMatch,
  type RuleSeverity,
} from "./types";
