import { DETECT_RULES } from "../rules/detect-rules";
import type { RuleMatch, RuleSeverity } from "../rules/types";

import { guideFor, type ComplianceGuide } from "./guides";

/**
 * 컴플라이언스 자가 진단 (S7-13 · 명세서 §2.3 F-V-10 · §4.2 · §6.3 `/vendor/compliance`)
 *
 * 프레임워크를 모르는 순수 모듈이다.
 *
 * ── 소비자 리포트와 같은 엔진, 다른 화면 ────────────────────────────────────
 * 검출은 **T-04 의 룰 20종과 `lib/core/rules/scan`** 이 한다. 여기서 룰을 새로 만들지
 * 않는다 — 두 벌이 되면 소비자가 본 것과 업체가 본 것이 달라지고, 그건 이 기능이
 * 존재하는 이유를 무너뜨린다. 다른 것은 **문장과 배지**뿐이다.
 *
 * ── AI 를 부르지 않는다 ─────────────────────────────────────────────────────
 * §2.3 이 "검출 룰 20종으로 자가 진단" 이라고 적었고, 여기에는 **배지가 걸린다.**
 * 같은 문서를 두 번 넣었을 때 다른 답이 나오면 배지가 우연의 산물이 된다 —
 * CLAUDE.md §3.1(결정적 계산에 LLM 을 쓰지 않는다)이 가리키는 자리다. 그래서
 * 소비자 리포트(§5.2)의 **AI 단계는 쓰지 않고 룰 스캔까지만** 쓴다.
 *
 * ── 배지는 우리가 붙이는 이름이다 ───────────────────────────────────────────
 * '투명 계약' 배지가 붙으면 **고객이 그것을 신뢰의 근거로 삼는다.** 그래서 이 파일은
 * 배지를 세 가지로 묶어 다룬다 — **기준**(어디에 두는가) · **범위**(무엇까지 참인가) ·
 * **시점**(언제 진단한 것인가). 셋 중 하나라도 빠지면 배지는 사실이 아니라 광고가 된다.
 */

// =============================================================================
// 진단 결과
// =============================================================================

export type ComplianceFinding = {
  ruleCode: string;
  title: string;
  severity: RuleSeverity;
  /** 근거 기준의 **이름**. 조항 번호를 넣지 않는다(T-04 가 테스트로 막는다). */
  basisRef: string;
  kind: "presence" | "absence";
  /** 걸린 문장. `absence` 는 인용할 문장이 없어 빈 문자열이다. */
  clauseExcerpt: string;
  guide: ComplianceGuide | null;
};

export type SeverityCount = Record<RuleSeverity, number>;

/**
 * 룰 스캔 결과 → 업체 화면이 쓰는 finding.
 *
 * **같은 룰이 여러 번 걸리면 하나로 합친다.** 업체에게 필요한 것은 "몇 문장이
 * 걸렸나" 가 아니라 **"무엇을 고쳐야 하나"** 이고, 같은 항목이 다섯 번 나오면
 * 목록이 길어질 뿐 할 일은 하나다. 인용은 **처음 걸린 문장**을 남긴다.
 */
export function toFindings(matches: readonly RuleMatch[]): ComplianceFinding[] {
  const byCode = new Map<string, ComplianceFinding>();

  for (const match of matches) {
    if (byCode.has(match.rule_code)) continue;

    byCode.set(match.rule_code, {
      ruleCode: match.rule_code,
      title: match.title,
      severity: match.severity,
      basisRef: match.basis_ref,
      kind: match.kind,
      clauseExcerpt: match.clause_excerpt,
      guide: guideFor(match.rule_code),
    });
  }

  // 심각한 것부터. 같은 등급이면 룰 코드 순 — **매번 같은 순서**여야 업체가
  // 어제 본 목록과 오늘 본 목록을 견줄 수 있다.
  const order: Record<RuleSeverity, number> = { high: 0, mid: 1, low: 2 };

  return [...byCode.values()].sort(
    (a, b) => order[a.severity] - order[b.severity] || a.ruleCode.localeCompare(b.ruleCode),
  );
}

export function countBySeverity(findings: readonly ComplianceFinding[]): SeverityCount {
  const counts: SeverityCount = { high: 0, mid: 0, low: 0 };

  for (const finding of findings) counts[finding.severity] += 1;

  return counts;
}

