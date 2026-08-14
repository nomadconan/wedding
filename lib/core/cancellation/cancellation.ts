/**
 * 계약 해지 · 위약금 정산 (S5-08 · 명세서 §2.3 F-A-17, §3.4, §5.3, §7.7,
 * D-21 · D-23 · D-24 · T-04)
 *
 * 프레임워크도 DB 도 모르는 순수 모듈이다. 금액은 **원 단위 정수 · 요율은 bp 정수**로만
 * 다루고 부동소수점을 쓰지 않는다(CLAUDE.md §6).
 *
 * ── 위약금 엔진을 새로 만들지 않는다 ────────────────────────────────────────
 * 구간 판정과 금액 산정은 T-04 의 `lib/core/pricing/penalty.ts`(`calculatePenalty`)가
 * 이미 갖고 있고 29개 테스트로 고정돼 있다. 이 파일은 그 **결과를 받아서**
 * "그래서 누가 얼마를 돌려받고 얼마가 남는가" 를 정한다. 같은 계산을 두 벌 만들지 않는다.
 *
 * ── 플랫폼은 판정자가 아니라 조율자다 (D-24) ────────────────────────────────
 * 이 파일이 만드는 것은 **제시값**이다. 양측이 확인해야 확정되고, 확인이 갈리면
 * 운영자 조율로 간다. 코드가 한쪽 편에서 집행하지 않는다 — 그래서 `undecided`
 * (귀책 미정) 상태에서도 계산은 되지만 `enforceable` 이 false 다.
 *
 * **여기 없는 것 셋.**
 *  1. **위약금 구간·요율.** `penalty_rules`(확정 후) 또는 T-04 의 가정치 룰 세트가 갖는다.
 *     **어느 쪽을 썼는지는 결과에 실려 나온다**(`isDraftRules`) — 화면이 그것을 숨기지 않는다.
 *  2. **업체 귀책 배상액.** 환불은 전액이지만 그 이상의 배상은 O-03 대기이며
 *     **코드가 금액을 만들지 않는다.** 조율 대상으로 넘긴다.
 *  3. **쿠폰 되돌리기.** 테이블이 아직 없다(S5-11). 자리만 두고 신호를 남긴다.
 */

import { twoSidedOutcome } from "../confirmation/two-sided";
import { AI_DISCLAIMER } from "../legal";

/** 금액·상태 입력이 규약을 벗어날 때 던진다. */
export class CancellationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CancellationError";
  }
}

// =============================================================================
// 값 집합 — DB CHECK 와 같아야 한다 (`db:rls` 가 정합을 본다)
// =============================================================================

/**
 * 취소 시점.
 *
 * **저장하지 않고 계산한다.** 계약·결제 상태에서 나오는 값이며, 저장하면 결제가
 * 하나 더 들어온 순간 화면이 거짓을 말한다(0028·0029·0030 이 세운 같은 규칙).
 *
 *  - `before_payment`  계약은 섰지만 아직 한 푼도 내지 않았다.
 *  - `partially_paid`  일부 회차를 냈다.
 *  - `fully_paid`      완납했다.
 *  - `after_event`     예식일이 지났다. **위 셋보다 우선한다** — 이행이 끝났거나
 *                      끝났어야 하는 시점이라 취소가 아니라 사후 정산의 문제다.
 */
export const CANCEL_STAGES = [
  "before_payment",
  "partially_paid",
  "fully_paid",
  "after_event",
] as const;

export type CancelStage = (typeof CANCEL_STAGES)[number];

export const CANCEL_STAGE_LABEL: Record<CancelStage, string> = {
  before_payment: "결제 전",
  partially_paid: "일부 결제 후",
  fully_paid: "완납 후",
  after_event: "예식일 경과 후",
};

/**
 * 귀책.
 *
 * `undecided` 를 **기본값으로 둔다.** 취소를 요청한 쪽이 스스로 "업체 잘못" 이라고
 * 적을 수 있으면 그 값이 곧 정산 결과를 바꾼다 — 귀책은 주장이지 사실이 아니다.
 * 양측 확인이나 운영자 조율을 거쳐야 값이 굳는다.
 */
