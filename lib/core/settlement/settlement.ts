/**
 * 정산 집계 · 상계 · 지급 (S5-07 · 명세서 §2.2 F-V-09, §2.3 F-A-11, §3.4, §3.8,
 * §6.3, D-16 · D-17 · D-18 · D-23 · D-27 · D-28)
 *
 * 프레임워크도 DB 도 모르는 순수 모듈이다. 금액은 **원 단위 정수 · 요율은 bp 정수**로만
 * 다루고 부동소수점을 쓰지 않는다(CLAUDE.md §6).
 *
 * ── 같은 계산을 두 벌 만들지 않는다 ─────────────────────────────────────────
 * 건별 수수료는 `lib/core/pricing/rates.ts`(S5-02 `calculateSettlement`)가, 스냅샷
 * 누락 판정과 집계는 `lib/core/payment/payment.ts`(S5-01 `buildSettlementDraft`)가
 * 이미 갖고 있다. 이 파일은 그 위에 **수수료 기준(O-15) · 쿠폰 차감 · 상계 · 지급**을
 * 얹는다.
 *
 * ── 미결은 실패가 아니다 ────────────────────────────────────────────────────
 * `settlement.fee_basis` 가 비어 있으면 정산을 세울 수 없다. 그것을 '실패' 로 적으면
 * 운영은 **우리 시스템이 고장난 것**으로 읽고 원인을 코드에서 찾는다. 실제로는
 * **결정 하나가 비어 있을 뿐**이므로, 이 모듈은 `blocked` + **무엇이 비었는지**를
 * 돌려주고 화면은 그것을 "설정 대기" 로 적는다.
 *
 * **여기 없는 것 둘.**
 *  1. **`fee_basis` 값.** O-15 미결이며 이 파일은 값을 고르지 않는다. 정해지면
 *     같은 정산서를 **재계산**한다.
 *  2. **정산 주기·지급 리드타임.** `app_settings.settlement.*` 가 갖는다(§7.4).
 */

import { buildSettlementDraft, type SettlementSourceLine } from "../payment/payment";

/** 입력이 규약을 벗어날 때 던진다. */
export class SettlementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettlementError";
  }
}

// =============================================================================
// 값 집합 — DB CHECK 와 같아야 한다 (`db:rls` 가 정합을 본다)
// =============================================================================

export const SETTLEMENT_STATUSES = ["blocked", "draft", "confirmed", "paid", "void"] as const;
export type SettlementStatus = (typeof SETTLEMENT_STATUSES)[number];

/**
 * 화면 라벨.
 *
 * **`blocked` 를 '실패' 라고 적지 않는다.** 무엇이 비었는지는 `BLOCKED_REASON_LABEL`
 * 이 말하고, 둘 다 "고쳐야 할 코드" 가 아니라 "채워야 할 값" 을 가리킨다.
 */
export const SETTLEMENT_STATUS_LABEL: Record<SettlementStatus, string> = {
  blocked: "설정 대기",
  draft: "확정 대기",
  confirmed: "지급 예정",
  paid: "지급 완료",
  void: "무효",
};

export const BLOCKED_REASONS = ["fee_basis_missing", "rate_snapshot_missing"] as const;
export type BlockedReason = (typeof BLOCKED_REASONS)[number];

export const BLOCKED_REASON_LABEL: Record<BlockedReason, string> = {
  fee_basis_missing: "수수료 기준 설정 대기",
  rate_snapshot_missing: "요율 스냅샷 누락",
};

/**
 * 화면이 그대로 적는 설명. **"오류가 났다" 가 아니라 "무엇이 아직 정해지지 않았다" 다.**
 *
 * 업체가 이 화면을 보고 고객센터에 "정산이 실패했다" 고 문의하면, 운영은 없는 장애를
 * 찾게 된다. 실제로 필요한 것은 **운영 결정 하나**이며 그 사실을 화면이 말해야 한다.
 */
export const BLOCKED_REASON_DETAIL: Record<BlockedReason, string> = {
  fee_basis_missing:
    "수수료를 할인 전 판매가와 할인 후 결제액 중 어느 금액에서 뗄지가 아직 정해지지 않았어요. 기준이 정해지면 이 기간의 정산이 그대로 계산됩니다 — 거래 내역은 이미 모여 있어요.",
  rate_snapshot_missing:
    "계약 확정 시점의 수수료율이 기록되지 않은 거래가 있어요. 그 거래를 확인해야 정산서를 만들 수 있습니다.",
};

export const ADJUSTMENT_SOURCES = [
  "cancellation_refund",
  "coupon",
  "planner_recovery",
  "manual",
] as const;

