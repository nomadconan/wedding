/**
 * 회차 결제 실행 판정 (S5-06 · 명세서 §2.1 F-C-14, §3.4 payments·payment_schedules,
 * §4.2, §6.2 /checkout, D-18 · D-21 · D-23 · D-27 · D-28)
 *
 * 프레임워크도 DB 도 모르는 순수 모듈이다. 금액은 **정수 원 · 비율은 bp 정수**로만
 * 다루고 부동소수점을 쓰지 않는다(CLAUDE.md §6).
 *
 * `payment.ts`(S5-01)가 **회차를 만드는 쪽**이라면 이 파일은 **만들어진 회차를 실제로
 * 내는 쪽**이다. 같은 계산을 두 벌 만들지 않는다 — 기한 판정(`scheduleState`)·회차
 * 분할(`splitAmount`)·멱등 열쇠(`paymentIdempotencyKey`)는 그쪽 것을 그대로 쓴다.
 *
 * **여기 없는 것 셋.**
 *  1. **위약금.** 취소 위약금은 `lib/core/pricing/penalty.ts`(T-04)가 갖고, 그것을
 *     환불에 적용하는 것은 S5-08 의 일이다. 이 파일은 "얼마까지 돌려줄 수 있는가"
 *     (=낸 돈에서 이미 돌려준 것을 뺀 값)만 안다.
 *  2. **쿠폰 계산.** 테이블도 `lib/core/coupon` 도 아직 없다(S5-11). 여기서는 결제
 *     화면의 **쿠폰 자리 상태**만 판정한다 — 아래 `couponSlotState` 주석 참조.
 *  3. **수수료·정산.** 고객이 낼 금액은 계약 총액이 정하고, 그 돈을 플랫폼과 업체가
 *     어떻게 나누는가는 정산(S5-07)이다. 결제 판정이 수수료를 알 이유가 없다.
 */

import { PaymentError, scheduleState, type PaymentScheduleStatus, type ScheduleState } from "./payment";

// =============================================================================
// 회차 목록 — 화면과 API 가 같은 값을 본다
// =============================================================================

export type ScheduleRow = {
  id: string;
  seq: number;
  amount: number;
  status: PaymentScheduleStatus;
  dueAt: string | null;
};

export type ScheduleView = ScheduleRow & {
  state: ScheduleState;
  /** 지금 이 회차를 결제할 수 있는가. 이유는 `blockedReason` 이 갖는다. */
  payable: boolean;
  blockedReason: PayBlockReason | null;
};

/**
 * 결제를 막는 이유.
 *
 * **'막혔다' 만 돌려주지 않는다.** 화면이 이유를 그대로 적을 수 있어야 고객이 다음에
 * 무엇을 할지 안다 — S4-12 가 견적에서, S5-04 가 발행 자격에서 쓴 것과 같은 모양이다.
 */
export type PayBlockReason =
  | "already_paid"
  | "voided"
  | "contract_not_active"
  | "earlier_unpaid"
  | "due_undecided"
  | "in_progress";

export const PAY_BLOCK_MESSAGE: Record<PayBlockReason, string> = {
  already_paid: "이미 결제된 회차예요.",
  voided: "취소된 회차라 결제하지 않습니다.",
  contract_not_active: "계약이 확정된 뒤에 결제할 수 있어요.",
  earlier_unpaid: "앞 회차를 먼저 결제해 주세요.",
  due_undecided: "이 회차는 지급 시점이 아직 정해지지 않아 미리 결제할 수 없어요.",
  in_progress: "이 회차의 결제가 진행 중이에요. 결과를 기다려 주세요.",
};

