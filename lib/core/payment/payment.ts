/**
 * 분할 결제 · 정산 · 플래너 지급 (S5-01 잔여분 · 명세서 §3.4, D-16 · D-17 · D-21 · D-28)
 *
 * 프레임워크도 DB 도 모르는 순수 모듈이다. 계산은 **basis point 정수**로만 하고
 * 부동소수점을 쓰지 않는다(CLAUDE.md §3.1 — 결정적 계산에 LLM 도, 부동소수점도 쓰지 않는다).
 *
 * **여기 없는 것 — 값.** 회차 비율·유예 일수·수수료 기준은 전부 `app_settings` 가 갖고
 * 이 파일의 함수는 인자로 받는다. 20/80 도 14일도 코드에 없다(§7.4).
 *
 * 요율 해석과 정산 한 건 계산은 이미 `lib/core/pricing/rates.ts`(S5-02)에 있다.
 * 이 파일은 그 위에 **회차 분할 · 기한 판정 · 정산서 집계 · 플래너 지급 시점**을 얹는다 —
 * 같은 계산을 두 벌 만들지 않는다.
 */

import { calculateSettlement } from "../pricing/rates";

/** 금액·비율 입력이 규약을 벗어날 때 던진다. */
export class PaymentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaymentError";
  }
}

// =============================================================================
// 값 집합 — DB CHECK 와 같아야 한다
// =============================================================================

/**
 * `payments.status`.
 *
 * **DB CHECK(`payments_status_values`)와 같은 목록이어야 한다** — `db:rls` 가 정합을
 * 본다(0023 이 알림 토픽에서 한쪽만 늘려 조용히 실패한 일을 되풀이하지 않기 위해서다).
 */
export const PAYMENT_STATUSES = [
  "pending",
  "paid",
  "failed",
  "cancelled",
  "partially_refunded",
  "refunded",
] as const;

export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/** `payment_schedules.status`. 도래·연체는 **값이 아니라 계산**이다(`scheduleState`). */
export const PAYMENT_SCHEDULE_STATUSES = ["scheduled", "paid", "void"] as const;
export type PaymentScheduleStatus = (typeof PAYMENT_SCHEDULE_STATUSES)[number];

export const PLANNER_SETTLEMENT_STATUSES = ["earned", "payable", "paid", "void"] as const;
export type PlannerSettlementStatus = (typeof PLANNER_SETTLEMENT_STATUSES)[number];

/** 기한의 기준 사건. DB CHECK(`payment_schedules_anchor_values`)와 같은 목록이다. */
export const DUE_ANCHORS = [
  "on_contract",
  "before_event",
  "on_preparation",
  "on_fulfillment",
] as const;

export type DueAnchor = (typeof DUE_ANCHORS)[number];

export const DUE_ANCHOR_LABEL: Record<DueAnchor, string> = {
  on_contract: "계약 체결 시",
  before_event: "예식 전",
  on_preparation: "사전 준비(탐방·리허설) 시점",
  on_fulfillment: "이행 완료 시",
};

// =============================================================================
// 회차 분할 — 합이 총액과 어긋나면 안 된다
// =============================================================================

export type Installment = {
  seq: number;
  ratioBp: number;
  amount: number;
  anchor: DueAnchor;
  /** `before_event` 는 며칠 전인지, `on_contract` 는 0, 나머지는 null. */
  offsetDays: number | null;
};

export type InstallmentPlan = {
  ratioBp: number;
  anchor: DueAnchor;
  offsetDays: number | null;
};

const TOTAL_BP = 10_000;

/**
 * 비율 합이 정확히 10000bp 인가.
 *
 * **DB 도 같은 것을 판정한다**(`trg_payment_schedules_ratio_sum`, 커밋 시점). 여기서 또
 * 보는 이유는 화면·API 가 저장 전에 답을 줄 수 있어야 하기 때문이며, **최종 경계는 DB** 다.
 * 회차를 만드는 경로가 앞으로 여럿이라(계약 발행·재발행·운영 보정) 한 곳만 빠뜨려도
 * 합이 99% 인 계약이 조용히 생긴다.
 */