export type AdjustmentSource = (typeof ADJUSTMENT_SOURCES)[number];

export const ADJUSTMENT_SOURCE_LABEL: Record<AdjustmentSource, string> = {
  cancellation_refund: "해지 환불 상계",
  coupon: "쿠폰 차감",
  planner_recovery: "플래너 수수료 회수",
  manual: "운영 조정",
};

export const PAYOUT_STATUSES = ["pending", "paid", "failed", "cancelled"] as const;
export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];

// =============================================================================
// 정산 기간 — 값은 설정이 갖는다
// =============================================================================

export type SettlementPeriod = { start: string; end: string };

/**
 * 이 시점이 속한 정산 기간.
 *
 * **월 단위만 구현한다.** 주기는 설정이 갖지만(`settlement.period`) 지금 값은 `month`
 * 하나이고, 쓰지 않는 주기를 미리 구현하면 시험되지 않은 코드가 남는다. 다른 주기가
 * 실제로 필요해지면 그때 이 함수가 분기한다 — 그 전까지는 **모르는 주기를 만나면
 * 던진다**(조용히 월로 처리하면 잘못된 기간의 정산서가 생긴다).
 */
export function settlementPeriod(at: Date, unit: string = "month"): SettlementPeriod {
  if (unit !== "month") {
    throw new SettlementError(`아직 지원하지 않는 정산 주기입니다: ${unit}`);
  }

  const year = at.getUTCFullYear();
  const month = at.getUTCMonth();
  const start = new Date(Date.UTC(year, month, 1));
  const end = new Date(Date.UTC(year, month + 1, 0));

  return { start: iso(start), end: iso(end) };
}

/** 직전 기간. 마감 배치가 "지난 달" 을 돌릴 때 쓴다. */
export function previousPeriod(period: SettlementPeriod): SettlementPeriod {
  const start = new Date(`${period.start}T00:00:00Z`);

  return settlementPeriod(new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() - 1, 1)));
}

function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** 지급 예정일 = 확정일 + 리드타임. 일수는 설정이 갖는다(§7.4). */
export function payableDateOf(confirmedAt: Date, leadDays: number): string {
  if (!Number.isInteger(leadDays) || leadDays < 0) {
    throw new SettlementError(`지급 리드타임이 규약을 벗어났습니다: ${leadDays}`);
  }

  return iso(new Date(confirmedAt.getTime() + leadDays * 86_400_000));
}

// =============================================================================
// 집계 — 미결이면 '대기' 로 남는다
// =============================================================================

export type SettlementLine = {
  bookingId: string;
  /** 할인 전 판매가. `pre_discount` 기준이 쓰는 금액이다. */
  grossAmount: number;
  /** 실제 결제액(할인 후). `post_discount` 기준이 쓰는 금액이다. */
  paidAmount: number;
  /** **계약 확정 시점 스냅샷.** null 이면 정산서를 만들지 않는다(§3.4 NOTE · D-16). */
  appliedFeeRateBp: number | null;
  /** 이 거래에서 **업체가 부담한** 쿠폰 할인액(D-27). 플랫폼 부담분은 0 이다. */
  vendorCouponDeduction: number;
};

export type SettlementItemResult = {
  bookingId: string;
  amount: number;
  feeRateBp: number;
  feeAmount: number;
  couponDeduction: number;
  netAmount: number;
};

export type SettlementBuild =
  | {
      status: "draft";
      feeBasis: "pre_discount" | "post_discount";
      items: SettlementItemResult[];
      grossAmount: number;
      feeAmount: number;
      couponDeduction: number;
      netAmount: number;
      weightedFeeRateBp: number;
    }
  | {
      status: "blocked";
      reason: BlockedReason;
      detail: string;
      /** 스냅샷이 없는 예약. 운영이 어느 계약을 고쳐야 할지 알 수 있게 돌려준다. */
      bookingIds: string[];
    };

/**
 * 정산서를 세운다.
 *
 * **수수료를 무엇에서 떼는가**(O-15)
 *  - `pre_discount`  할인 **전** 판매가에서 뗀다. 플랫폼 수입이 할인과 무관해지고,
 *    업체 쿠폰의 비용을 업체가 온전히 진다.
 *  - `post_discount` 할인 **후** 결제액에서 뗀다. 업체가 할인하면 플랫폼도 함께 덜 받는다.
 *
 * **값이 없으면 세우지 않는다.** 코드가 기본값을 고르면 미결정이 조용히 확정된다
 * (`feeBasisOf`·`resolveSplitPlans` 와 같은 원칙). 다만 **거래 내역은 이미 모여 있고**
 * 기준만 채우면 같은 데이터로 계산되므로, 그 사실을 `detail` 이 말한다.
 *
 * **스냅샷이 없는 건이 하나라도 있으면 만들지 않는다**(§3.4). 빼고 만들면 업체는
 * 금액이 왜 적은지 알 수 없고, 0으로 채우면 수수료를 안 받은 것이 된다.
 *
 * **쿠폰은 업체 부담분만 뺀다**(D-27). 플랫폼 쿠폰은 업체 정산에서 차감하지 않는다 —
 * 업체가 모르는 사이에 자기 수입이 깎이면 안 된다.
 */
