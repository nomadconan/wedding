import { DISCLAIMER_REQUIRED_PHRASE } from "../legal";
import type { PenaltyResult } from "../schemas/penalty";

/**
 * 위약금 시뮬레이터 화면 규칙 (S7-04 · 명세서 §2.1 F-C-08 · §5.3 · §6.2 `/tools/penalty` · §7.7)
 *
 * ── 이 파일이 있는 이유 ─────────────────────────────────────────────────────
 * 계산은 `penalty.ts`(T-04)가 이미 한다. 여기 있는 것은 **그 결과를 화면이 어떻게
 * 말해도 되는가** 뿐이다 — 그 판단을 화면 파일에 두면 다음 화면(리포트·해지 견적)이
 * 같은 결과를 다르게 말하게 된다(S7-19 D-79 와 같은 처리).
 *
 * ── 여기서 하지 않는 것 ─────────────────────────────────────────────────────
 * **초과분에 등급·심각도를 매기지 않는다.** "과도한 조항" 같은 말은 평가적 단정이며
 * CLAUDE.md §2.3 이 금지한다 — 업체에 대한 부정적 판단은 **사실과 기준 대비 편차로만**
 * 표현한다. 그래서 이 모듈이 내보내는 것은 **금액과 비율**뿐이고, 그것을 어떻게
 * 받아들일지는 사용자가 정한다.
 *
 * 프레임워크를 모르는 순수 모듈이다.
 */

// =============================================================================
// 기준의 출처 — "0원" 이 아니라 "기준 미설정" 이다
// =============================================================================

/**
 * 어떤 기준으로 계산했는가.
 *
 * `penalty_rules` 는 **일부러 시드하지 않았다**(0031 근거 6 · S5-08) — 법무 검수 전
 * 수치를 DB 에 넣으면 그것이 운영 기준처럼 굳기 때문이다. 그래서 지금 돌아가는 계산은
 * **T-04 의 가정치**이고, 화면은 그 사실을 **숨기지 않고 맨 위에 적는다.**
 *
 * **비어 있다고 0원을 말하지 않는다.** 위약금 0원은 "안 내도 된다" 로 읽히는데 그것은
 * 우리가 아는 사실이 아니라 **기준이 아직 없다는 우리 쪽 사정**이다(미설정 파라미터를
 * 0으로 읽지 않는다 — D-49·D-82 와 같은 규칙).
 */
export const RULE_SOURCES = ["database", "draft"] as const;
export type RuleSource = (typeof RULE_SOURCES)[number];

export type RuleState = {
  source: RuleSource;
  isDraft: boolean;
  /** 화면 맨 위에 고정으로 적는 한 줄. */
  headline: string;
  /** 무엇을 해야 확정되는지. 다음 사람이 읽을 자리다. */
  detail: string;
  /** 확정된 기준으로 계산했는가. 거짓이면 화면이 경고 톤을 쓴다. */
  settled: boolean;
};

export function ruleStateOf(input: { source: RuleSource; isDraft: boolean }): RuleState {
  // DB 에 행이 없어 코드 가정치로 내려온 경우. **가장 정확히 말해야 하는 상태다.**
  if (input.source === "draft") {
    return {
      ...input,
      headline: "확정된 위약금 기준이 아직 등록되지 않았어요.",
      detail:
        "지금 보이는 금액은 소비자분쟁해결기준을 참고한 가정치로 계산한 값이에요. 법무 검수를 거친 기준이 등록되면 그 값으로 다시 계산됩니다.",
      settled: false,
    };
  }

  if (input.isDraft) {
    return {
      ...input,
      headline: "등록된 기준 중 일부가 아직 가정치예요.",
      detail:
        "확정되지 않은 구간이 섞여 있어 금액이 바뀔 수 있어요. 계약 협의에 그대로 쓰기 전에 확인이 필요합니다.",
      settled: false,
    };
  }

  return {
    ...input,
    headline: "등록된 기준으로 계산했어요.",
    detail: "소비자분쟁해결기준을 근거로 등록된 구간·요율을 적용했습니다.",
    settled: true,
  };
}

