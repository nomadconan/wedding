import { readSetting } from "@/lib/app-settings";
import { feeBasisOf } from "@/lib/core/payment/payment";
import {
  ADJUSTMENT_SOURCE_LABEL,
  BLOCKED_REASON_DETAIL,
  BLOCKED_REASON_LABEL,
  FEE_BASIS_LABEL,
  SETTLEMENT_STATUS_LABEL,
  needsRecalculation,
  taxSummary,
  type AdjustmentSource,
  type BlockedReason,
  type SettlementStatus,
  type TaxSummary,
} from "@/lib/core/settlement/settlement";

/**
 * 정산 화면·API 가 함께 쓰는 조회 (S5-07)
 *
 * **화면과 API 가 같은 함수를 쓴다.** 집계 규칙을 두 벌 만들면 언젠가 화면의 숫자와
 * 자료 다운로드의 숫자가 갈리고, 업체는 어느 쪽이 맞는지 알 수 없다.
 *
 * **읽기는 호출자가 넘긴 세션 클라이언트로 한다.** `settlements` 정책은 **업체 대표
 * 전용**이다(0028) — staff 에게는 애초에 안 보인다. 여기서 역할을 다시 비교하지
 * 않는다(§5.5 — 앱 레벨 체크는 보안 경계가 아니다).
 */
type Reader = Awaited<ReturnType<typeof import("@/lib/supabase/server").createClient>>;

export type SettlementItemView = {
  bookingId: string | null;
  amount: number;
  feeRateBp: number | null;
  feeAmount: number;
  couponDeduction: number;
  netAmount: number;
};

export type AdjustmentView = {
  id: string;
  sourceType: AdjustmentSource;
  sourceLabel: string;
  amount: number;
  reason: string;
  applied: boolean;
};

export type SettlementView = {
  id: string;
  periodStart: string;
  periodEnd: string;
  status: SettlementStatus;
  statusLabel: string;
  blockedReason: BlockedReason | null;
  blockedLabel: string | null;
  blockedDetail: string | null;
  /** 기준이 정해져 지금 다시 계산할 수 있는가. 화면이 버튼을 여는 조건이다. */
  recalculable: boolean;
  feeBasis: "pre_discount" | "post_discount" | null;
  feeBasisLabel: string | null;
  grossAmount: number;
  feeAmount: number;
  feeRateBp: number;
  couponDeduction: number;
  adjustmentAmount: number;
  netAmount: number;
  payoutAmount: number | null;
  payableAt: string | null;
  paidAt: string | null;
  vendorNote: string | null;
  items: SettlementItemView[];
  tax: TaxSummary | null;
};

export type SettlementsPayload = {
  settlements: SettlementView[];
  /** 아직 어느 정산서에도 붙지 않은 상계. **다음 정산에서 차감 예정**이다. */
  pendingAdjustments: AdjustmentView[];
  feeBasisResolved: boolean;
};

const SETTLEMENT_COLUMNS =
  "id, period_start, period_end, status, blocked_reason, fee_basis, gross_amount, fee_amount, fee_rate_bp, coupon_deduction, adjustment_amount, net_amount, payout_amount, payable_at, paid_at, vendor_note";

export async function loadSettlements(
  client: Reader,
  options: { vendorId?: string } = {},
): Promise<SettlementsPayload> {
  const basis = feeBasisOf(await readSetting("settlement.fee_basis"));
  // 부가세율도 설정이 갖는다(§7.4). 없으면 세금 자료를 만들지 않는다.
  const taxRateBp = Number((await readSetting("settlement.tax_rate_bp"))?.rateBp);
  const rate = Number.isInteger(taxRateBp) ? taxRateBp : null;

  let query = client
    .from("settlements")
    .select(SETTLEMENT_COLUMNS)
    .order("period_start", { ascending: false });

  if (options.vendorId) query = query.eq("vendor_id", options.vendorId);

  const { data: rows } = await query;
  const settlementRows = (rows ?? []) as Record<string, unknown>[];

  const ids = settlementRows.map((row) => row.id as string);

  const { data: itemRows } = ids.length
    ? await client
        .from("settlement_items")
        .select("settlement_id, booking_id, amount, fee_rate_bp, fee_amount, coupon_deduction, net_amount")
        .in("settlement_id", ids)
    : { data: [] };

  const { data: adjustmentRows } = await client
    .from("settlement_adjustments")
    .select("id, source_type, amount, reason, applied_settlement_id");

  const adjustments = (adjustmentRows ?? []) as {
    id: string;
    source_type: AdjustmentSource;
    amount: number;
    reason: string;
    applied_settlement_id: string | null;
  }[];

  const settlements = settlementRows.map((row) =>
    toView(row, (itemRows ?? []) as Record<string, unknown>[], rate, basis.ok),
  );

  return {
    settlements,
    pendingAdjustments: adjustments
      .filter((row) => row.applied_settlement_id === null)
      .map(toAdjustmentView),
    feeBasisResolved: basis.ok,
  };
}