export function buildSettlement(input: {
  lines: readonly SettlementLine[];
  feeBasis: "pre_discount" | "post_discount" | null;
}): SettlementBuild {
  if (input.feeBasis === null) {
    return {
      status: "blocked",
      reason: "fee_basis_missing",
      detail: BLOCKED_REASON_DETAIL.fee_basis_missing,
      bookingIds: [],
    };
  }

  // 수수료 대상 금액을 기준이 정한다. 이 한 줄이 O-15 의 두 선택지를 가른다.
  const sourceLines: SettlementSourceLine[] = input.lines.map((line) => ({
    bookingId: line.bookingId,
    grossAmount: input.feeBasis === "pre_discount" ? line.grossAmount : line.paidAmount,
    appliedFeeRateBp: line.appliedFeeRateBp,
  }));

  const draft = buildSettlementDraft(sourceLines);

  if (!draft.ok) {
    return {
      status: "blocked",
      reason: "rate_snapshot_missing",
      detail: BLOCKED_REASON_DETAIL.rate_snapshot_missing,
      bookingIds: draft.bookingIds,
    };
  }

  const deductionOf = new Map(
    input.lines.map((line) => [line.bookingId, line.vendorCouponDeduction]),
  );

  const items: SettlementItemResult[] = draft.lines.map((line) => {
    const couponDeduction = deductionOf.get(line.bookingId) ?? 0;

    assertAmount(couponDeduction, "쿠폰 차감액");

    return {
      bookingId: line.bookingId,
      amount: line.grossAmount,
      feeRateBp: line.feeRateBp,
      feeAmount: line.feeAmount,
      couponDeduction,
      // 건별 순액 = 대상 금액 − 수수료 − 업체 부담 쿠폰. DB CHECK 와 같은 식이다.
      netAmount: line.grossAmount - line.feeAmount - couponDeduction,
    };
  });

  const couponDeduction = items.reduce((sum, item) => sum + item.couponDeduction, 0);

  return {
    status: "draft",
    feeBasis: input.feeBasis,
    items,
    grossAmount: draft.grossAmount,
    feeAmount: draft.feeAmount,
    couponDeduction,
    netAmount: draft.netAmount - couponDeduction,
    weightedFeeRateBp: draft.weightedFeeRateBp,
  };
}

function assertAmount(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new SettlementError(`${label}은 0 이상 정수여야 합니다: ${value}`);
  }
}

// =============================================================================
// 상계 — 모자라면 다음 기간으로 넘긴다
// =============================================================================

export type PendingAdjustment = {
  id: string;
  sourceType: AdjustmentSource;
  amount: number;
  reason: string;
};

export type AdjustmentApplication = {
  applied: { id: string; amount: number }[];
  appliedTotal: number;
  /** 이번에 못 뺀 금액. **다음 정산으로 넘어간다.** */
  carriedTotal: number;
  carried: { id: string; amount: number }[];
  payoutAmount: number;
};

/**
 * 상계를 지급액에 반영한다.
 *
 * **지급액은 음수가 되지 않는다.** 순액보다 상계가 크면 이번에는 순액만큼만 빼고
 * **나머지는 다음 정산으로 넘긴다.** 음수 지급을 허용하면 "업체가 플랫폼에 송금한다"
 * 는 뜻이 되는데, 그 청구 경로는 없고 만들 계획도 없다.
 *
 * **부분 반영을 하지 않는다.** 상계 건 하나를 반으로 쪼개 절반만 빼면, 그 건이 두
 * 정산서에 걸쳐 남아 "이 환불이 어디서 얼마나 빠졌나" 를 재현하기 어려워진다.
 * 그래서 **건 단위로 들어가거나 통째로 넘어간다** — 큰 건 하나 때문에 작은 건들이
 * 밀리지 않도록 **금액이 작은 것부터** 넣는다.
 */