// =============================================================================
// 비교 — 기준과 계약서를 나란히
// =============================================================================

/**
 * 막대 길이(bp).
 *
 * **둘 중 큰 값을 100% 로 잡는다.** 총액을 기준으로 잡으면 위약금이 총액의 10% 인
 * 흔한 경우에 두 막대가 모두 짧아져 **차이가 보이지 않는다** — 이 화면이 보여주려는
 * 것이 바로 그 차이다.
 *
 * 둘 다 0이면 0을 준다. **나눗셈을 하지 않는다.**
 */
export function barBp(value: number, max: number): number {
  if (max <= 0) return 0;
  if (value <= 0) return 0;

  return Math.min(10_000, Math.round((value * 10_000) / max));
}

export type PenaltyComparison = {
  /** 둘 중 큰 금액. 막대의 100% 기준이다. */
  scale: number;
  standardBp: number;
  contractBp: number;
  /** 계약서가 기준보다 많은 금액. 0이면 넘지 않았다. */
  excess: number;
  /** 초과분이 **기준 대비** 몇 bp 인가. 기준이 0이면 비율을 만들지 않는다. */
  excessOverStandardBp: number | null;
  /** 초과분이 **총액 대비** 몇 bp 인가. 총액이 0이면 만들지 않는다. */
  excessOverTotalBp: number | null;
};

export function comparisonOf(input: {
  result: Pick<PenaltyResult, "standard" | "contract" | "excessPenalty">;
  totalAmount: number;
}): PenaltyComparison {
  const standard = input.result.standard.penalty;
  const contract = input.result.contract.penalty;
  const scale = Math.max(standard, contract);

  return {
    scale,
    standardBp: barBp(standard, scale),
    contractBp: barBp(contract, scale),
    excess: input.result.excessPenalty,
    // **기준이 0인데 비율을 내면 무한대가 된다.** 없는 값은 만들지 않는다.
    excessOverStandardBp:
      standard <= 0 ? null : Math.round((input.result.excessPenalty * 10_000) / standard),
    excessOverTotalBp:
      input.totalAmount <= 0
        ? null
        : Math.round((input.result.excessPenalty * 10_000) / input.totalAmount),
  };
}

/**
 * 초과분을 한 줄로.
 *
 * **평가어를 쓰지 않는다.** "과도하다"·"불리하다" 는 판단이고, 우리가 말할 수 있는
 * 것은 **얼마나 차이가 나는가**뿐이다(CLAUDE.md §2.3).
 */
export function excessSentence(comparison: PenaltyComparison): string {
  if (comparison.excess <= 0) {
    return "계약서 조건이 기준 금액을 넘지 않아요.";
  }

  const amount = `${comparison.excess.toLocaleString("ko-KR")}원`;

  if (comparison.excessOverStandardBp === null) {
    return `계약서 조건이 기준보다 ${amount} 많아요.`;
  }

  return `계약서 조건이 기준보다 ${amount} 많아요 (기준 대비 ${(comparison.excessOverStandardBp / 100).toFixed(1)}%).`;
}

/**
 * 기준 위약금이 0원일 때 **왜 0인지** 말한다.
 *
 * **흐름 점검이 잡았다.** 예식일 90일 전 취소는 기준상 계약금을 돌려받는 구간이라
 * `standard.penalty` 가 정직하게 0이 된다. 그런데 화면에 "기준 위약금 0원" 만 뜨면
 * 위쪽의 "확정된 기준이 아직 등록되지 않았어요" 와 겹쳐 읽혀 **"기준이 없어서 0인가"**
 * 로 이해된다 — 둘은 완전히 다른 사실이다.
 *
 * · 계산된 0 = **이 시점에는 안 내도 된다는 기준의 답**
 * · 기준 미설정 = **우리가 답을 모른다**(`ruleStateOf` 가 따로 말한다)
 *
 * 그래서 계산된 0에는 **근거 구간을 붙여 준다.** 0을 설명 없이 두지 않는다.
 */
