/**
 * 플래너 지급 (S6-05 · 명세서 §3.4 planner_settlements, §4.5 planner-payout-due,
 * D-16 · D-17 · D-21 · D-23 · D-28)
 *
 * 프레임워크도 DB 도 모르는 순수 모듈이다.
 *
 * ── 여기서 다시 만들지 않는 것 ──────────────────────────────────────────────
 * **유예 판정은 `lib/core/payment` 의 `plannerPayoutState()` 하나가 한다**(S5-01).
 * 같은 값을 두 곳이 해석하면 답이 갈린다 — FIX-52 가 요율에서 실제로 그랬다(장바구니는
 * 플래너 키 없이 풀고 계약은 넣어서 풀었다). 그래서 이 파일은 그 함수를 **부르고
 * 다시 내보내기만** 하며, 경계(`payable_at` 당일 그 시각 포함)도 그쪽 정의를 따른다.
 *
 * 지급 상태 어휘(`PAYOUT_STATUSES`)도 업체 지급과 **같은 것을 쓴다** — 운영자는 한
 * 화면에서 둘을 보므로 어휘가 갈리면 같은 뜻을 두 단어로 읽는다.
 *
 * ── 이 파일이 답하는 것 ─────────────────────────────────────────────────────
 *  1. 지금 무엇이 유예 중이고 무엇이 받을 수 있고 무엇이 이미 나갔는가(합계 셋).
 *  2. 이 건에 지금 지급을 실행해도 되는가(막는 이유를 코드로).
 *  3. 배치가 오늘 무엇을 `earned → payable` 로 옮겨야 하는가.
 */

import {
  PLANNER_PAYOUT_STATE_LABEL,
  plannerPayoutState,
  type PlannerPayoutState,
  type PlannerSettlementStatus,
} from "../payment/payment";
import { PAYOUT_STATUSES, type PayoutStatus } from "./settlement";

export {
  PLANNER_PAYOUT_STATE_LABEL,
  plannerPayoutState,
  type PlannerPayoutState,
} from "../payment/payment";
export { PAYOUT_STATUSES, type PayoutStatus } from "./settlement";

/** 입력이 규약을 벗어날 때 던진다. */
export class PlannerPayoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlannerPayoutError";
  }
}

// =============================================================================
// 멱등 열쇠 — 업체 지급과 같은 모양, 다른 접두어
// =============================================================================

/**
 * 나가는 요청의 멱등 열쇠.
 *
 * **접두어를 가른다.** 업체 지급은 `settlement:…`, 플래너 지급은
 * `planner_settlement:…` 다 — 두 원장의 id 는 서로 다른 표에서 나오지만 uuid 라
 * 우연히 같을 이유가 없어도, **열쇠를 보고 어느 지급인지 알 수 있어야** 대사(對査)가
 * 된다. PG 쪽 로그에는 열쇠만 남는다.
 *
 * **시도 횟수를 자동 재시도에서 올리지 않는다** — 올리면 재시도가 새 이체가 되고
 * 돈이 두 번 나간다(`paymentIdempotencyKey` · `payoutIdempotencyKey` 와 같은 규칙).
 */
export function plannerPayoutIdempotencyKey(input: {
  plannerSettlementId: string;
  attempt?: number;
}): string {
  const attempt = input.attempt ?? 1;

  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new PlannerPayoutError(`시도 번호가 규약을 벗어났습니다: ${attempt}`);
  }

  return `planner_settlement:${input.plannerSettlementId}:payout:${attempt}`;
}

// =============================================================================
// 지급 가능 판정
// =============================================================================

export const PLANNER_PAYOUT_BLOCK_REASONS = [
  "waiting_grace",
  "already_paid",
  "voided",
  "in_progress",
  "zero_amount",
  "attempts_exceeded",
] as const;

export type PlannerPayoutBlockReason = (typeof PLANNER_PAYOUT_BLOCK_REASONS)[number];