/**
 * 어느 회차를 낼 수 있는가.
 *
 * 세 가지를 정했고 각각 이유가 있다.
 *
 * **(가) 순서를 건너뛸 수 없다.** 1회차(계약금)를 건너뛰고 잔금만 내는 것을 막는다.
 * 위약금 기준(소비자분쟁해결기준 · T-04)이 **계약금 반환 여부**를 따로 다루기 때문에,
 * 계약금이 미납인 채 잔금만 들어오면 취소 시 "무엇을 돌려주는가" 를 계산할 수 없다.
 * 회차는 금액을 쪼갠 것이자 **이행 단계**이며 단계는 순서가 있다.
 *
 * **(나) 미도래 회차는 미리 낼 수 있다.** 기한이 남았다는 이유로 막지 않는다 —
 * 고객이 먼저 내겠다는 것을 막을 근거가 없고, 막으면 "돈을 내려는데 못 낸다" 는
 * 문의가 생긴다. 업체에도 손해가 아니다. 다만 **기한이 정해지지 않은 회차**
 * (`on_preparation`·`on_fulfillment` — 사건이 아직 일어나지 않아 `due_at` 이 null)는
 * 예외로 막는다. F-C-14 가 "각 회차의 지급 조건·기한·금액을 **결제 전 고지**" 를
 * 요구하는데 기한을 고지할 수 없는 회차이기 때문이다. 고지할 수 없는 것을 받을 수는 없다.
 *
 * **(다) 진행 중인 결제가 있으면 새로 열지 않는다.** 승인 결과를 기다리는 동안 같은
 * 회차를 다시 열면 멱등 열쇠가 같아 PG 는 접어 주더라도, 우리 쪽에 `pending` 이 둘
 * 생겨 어느 것이 그 회차의 결제인지 알 수 없게 된다.
 */
export function viewSchedules(input: {
  schedules: readonly ScheduleRow[];
  contractActive: boolean;
  /** 결제 진행 중(`pending`)인 회차 id. 승인 대기 중인 건이 여기 들어온다. */
  pendingScheduleIds?: readonly string[];
  now: Date;
}): ScheduleView[] {
  const ordered = [...input.schedules].sort((a, b) => a.seq - b.seq);
  const pending = new Set(input.pendingScheduleIds ?? []);
  let earlierUnpaid = false;

  return ordered.map((row) => {
    const state = scheduleState({ status: row.status, dueAt: row.dueAt, now: input.now });
    const reason = blockReason({
      row,
      state,
      contractActive: input.contractActive,
      earlierUnpaid,
      inProgress: pending.has(row.id),
    });

    // void 회차는 순서를 막지 않는다 — 취소된 단계는 이행에서 빠진 것이지 미납이 아니다.
    if (row.status === "scheduled") earlierUnpaid = true;

    return { ...row, state, payable: reason === null, blockedReason: reason };
  });
}

function blockReason(input: {
  row: ScheduleRow;
  state: ScheduleState;
  contractActive: boolean;
  earlierUnpaid: boolean;
  inProgress: boolean;
}): PayBlockReason | null {
  if (input.row.status === "paid") return "already_paid";
  if (input.row.status === "void") return "voided";
  if (!input.contractActive) return "contract_not_active";
  if (input.earlierUnpaid) return "earlier_unpaid";
  if (input.state === "unscheduled") return "due_undecided";
  if (input.inProgress) return "in_progress";

  return null;
}

/** 지금 낼 수 있는 회차. 없으면 null 이다(완납이거나 앞이 막혔다). */
export function nextPayable(views: readonly ScheduleView[]): ScheduleView | null {
  return views.find((view) => view.payable) ?? null;
}

// =============================================================================
// 완납 — 세면 나오는 값이라 저장하지 않는다
// =============================================================================

export type PaymentProgress = {
  /** 청구 대상 회차(취소분 제외) 합. 계약 총액과 같아야 한다. */
  totalAmount: number;
  paidAmount: number;
  remainingAmount: number;
  paidCount: number;
  activeCount: number;
  fullyPaid: boolean;
};