export function ratioSumOk(plans: readonly { ratioBp: number }[]): boolean {
  if (plans.length === 0) return false;

  return plans.reduce((sum, plan) => sum + plan.ratioBp, 0) === TOTAL_BP;
}

/**
 * 총액을 회차로 나눈다.
 *
 * **잔여는 마지막 회차가 흡수한다.**
 *  - 각 회차는 `floor(total * ratioBp / 10000)` 이고, 남은 1~n원을 마지막 회차에 더한다.
 *  - 그래서 **회차 합은 언제나 총액과 같다.** 반올림으로 1원이 사라지면 잔금을 다 받아도
 *    미납으로 남고, 1원이 늘면 받지 않은 돈을 받았다고 적게 된다.
 *
 * **왜 마지막 회차인가.** 대안은 최대 잔여법(가장 큰 소수부에 1원씩 배분)인데, 그러면
 * 어느 회차가 1원 더 낼지 예측할 수 없어 "계약 시 20%" 라는 안내 문구를 만들 수 없다.
 * 첫 회차는 고객이 계약 시점에 보는 금액이라 비율 그대로여야 하고, 잔금은 "나머지 전부"
 * 라는 뜻이 자연스럽다. 그래서 **앞은 비율대로, 마지막이 나머지**다.
 *
 * 반올림이 아니라 **내림**을 쓰는 이유 — 올림하면 앞 회차 합이 총액을 넘어 마지막 회차가
 * 음수가 될 수 있다(예: 3회 분할의 잔돈).
 */
export function splitAmount(total: number, plans: readonly InstallmentPlan[]): Installment[] {
  if (!Number.isInteger(total) || total < 0) {
    throw new PaymentError(`총액은 0 이상 정수여야 합니다: ${total}`);
  }

  if (plans.length === 0) throw new PaymentError("회차가 없습니다.");

  if (!ratioSumOk(plans)) {
    const sum = plans.reduce((acc, plan) => acc + plan.ratioBp, 0);

    throw new PaymentError(`회차 비율 합이 ${sum}bp 입니다. 10000bp 여야 합니다.`);
  }

  for (const plan of plans) {
    if (!Number.isInteger(plan.ratioBp) || plan.ratioBp <= 0 || plan.ratioBp > TOTAL_BP) {
      throw new PaymentError(`회차 비율이 규약을 벗어났습니다: ${plan.ratioBp}bp`);
    }

    assertOffsetShape(plan);
  }

  const product = total * TOTAL_BP;

  if (!Number.isSafeInteger(product)) {
    throw new PaymentError(`총액 ${total} 은 정수 안전 범위를 벗어난 계산을 만듭니다.`);
  }

  const installments: Installment[] = plans.map((plan, index) => ({
    seq: index + 1,
    ratioBp: plan.ratioBp,
    amount: Math.floor((total * plan.ratioBp) / TOTAL_BP),
    anchor: plan.anchor,
    offsetDays: plan.offsetDays,
  }));

  // 내림으로 생긴 잔여를 마지막 회차에 몰아준다. 합은 여기서 총액과 같아진다.
  const assigned = installments.reduce((sum, item) => sum + item.amount, 0);
  installments[installments.length - 1].amount += total - assigned;

  return installments;
}

/** 기준 사건과 오프셋의 짝. DB CHECK(`payment_schedules_offset_shape`)와 같은 규칙이다. */
function assertOffsetShape(plan: InstallmentPlan): void {
  if (plan.anchor === "on_contract" && plan.offsetDays !== 0) {
    throw new PaymentError("계약 체결 시 회차의 오프셋은 0 이어야 합니다.");
  }

  if (plan.anchor === "before_event" && (plan.offsetDays === null || plan.offsetDays < 1)) {
    throw new PaymentError("예식 기준 회차는 1일 이상의 오프셋이 필요합니다.");
  }

  if (
    (plan.anchor === "on_preparation" || plan.anchor === "on_fulfillment") &&
    plan.offsetDays !== null
  ) {
    throw new PaymentError("사건 기준 회차에는 오프셋을 둘 수 없습니다 — 날짜를 미리 알 수 없습니다.");
  }
}