export const PLANNER_PAYOUT_BLOCK_MESSAGE: Record<PlannerPayoutBlockReason, string> = {
  waiting_grace:
    "아직 지급 유예 기간이에요. 환불·분쟁 창구가 닫히기를 기다리는 기간이라 앞당길 수 없습니다.",
  already_paid: "이미 지급된 건이에요.",
  voided: "해지로 무효가 된 건이에요.",
  in_progress: "이 건의 지급이 이미 진행 중이에요.",
  zero_amount: "지급할 금액이 없어요.",
  attempts_exceeded:
    "지급 시도 횟수를 넘었습니다. 계좌 정보를 확인하거나 담당자에게 문의해 주세요.",
};

export type PlannerPayoutEligibility =
  | { ok: true }
  | { ok: false; reason: PlannerPayoutBlockReason; detail: string };

/**
 * 지금 이 건에 지급을 실행해도 되는가.
 *
 * **유예 경계를 여기서 다시 계산하지 않는다** — `plannerPayoutState()` 가 답한 것을
 * 받는다. 그리고 **DB 트리거가 최종 경계다**(0028 이 유예 전 `payable` 을 막고 0071 이
 * 성공한 지급 없는 `paid` 를 막는다). 여기서 먼저 판정하는 이유는 화면이 **왜**
 * 막혔는지 말할 수 있어야 하기 때문이다.
 */
export function plannerPayoutEligibility(input: {
  state: PlannerPayoutState;
  feeAmount: number;
  hasPending: boolean;
  failedCount: number;
  maxAttempts: number;
}): PlannerPayoutEligibility {
  const block = (reason: PlannerPayoutBlockReason): PlannerPayoutEligibility => ({
    ok: false,
    reason,
    detail: PLANNER_PAYOUT_BLOCK_MESSAGE[reason],
  });

  if (input.state === "paid") return block("already_paid");
  if (input.state === "void") return block("voided");
  if (input.state === "waiting_grace") return block("waiting_grace");
  if (input.hasPending) return block("in_progress");
  if (input.feeAmount < 1) return block("zero_amount");
  if (input.failedCount >= input.maxAttempts) return block("attempts_exceeded");

  return { ok: true };
}

// =============================================================================
// 합계 — 읽는 방식을 셋으로 가른다
// =============================================================================

export type PlannerSettlementRow = {
  id: string;
  status: PlannerSettlementStatus;
  feeAmount: number;
  earnedAt: string;
  payableAt: string;
};

export type PlannerPayoutBucket = { count: number; amount: number };

export type PlannerPayoutSummary = {
  /** 아직 유예 중. **받을 수 있는 돈이 아니다.** */
  waitingGrace: PlannerPayoutBucket;
  /** 유예가 지났고 아직 안 나갔다. **받을 수 있지만 아직 받은 것은 아니다.** */
  payable: PlannerPayoutBucket;
  /** 실제로 나갔다. */
  paid: PlannerPayoutBucket;
  /** 해지로 무효. */
  void: PlannerPayoutBucket;
};

const emptyBucket = (): PlannerPayoutBucket => ({ count: 0, amount: 0 });

/**
 * 국면별 합계.
 *
 * **`payable` 과 `paid` 를 합치지 않는다**(S5-07 이 업체 정산에서 세운 원칙).
 * `payable_at` 이 지났다는 것은 "보낼 수 있다" 이지 "보냈다" 가 아니다 — 합치면
 * 플래너는 이미 받은 줄 알고 입금을 기다리지 않는다. 화면도 두 줄로 적는다.
 *
 * **유예 중인 금액을 0으로 접지 않는다.** 0으로 적으면 "일한 대가가 없다" 로 읽히고
 * 그것은 사실이 아니다 — 있는 돈이고 아직 못 받을 뿐이다.
 */