/** 검사한 룰 수. 화면이 **"무엇까지 봤는가"** 를 적는 근거다. */
export function activeRuleCount(): number {
  return DETECT_RULES.filter((rule) => rule.is_active).length;
}

// =============================================================================
// 배지
// =============================================================================

/**
 * 배지 코드.
 *
 * `vendors.badge_flags` 에 들어가는 값이며 0003 이 **"사실 기반 배지만"** 이라고
 * 자리를 잡아 두었다. `response_fast`(응답 우수)는 이 태스크의 것이 아니다 —
 * 여기서는 `transparent_contract` 하나만 다룬다.
 */
export const TRANSPARENT_CONTRACT_BADGE = "transparent_contract";

export const BADGE_LABEL = "투명 계약";

/**
 * **배지가 무엇을 뜻하는지 배지 옆에 늘 적는다.**
 *
 * 이 문장이 없으면 배지는 "이 업체는 믿을 만하다" 로 읽힌다. 우리가 실제로 아는 것은
 * **업체가 제출한 약관이 우리 룰 20종에 걸리지 않았다**는 것뿐이다 — 제출한 문서가
 * 고객에게 실제로 주는 계약서와 같은지 우리는 확인하지 않았다. 자가 진단의 한계를
 * 감추면 그 배지는 사실이 아니라 광고가 된다(D-03 · D-24 · CLAUDE.md §2.3).
 */
export const BADGE_SCOPE_NOTICE =
  "업체가 제출한 약관을 검출 룰로 검사한 결과입니다. 실제 계약서와 다를 수 있으며 계약 전 원문을 확인해 주세요.";

/**
 * 기준 설명 — **읽는 사람에 따라 문장이 다르다.**
 *
 * 업체용에는 "고치면 다시 진단해 주세요" 가 붙지만 **고객 화면에 그 문장이 가면**
 * 안 된다 — 고객이 할 수 있는 일이 아니고, 남의 할 일을 읽는 것은 화면을 흐린다.
 * 흐름 점검이 고객 화면에서 그 문장을 실제로 잡았다.
 */
export const BADGE_CRITERIA_NOTICE =
  "'먼저 손볼 곳'으로 분류된 항목이 하나도 없을 때 붙습니다. 약관을 고치면 다시 진단해 주세요.";

export const BADGE_CRITERIA_PUBLIC_NOTICE =
  "검출 룰에서 확인이 필요한 항목이 하나도 나오지 않았을 때 붙습니다.";

/** 미결 파라미터의 키. **값이 아니라 키만** 코드가 갖는다(§7.4). */
export const COMPLIANCE_SETTING_KEYS = {
  badgeMaxHigh: { key: "compliance.badge_max_high", field: "value" },
} as const;

export type BadgeDecision =
  | { granted: true; reason: "passed" }
  | { granted: false; reason: "never_scanned" | "has_high" | "criteria_unconfigured" };

export const BADGE_REASON_NOTE: Record<BadgeDecision["reason"], string> = {
  passed: "진단을 통과했어요. 업체 목록과 상세에 배지가 보입니다.",
  // **0건과 '아직 안 했다' 를 겹쳐 읽히게 두지 않는다.**
  never_scanned: "아직 진단하지 않았어요. 0건이 아니라 아직 세지 않은 것입니다.",
  has_high: "'먼저 손볼 곳' 항목이 남아 있어 아직 붙지 않았어요.",
  criteria_unconfigured: "배지 기준이 설정되지 않아 지금은 부여할 수 없어요.",
};

/**
 * 배지 판정.
 *
 * ── 기준을 어디에 두는가 ────────────────────────────────────────────────────
 * **`high` 허용 개수 하나**만 본다. 그 값은 `app_settings.compliance.badge_max_high` 이며
 * **코드가 숫자를 갖지 않는다**(§7.4). 값이 없으면 **배지를 주지 않는다** — 없는 기준을
 * '0건이면 통과' 로 읽으면 그 순간 기준을 코드가 정한 것이 된다(D-49·D-90 과 같은 규칙).
 *
 * ── `mid` 를 기준에 넣지 않은 이유 ──────────────────────────────────────────
 * "mid 를 몇 개까지 봐줄 것인가" 는 **답이 임의인 물음**이다. 2개면 되고 3개면 안 되는
 * 근거를 우리가 갖고 있지 않다. 반면 `high` 는 T-04 가 **"소비자에게 불리하고 근거가
 * 있는 것"** 으로 정의했으므로 그런 항목이 남은 약관을 '투명 계약' 이라 부를 수 없다는
 * 판단은 **등급 정의에서 따라 나온다.** 임의 숫자를 기준에 섞지 않는다.
 *
 * ── 유효기간을 두지 않은 이유 ───────────────────────────────────────────────
 * 약관은 바뀌고 배지는 **진단 시점의 문서**에 대한 것이다. 만료일을 파라미터로 두는
 * 대신 **진단 날짜를 배지와 함께 항상 보여준다** — 기간을 정하는 것은 또 하나의 임의
 * 숫자이고, 날짜를 보이면 보는 사람이 스스로 판단한다(계산 가능한 값을 저장하지
 * 않는다는 원칙과도 같다).
 */