/** 회차 합. 호출부가 총액과 대조할 때 쓴다. */
export function installmentTotal(installments: readonly { amount: number }[]): number {
  return installments.reduce((sum, item) => sum + item.amount, 0);
}

// =============================================================================
// 운영 파라미터 읽기 — 값이 없으면 지어내지 않는다
// =============================================================================

export type SplitPlanResolution =
  | { ok: true; plans: InstallmentPlan[] }
  | { ok: false; reason: "undecided" | "invalid"; detail: string };

/**
 * `app_settings.payment.split_ratios_bp` 를 회차 계획으로 읽는다.
 *
 * **값이 없으면 실패한다.** 기본값을 만들면 그 순간 코드가 운영 파라미터의 두 번째
 * 진실이 된다(rates.ts 의 `no_matching_rate` 와 같은 원칙 — 없는 값을 지어내지 않는다).
 */
export function resolveSplitPlans(setting: unknown): SplitPlanResolution {
  const raw = (setting as { installments?: unknown } | null)?.installments;

  if (!Array.isArray(raw) || raw.length === 0) {
    return {
      ok: false,
      reason: "undecided",
      detail:
        "분할 회차 설정(payment.split_ratios_bp)이 없습니다. 기본 비율을 코드에서 만들지 않습니다.",
    };
  }

  const plans: InstallmentPlan[] = [];

  for (const item of raw) {
    const row = item as { ratioBp?: unknown; anchor?: unknown; offsetDays?: unknown };
    const ratioBp = Number(row.ratioBp);
    const anchor = row.anchor;
    const offsetDays = row.offsetDays === null || row.offsetDays === undefined ? null : Number(row.offsetDays);

    if (!Number.isInteger(ratioBp) || ratioBp <= 0) {
      return { ok: false, reason: "invalid", detail: `회차 비율이 정수 bp 가 아닙니다: ${String(row.ratioBp)}` };
    }

    if (typeof anchor !== "string" || !(DUE_ANCHORS as readonly string[]).includes(anchor)) {
      return { ok: false, reason: "invalid", detail: `알 수 없는 기한 기준입니다: ${String(anchor)}` };
    }

    plans.push({ ratioBp, anchor: anchor as DueAnchor, offsetDays });
  }

  if (!ratioSumOk(plans)) {
    const sum = plans.reduce((acc, plan) => acc + plan.ratioBp, 0);

    return { ok: false, reason: "invalid", detail: `회차 비율 합이 ${sum}bp 입니다.` };
  }

  return { ok: true, plans };
}

/** 유예 일수. 설정이 없으면 null 이며 호출부는 지급 전환을 하지 않는다. */
export function resolveGraceDays(setting: unknown): number | null {
  const days = Number((setting as { days?: unknown } | null)?.days);

  return Number.isInteger(days) && days >= 0 ? days : null;
}

/**
 * 수수료를 무엇에서 떼는가 — **O-15 미결이다.**
 *
 * 할인 전 판매가에서 떼면 플랫폼 수입이 할인과 무관해지고, 할인 후 실수금에서 떼면
 * 업체가 할인할 때 플랫폼도 함께 덜 받는다. 어느 쪽이든 정책 결정이며 **코드가 고르지
 * 않는다.** 값이 없으면 정산 계산 자체를 세우지 않는다.
 */
export const FEE_BASES = ["pre_discount", "post_discount"] as const;
export type FeeBasis = (typeof FEE_BASES)[number];