export function standardZeroReason(result: {
  standard: { penalty: number };
  depositRefundable: boolean;
  bandLabel: string;
}): string | null {
  if (result.standard.penalty > 0) return null;

  if (result.depositRefundable) {
    return `${result.bandLabel} 구간이라 기준상 계약금을 돌려받아요. 기준 위약금이 0원인 것은 계산 결과입니다.`;
  }

  return `${result.bandLabel} 구간의 기준 위약률이 0%예요. 기준 위약금이 0원인 것은 계산 결과입니다.`;
}

// =============================================================================
// 입력 — 계약서 조항을 폼 값으로
// =============================================================================

export const CONTRACT_TERM_KINDS = ["rate", "forfeit_deposit", "none"] as const;
export type ContractTermKind = (typeof CONTRACT_TERM_KINDS)[number];

export const CONTRACT_TERM_LABEL: Record<ContractTermKind, string> = {
  rate: "총액의 일정 비율",
  forfeit_deposit: "계약금 전액 몰취",
  none: "계약서에 규정이 없음",
};

export const CONTRACT_TERM_HINT: Record<ContractTermKind, string> = {
  rate: "계약서에 적힌 위약률을 그대로 넣어 주세요.",
  forfeit_deposit: "‘계약금은 반환하지 않는다’ 류의 조항이 여기 해당해요.",
  none: "규정이 없으면 기준 금액을 그대로 비교값으로 씁니다.",
};

/** 폼 값 → 엔진 입력. **비율을 고르지 않았으면 요율을 지어내지 않는다.** */
export function contractTermOf(input: {
  kind: ContractTermKind;
  ratePercent: number | null;
}): { kind: "rate"; rateBp: number } | { kind: "forfeit_deposit" } | { kind: "none" } {
  if (input.kind !== "rate") return { kind: input.kind };

  // 비율을 비워 두면 0% 가 아니라 **규정 없음**으로 읽는다 — 0% 라고 단정하면
  // "위약금이 없는 계약" 이라는 없는 사실을 말하게 된다.
  if (input.ratePercent === null) return { kind: "none" };

  return { kind: "rate", rateBp: Math.round(input.ratePercent * 100) };
}

// =============================================================================
// 고지 — 상시 노출을 코드가 요구한다
// =============================================================================

/**
 * 결과를 화면에 내도 되는가.
 *
 * §7.7·CLAUDE.md §2.3 은 고지 **상시 노출**을 요구한다. 엔진이 `disclaimer` 를 붙이지만
 * **붙지 않은 결과가 화면에 닿는 경로가 생기는 날**(다른 곳에서 만든 결과를 그리는 등)
 * 조용히 고지 없는 화면이 된다. 그래서 그리기 전에 확인한다.
 */
export function isDisclosable(result: Pick<PenaltyResult, "disclaimer">): boolean {
  return result.disclaimer.includes(DISCLAIMER_REQUIRED_PHRASE);
}

/**
 * 저장한 계산 한 줄.
 *
 * **금액을 다시 계산하지 않는다** — 저장 시점의 값을 그대로 보인다. 기준이 바뀌면
 * 지금 계산과 달라질 수 있고, **그 차이 자체가 남겨 둘 사실**이다(D-16 스냅샷과 같은
 * 이유 — "그때 어떤 기준이었나" 를 답할 수 있어야 한다).
 */
export type SavedSimulation = {
  id: string;
  category: string;
  standardAmount: number;
  contractAmount: number;
  excessAmount: number;
  ruleVersion: string | null;
  createdAt: string;
};

export const SAVED_SIMULATION_NOTE =
  "저장한 계산은 그때의 기준으로 낸 값이에요. 기준이 바뀌어도 다시 계산하지 않습니다.";

export const SIMULATOR_INTRO =
  "계약서에 적힌 위약 조건과 소비자분쟁해결기준을 나란히 놓고 차이를 보여드려요. 금액을 대신 판단해 드리지는 않아요.";