export function applyAdjustments(
  netAmount: number,
  pending: readonly PendingAdjustment[],
): AdjustmentApplication {
  assertAmount(netAmount, "순액");

  const ordered = [...pending].sort((a, b) => a.amount - b.amount || a.id.localeCompare(b.id));
  const applied: { id: string; amount: number }[] = [];
  const carried: { id: string; amount: number }[] = [];
  let left = netAmount;

  for (const item of ordered) {
    assertAmount(item.amount, "상계 금액");

    if (item.amount <= left) {
      applied.push({ id: item.id, amount: item.amount });
      left -= item.amount;
    } else {
      carried.push({ id: item.id, amount: item.amount });
    }
  }

  return {
    applied,
    appliedTotal: applied.reduce((sum, item) => sum + item.amount, 0),
    carried,
    carriedTotal: carried.reduce((sum, item) => sum + item.amount, 0),
    payoutAmount: left,
  };
}

export const ADJUSTMENT_CARRY_NOTICE =
  "이번 정산액보다 큰 상계는 다음 정산으로 넘어갑니다. 지급액이 음수가 되지는 않아요.";

// =============================================================================
// 재계산 — 값이 정해지면 같은 정산서를 다시 세운다
// =============================================================================

/**
 * 이 정산서를 다시 계산할 수 있는가.
 *
 * **확정·지급된 정산서는 재계산하지 않는다.** 업체가 본 숫자와 받은 돈이 달라지면
 * 그 자체가 분쟁이다(D-23). 고칠 일이 생기면 금액을 덮어쓰는 것이 아니라 **상계로
 * 다음 정산에 반영**한다 — 0031 이 해지에서 확정 정산서를 조율로 보낸 것과 같은 판단.
 *
 * **새 행을 만들지 않고 같은 행을 고친다.** 기간·업체당 하나이며, 지우고 다시 만들면
 * 증적(`entity_events.entity_id`)이 가리키던 대상이 사라진다.
 */
export function recalculable(status: SettlementStatus): boolean {
  return status === "blocked" || status === "draft";
}

export const RECALCULATE_BLOCKED_NOTICE =
  "확정된 정산서는 다시 계산하지 않습니다. 조정이 필요하면 상계로 다음 정산에 반영해요.";

/** 재계산이 필요한 정산서인가 — 화면이 "지금 다시 계산할 수 있어요" 를 말하는 조건. */
export function needsRecalculation(input: {
  status: SettlementStatus;
  blockedReason: string | null;
  feeBasisResolved: boolean;
}): boolean {
  return (
    input.status === "blocked" &&
    input.blockedReason === "fee_basis_missing" &&
    input.feeBasisResolved
  );
}

export const RECALCULATE_READY_NOTICE =
  "수수료 기준이 정해졌어요. 이 기간의 정산을 다시 계산할 수 있습니다.";

// =============================================================================
// 지급 — 멱등 열쇠는 정산서 + 시도 회차
// =============================================================================

/**
 * 나가는 이체의 멱등 열쇠.
 *
 * **자동 재시도에서 회차를 올리지 않는다.** 올리면 재시도가 새 이체가 되어 **돈이 두
 * 번 나간다.** 네트워크가 끊긴 뒤의 재시도는 "같은 이체를 다시 확인" 이지 새 이체가
 * 아니다(S5-06 의 `paymentIdempotencyKey` 와 같은 규칙). 운영자가 명시적으로 다시
 * 지급할 때만 회차가 오른다.
 */
export function payoutIdempotencyKey(input: { settlementId: string; attempt?: number }): string {
  const attempt = input.attempt ?? 1;

  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new SettlementError(`시도 번호가 규약을 벗어났습니다: ${attempt}`);
  }

  return `settlement:${input.settlementId}:payout:${attempt}`;
}

export type PayoutBlockReason = "not_confirmed" | "already_paid" | "in_progress" | "zero_amount";

export const PAYOUT_BLOCK_MESSAGE: Record<PayoutBlockReason, string> = {
  not_confirmed: "확정된 정산서만 지급할 수 있어요.",
  already_paid: "이미 지급된 정산서예요.",
  in_progress: "이 정산서의 지급이 진행 중이에요.",
  zero_amount: "지급할 금액이 없어요. 상계가 정산액을 모두 덮었습니다.",
};

export function payoutEligibility(input: {
  status: SettlementStatus;
  payoutAmount: number;
  hasPending: boolean;
}): { ok: true } | { ok: false; reason: PayoutBlockReason; detail: string } {
  if (input.status === "paid") return payoutBlock("already_paid");
  if (input.status !== "confirmed") return payoutBlock("not_confirmed");
  if (input.hasPending) return payoutBlock("in_progress");
  if (input.payoutAmount <= 0) return payoutBlock("zero_amount");

  return { ok: true };
}