export type FeeBasisResolution =
  | { ok: true; basis: FeeBasis }
  | { ok: false; reason: "undecided"; openIssue: string; detail: string };

export function feeBasisOf(setting: unknown): FeeBasisResolution {
  const value = (setting as { basis?: unknown; openIssue?: unknown } | null) ?? null;
  const basis = value?.basis;

  if (typeof basis === "string" && (FEE_BASES as readonly string[]).includes(basis)) {
    return { ok: true, basis: basis as FeeBasis };
  }

  return {
    ok: false,
    reason: "undecided",
    openIssue: typeof value?.openIssue === "string" ? value.openIssue : "O-15",
    detail:
      "수수료 기준(할인 전·후)이 정해지지 않았습니다. 기본값을 코드에서 고르지 않습니다 — 정산을 세우기 전에 운영 결정이 필요합니다.",
  };
}

// =============================================================================
// 기한 — 기준 사건 + 며칠
// =============================================================================

const DAY_MS = 86_400_000;

export type DueContext = {
  /** 계약 체결 시각. `on_contract` 회차의 기준이다. */
  contractIssuedAt: string | null;
  /** 예식일(YYYY-MM-DD). `before_event` 회차의 기준이다. */
  eventDate: string | null;
};

/**
 * 회차 기한.
 *
 * **모르는 것은 null 이다.** 기준 사건이 아직 일어나지 않았거나(계약 미발행) 예식일이
 * 미정이면 기한을 만들지 않는다 — 없는 날짜를 지어내면 청구 배치가 엉뚱한 날에 돈다.
 * `on_preparation`·`on_fulfillment` 는 사건이 일어날 때 서버가 찍으므로 여기서는 항상
 * null 이다.
 */
export function dueAtOf(plan: InstallmentPlan, context: DueContext): string | null {
  if (plan.anchor === "on_contract") {
    return context.contractIssuedAt === null ? null : context.contractIssuedAt;
  }

  if (plan.anchor === "before_event") {
    if (context.eventDate === null || plan.offsetDays === null) return null;

    const eventMs = Date.parse(`${context.eventDate}T00:00:00Z`);

    if (Number.isNaN(eventMs)) return null;

    return new Date(eventMs - plan.offsetDays * DAY_MS).toISOString();
  }

  return null;
}

/**
 * 회차의 지금 상태.
 *
 * **저장하지 않고 계산한다.** '도래'·'연체' 를 컬럼으로 두면 갱신 배치가 늦은 만큼
 * 화면이 거짓을 말한다(0027 이 장바구니 상태에서 세운 것과 같은 규칙).
 *
 *  - `unscheduled` 기한이 아직 정해지지 않았다(기준 사건 대기).
 *  - `upcoming`    기한이 남았다.
 *  - `due`         기한이 지났고 아직 안 냈다.
 *  - `paid` · `void` 는 저장된 상태 그대로다.
 */
export type ScheduleState = "paid" | "void" | "unscheduled" | "upcoming" | "due";

export function scheduleState(input: {
  status: PaymentScheduleStatus;
  dueAt: string | null;
  now: Date;
}): ScheduleState {
  if (input.status === "paid") return "paid";
  if (input.status === "void") return "void";
  if (input.dueAt === null) return "unscheduled";

  const dueMs = Date.parse(input.dueAt);

  if (Number.isNaN(dueMs)) return "unscheduled";

  // 기한 당일 그 시각이 되는 순간 도래다. 경계는 '지났다' 쪽에 넣는다 —
  // 청구가 하루 늦는 것보다 하루 이른 것이 고객에게 설명하기 쉽다.
  return input.now.getTime() >= dueMs ? "due" : "upcoming";
}

export const SCHEDULE_STATE_LABEL: Record<ScheduleState, string> = {
  paid: "결제 완료",
  void: "취소된 회차",
  unscheduled: "기한 미정",
  upcoming: "예정",
  due: "결제 기한이 지났어요",
};

