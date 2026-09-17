import { createClient } from "@/lib/supabase/server";

/**
 * 운영자 거래 조회 (C-1 · F-A-05 계열 · §6.4 `/admin/transactions`)
 *
 * ══════════════════════════════════════════════════════════════════════════
 * **운영자는 거래 하나를 통으로 보는 화면이 없었다** (B-1 조사 3)
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 문의·견적·상담·계약을 보는 유일한 경로가 **대시보드의 집계 숫자**였다
 * (`lib/admin/metrics.ts` — inquiries · consultations · bookings · contracts).
 * 행 단위로 여는 화면이 없어 "이 거래가 지금 어디까지 왔나" 에 답할 수 없었다.
 *
 * ── 왜 정책이 아니라 definer 함수인가 (D-115 ↔ D-120) ──────────────────────
 * D-115 는 "행이 목적이면 정책" 이라 정했고 그 말은 맞다. 그런데 D-120 이 조건을
 * 하나 더 달았다 — **행을 보여 줘도 되는가.**
 *
 * 거래 사슬에는 운영자가 볼 이유가 없는 칸이 섞여 있다:
 *   `contracts.clauses_json` · `contracts.pdf_path` — 정본과 **Storage 경로**(§5.3 금지)
 *   `inquiries.note` · `quotes.vendor_memo` · `consultations.location`
 *
 * **정책으로 열면 표 전체가 열린다** — 정책은 행을 가르지 칸을 가르지 않는다.
 * 그래서 0074 의 definer 함수가 **투영해서** 내보내고, 위 칸들은 애초에 함수 밖으로
 * 나가지 않는다. 앱은 지울 것을 고르지 않는다 — **DB 가 안 준다.**
 *
 * ── 판정하지 않는다 (D-24) ─────────────────────────────────────────────────
 * 여기 있는 것은 전부 **시각과 상태**다. "지연" · "문제 있음" 같은 평가 어휘를 만들지
 * 않는다 — 플랫폼은 판정자가 아니라 조율자이고, 화면이 판정어를 쓰면 그 자체가 입장이 된다.
 */

export type AdminTransactionRow = {
  bookingId: string;
  bookingStatus: string;
  vendorId: string;
  vendorName: string;
  coupleId: string;
  totalAmount: number;
  createdAt: string;
  acceptedAt: string | null;
  declinedAt: string | null;
  quoteId: string | null;
  contractId: string | null;
  contractStatus: string | null;
  paidCount: number;
  scheduleCount: number;
  settled: boolean;
};

export type AdminChainStep = {
  stage: string;
  occurredAt: string;
  detail: string | null;
};

/** 사슬 단계 이름. **어휘를 화면이 지어내지 않는다** — 함수가 주는 코드에 라벨만 붙인다. */
export const CHAIN_STAGE_LABEL: Record<string, string> = {
  inquiry_sent: "문의 발송",
  quote_sent: "견적 발송",
  quote_decided: "견적 응답",
  booking_created: "예약 신청",
  booking_accepted: "업체 승인",
  booking_declined: "업체 거절",
  contract_issued: "계약서 발행",
  contract_activated: "계약 확정",
  contract_cancelled: "계약 해지",
  payment_paid: "결제 완료",
  settled: "정산 반영",
};

export async function loadAdminTransactions(limit = 100): Promise<AdminTransactionRow[]> {
  const supabase = await createClient();

  const { data, error } = await supabase.rpc("admin_transaction_rows", { p_limit: limit });

  // **권한 없음을 오류로 알리지 않는다.** 함수가 0건을 돌려주며, 그 편이 "운영자만
  // 볼 수 있는 무언가가 있다" 는 사실 자체를 흘리지 않는다.
  if (error) throw new Error("ADMIN_TRANSACTIONS_LOAD_FAILED");

  return ((data ?? []) as {
    booking_id: string;
    booking_status: string;
    vendor_id: string;
    vendor_name: string;
    couple_id: string;
    total_amount: number;
    created_at: string;
    accepted_at: string | null;
    declined_at: string | null;
    quote_id: string | null;
    contract_id: string | null;
    contract_status: string | null;
    paid_count: number;
    schedule_count: number;
    settled: boolean;
  }[]).map((row) => ({
    bookingId: row.booking_id,
    bookingStatus: row.booking_status,
    vendorId: row.vendor_id,
    vendorName: row.vendor_name,
    coupleId: row.couple_id,
    totalAmount: row.total_amount,
    createdAt: row.created_at,
    acceptedAt: row.accepted_at,
    declinedAt: row.declined_at,
    quoteId: row.quote_id,
    contractId: row.contract_id,
    contractStatus: row.contract_status,
    paidCount: row.paid_count,
    scheduleCount: row.schedule_count,
    settled: row.settled,
  }));
}

export async function loadAdminChain(bookingId: string): Promise<AdminChainStep[]> {
  const supabase = await createClient();

  const { data, error } = await supabase.rpc("admin_transaction_chain", {
    p_booking_id: bookingId,
  });

  if (error) throw new Error("ADMIN_CHAIN_LOAD_FAILED");

  return ((data ?? []) as {
    stage: string;
    occurred_at: string;
    detail: string | null;
  }[]).map((row) => ({
    stage: row.stage,
    occurredAt: row.occurred_at,
    detail: row.detail,
  }));
}

/**
 * 진행 한 줄.
 *
 * **회차가 없는 것과 완납을 같은 말로 적지 않는다**(`settledLabelOf` 와 같은 규칙).
 * 그리고 **측정하지 않은 것을 0으로 적지 않는다** — 계약 전 예약의 회차는 0건이
 * 아니라 **아직 없다.**
 */
export function progressLabel(row: AdminTransactionRow): string {
  if (row.settled) return "정산 반영됨";
  if (row.scheduleCount === 0) {
    return row.contractId === null ? "계약 발행 전" : "회차 편성 전";
  }

  return `${row.scheduleCount}회차 중 ${row.paidCount}회차 입금`;
}