function payoutBlock(reason: PayoutBlockReason) {
  return { ok: false as const, reason, detail: PAYOUT_BLOCK_MESSAGE[reason] };
}

// =============================================================================
// 세금계산서 자료 — 자료까지, 발행은 아니다
// =============================================================================

/**
 * 세금계산서 **자료**(F-V-09 "세금계산서 자료 다운로드").
 *
 * **발행이 아니라 자료까지가 범위다.** 전자세금계산서 발행은 (가) 국세청 연동 또는
 * 발행 대행사 계약이 필요하고(D-28 과 같은 외부 계약 문제) (나) 사업자등록번호·대표자
 * ·업태·종목 같은 **우리가 아직 평문으로 갖고 있지 않은 정보**를 요구한다
 * (`vendors.biz_no_enc` 는 해시다 — §7.2). 그 둘이 없는 상태에서 발행을 흉내 내면
 * **세금계산서처럼 보이는 문서**가 생기고, 그것은 회계에서 실제로 쓰이게 된다.
 *
 * 그래서 이 함수가 만드는 것은 **집계 값**이다 — 공급가액·세액·합계. 업체는 이것을
 * 내려받아 자기 세무 대리인에게 넘긴다. 부가세율은 **설정이 갖는다**(§7.4) — 세율을
 * 코드에 박으면 바뀌는 날 배포가 필요하다.
 */
export type TaxSummary = {
  supplyAmount: number;
  taxAmount: number;
  totalAmount: number;
  taxRateBp: number;
  note: string;
};

export const TAX_DOCUMENT_NOTE =
  "세금계산서 발행용 집계 자료입니다. 이 문서 자체는 세금계산서가 아니며, 발행은 업체가 직접 하거나 세무 대리인을 통해 진행합니다.";

/**
 * 수수료에 대한 공급가액·세액.
 *
 * **정산액이 아니라 수수료가 과세 대상**이다 — 플랫폼이 업체에 제공한 용역의 대가는
 * 중개 수수료이고, 거래 대금 자체는 고객과 업체 사이의 것이다(D-24 — 플랫폼은 계약
 * 당사자가 아니다). 이 구분을 틀리면 업체가 세금을 과다 신고한다.
 */
export function taxSummary(feeAmount: number, taxRateBp: number | null): TaxSummary | null {
  assertAmount(feeAmount, "수수료");

  // 세율 설정이 없으면 만들지 않는다. 지어낸 세율로 만든 자료는 신고에 그대로 쓰인다.
  if (taxRateBp === null) return null;

  if (!Number.isInteger(taxRateBp) || taxRateBp < 0 || taxRateBp > 10_000) {
    throw new SettlementError(`부가세율이 규약을 벗어났습니다: ${taxRateBp}bp`);
  }

  // 공급가액은 수수료 그 자체다. 세액은 그 위에 붙는다.
  const taxAmount = Math.floor((feeAmount * taxRateBp) / 10_000);

  return {
    supplyAmount: feeAmount,
    taxAmount,
    totalAmount: feeAmount + taxAmount,
    taxRateBp,
    note: TAX_DOCUMENT_NOTE,
  };
}

// =============================================================================
// 화면 문구 (D-18 — 총액·수수료·상계·순지급액을 구분한다)
// =============================================================================

export const SETTLEMENT_TITLE = "정산";

export const SETTLEMENT_EMPTY_TITLE = "아직 정산할 거래가 없어요";

export const SETTLEMENT_EMPTY_BODY =
  "결제가 완료된 거래가 생기면 기간별 정산서가 여기에 만들어집니다.";

/**
 * 요율 스냅샷 고지(D-16).
 *
 * **지금 요율과 다를 수 있다는 사실을 화면이 먼저 말한다.** 업체가 정산서의 요율과
 * 설정 화면의 요율이 다른 것을 발견하고 문의하는 것보다, 그 이유를 먼저 읽는 편이 낫다.
 */
export const RATE_SNAPSHOT_NOTICE =
  "적용 요율은 각 계약이 확정된 시점의 값입니다. 이후 요율이 바뀌어도 지난 거래에 소급되지 않아요.";

export const FEE_BASIS_LABEL: Record<"pre_discount" | "post_discount", string> = {
  pre_discount: "할인 전 판매가 기준",
  post_discount: "할인 후 결제액 기준",
};

export const PAYOUT_STUB_NOTICE =
  "지금은 지급이 개발용 대체 수단으로 동작해요. 실제 이체는 일어나지 않습니다.";

export const VENDOR_NOTE_PLACEHOLDER =
  "금액이 다르다고 생각되면 여기에 적어 주세요. 운영자가 확인합니다.";