// =============================================================================
// 정산서 집계 — 스냅샷 요율만 쓴다
// =============================================================================

export type SettlementSourceLine = {
  bookingId: string;
  /** 정산 대상 금액. 어느 금액인가는 O-15(`feeBasisOf`)가 정한다. */
  grossAmount: number;
  /** **계약 시점 스냅샷**(`bookings.applied_fee_rate_bp`). 정산 시점 요율이 아니다. */
  appliedFeeRateBp: number | null;
};

export type SettlementLine = {
  bookingId: string;
  grossAmount: number;
  feeRateBp: number;
  feeAmount: number;
  netAmount: number;
};

export type SettlementDraft =
  | {
      ok: true;
      lines: SettlementLine[];
      grossAmount: number;
      feeAmount: number;
      netAmount: number;
      /** 집계에 쓰인 요율. 건마다 다르면 가중 평균이며 **표시용**이다. */
      weightedFeeRateBp: number;
    }
  | {
      ok: false;
      reason: "missing_snapshot";
      detail: string;
      /** 스냅샷이 없는 예약. 운영이 어느 계약을 고쳐야 할지 알 수 있게 돌려준다. */
      bookingIds: string[];
    };

/**
 * 정산서 초안.
 *
 * **요율은 예약에 박힌 스냅샷만 쓴다**(§3.4 NOTE). 요율 테이블을 다시 조회하면 요율
 * 변경이 과거 거래를 소급 변경해 정산 분쟁이 된다.
 *
 * **스냅샷이 없는 건이 하나라도 있으면 정산서를 만들지 않는다.** 그 건을 빼고 만들면
 * 업체는 왜 금액이 적은지 알 수 없고, 0으로 채우면 수수료를 안 받은 것이 된다.
 * 부분 결과를 내놓지 않는다는 규칙은 AI 파이프라인(§5)과 같다.
 */
export function buildSettlementDraft(lines: readonly SettlementSourceLine[]): SettlementDraft {
  const missing = lines.filter((line) => line.appliedFeeRateBp === null).map((line) => line.bookingId);

  if (missing.length > 0) {
    return {
      ok: false,
      reason: "missing_snapshot",
      detail: `요율 스냅샷이 없는 예약이 ${missing.length}건 있어 정산서를 만들 수 없습니다. 계약 확정 시 요율이 박혀야 합니다(D-16).`,
      bookingIds: missing,
    };
  }

  const computed: SettlementLine[] = lines.map((line) => {
    const result = calculateSettlement({
      salePrice: line.grossAmount,
      feeRateBp: line.appliedFeeRateBp as number,
    });

    return {
      bookingId: line.bookingId,
      grossAmount: result.salePrice,
      feeRateBp: result.feeRateBp,
      feeAmount: result.feeAmount,
      netAmount: result.netAmount,
    };
  });

  const grossAmount = computed.reduce((sum, line) => sum + line.grossAmount, 0);
  const feeAmount = computed.reduce((sum, line) => sum + line.feeAmount, 0);

  return {
    ok: true,
    lines: computed,
    grossAmount,
    feeAmount,
    netAmount: grossAmount - feeAmount,
    // 건별 요율이 다를 수 있다(계약 시점이 다르므로). 대표값은 실제 수수료에서 되짚는다 —
    // 요율을 평균해 금액을 다시 계산하면 합이 건별 합계와 어긋난다.
    weightedFeeRateBp: grossAmount === 0 ? 0 : Math.round((feeAmount * TOTAL_BP) / grossAmount),
  };
}

// =============================================================================
// 플래너 지급 — 계약 성사 + 유예
// =============================================================================

/** `earned_at + graceDays`. 유예 값은 설정이 갖는다(§7.4). */
export function payableAtOf(earnedAt: string, graceDays: number): string {
  if (!Number.isInteger(graceDays) || graceDays < 0) {
    throw new PaymentError(`유예 일수가 규약을 벗어났습니다: ${graceDays}`);
  }

  const earnedMs = Date.parse(earnedAt);

  if (Number.isNaN(earnedMs)) throw new PaymentError(`발생 시각을 읽을 수 없습니다: ${earnedAt}`);

  return new Date(earnedMs + graceDays * DAY_MS).toISOString();
}