export const FAULT_PARTIES = ["couple", "vendor", "mutual", "undecided"] as const;
export type FaultParty = (typeof FAULT_PARTIES)[number];

export const FAULT_LABEL: Record<FaultParty, string> = {
  couple: "고객 사정",
  vendor: "업체 사정",
  mutual: "양측 합의",
  undecided: "확인 중",
};

/**
 * 해지 절차 상태.
 *
 * S4-07 이 상담 이행 확인에서 쓴 모양을 그대로 가져온다 — **양측 확인 → 일치하면
 * 진행, 갈리면 조율 큐**. 구조를 재사용하는 이유는 운영이 배워야 할 흐름이 하나로
 * 줄고, 조율 큐를 두 벌 만들지 않기 때문이다.
 */
export const CANCELLATION_STATUSES = [
  "requested",
  "agreed",
  "disputed",
  "settled",
  "withdrawn",
] as const;

export type CancellationStatus = (typeof CANCELLATION_STATUSES)[number];

export const CANCELLATION_STATUS_LABEL: Record<CancellationStatus, string> = {
  requested: "확인 대기",
  agreed: "양측 확인 완료",
  disputed: "운영자 조율 중",
  settled: "정산 완료",
  withdrawn: "요청 철회됨",
};

/** 취소 사유 코드. 자유 텍스트를 쓰지 않는 이유는 아래 `reasonNote` 주석 참조. */
export const CANCEL_REASON_CODES = [
  "schedule_changed",
  "budget",
  "vendor_unavailable",
  "vendor_terms",
  "service_quality",
  "personal",
  "other",
] as const;

export type CancelReasonCode = (typeof CANCEL_REASON_CODES)[number];

export const CANCEL_REASON_LABEL: Record<CancelReasonCode, string> = {
  schedule_changed: "예식 일정이 바뀌었어요",
  budget: "예산이 맞지 않아요",
  vendor_unavailable: "업체가 진행할 수 없다고 했어요",
  vendor_terms: "업체가 조건을 바꾸려 해요",
  service_quality: "서비스 내용이 약속과 달라요",
  personal: "개인 사정이에요",
  other: "그 밖의 사유",
};

/**
 * 사유 코드가 **업체 귀책을 주장**하는가.
 *
 * 주장일 뿐이며 그것만으로 귀책이 정해지지 않는다 — 아래 `resolveFault` 참조.
 * 다만 이 셋이 선택되면 **자동 확정 경로를 타지 않고** 업체 확인을 반드시 거친다.
 */
export function claimsVendorFault(code: CancelReasonCode): boolean {
  return code === "vendor_unavailable" || code === "vendor_terms" || code === "service_quality";
}

// =============================================================================
// 취소 시점 판정
// =============================================================================

export function cancelStage(input: {
  paidAmount: number;
  totalAmount: number;
  eventDate: string | null;
  cancelDate: string;
}): CancelStage {
  if (input.eventDate !== null && dateOnly(input.cancelDate) > dateOnly(input.eventDate)) {
    return "after_event";
  }

  if (input.paidAmount <= 0) return "before_payment";
  if (input.paidAmount >= input.totalAmount && input.totalAmount > 0) return "fully_paid";

  return "partially_paid";
}

/** 'YYYY-MM-DD' 앞부분만 비교한다 — 예식일은 date 컬럼이고 시각·타임존이 끼면 하루가 밀린다. */
function dateOnly(value: string): string {
  return value.slice(0, 10);
}

// =============================================================================
// 귀책 판정 — 주장과 확인을 가른다
// =============================================================================