export function decideBadge(input: {
  /** 진단한 적이 없으면 null. **0 과 구분한다.** */
  highCount: number | null;
  /** `app_settings.compliance.badge_max_high`. 없으면 null. */
  maxHigh: number | null;
}): BadgeDecision {
  if (input.highCount === null) return { granted: false, reason: "never_scanned" };

  if (input.maxHigh === null || !Number.isInteger(input.maxHigh) || input.maxHigh < 0) {
    return { granted: false, reason: "criteria_unconfigured" };
  }

  return input.highCount <= input.maxHigh
    ? { granted: true, reason: "passed" }
    : { granted: false, reason: "has_high" };
}

// =============================================================================
// 입력
// =============================================================================

/**
 * 진단할 수 있는 길이.
 *
 * 아래는 **비용·상한이 아니라 입력 검증**이다. 너무 짧으면 스캔이 의미 없고(문장이
 * 없으면 부재 룰이 전부 걸린다) 너무 길면 정규식 20종을 도는 비용이 요청 시간을
 * 넘긴다. 소비자 업로드(S7-03)와 같은 계열의 판단이다.
 */
export const TERMS_MIN_LENGTH = 200;
export const TERMS_MAX_LENGTH = 100_000;

export type TermsIssue = "too_short" | "too_long" | "empty";

export const TERMS_ISSUE_NOTE: Record<TermsIssue, string> = {
  empty: "약관 내용을 붙여넣어 주세요.",
  too_short: `약관이 너무 짧아요. ${TERMS_MIN_LENGTH}자 이상 넣어 주세요 — 짧은 글은 조항이 없는 것으로 읽혀 대부분의 항목이 걸립니다.`,
  too_long: `약관이 너무 길어요. ${TERMS_MAX_LENGTH.toLocaleString("ko-KR")}자 이하로 나눠 넣어 주세요.`,
};

export function termsIssue(text: string): TermsIssue | null {
  const trimmed = text.trim();

  if (trimmed.length === 0) return "empty";
  if (trimmed.length < TERMS_MIN_LENGTH) return "too_short";
  if (trimmed.length > TERMS_MAX_LENGTH) return "too_long";

  return null;
}

// =============================================================================
// 화면 문구
// =============================================================================

/** §7.7 · CLAUDE.md §2.3 — AI 결과가 아니어도 **법적 판단이 아님**을 밝힌다. */
export const COMPLIANCE_DISCLAIMER =
  "참고 정보이며 법률 자문이 아닙니다. 표준약관·소비자분쟁해결기준과 견줘 확인이 필요한 부분을 짚어 드리는 것이며, 조항의 효력에 대한 판단이 아닙니다.";

export const SELF_SCAN_NOTICE =
  "붙여넣은 약관은 저장하지 않습니다. 검사 결과(걸린 항목과 인용 문장)만 남습니다.";

/**
 * 걸린 것이 하나도 없을 때.
 *
 * **"문제 없음" 이라고 적지 않는다.** 우리가 아는 것은 **룰 20종에 걸리지 않았다**는
 * 것뿐이고, 그 밖의 문제를 우리는 보지 않았다. 계산된 0 에 **무엇을 세어 0 인지**를
 * 붙인다(S7-04 가 위약금 기준에서 세운 규칙).
 */
export function cleanScanNote(ruleCount: number): string {
  return `검출 룰 ${ruleCount}종에 걸린 항목이 없습니다. 이 ${ruleCount}종 밖의 내용은 검사하지 않았어요.`;
}