function toView(
  row: Record<string, unknown>,
  itemRows: Record<string, unknown>[],
  taxRateBp: number | null,
  feeBasisResolved: boolean,
): SettlementView {
  const status = row.status as SettlementStatus;
  const blockedReason = (row.blocked_reason as BlockedReason | null) ?? null;
  const feeAmount = (row.fee_amount as number) ?? 0;

  return {
    id: row.id as string,
    periodStart: row.period_start as string,
    periodEnd: row.period_end as string,
    status,
    statusLabel: SETTLEMENT_STATUS_LABEL[status],
    blockedReason,
    blockedLabel: blockedReason === null ? null : BLOCKED_REASON_LABEL[blockedReason],
    blockedDetail: blockedReason === null ? null : BLOCKED_REASON_DETAIL[blockedReason],
    recalculable: needsRecalculation({ status, blockedReason, feeBasisResolved }),
    feeBasis: (row.fee_basis as "pre_discount" | "post_discount" | null) ?? null,
    feeBasisLabel:
      row.fee_basis === null || row.fee_basis === undefined
        ? null
        : FEE_BASIS_LABEL[row.fee_basis as "pre_discount" | "post_discount"],
    grossAmount: (row.gross_amount as number) ?? 0,
    feeAmount,
    feeRateBp: (row.fee_rate_bp as number) ?? 0,
    couponDeduction: (row.coupon_deduction as number) ?? 0,
    adjustmentAmount: (row.adjustment_amount as number) ?? 0,
    netAmount: (row.net_amount as number) ?? 0,
    payoutAmount: (row.payout_amount as number | null) ?? null,
    payableAt: (row.payable_at as string | null) ?? null,
    paidAt: (row.paid_at as string | null) ?? null,
    vendorNote: (row.vendor_note as string | null) ?? null,
    items: itemRows
      .filter((item) => item.settlement_id === row.id)
      .map((item) => ({
        bookingId: (item.booking_id as string | null) ?? null,
        amount: (item.amount as number) ?? 0,
        feeRateBp: (item.fee_rate_bp as number | null) ?? null,
        feeAmount: (item.fee_amount as number) ?? 0,
        couponDeduction: (item.coupon_deduction as number) ?? 0,
        netAmount: (item.net_amount as number) ?? 0,
      })),
    // 세금 자료는 **수수료**에 대한 것이다 — 거래 대금은 고객과 업체 사이의 것이고
    // 플랫폼이 제공한 용역의 대가는 중개 수수료뿐이다(D-24).
    tax: status === "blocked" ? null : taxSummary(feeAmount, taxRateBp),
  };
}

function toAdjustmentView(row: {
  id: string;
  source_type: AdjustmentSource;
  amount: number;
  reason: string;
  applied_settlement_id: string | null;
}): AdjustmentView {
  return {
    id: row.id,
    sourceType: row.source_type,
    sourceLabel: ADJUSTMENT_SOURCE_LABEL[row.source_type] ?? row.source_type,
    amount: row.amount,
    reason: row.reason,
    applied: row.applied_settlement_id !== null,
  };
}

/**
 * 세금계산서 **자료** CSV.
 *
 * **발행이 아니라 자료다**(F-V-09 "세금계산서 자료 다운로드"). 발행에는 국세청 연동
 * 또는 대행사 계약(D-28 과 같은 외부 계약)과 사업자 정보 평문이 필요한데, 후자는 우리가
 * 갖고 있지 않다(`vendors.biz_no_enc` 는 해시 · §7.2). 그 상태에서 발행을 흉내 내면
 * **세금계산서처럼 보이는 문서**가 생기고 회계에서 실제로 쓰이게 된다.
 */
export function toTaxCsv(settlements: readonly SettlementView[]): string {
  const header = [
    "정산기간시작",
    "정산기간종료",
    "상태",
    "수수료기준",
    "거래총액",
    "수수료(공급가액)",
    "부가세",
    "합계",
    "쿠폰차감",
    "상계",
    "지급액",
  ];

  const rows = settlements.map((row) =>
    [
      row.periodStart,
      row.periodEnd,
      row.statusLabel,
      row.feeBasisLabel ?? "-",
      row.grossAmount,
      row.tax?.supplyAmount ?? row.feeAmount,
      row.tax?.taxAmount ?? "-",
      row.tax?.totalAmount ?? "-",
      row.couponDeduction,
      row.adjustmentAmount,
      row.payoutAmount ?? "-",
    ].join(","),
  );

  // BOM 을 붙인다 — 없으면 Excel 이 UTF-8 을 깨서 연다(§4.1 인코딩 사고 방지와 같은 취지).
  return `﻿${[header.join(","), ...rows].join("\r\n")}\r\n`;
}