/**
 * 귀책을 정한다.
 *
 * **요청자의 주장만으로는 정해지지 않는다.** 고객이 "업체 사정" 이라고 적으면 그 값이
 * 그대로 위약금 0 이 되는데, 그러면 취소 사유 선택 하나가 곧 정산 결과가 된다.
 * 그래서 세 층으로 나눈다.
 *
 *  1. **운영자 조율 결과가 있으면 그것이 최종**이다(D-24 — 조율자의 결론).
 *  2. **양측이 같은 귀책에 동의했으면** 그것으로 확정한다.
 *  3. 그 외에는 `undecided` 다. 계산은 하되 **집행하지 않는다.**
 */
export function resolveFault(input: {
  coupleClaim: FaultParty | null;
  vendorClaim: FaultParty | null;
  adminDecision?: FaultParty | null;
}): FaultParty {
  if (input.adminDecision && input.adminDecision !== "undecided") return input.adminDecision;

  if (
    input.coupleClaim !== null &&
    input.coupleClaim === input.vendorClaim &&
    input.coupleClaim !== "undecided"
  ) {
    return input.coupleClaim;
  }

  return "undecided";
}

// =============================================================================
// 정산 — 위약금 결과를 받아 환불·잔여 청구로 나눈다
// =============================================================================

/**
 * `calculatePenalty` 결과 중 이 파일이 쓰는 부분만.
 *
 * 전체 타입을 요구하지 않는 이유 — 이 모듈이 위약금 엔진의 출력 형태에 묶이면
 * 엔진이 필드를 하나 더할 때마다 여기가 따라 바뀐다. 필요한 것은 **기준 위약금과
 * 계약서 위약금, 그리고 그 근거**뿐이다.
 */
export type PenaltyBasis = {
  standardPenalty: number;
  contractPenalty: number;
  bandCode: string;
  bandLabel: string;
  basisRef: string;
  ruleVersion: string;
  isDraftRules: boolean;
};

export type CancellationSettlement = {
  stage: CancelStage;
  fault: FaultParty;
  /** 실제로 적용한 위약금. 귀책에 따라 기준값과 다를 수 있다. */
  penaltyAmount: number;
  /** 돌려주는 금액. 낸 돈을 넘지 않는다. */
  refundAmount: number;
  /** 아직 안 낸 위약금. 낸 돈이 위약금에 못 미칠 때 생긴다. */
  balanceDue: number;
  /** 지금 집행할 수 있는가. 귀책이 미정이면 false — 제시값이다. */
  enforceable: boolean;
  /** 어느 규칙을 적용했는지. 화면이 근거로 그대로 보여준다. */
  appliedRule: string;
  notes: string[];
  disclaimer: string;
};

/**
 * 해지 정산.
 *
 * **취소 시점별 규칙과 근거**
 *
 * | 시점 | 위약금 | 환불 |
 * |---|---|---|
 * | 결제 전 | 기준대로 산정 | 낸 돈이 없어 0. **잔여 청구액**이 생긴다 |
 * | 일부 결제 후 | 기준대로 산정 | 낸 돈 − 위약금(음수면 0, 차액은 잔여 청구) |
 * | 완납 후 | 기준대로 산정 | 총액 − 위약금 |
 * | 예식일 경과 후 | 사후 정산 구간 | 같은 식. 다만 이행이 끝났을 수 있어 조율 대상이 많다 |
 *
 * **귀책이 바꾸는 것**
 *  - `vendor` — **위약금 0, 낸 돈 전액 환불.** 업체 사정으로 계약이 깨졌는데 고객이
 *    위약금을 무는 것은 앞뒤가 맞지 않는다(S4-07 이 노쇼에서 "귀책 있는 쪽이 부담"
 *    으로 정한 것과 같은 방향). **배상은 여기서 계산하지 않는다** — 금액 기준이
 *    O-03 대기이고, 코드가 만들면 그 숫자가 기준처럼 굳는다.
 *  - `mutual` — **위약금 0, 전액 환불.** 합의 해지는 원상회복이 기본이고 그 이상은
 *    당사자가 합의할 몫이다. 플랫폼이 합의 금액을 만들지 않는다(D-24).
 *  - `couple` — 기준·계약서 조건을 적용한다.
 *  - `undecided` — 고객 귀책 가정으로 **미리보기**를 만들되 `enforceable=false` 다.
 *    "이대로 취소하면 얼마" 를 보여주지 않으면 고객은 모르고 취소하게 된다.
 *
 * **계약서 조건이 기준보다 무거우면 기준을 쓴다.** T-04 는 둘을 나란히 보여주는 것까지
 * 하고 초과분(`excessPenalty`)을 계산한다. 집행 단계인 여기서는 **낮은 쪽**을 적용한다 —
 * 기준을 넘는 위약 조항은 다툼의 대상이고(검출 룰 R-02), 플랫폼이 그 초과분을 먼저
 * 집행해 버리면 §7.7 의 "기준 대비 비교값" 원칙이 무의미해진다.
 */