/**
 * 납부 진행.
 *
 * **`void` 회차는 어느 쪽에도 세지 않는다.** 취소된 회차를 총액에 넣으면 잔금을 다
 * 내도 미납으로 남고, 납부액에 넣으면 받지 않은 돈을 받았다고 적게 된다.
 *
 * **완납은 저장하지 않는다.** 회차를 세면 나오는 값이며, 컬럼으로 두면 갱신을 빠뜨린
 * 만큼 화면이 거짓을 말한다(0027·0028·0029 가 세운 같은 규칙).
 * 회차가 하나도 없으면 완납이 아니다 — 아직 낼 것이 정해지지 않은 상태이지
 * 다 낸 상태가 아니다.
 */
export function paymentProgress(schedules: readonly ScheduleRow[]): PaymentProgress {
  const active = schedules.filter((row) => row.status !== "void");
  const paid = active.filter((row) => row.status === "paid");

  const totalAmount = active.reduce((sum, row) => sum + row.amount, 0);
  const paidAmount = paid.reduce((sum, row) => sum + row.amount, 0);

  return {
    totalAmount,
    paidAmount,
    remainingAmount: totalAmount - paidAmount,
    paidCount: paid.length,
    activeCount: active.length,
    fullyPaid: active.length > 0 && paid.length === active.length,
  };
}

// =============================================================================
// 결제 시도 — 상태 전이는 실제와 똑같이 돈다 (D-28)
// =============================================================================

/**
 * `payments.purpose`(enum `payment_purpose`)를 회차에서 정한다.
 *
 * **첫 회차가 계약금(`deposit`)이고 나머지는 잔금(`balance`)이다.** 회차 수가 늘어도
 * 이 규칙은 그대로다 — 위약금 기준이 특별하게 다루는 것은 "계약 시 낸 돈" 하나뿐이고,
 * 그것은 언제나 첫 회차다. `membership` 은 회차 결제가 아니며 DB CHECK 가 막는다.
 */
export function purposeOfSeq(seq: number): "deposit" | "balance" {
  if (!Number.isInteger(seq) || seq < 1) {
    throw new PaymentError(`회차 순번이 규약을 벗어났습니다: ${seq}`);
  }

  return seq === 1 ? "deposit" : "balance";
}

/**
 * 실패한 결제 뒤에 무엇을 하는가.
 *
 * **되돌리는 것은 결제이지 회차가 아니다.** 회차(`payment_schedules`)는 계약이 정한
 * 이행 계획이고 결제 실패는 그 계획을 바꾸지 않는다 — 실패했다고 회차를 지우면 낼
 * 것이 사라지고, `void` 로 만들면 비율 합이 깨진다(0028 의 커밋 시점 트리거).
 * 그래서 **회차는 `scheduled` 그대로 두고 `payments` 행만 `failed` 로 적는다.**
 *
 * 재시도는 **같은 멱등 열쇠**로 한다(`paymentIdempotencyKey` 의 attempt 를 올리지
 * 않는다) — 네트워크가 끊긴 뒤의 재시도는 "같은 결제를 다시 확인" 이지 새 결제가
 * 아니다. 사용자가 화면에서 다시 누르는 것은 새 시도이며 그때만 attempt 가 오른다.
 */
export type ChargeFailureDisposition = {
  scheduleStaysScheduled: true;
  paymentStatus: "failed";
  /** 자동 재시도 대상인가. 상한은 `MAX_PAYMENT_ATTEMPTS`(S4-08)와 같다. */
  retryable: boolean;
  /** 고객 화면에 그대로 적는 다음 행동. */
  nextAction: string;
};

export function chargeFailureDisposition(input: {
  retryable: boolean;
  attemptCount: number;
  maxAttempts: number;
}): ChargeFailureDisposition {
  const retryable = input.retryable && input.attemptCount < input.maxAttempts;

  return {
    scheduleStaysScheduled: true,
    paymentStatus: "failed",
    retryable,
    nextAction: retryable
      ? "잠시 후 다시 시도해 주세요. 결제 수단이나 한도를 확인하면 도움이 됩니다."
      : "결제가 계속 실패하고 있어요. 다른 결제 수단으로 시도하거나 고객센터로 문의해 주세요.",
  };
}

