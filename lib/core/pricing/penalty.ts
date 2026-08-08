// 위약금 룰 엔진 (명세서 §5.3)
//
//  * **LLM 을 사용하지 않는다.** 같은 입력이면 항상 같은 결과가 나오는 순수 함수다.
//  * 금액은 원 단위 정수, 요율은 basis point 정수로만 다룬다. 부동소수점 누산 없음.
//  * 룰 데이터(구간·요율)는 인자로 주입받는다 — penalty_rules 시드가 나중에 확정돼도
//    이 파일은 바뀌지 않는다.
//  * 출력은 "기준 대비 비교값" 이다. 확정적 법적 결론·승소 가능성을 담지 않는다
//    (CLAUDE.md §2.3, 명세서 §7.7).

import { AI_DISCLAIMER } from "../legal";
import {
  PenaltyInputSchema,
  PenaltyResultSchema,
  PenaltyRuleSetSchema,
  bpToPercent,
  type PenaltyBand,
  type PenaltyInput,
  type PenaltyResult,
  type PenaltyRuleSet,
  type PenaltySettlement,
} from "../schemas/penalty";

export {
  DRAFT_PENALTY_RULE_SETS,
  PENALTY_RULES_VERSION,
  getDraftPenaltyRuleSet,
} from "./penalty-rules";

/** 룰 세트가 입력을 감당하지 못할 때 던진다. */
export class PenaltyRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PenaltyRuleError";
  }
}

const MS_PER_DAY = 86_400_000;

/**
 * 날짜 문자열에서 **날짜 부분만** 뽑아 UTC 자정 타임스탬프로 만든다.
 *
 * 'YYYY-MM-DD' 로 시작하면 시각·타임존을 무시하고 그 날짜를 그대로 쓴다.
 * 예식일은 DB 에서 date 컬럼이고 사용자는 KST 로 입력하므로,
 * 타임존 변환이 끼어들어 하루가 밀리는 사고를 원천 차단한다.
 */
function toUtcDateOnly(value: string): number {
  const plain = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);

  if (plain) {
    return Date.UTC(Number(plain[1]), Number(plain[2]) - 1, Number(plain[3]));
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new PenaltyRuleError(`날짜를 해석할 수 없습니다: ${value}`);
  }

  return Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate());
}

/**
 * 취소 시점 기준으로 예식일까지 남은 일수.
 * 예식 당일 취소는 0, 예식일이 지난 뒤 취소는 음수다.
 */
export function daysUntilEvent(cancelDate: string, eventDate: string): number {
  return Math.round((toUtcDateOnly(eventDate) - toUtcDateOnly(cancelDate)) / MS_PER_DAY);
}

/**
 * 남은 일수에 해당하는 구간을 고른다.
 *
 * 경계값은 양끝 포함이다. 구간이 겹치면 minDaysBeforeEvent 가 큰 쪽(더 구체적인 쪽)을
 * 고르므로 룰 배열의 정렬 순서에 결과가 좌우되지 않는다.
 */
export function selectBand(ruleSet: PenaltyRuleSet, daysBeforeEvent: number): PenaltyBand {
  if (daysBeforeEvent < 0) return ruleSet.afterEvent;

  const candidates = [...ruleSet.bands]
    .filter(
      (band) =>
        daysBeforeEvent >= band.minDaysBeforeEvent &&
        (band.maxDaysBeforeEvent === null || daysBeforeEvent <= band.maxDaysBeforeEvent),
    )
    .sort((a, b) => b.minDaysBeforeEvent - a.minDaysBeforeEvent);

  const band = candidates[0];
  if (!band) {
    throw new PenaltyRuleError(
      `남은 일수 ${daysBeforeEvent}일에 해당하는 구간이 룰 세트(${ruleSet.category}/${ruleSet.version})에 없습니다.`,
    );
  }

  return band;
}

/** 총액 × 요율(bp). 정수 연산만 사용한다. */
function applyRate(totalAmount: number, rateBp: number): number {
  return Math.round((totalAmount * rateBp) / 10_000);
}

/** 위약금과 계약금으로 정산 결과를 만든다. */
function settle(penalty: number, deposit: number, refundDeposit: boolean): PenaltySettlement {
  if (refundDeposit) {
    return { penalty: 0, depositRefund: deposit, balanceDue: 0 };
  }

  return {
    penalty,
    depositRefund: Math.max(0, deposit - penalty),
    balanceDue: Math.max(0, penalty - deposit),
  };
}

function formatKrw(amount: number): string {
  return `${amount.toLocaleString("ko-KR")}원`;
}

