import {
  CANCELLATION_STATUS_LABEL,
  CANCEL_REASON_LABEL,
  CANCEL_STAGE_LABEL,
  FAULT_LABEL,
  cancelStage,
  type CancelStage,
  type CancellationStatus,
  type FaultParty,
} from "@/lib/core/cancellation/cancellation";

import { loadCancellationContext, quoteCancellation, type CancellationQuote } from "./actions";

/**
 * 해지 화면·API 가 함께 쓰는 조회 (S5-08)
 *
 * **화면과 API 가 같은 함수를 쓴다.** 산정 규칙을 두 벌 만들면 언젠가 화면의 예상액과
 * API 의 확정액이 갈리고, 그 차이가 그대로 분쟁이 된다.
 *
 * **읽기 대상 확인은 RLS 가 한다.** 호출자가 세션 클라이언트로 계약을 먼저 읽어
 * 당사자임을 확인한 뒤 이 함수를 부른다 — 산정 자체는 서비스롤이 필요하다(결제·정산
 * 이력을 봐야 하고 그 표들은 owner·업체 멤버에게만 열려 있다).
 */
type Reader = Awaited<ReturnType<typeof import("@/lib/supabase/server").createClient>>;

export type CancellationRow = {
  id: string;
  status: CancellationStatus;
  statusLabel: string;
  requesterSide: "couple" | "vendor";
  reasonCode: string;
  reasonLabel: string;
  reasonNote: string | null;
  fault: FaultParty;
  faultLabel: string;
  coupleClaim: FaultParty | null;
  vendorClaim: FaultParty | null;
  coupleAgreed: boolean | null;
  vendorAgreed: boolean | null;
  confirmDueAt: string | null;
  bandLabel: string | null;
  basisRef: string | null;
  isDraftRules: boolean;
  paidAmount: number | null;
  penaltyApplied: number | null;
  refundAmount: number | null;
  balanceDue: number | null;
  resolutionNote: string | null;
  settledAt: string | null;
};

export type CancellationView = {
  bookingId: string;
  contractId: string;
  contractStatus: string;
  stage: CancelStage;
  stageLabel: string;
  quote: CancellationQuote | null;
  cancellation: CancellationRow | null;
};

/** 소비자·업체 화면이 함께 쓰는 조회. 진행 중인 절차가 있으면 그것을 함께 준다. */
export async function loadCancellationView(
  client: Reader,
  bookingId: string,
  now: Date = new Date(),
): Promise<CancellationView | null> {
  // 이 예약의 계약이 내게 보이는가 — **RLS 에게 묻는다**(0029 정책).
  const { data: contractRow } = await client
    .from("contracts")
    .select("id, status")
    .eq("booking_id", bookingId)
    .neq("status", "cancelled")
    .maybeSingle();

  const contract = contractRow as { id: string; status: string } | null;
  if (!contract) return null;

  const { data: rows } = await client
    .from("contract_cancellations")
    .select(
      "id, status, requester_side, reason_code, reason_note, fault, couple_claim, vendor_claim, couple_agreed, vendor_agreed, confirm_due_at, band_label, basis_ref, is_draft_rules, paid_amount, penalty_applied, refund_amount, balance_due, resolution_note, settled_at",
    )
    .eq("contract_id", contract.id)
    .neq("status", "withdrawn")
    .maybeSingle();

  const row = rows as Record<string, unknown> | null;
  const context = await loadCancellationContext(bookingId);

  // 산정은 **귀책 미정 기준의 예상값**이다. 확정은 확인·조율을 거친다.
  const quote =
    context === null ? null : await quoteCancellation({ context, fault: "undecided", now });

  const stage =
    context === null
      ? "before_payment"
      : cancelStage({
          paidAmount: context.paidAmount,
          totalAmount: context.totalAmount,
          eventDate: context.eventDate,
          cancelDate: now.toISOString().slice(0, 10),
        });

  return {
    bookingId,
    contractId: contract.id,
    contractStatus: contract.status,
    stage,
    stageLabel: CANCEL_STAGE_LABEL[stage],
    quote,
    cancellation: row === null ? null : toRow(row),
  };
}

function toRow(row: Record<string, unknown>): CancellationRow {
  const status = row.status as CancellationStatus;
  const fault = row.fault as FaultParty;
  const reasonCode = row.reason_code as string;

  return {
    id: row.id as string,
    status,
    statusLabel: CANCELLATION_STATUS_LABEL[status],
    requesterSide: row.requester_side as "couple" | "vendor",
    reasonCode,
    reasonLabel:
      CANCEL_REASON_LABEL[reasonCode as keyof typeof CANCEL_REASON_LABEL] ?? reasonCode,
    reasonNote: (row.reason_note as string | null) ?? null,
    fault,
    faultLabel: FAULT_LABEL[fault],
    coupleClaim: (row.couple_claim as FaultParty | null) ?? null,
    vendorClaim: (row.vendor_claim as FaultParty | null) ?? null,
    coupleAgreed: (row.couple_agreed as boolean | null) ?? null,
    vendorAgreed: (row.vendor_agreed as boolean | null) ?? null,
    confirmDueAt: (row.confirm_due_at as string | null) ?? null,
    bandLabel: (row.band_label as string | null) ?? null,
    basisRef: (row.basis_ref as string | null) ?? null,
    isDraftRules: (row.is_draft_rules as boolean | null) ?? true,
    paidAmount: (row.paid_amount as number | null) ?? null,
    penaltyApplied: (row.penalty_applied as number | null) ?? null,
    refundAmount: (row.refund_amount as number | null) ?? null,
    balanceDue: (row.balance_due as number | null) ?? null,
    resolutionNote: (row.resolution_note as string | null) ?? null,
    settledAt: (row.settled_at as string | null) ?? null,
  };
}

const ROW_COLUMNS =
  "id, booking_id, status, requester_side, reason_code, reason_note, fault, couple_claim, vendor_claim, couple_agreed, vendor_agreed, confirm_due_at, band_label, basis_ref, is_draft_rules, paid_amount, penalty_applied, refund_amount, balance_due, resolution_note, settled_at";

/**
 * 업체가 응대할 해지 목록.
 *
 * **RLS 가 업체를 가른다** — 정책이 `is_vendor_member` 로 쓰여 있어 남의 업체 건은
 * 조회 자체가 비어 온다. 여기서 vendor_id 로 다시 거르지 않는다(§5.5).
 */
export async function loadVendorCancellations(
  client: Reader,
): Promise<(CancellationRow & { bookingId: string })[]> {
  const { data } = await client
    .from("contract_cancellations")
    .select(ROW_COLUMNS)
    .neq("status", "withdrawn")
    .order("created_at", { ascending: false });

  return ((data ?? []) as Record<string, unknown>[]).map((row) => ({
    ...toRow(row),
    bookingId: row.booking_id as string,
  }));
}

/** 운영자 조율 큐(F-A-16·F-A-17). S4-07 이 상담에서 쓴 것과 같은 모양이다. */
export async function loadDisputeQueue(client: Reader): Promise<CancellationRow[]> {
  const { data } = await client
    .from("contract_cancellations")
    .select(
      "id, status, requester_side, reason_code, reason_note, fault, couple_claim, vendor_claim, couple_agreed, vendor_agreed, confirm_due_at, band_label, basis_ref, is_draft_rules, paid_amount, penalty_applied, refund_amount, balance_due, resolution_note, settled_at",
    )
    .eq("status", "disputed")
    .order("disputed_at", { ascending: true });

  return ((data ?? []) as Record<string, unknown>[]).map(toRow);
}