// =============================================================================
// 환불 — 부분 환불을 전제로 만든다
// =============================================================================

/**
 * **부분 환불을 허용한다.** 이유는 스키마가 이미 그렇게 말하고 있다 —
 * `payments.status` 에 `partially_refunded` 가 있다(§3.4).
 *
 * 실무에서 회차 하나를 통째로 돌려주는 경우는 오히려 드물다. 취소 위약금이 붙으면
 * 돌려줄 금액은 "낸 돈 − 위약금" 이라 회차 금액보다 작고(T-04), 계약 일부만 취소하면
 * (촬영은 하고 드레스만 취소) 그 비율만큼만 돌아간다. 전액 환불만 지원하면 그런
 * 경우에 **환불을 두 번으로 쪼개거나 장부 밖에서 정산**하게 되는데, 둘 다 D-23 이
 * 요구하는 "언제 얼마를 냈고 얼마를 돌려받았는가" 를 재현 불가능하게 만든다.
 *
 * **얼마를 돌려줄지는 여기서 정하지 않는다** — 위약금 적용과 운영자 승인은 S5-08 이다.
 * 이 함수가 답하는 것은 "그 금액이 돌려줄 수 있는 범위 안인가" 뿐이다.
 */
export type RefundDecision =
  | { ok: true; refundedTotal: number; nextStatus: "partially_refunded" | "refunded" }
  | { ok: false; reason: RefundBlockReason; detail: string };

export type RefundBlockReason = "not_paid" | "exceeds_paid" | "not_positive" | "nothing_left";

export function refundableAmount(input: { amount: number; refundedAmount: number }): number {
  return Math.max(0, input.amount - input.refundedAmount);
}

export function decideRefund(input: {
  status: string;
  amount: number;
  refundedAmount: number;
  requested: number;
}): RefundDecision {
  // 승인되지 않은 결제는 환불 대상이 아니다. 실패·취소 건을 환불하면 있지도 않은
  // 돈이 나가고, 그 기록이 다시 정산으로 흘러간다.
  if (input.status !== "paid" && input.status !== "partially_refunded") {
    return {
      ok: false,
      reason: "not_paid",
      detail: `승인된 결제만 환불할 수 있습니다. 현재 상태: ${input.status}`,
    };
  }

  if (!Number.isInteger(input.requested) || input.requested <= 0) {
    return { ok: false, reason: "not_positive", detail: "환불 금액은 1원 이상 정수여야 합니다." };
  }

  const left = refundableAmount(input);

  if (left === 0) {
    return { ok: false, reason: "nothing_left", detail: "이미 전액 환불된 결제입니다." };
  }

  if (input.requested > left) {
    return {
      ok: false,
      reason: "exceeds_paid",
      detail: `환불 가능액은 ${left}원입니다. 받은 돈보다 많이 돌려줄 수 없습니다.`,
    };
  }

  const refundedTotal = input.refundedAmount + input.requested;

  return {
    ok: true,
    refundedTotal,
    // 경계는 '전액' 쪽이다 — 1원이 남았는데 refunded 라고 적으면 그 1원이 장부에서 사라진다.
    nextStatus: refundedTotal === input.amount ? "refunded" : "partially_refunded",
  };
}

/**
 * 승인 전 결제를 취소한다(`pending` → `cancelled`).
 *
 * 환불과 다른 일이다. 환불은 나간 돈을 되돌리는 것이고 취소는 **아직 안 나간 돈의
 * 요청을 거두는 것**이다. 상태를 하나로 합치면 "돈이 실제로 오갔는가" 를 장부에서
 * 구별할 수 없다.
 */
export function canCancelPayment(status: string): boolean {
  return status === "pending";
}

// =============================================================================
// 동의 — 결제 전 고지 (F-C-14 · §7.4)
// =============================================================================