function buildObjectionScript(params: {
  daysBeforeEvent: number;
  band: PenaltyBand;
  standard: PenaltySettlement;
  contract: PenaltySettlement;
  excessPenalty: number;
  basisRef: string;
}): string {
  const { daysBeforeEvent, band, standard, contract, excessPenalty, basisRef } = params;

  const timing =
    daysBeforeEvent >= 0
      ? `예식일 ${daysBeforeEvent}일 전(${band.label})`
      : `예식일 ${Math.abs(daysBeforeEvent)}일 경과 후(${band.label})`;

  const lines = [
    `[취소 시점] ${timing}`,
    `[기준 위약금] ${formatKrw(standard.penalty)} (총액의 ${bpToPercent(band.rateBp)}%)`,
    `[계약서 기준 위약금] ${formatKrw(contract.penalty)}`,
  ];

  if (excessPenalty > 0) {
    lines.push(
      `[차이] 계약서 조건이 기준보다 ${formatKrw(excessPenalty)} 많습니다.`,
      "",
      "요청 문구:",
      `"${basisRef}을 기준으로 하면 이 시점의 위약금은 ${formatKrw(standard.penalty)}로 산정됩니다. ` +
        `계약서 조건과 ${formatKrw(excessPenalty)} 차이가 있어 확인을 요청드립니다. ` +
        `기준에 맞춘 금액으로 조정이 가능한지 회신 부탁드립니다."`,
    );
  } else {
    lines.push(
      "[차이] 계약서 조건이 기준을 넘지 않습니다.",
      "",
      "요청 문구:",
      `"취소 시점과 정산 내역을 확인했습니다. ${basisRef} 기준과 비교했을 때 ` +
        `차이가 없어 계약서 조건대로 정산 진행 부탁드립니다."`,
    );
  }

  return lines.join("\n");
}

/**
 * 위약금을 결정적으로 계산한다.
 *
 * @param input 카테고리·총액·계약금·예식일·취소 시점·계약서 위약 조건
 * @param ruleSet 기준 룰 세트. 운영에서는 penalty_rules 값을 주입한다.
 */
export function calculatePenalty(input: PenaltyInput, ruleSet: PenaltyRuleSet): PenaltyResult {
  // 입력·룰 양방향 검증(CLAUDE.md §6). 총액 음수·비정수 등은 여기서 걸린다.
  const parsedInput = PenaltyInputSchema.parse(input);
  const parsedRules = PenaltyRuleSetSchema.parse(ruleSet);

  if (parsedRules.category !== parsedInput.category) {
    throw new PenaltyRuleError(
      `룰 세트 카테고리(${parsedRules.category})가 입력(${parsedInput.category})과 다릅니다.`,
    );
  }

  const notes: string[] = [];

  if (parsedRules.isDraft) {
    notes.push(
      "적용된 기준 수치는 법무 검수 전 가정치입니다. 실제 분쟁 시에는 최신 소비자분쟁해결기준을 확인하세요.",
    );
  }

  const totalAmount = parsedInput.totalAmount;

  // 계약금이 총액을 넘는 비정상 입력은 총액으로 자른다.
  let deposit = parsedInput.depositAmount;
  if (deposit > totalAmount) {
    notes.push(
      `계약금(${formatKrw(deposit)})이 총액(${formatKrw(totalAmount)})보다 큽니다. 총액 기준으로 계산했습니다.`,
    );
    deposit = totalAmount;
  }

  if (totalAmount === 0) {
    notes.push("총액이 0원입니다. 계약 금액을 확인하세요.");
  }

  const daysBeforeEvent = daysUntilEvent(parsedInput.cancelDate, parsedInput.eventDate);

  if (daysBeforeEvent < 0) {
    notes.push("예식일이 지난 뒤의 취소입니다. 기준 구간이 아니라 사후 정산 기준이 적용됩니다.");
  }

  const band = selectBand(parsedRules, daysBeforeEvent);

  // ── 기준(소비자분쟁해결기준) 적용 ──────────────────────────────
  const standardPenalty = band.refundDeposit ? 0 : applyRate(totalAmount, band.rateBp);
  const standard = settle(standardPenalty, deposit, band.refundDeposit);

  // ── 계약서 조항 적용 ──────────────────────────────────────────
  let contractPenalty: number;
  switch (parsedInput.contractTerm.kind) {
    case "rate":
      contractPenalty = applyRate(totalAmount, parsedInput.contractTerm.rateBp);
      break;
    case "forfeit_deposit":
      // 계약금 전액 몰취(R-02 가 잡는 전형적 조항).
      contractPenalty = deposit;
      notes.push("계약서가 계약금 전액 몰취를 규정하고 있습니다(검출 룰 R-02 대상).");
      break;
    case "none":
      contractPenalty = standardPenalty;
      notes.push("계약서에 위약 규정이 없어 기준 금액을 그대로 비교값으로 사용했습니다.");
      break;
  }

  const contract = settle(contractPenalty, deposit, false);

  // 계약서 조건이 기준보다 낮으면 초과분은 0이다. 음수가 되지 않는다.
  const excessPenalty = Math.max(0, contractPenalty - standardPenalty);

  const result: PenaltyResult = {
    daysBeforeEvent,
    bandCode: band.code,
    bandLabel: band.label,
    standard,
    contract,
    excessPenalty,
    depositRefundable: band.refundDeposit,
    basisRef: parsedRules.basisRef,
    ruleVersion: parsedRules.version,
    objectionScript: buildObjectionScript({
      daysBeforeEvent,
      band,
      standard,
      contract,
      excessPenalty,
      basisRef: parsedRules.basisRef,
    }),
    notes,
    disclaimer: AI_DISCLAIMER,
  };

  // 출력도 검증한다(양방향 검증). 음수 금액 같은 계산 사고를 여기서 잡는다.
  return PenaltyResultSchema.parse(result);
}