export function settleCancellation(input: {
  stage: CancelStage;
  fault: FaultParty;
  paidAmount: number;
  penalty: PenaltyBasis;
}): CancellationSettlement {
  assertAmount(input.paidAmount, "기납부액");
  assertAmount(input.penalty.standardPenalty, "기준 위약금");
  assertAmount(input.penalty.contractPenalty, "계약서 위약금");

  const notes: string[] = [];

  if (input.penalty.isDraftRules) {
    notes.push(
      "적용된 기준 수치는 법무 검수 전 가정치입니다. 확정 기준이 반영되면 금액이 달라질 수 있습니다.",
    );
  }

  // 업체 귀책·합의 해지는 위약금이 없다.
  if (input.fault === "vendor" || input.fault === "mutual") {
    if (input.fault === "vendor") {
      notes.push(
        "업체 사정으로 인한 해지로 확인되어 위약금 없이 전액 환불로 계산했습니다. 그 밖의 배상은 당사자 협의 또는 분쟁조정 절차로 정해집니다.",
      );
    } else {
      notes.push("양측 합의 해지로 위약금 없이 전액 환불로 계산했습니다.");
    }

    return {
      stage: input.stage,
      fault: input.fault,
      penaltyAmount: 0,
      refundAmount: input.paidAmount,
      balanceDue: 0,
      enforceable: true,
      appliedRule: input.fault === "vendor" ? "업체 귀책 — 위약금 없음" : "합의 해지 — 위약금 없음",
      notes,
      disclaimer: AI_DISCLAIMER,
    };
  }

  // 기준보다 무거운 계약서 조건은 집행하지 않는다.
  const applied = Math.min(input.penalty.standardPenalty, input.penalty.contractPenalty);

  if (input.penalty.contractPenalty > input.penalty.standardPenalty) {
    notes.push(
      `계약서 조건(${formatKrw(input.penalty.contractPenalty)})이 기준(${formatKrw(
        input.penalty.standardPenalty,
      )})보다 무거워 기준 금액으로 계산했습니다. 차액은 당사자 협의 대상입니다.`,
    );
  }

  if (input.stage === "before_payment") {
    notes.push("아직 결제한 금액이 없어 돌려드릴 금액이 없습니다. 위약금은 청구 대상입니다.");
  }

  if (input.stage === "after_event") {
    notes.push("예식일이 지난 뒤의 해지입니다. 이행 여부에 따라 정산이 달라질 수 있습니다.");
  }

  if (input.fault === "undecided") {
    notes.push(
      "귀책이 확인되지 않아 예상 금액입니다. 양측 확인 또는 운영자 조율을 거쳐 확정됩니다.",
    );
  }

  return {
    stage: input.stage,
    fault: input.fault,
    penaltyAmount: applied,
    refundAmount: Math.max(0, input.paidAmount - applied),
    balanceDue: Math.max(0, applied - input.paidAmount),
    // 귀책이 미정이면 계산은 하되 집행하지 않는다.
    enforceable: input.fault === "couple",
    appliedRule: `${input.penalty.bandLabel}(${input.penalty.bandCode}) · ${input.penalty.basisRef}`,
    notes,
    disclaimer: AI_DISCLAIMER,
  };
}