/**
 * 결제 전 동의 항목.
 *
 * F-C-14 는 "각 회차의 지급 조건·기한·금액을 **결제 전 고지**하고 **동의 로그를 저장**"
 * 을 요구한다. 그래서 동의는 체크박스 UI 가 아니라 **기록**이 본체다 —
 * `payment_consents` 행이 남고, 그 행 없이는 결제가 진행되지 않는다(0030).
 *
 * **문구를 여기 두는 이유.** 화면마다 다시 쓰면 고지 내용이 화면별로 갈라지고, 그러면
 * "무엇에 동의했는가" 를 나중에 재현할 수 없다(D-23 이 계약 해시로 푼 것과 같은 문제).
 * `version` 을 붙여 저장하므로 문구가 바뀌어도 과거 동의가 무엇이었는지 알 수 있다.
 *
 * **조항 문안이 아니다.** 환불 규정의 구체 조항은 O-03 법무 검수 대기이며(§7.7),
 * 여기 적힌 것은 "어디에 규정이 있고 무엇을 확인했는가" 라는 **사실**뿐이다.
 */
export const CHECKOUT_CONSENT_VERSION = "v1";

export const CONSENT_KINDS = ["installment_terms", "refund_policy"] as const;
export type ConsentKind = (typeof CONSENT_KINDS)[number];

export type ConsentItem = { kind: ConsentKind; label: string; detail: string };

export const CHECKOUT_CONSENT_ITEMS: readonly ConsentItem[] = [
  {
    kind: "installment_terms",
    label: "회차별 금액·기한을 확인했어요",
    detail:
      "이번 회차 금액과 남은 회차의 지급 시점을 확인했습니다. 회차 금액의 합은 계약 총액과 같습니다.",
  },
  {
    kind: "refund_policy",
    label: "취소·환불 규정을 확인했어요",
    detail:
      "취소 시점에 따라 돌려받는 금액이 달라집니다. 기준은 소비자분쟁해결기준과 계약서의 취소·위약 항목입니다.",
  },
];

/** 모든 항목에 동의했는가. 하나라도 빠지면 결제를 진행하지 않는다. */
export function consentComplete(agreed: readonly string[]): boolean {
  const set = new Set(agreed);

  return CONSENT_KINDS.every((kind) => set.has(kind));
}

export const CONSENT_REQUIRED_MESSAGE =
  "결제 전에 회차 조건과 취소·환불 규정 확인이 필요해요.";

// =============================================================================
// 쿠폰 자리 — '아직 없음' 과 '쿠폰 없음' 은 다른 말이다 (D-27 · S5-11~S5-14)
// =============================================================================

/**
 * §6.2 는 결제 화면에 **쿠폰 선택 영역**을 두라고 한다. 그런데 쿠폰 테이블은 S5-11 이
 * 만들고 계산은 `lib/core/coupon`(역시 S5-11)이 갖는다 — **이번 범위가 아니다.**
 *
 * 그렇다고 영역을 지우지 않는다. 지우면 S5-12 가 화면을 다시 설계하게 되고, 그 사이
 * 고객은 "쿠폰을 못 쓰는 서비스" 로 이해한다. **자리를 두되 상태를 정직하게 적는다.**
 *
 * **두 상태를 구별한다.**
 *  - `unavailable` — 쿠폰 기능이 **아직 없다.** 우리가 안 만든 것이다.
 *  - `empty` — 기능은 있고 **이 고객이 쓸 수 있는 쿠폰이 없다.**
 * 같은 문구로 적으면 고객은 "나한테 쿠폰이 없구나" 로 읽고, 실제로는 기능이 없는
 * 것이라 문의도 하지 않는다. 그 상태로 몇 달이 지나면 아무도 그 영역이 죽어 있다는
 * 것을 모른다 — S2-08·S3-11 이 "아직 보내지 않는 알림" 에서, S4-04 가 채팅에서
 * 세운 원칙 그대로다.
 */
export type CouponSlotState = "unavailable" | "empty" | "available";