/**
 * 플래너 정산의 지금 상태.
 *
 * **유예가 지났는지는 시계로 판정한다.** 배치(`planner-payout-due`)가 `earned` →
 * `payable` 로 옮기지만, 배치가 늦어도 화면은 사실을 말해야 한다. 반대로 배치가 일찍
 * 옮기는 것은 DB 트리거가 막는다(`assert_planner_settlement_payable`).
 *
 * 경계는 **`payable_at` 당일 그 시각을 포함**한다 — 유예 14일이면 14일째 그 시각에
 * 지급 대상이 된다. 하루를 더 기다리게 하면 유예가 사실상 15일이 된다.
 */
export type PlannerPayoutState = "paid" | "void" | "waiting_grace" | "payable";

export function plannerPayoutState(input: {
  status: PlannerSettlementStatus;
  payableAt: string;
  now: Date;
}): PlannerPayoutState {
  if (input.status === "paid") return "paid";
  if (input.status === "void") return "void";

  const payableMs = Date.parse(input.payableAt);

  if (Number.isNaN(payableMs)) return "waiting_grace";

  return input.now.getTime() >= payableMs ? "payable" : "waiting_grace";
}

export const PLANNER_PAYOUT_STATE_LABEL: Record<PlannerPayoutState, string> = {
  paid: "지급 완료",
  void: "무효",
  waiting_grace: "지급 유예 중",
  payable: "지급 대상",
};

/**
 * 플래너 수수료 원장 한 건.
 *
 * **계약 성사 시에만 만들어진다**(D-17). 상담·탐방만으로는 발생하지 않으므로 이 함수를
 * 부르는 지점은 계약 확정 경로 하나여야 한다.
 */
export type PlannerEarning = {
  grossAmount: number;
  feeRateBp: number;
  feeAmount: number;
  earnedAt: string;
  payableAt: string;
};

export function plannerEarning(input: {
  grossAmount: number;
  /** `bookings.applied_planner_fee_rate_bp` 스냅샷. 0 이면 플래너 미선택이다. */
  appliedPlannerFeeRateBp: number;
  earnedAt: string;
  graceDays: number;
}): PlannerEarning | null {
  if (!Number.isInteger(input.appliedPlannerFeeRateBp) || input.appliedPlannerFeeRateBp < 0) {
    throw new PaymentError(`플래너 요율이 규약을 벗어났습니다: ${input.appliedPlannerFeeRateBp}`);
  }

  // 0bp 는 플래너를 쓰지 않은 계약이다. 0원 행을 만들면 지급 목록에 빈 건이 쌓인다.
  if (input.appliedPlannerFeeRateBp === 0) return null;

  const { feeAmount } = calculateSettlement({
    salePrice: input.grossAmount,
    feeRateBp: input.appliedPlannerFeeRateBp,
  });

  return {
    grossAmount: input.grossAmount,
    feeRateBp: input.appliedPlannerFeeRateBp,
    feeAmount,
    earnedAt: input.earnedAt,
    payableAt: payableAtOf(input.earnedAt, input.graceDays),
  };
}

// =============================================================================
// 멱등 (D-28 — 실연동은 나중이고 열쇠 설계는 지금이다)
// =============================================================================