function assertAmount(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new CancellationError(`${label}은 0 이상 정수여야 합니다: ${value}`);
  }
}

function formatKrw(amount: number): string {
  return `${amount.toLocaleString("ko-KR")}원`;
}

// =============================================================================
// 환불 배분 — 어느 결제에서 얼마를 돌려주는가
// =============================================================================

export type RefundablePayment = {
  paymentId: string;
  seq: number;
  amount: number;
  refundedAmount: number;
};

export type RefundLine = { paymentId: string; seq: number; amount: number };

export type RefundAllocation = {
  lines: RefundLine[];
  allocated: number;
  /** 배분하지 못한 금액. 0이 아니면 환불 계획이 요청액을 못 채운 것이다. */
  shortfall: number;
};

/**
 * 환불액을 결제 건에 나눈다.
 *
 * **나중 회차부터 돌려준다.** 이유가 둘이다.
 *  1. 계약금(1회차)은 **위약금의 기준이자 마지막까지 남는 돈**이다. 소비자분쟁해결기준도
 *     계약금 반환 여부를 따로 다루고(T-04 `refundDeposit`), 계약서 조항도 계약금 몰취를
 *     규정하는 경우가 많다(검출 룰 R-02). 잔금부터 돌려주면 그 구조와 자연히 맞는다.
 *  2. 부분 환불이 **회차 경계를 덜 넘는다.** 앞에서부터 돌려주면 거의 모든 해지가
 *     여러 결제 건에 걸치고, 결제 건마다 부분 환불이 생겨 장부가 잘게 쪼개진다.
 *
 * 배분하지 못한 금액(`shortfall`)은 삼키지 않는다 — 0이 아니면 호출부가 멈춘다.
 */
export function allocateRefund(
  payments: readonly RefundablePayment[],
  refundTotal: number,
): RefundAllocation {
  assertAmount(refundTotal, "환불 총액");

  const ordered = [...payments].sort((a, b) => b.seq - a.seq);
  const lines: RefundLine[] = [];
  let left = refundTotal;

  for (const payment of ordered) {
    if (left <= 0) break;

    const refundable = Math.max(0, payment.amount - payment.refundedAmount);
    if (refundable === 0) continue;

    const amount = Math.min(refundable, left);
    lines.push({ paymentId: payment.paymentId, seq: payment.seq, amount });
    left -= amount;
  }

  return { lines, allocated: refundTotal - left, shortfall: left };
}

// =============================================================================
// 양측 확인 — 무응답을 동의로 읽지 않는다
// =============================================================================

export type ConfirmationDecision = "waiting" | "agreed" | "disputed";

/**
 * 양측 확인 결과.
 *
 * **판정 뼈대는 `lib/core/confirmation/two-sided.ts` 가 갖는다**(S5-09 가 뽑아냈다).
 * 여기서 하는 일은 그 결과를 **해지 도메인의 뜻으로 옮기는 것**뿐이다.
 *
 * **무응답을 동의로 읽지 않는다.** S4-07 은 상담 보증금에서 "양측 무응답의 기본값은
 * 환불" 로 정했는데, 그것은 금액이 소액·정형이고 방향이 하나였기 때문이다. 계약 해지는
 * 금액이 크고 **귀책에 따라 결과가 정반대**라 기본값을 만들 수 없다. 기한이 지나면
 * 조율로 보낸다 — 자동 집행보다 사람이 보는 편이 낫다.
 * (에스크로는 **반대로** 기한 경과를 릴리즈로 읽는다 — S5-09 참조. 같은 뼈대를 쓰되
 * 해석이 다른 것이 이 분리의 이유다.)
 *
 * 한쪽이 이의를 내면 즉시 조율이다. 기다릴 이유가 없다.
 */