export function couponSlotState(input: {
  /** 쿠폰 기능이 열렸는가. S5-11 이 테이블을 만들기 전까지는 false 다. */
  featureReady: boolean;
  applicableCount: number;
}): CouponSlotState {
  if (!input.featureReady) return "unavailable";

  return input.applicableCount > 0 ? "available" : "empty";
}

export const COUPON_SLOT_MESSAGE: Record<CouponSlotState, string> = {
  unavailable: "쿠폰 기능은 준비 중이에요. 열리면 이 자리에서 바로 쓸 수 있어요.",
  empty: "지금 이 결제에 쓸 수 있는 쿠폰이 없어요.",
  available: "쓸 수 있는 쿠폰이 있어요.",
};

/** 쿠폰 담당 태스크. 화면이 "언제 열리는가" 를 답할 수 있게 코드에 적어 둔다. */
export const COUPON_SLOT_OWNER_TASK = "S5-11~S5-14";

// =============================================================================
// 금액 표시 — 총액과 이번 회차를 구분한다 (D-18)
// =============================================================================

/**
 * D-18 은 "할인 전 · 할인액 · 할인 후를 함께" 를 요구하고, 같은 취지로 결제 화면은
 * **계약 총액과 이번에 낼 금액을 나란히** 보여야 한다. 둘 중 하나만 크게 적으면
 * 고객은 그 숫자를 결제액으로 읽는다 — 20% 회차 화면에 총액만 크면 놀라서 이탈하고,
 * 총액 없이 회차만 크면 "이게 전부인 줄 알았다" 가 된다.
 *
 * 쿠폰이 붙으면 `discountAmount` 가 채워진다(S5-12).
 *
 * **이미 쓴 할인도 함께 받는다**(`priorDiscountAmount` · FIX-13). 안 받으면
 * `remainingAfterThis` 가 **이미 깎인 만큼을 남은 빚으로 적는다** — 계약 총액은
 * 쿠폰 전 금액이고 `paidAmount` 는 할인 뒤 실제로 난 돈이라, 둘을 그대로 빼면
 * 차액이 사라지지 않고 마지막 회차까지 간 뒤에도 "아직 낼 것이 남았다" 가 된다.
 */
export type CheckoutAmounts = {
  contractTotal: number;
  installmentAmount: number;
  discountAmount: number;
  payableAmount: number;
  paidAmount: number;
  remainingAfterThis: number;
};

export function checkoutAmounts(input: {
  contractTotal: number;
  installmentAmount: number;
  paidAmount: number;
  discountAmount?: number;
  /** 앞선 회차에서 이미 쓴 할인액의 합. 없으면 0. */
  priorDiscountAmount?: number;
}): CheckoutAmounts {
  const discountAmount = input.discountAmount ?? 0;
  const priorDiscountAmount = input.priorDiscountAmount ?? 0;

  if (!Number.isInteger(discountAmount) || discountAmount < 0) {
    throw new PaymentError(`할인 금액이 규약을 벗어났습니다: ${discountAmount}`);
  }

  if (!Number.isInteger(priorDiscountAmount) || priorDiscountAmount < 0) {
    throw new PaymentError(`이미 쓴 할인 금액이 규약을 벗어났습니다: ${priorDiscountAmount}`);
  }

  if (discountAmount > input.installmentAmount) {
    throw new PaymentError("할인 금액이 회차 금액보다 클 수 없습니다.");
  }

  const payableAmount = input.installmentAmount - discountAmount;

  return {
    contractTotal: input.contractTotal,
    installmentAmount: input.installmentAmount,
    discountAmount,
    payableAmount,
    paidAmount: input.paidAmount,
    // **할인은 '낸 돈' 과 같은 자리에서 빠진다**(FIX-13). 계약 총액은 쿠폰 전
    // 금액이므로, 깎인 만큼을 빼지 않으면 끝까지 낸 뒤에도 잔액이 남는다.
    remainingAfterThis: Math.max(
      0,
      input.contractTotal - input.paidAmount - priorDiscountAmount - payableAmount - discountAmount,
    ),
  };
}