/**
 * **나가는 요청**의 멱등 열쇠.
 *
 * PG 는 같은 열쇠의 요청을 두 번 처리하지 않는다. 그래서 열쇠는 **같은 의도의 재시도에서
 * 같고, 다른 의도에서 달라야** 한다. S4-08 이 보증금에서 쓴 `deposit:<id>:<상태>` 와 같은
 * 모양이며, 회차 결제는 **회차 id + 시도 목적**으로 정한다.
 *
 * **시도 횟수를 열쇠에 넣지 않는다.** 넣으면 재시도가 매번 새 열쇠가 되어 멱등이 사라진다 —
 * 네트워크가 끊긴 뒤의 재시도는 "같은 결제를 다시 확인" 이지 "새 결제" 가 아니다.
 * 사용자가 명시적으로 새 결제를 시작하면 `attempt` 를 올려 **다른 열쇠**를 만든다.
 */
export function paymentIdempotencyKey(input: {
  scheduleId: string;
  purpose: "charge" | "cancel" | "refund";
  /** 명시적 재결제 회차. 기본 1이며 자동 재시도에서는 올리지 않는다. */
  attempt?: number;
}): string {
  const attempt = input.attempt ?? 1;

  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new PaymentError(`시도 번호가 규약을 벗어났습니다: ${attempt}`);
  }

  return `schedule:${input.scheduleId}:${input.purpose}:${attempt}`;
}

/**
 * **들어오는 웹훅**의 중복 판정.
 *
 * PG 는 같은 이벤트를 여러 번 보낸다 — 재시도가 정상 동작이다. 그래서 수신 측이
 * `(provider, event_id)` 로 접는다(`payment_webhook_events` 유니크). 이 함수는 그 열쇠를
 * 만들 뿐이고, **판정은 DB 유니크가 한다** — 코드가 먼저 조회해 없으면 넣는 방식은
 * 동시 수신에서 둘 다 통과한다(S4-08 이 보증금에서 같은 결론에 이르렀다).
 */
export function webhookDedupeKey(input: { provider: string; eventId: string }): string {
  const provider = input.provider.trim();
  const eventId = input.eventId.trim();

  if (provider === "" || eventId === "") {
    throw new PaymentError("웹훅 식별자가 비어 있습니다. 중복을 접을 수 없습니다.");
  }

  return `${provider}:${eventId}`;
}

/**
 * 웹훅 처리 결정.
 *
 * **순서가 중요하다** — 서명 검증 → 중복 확인 → 상태 전이. 서명을 확인하기 전에 중복을
 * 접으면 남이 보낸 이벤트 id 로 진짜 이벤트를 막을 수 있다(선점 공격).
 */
export type WebhookDecision =
  | { action: "reject"; reason: "bad_signature" }
  | { action: "skip"; reason: "duplicate" }
  | { action: "process" };

export function decideWebhook(input: {
  signatureOk: boolean;
  alreadyProcessed: boolean;
}): WebhookDecision {
  if (!input.signatureOk) return { action: "reject", reason: "bad_signature" };
  if (input.alreadyProcessed) return { action: "skip", reason: "duplicate" };

  return { action: "process" };
}

/**
 * 웹훅 payload 에서 **보관해도 되는 것만** 남긴다.
 *
 * §7.3 은 원문·식별정보를 남기지 말라고 하고 D-23 은 증적을 요구한다. 둘을 다 지키는
 * 방법은 **정규화 스냅샷 + 원문 해시**다 — 무엇을 받았는지 증명할 수 있고 원문은 PG 사에
 * 남아 있다. DB CHECK(`payments_webhook_no_pii`)가 금지 키를 한 층 더 막는다.
 */
export const WEBHOOK_SNAPSHOT_KEYS = [
  "provider",
  "eventId",
  "eventType",
  "paymentKey",
  "orderId",
  "status",
  "amount",
  "currency",
  "approvedAt",
  "methodType",
] as const;

export function minimizeWebhook(payload: Record<string, unknown>): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {};

  for (const key of WEBHOOK_SNAPSHOT_KEYS) {
    const value = payload[key];

    // 객체·배열은 담지 않는다. 중첩 안에 식별정보가 숨어 들어오는 경로다.
    if (value === undefined || value === null) continue;
    if (typeof value === "object") continue;

    snapshot[key] = value;
  }

  return snapshot;
}