export function summarizePlannerPayouts(
  rows: readonly PlannerSettlementRow[],
  now: Date,
): PlannerPayoutSummary {
  const summary: PlannerPayoutSummary = {
    waitingGrace: emptyBucket(),
    payable: emptyBucket(),
    paid: emptyBucket(),
    void: emptyBucket(),
  };

  for (const row of rows) {
    const state = plannerPayoutState({
      status: row.status,
      payableAt: row.payableAt,
      now,
    });

    const bucket =
      state === "paid"
        ? summary.paid
        : state === "void"
          ? summary.void
          : state === "payable"
            ? summary.payable
            : summary.waitingGrace;

    bucket.count += 1;
    bucket.amount += row.feeAmount;
  }

  return summary;
}

export const PAYOUT_NOT_RECEIVED_NOTICE =
  "**'받을 수 있음' 은 아직 받은 것이 아니에요.** 지급이 실행되고 성공해야 '지급 완료'로 바뀝니다.";

export const GRACE_REASON_NOTICE =
  "계약이 성사돼도 바로 지급하지 않고 유예 기간을 둡니다. 환불·분쟁 창구가 닫히기를 기다리는 기간이라 앞당길 수 없어요.";

// =============================================================================
// 배치 — 오늘 무엇을 옮기는가
// =============================================================================

/**
 * 유예가 지난 `earned` 건.
 *
 * **배치가 자체 규칙을 갖지 않는다.** 판정은 `plannerPayoutState()` 가 하고 이 함수는
 * 대상을 고를 뿐이다 — 배치에 규칙이 생기면 화면과 답이 갈린다(`consultation-resolve`
 * 가 세운 같은 규칙).
 *
 * **`payable` 을 다시 담지 않는다.** 이미 옮겨진 건을 또 옮기면 `updated_at` 만 흔들려
 * "언제 지급 대상이 됐는가" 를 재현할 수 없다.
 */
export function dueForPayable(
  rows: readonly PlannerSettlementRow[],
  now: Date,
): PlannerSettlementRow[] {
  return rows.filter(
    (row) =>
      row.status === "earned" &&
      plannerPayoutState({ status: row.status, payableAt: row.payableAt, now }) === "payable",
  );
}

/** 지급 상태 어휘가 업체 지급과 같은지 코드로 붙잡아 둔다. */
export function sharesPayoutVocabulary(statuses: readonly string[]): boolean {
  return (
    statuses.length === PAYOUT_STATUSES.length &&
    statuses.every((status) => (PAYOUT_STATUSES as readonly string[]).includes(status))
  );
}

export type { PayoutStatus as PlannerPayoutRowStatus };

// =============================================================================
// 화면 문구
// =============================================================================

export const PLANNER_SETTLEMENT_TITLE = "내 정산";

export const PLANNER_SETTLEMENT_EMPTY_TITLE = "아직 정산할 계약이 없어요";

export const PLANNER_SETTLEMENT_EMPTY_BODY =
  "고객이 카테고리를 맡기고 그 계약이 성사되면 수수료가 쌓입니다. 상담만으로는 발생하지 않아요.";

/**
 * **요율 스냅샷을 화면이 근거로 든다**(D-16 · §3.4).
 *
 * 금액만 적으면 "왜 이 금액인가" 를 재현할 수 없다 — 정산 이의에 답하려면 계약 시점에
 * 박힌 요율이 함께 보여야 하고, 나중에 요율이 바뀌어도 그 값은 움직이지 않는다.
 */
export const PLANNER_RATE_SNAPSHOT_NOTICE =
  "수수료는 **계약이 확정된 시점의 요율**로 계산돼요. 이후 요율이 바뀌어도 지난 계약에는 소급되지 않습니다.";

/** 지급 실행이 아직 스텁이라는 사실(D-28). 화면이 숨기지 않는다. */
export const PAYOUT_ADAPTER_PENDING_NOTICE =
  "지급 대행 연동은 아직 계약 전이라 실제 이체가 일어나지 않아요. 지급 대상 금액과 시점은 그대로 계산됩니다.";