// =============================================================================
// 정산 연계 — 결제는 되는데 정산이 안 되는 상태를 다룬다 (O-15)
// =============================================================================

/**
 * 결제 성공 뒤 정산을 세울 수 있는가.
 *
 * **`settlement.fee_basis` 가 없으면 정산은 세울 수 없다**(O-15 · `feeBasisOf`).
 * 그러면 결제를 막아야 하는가? **막지 않는다.**
 *
 * 이유. 고객이 낼 금액은 **계약 총액**이 정하고 그것은 이미 서명으로 확정돼 있다.
 * 수수료를 할인 전·후 어느 금액에서 뗄지는 **플랫폼과 업체 사이의 문제**이며 고객의
 * 채무와 무관하다. 미결정 하나로 거래 전체를 세우면, 결정이 늦어지는 만큼 고객이
 * 계약을 이행하지 못한다 — 그 손해는 우리가 아니라 당사자들이 진다.
 *
 * 대신 **보류를 셀 수 있게 만든다.** 조용히 넘어가면 "결제는 됐는데 정산이 안 된"
 * 건이 쌓이고 아무도 모른다. 그래서 결제 성공 시 정산 가능 여부를 함께 판정해
 * `settlement_deferred` 증적을 남기고, 운영은 그 수를 볼 수 있다(S5-07 이 이어받는다).
 *
 * **플래너 수수료는 여기서 만들지 않는다.** D-17 은 "계약 성사 시" 발생이라고 적었고
 * 계약 성사는 **전원 서명(contracts.status='active')** 이지 첫 회차 결제가 아니다.
 * 결제는 성사된 계약의 **이행**이다. 결제 시점에 만들면 (가) 계약은 성사됐는데 결제가
 * 늦어지는 동안 플래너 수수료가 발생하지 않고 (나) 회차마다 결제할 때 원장이 여러 벌
 * 생긴다. 그래서 `planner_settlements` 는 계약 확정 경로가 만든다(`lib/contract`).
 */
export type SettlementLinkage =
  | { ok: true; note: "정산 대상으로 집계할 수 있습니다." }
  | { ok: false; reason: "fee_basis_undecided"; openIssue: string; detail: string };

export function settlementLinkage(input: { feeBasisResolved: boolean; openIssue?: string }): SettlementLinkage {
  if (input.feeBasisResolved) return { ok: true, note: "정산 대상으로 집계할 수 있습니다." };

  return {
    ok: false,
    reason: "fee_basis_undecided",
    openIssue: input.openIssue ?? "O-15",
    detail:
      "수수료 기준(할인 전·후)이 정해지지 않아 이 결제는 정산 집계에서 보류됩니다. 결제 자체는 정상이며, 기준이 정해지면 같은 결제로 정산이 세워집니다.",
  };
}

export const SETTLEMENT_DEFERRED_EVENT = "settlement_deferred";

// =============================================================================
// 화면 문구
// =============================================================================

export const CHECKOUT_TITLE = "결제";

export const CHECKOUT_EMPTY_TITLE = "결제할 회차가 없어요";

export const CHECKOUT_EMPTY_BODY =
  "계약이 확정되면 회차별 금액과 기한이 여기에 나타납니다.";

export const CHECKOUT_FULLY_PAID_TITLE = "모든 회차를 결제했어요";

export const CHECKOUT_FULLY_PAID_BODY =
  "남은 결제가 없습니다. 영수 내역은 예약 상세에서 다시 볼 수 있어요.";

export const CHECKOUT_STUB_NOTICE =
  "지금은 결제가 개발용 대체 수단으로 동작해요. 실제 카드 승인은 일어나지 않습니다.";

export const CHECKOUT_RESULT_TITLE: Record<"paid" | "failed" | "cancelled", string> = {
  paid: "결제가 완료됐어요",
  failed: "결제하지 못했어요",
  cancelled: "결제를 취소했어요",
};