export function confirmationDecision(input: {
  coupleAgreed: boolean | null;
  vendorAgreed: boolean | null;
  dueAt: string | null;
  now: Date;
}): ConfirmationDecision {
  const outcome = twoSidedOutcome({
    partyA: input.coupleAgreed,
    partyB: input.vendorAgreed,
    dueAt: input.dueAt,
    now: input.now,
  });

  if (outcome === "agreed") return "agreed";
  // 이의도 무응답도 **조율**로 간다. 자동 집행하지 않는 것이 이 도메인의 규칙이다.
  if (outcome === "rejected" || outcome === "timeout") return "disputed";

  return "waiting";
}

export const CONFIRMATION_TIMEOUT_NOTICE =
  "기한 안에 양측 확인이 끝나지 않으면 운영자 조율로 넘어갑니다. 자동으로 정산되지 않아요.";

// =============================================================================
// 정산 되돌리기 — 이미 나간 돈은 코드가 회수하지 않는다
// =============================================================================

export const PLANNER_SETTLEMENT_REVERSALS = ["void", "recover"] as const;
export type PlannerSettlementReversal = (typeof PLANNER_SETTLEMENT_REVERSALS)[number];

export type SettlementReversal = {
  planner: PlannerSettlementReversal | "none";
  /** 업체 정산서에 이미 실렸는가. 실렸으면 조율 대상이다. */
  vendorSettlementLinked: boolean;
  /** 쿠폰 사용 이력을 되돌려야 하는가. 테이블이 없어 지금은 언제나 false 다. */
  couponReversalPending: boolean;
  needsOperator: boolean;
  notes: string[];
};

/**
 * 해지가 정산에 미치는 영향.
 *
 * **플래너 수수료** — 계약 확정 시점에 발생한다(D-17 · S5-06). 계약이 깨지면 그 근거가
 * 사라지므로 되돌린다. 다만 **이미 지급된 것은 코드가 회수하지 않는다.**
 *  - `earned`·`payable` → `void`. 아직 안 나간 돈이라 무효로 만들면 끝이다.
 *  - `paid` → **`recover`**(회수 대상 표시)이며 **운영자 조율로 간다.** 이미 계좌로
 *    나간 돈을 코드가 자동으로 되가져올 방법이 없고, 있다고 해도 그렇게 하면 안 된다.
 *    상계할 다음 지급이 있을지도 코드가 알 수 없다.
 *
 * **업체 정산서** — 정산서를 만드는 경로는 아직 없다(S5-07). 이미 실린 건이 있으면
 * 금액을 고치는 것이 아니라 **조율로 보낸다** — 확정된 정산서를 소급 수정하면
 * "언제 얼마를 정산했는가" 가 재현되지 않는다(D-23).
 *
 * **쿠폰** — `coupon_redemptions` 는 **insert-only** 이며 사용을 되돌리는 일은 행 수정이
 * 아니라 환불의 일이라고 명세가 적어 뒀다(§3.4 D-27). 테이블 자체가 아직 없으므로
 * (S5-11) 여기서는 **자리만 두고 언제나 false** 다. 만들어지면 이 함수가 신호를 켠다.
 */
export function settlementReversal(input: {
  plannerSettlementStatus: "earned" | "payable" | "paid" | "void" | null;
  vendorSettlementLinked: boolean;
  couponFeatureReady?: boolean;
}): SettlementReversal {
  const notes: string[] = [];
  let planner: SettlementReversal["planner"] = "none";

  if (input.plannerSettlementStatus === "earned" || input.plannerSettlementStatus === "payable") {
    planner = "void";
    notes.push("플래너 수수료는 아직 지급 전이라 무효 처리합니다.");
  }

  if (input.plannerSettlementStatus === "paid") {
    planner = "recover";
    notes.push(
      "플래너 수수료가 이미 지급됐습니다. 자동 회수하지 않고 운영자 조율로 넘깁니다.",
    );
  }

  if (input.vendorSettlementLinked) {
    notes.push(
      "이 예약이 확정된 정산서에 이미 실려 있습니다. 정산서를 고치지 않고 운영자 조율로 넘깁니다.",
    );
  }

  return {
    planner,
    vendorSettlementLinked: input.vendorSettlementLinked,
    // 쿠폰은 S5-11 이 만든다. 그때까지 이 신호는 켜지지 않는다.
    couponReversalPending: (input.couponFeatureReady ?? false) === true,
    needsOperator: planner === "recover" || input.vendorSettlementLinked,
    notes,
  };
}

// =============================================================================
// 예약 자리 — 확정에서 줄이고 해지에서 되돌린다 (S2-05 가 남긴 자리)
// =============================================================================

/**
 * 예약 확정과 계약 확정은 **다른 사건**이다.
 *
 *  - **계약 확정**(`contracts.status='active'`) — 3자 서명이 끝났다. 문서의 사건이다.
 *  - **예약 확정**(`bookings.status='confirmed'`) — 그 결과로 **자리를 잡는다.**
 *    재고(`inventory_slots.remaining`)가 줄어드는 지점이 여기다.
 *
 * 하나로 합치지 않는 이유 — 계약 없이 자리를 잡는 경우(가예약)와 자리 없는 계약
 * (스튜디오·드레스처럼 날짜 슬롯을 쓰지 않는 상품)이 **둘 다 있다.** 합치면 둘 중
 * 하나를 표현할 수 없다.
 *
 * **슬롯 없이도 계약할 수 있다.** `bookings.slot_id` 는 nullable 이고, 슬롯을 쓰지 않는
 * 카테고리가 실제로 있다. 다만 **슬롯이 붙어 있는데 남은 자리가 없으면 확정을 막는다** —
 * 없는 자리를 파는 것이기 때문이다. 판정은 DB 가 한다(0031 트리거).
 */
export type SlotMovement = { delta: -1 | 0 | 1; reason: string };

export function slotMovement(input: {
  hasSlot: boolean;
  from: string;
  to: string;
}): SlotMovement {
  if (!input.hasSlot) return { delta: 0, reason: "자리를 쓰지 않는 예약입니다." };

  const occupies = (status: string) => status === "confirmed" || status === "fulfilled";

  if (!occupies(input.from) && occupies(input.to)) {
    return { delta: -1, reason: "예약이 확정되어 자리를 하나 차지합니다." };
  }

  if (occupies(input.from) && !occupies(input.to)) {
    return { delta: 1, reason: "예약이 풀려 자리를 하나 되돌립니다." };
  }

  return { delta: 0, reason: "자리 수가 달라지지 않습니다." };
}

// =============================================================================
// 화면 문구
// =============================================================================

export const CANCEL_TITLE = "계약 해지 요청";

export const CANCEL_PREVIEW_TITLE = "이대로 해지하면";

/**
 * **모르고 취소하게 두지 않는다.** 요청 화면은 위약금 예상액과 **산정 근거**를 먼저
 * 보여준다. 결과 숫자만 보여주면 납득할 수 없고, 납득하지 못한 정산은 그대로 분쟁이 된다.
 */
export const CANCEL_PREVIEW_NOTICE =
  "아래 금액은 지금 시점 기준의 예상값이에요. 양측 확인을 거쳐 확정되며, 확인이 갈리면 운영자가 조율합니다.";

export const CANCEL_PLATFORM_ROLE_NOTICE =
  "웨딩클리어는 계약 당사자가 아니라 조율자입니다. 위약금을 대신 청구하거나 일방적으로 집행하지 않아요.";

export const CANCEL_EMPTY_TITLE = "해지할 계약이 없어요";

export const CANCEL_EMPTY_BODY = "계약이 확정된 뒤에 이 화면에서 해지를 요청할 수 있어요.";

export const CANCEL_ALREADY_TITLE = "이미 해지 절차가 진행 중이에요";

export const DISPUTE_QUEUE_NOTICE =
  "양측 확인이 달라 운영자가 조율할 예정이에요. 확정되면 알려드릴게요.";
