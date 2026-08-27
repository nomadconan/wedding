import {
  HANDLED_AT,
  type DisputeSource,
  type QueueItem,
  type QueueSummary,
  isOpenFor,
  queueSummary,
  sortDisputeQueue,
} from "@/lib/core/dispute/queue";
import { createClient } from "@/lib/supabase/server";

/**
 * 분쟁 조율 큐 로더 (S8-03 · F-A-12 · F-A-16)
 *
 * **네 표를 각각 읽어 한 목록으로 세운다.** 뷰를 만들지 않았다 —
 * 네 표의 소유자 조건이 서로 다르고(예약 소속 / 상담 소속 / 계약 소속 / 결제 소속)
 * 그것을 하나의 뷰에 담으면 **소유자 필터가 넷 중 가장 느슨한 것으로 수렴한다.**
 * 표별로 읽으면 각 표의 RLS 정책이 그대로 자기 몫을 한다(D-120).
 *
 * **세션 클라이언트로 읽는다.** 네 표 모두 운영자 SELECT 정책이 있고(0055 가 둘을 더했다)
 * 여기서 필요한 것은 **행**이다 — 목적이 행이면 경계는 RLS 다(D-115).
 *
 * ── 임베드를 쓰지 않는다 (함정 1) ──────────────────────────────────────────
 * `escrow_holds` 의 예약 id 는 `booking_id` 컬럼에 있지만, 없는 행은 `payment_id` 를
 * 거쳐야 한다. PostgREST 임베드로 `payments(booking_id)` 를 붙이면 **`payments` 정책이
 * 운영자를 모를 때 값이 조용히 사라진다.** 지금은 붙이지 않고 컬럼에 있는 것만 쓴다 —
 * 없으면 `null` 이고 화면이 "예약 정보 없음" 이라고 적는다(빈칸으로 두지 않는다).
 */
export type DisputePayload = {
  items: QueueItem[];
  summary: QueueSummary[];
  /** 읽지 못한 출처. **빈 목록과 구분한다** — 조회 실패를 '분쟁 없음' 으로 그리면 안 된다. */
  failedSources: DisputeSource[];
};

type Client = Awaited<ReturnType<typeof createClient>>;

async function loadBookingDisputes(supabase: Client): Promise<QueueItem[] | null> {
  const { data, error } = await supabase
    .from("disputes")
    .select("id, booking_id, reason_code, status, created_at")
    .order("created_at", { ascending: true })
    .limit(200);

  if (error) return null;

  return ((data ?? []) as {
    id: string; booking_id: string; reason_code: string; status: string; created_at: string;
  }[]).map((row) => ({
    source: "booking" as const,
    id: row.id,
    status: row.status,
    openedAt: row.created_at,
    // 예약 분쟁 자체에는 금액이 없다. **0 으로 적지 않는다** — 0원은 "걸린 돈이 없다"
    // 는 뜻이고, 여기서는 "이 표가 금액을 갖고 있지 않다" 가 사실이다.
    amountKrw: null,
    reasonCode: row.reason_code,
    bookingId: row.booking_id,
    isOpen: isOpenFor("booking", row.status),
    handledAt: HANDLED_AT.booking,
  }));
}

async function loadDepositDisputes(supabase: Client): Promise<QueueItem[] | null> {
  const { data, error } = await supabase
    .from("consultation_deposits")
    .select("id, consultation_id, amount, status, held_at, created_at")
    .eq("status", "disputed")
    .limit(200);

  if (error) return null;

  return ((data ?? []) as {
    id: string; consultation_id: string; amount: number; status: string;
    held_at: string | null; created_at: string;
  }[]).map((row) => ({
    source: "consultation" as const,
    id: row.id,
    status: row.status,
    openedAt: row.held_at ?? row.created_at,
    amountKrw: row.amount,
    reasonCode: "no_show",
    // 상담 분쟁은 예약이 아니라 상담에 매달린다. 타임라인은 상담 id 로 연다.
    bookingId: null,
    isOpen: isOpenFor("consultation", row.status),
    handledAt: HANDLED_AT.consultation,
  }));
}

async function loadCancellationDisputes(supabase: Client): Promise<QueueItem[] | null> {
  const { data, error } = await supabase
    .from("contract_cancellations")
    .select("id, booking_id, reason_code, status, disputed_at, created_at, penalty_applied")
    .eq("status", "disputed")
    .limit(200);

  if (error) return null;

  return ((data ?? []) as {
    id: string; booking_id: string; reason_code: string; status: string;
    disputed_at: string | null; created_at: string; penalty_applied: number | null;
  }[]).map((row) => ({
    source: "cancellation" as const,
    id: row.id,
    status: row.status,
    openedAt: row.disputed_at ?? row.created_at,
    // 산정된 위약금. **여기서 다시 계산하지 않는다** — `lib/core/pricing/penalty.ts` 가
    // 계약 시점 규칙으로 이미 산정해 행에 박아 두었고(S5-08), 큐가 다시 세면 두 값이 갈린다.
    amountKrw: row.penalty_applied,
    reasonCode: row.reason_code,
    bookingId: row.booking_id,
    isOpen: isOpenFor("cancellation", row.status),
    handledAt: HANDLED_AT.cancellation,
  }));
}

async function loadEscrowDisputes(supabase: Client): Promise<QueueItem[] | null> {
  const { data, error } = await supabase
    .from("escrow_holds")
    .select("id, booking_id, held_amount, status, disputed_at, created_at")
    .eq("status", "disputed")
    .limit(200);

  if (error) return null;

  return ((data ?? []) as {
    id: string; booking_id: string | null; held_amount: number; status: string;
    disputed_at: string | null; created_at: string;
  }[]).map((row) => ({
    source: "escrow" as const,
    id: row.id,
    status: row.status,
    openedAt: row.disputed_at ?? row.created_at,
    amountKrw: row.held_amount,
    reasonCode: "refund",
    bookingId: row.booking_id,
    isOpen: isOpenFor("escrow", row.status),
    handledAt: HANDLED_AT.escrow,
  }));
}

export async function loadDisputeQueue(): Promise<DisputePayload> {
  const supabase = await createClient();

  const [booking, deposit, cancellation, escrow] = await Promise.all([
    loadBookingDisputes(supabase),
    loadDepositDisputes(supabase),
    loadCancellationDisputes(supabase),
    loadEscrowDisputes(supabase),
  ]);

  const sources: [DisputeSource, QueueItem[] | null][] = [
    ["booking", booking],
    ["consultation", deposit],
    ["cancellation", cancellation],
    ["escrow", escrow],
  ];

  const items: QueueItem[] = [];
  const failedSources: DisputeSource[] = [];

  for (const [source, rows] of sources) {
    // **읽지 못한 것과 없는 것을 가른다.** 실패를 빈 배열로 접으면 화면이
    // "이 종류는 분쟁이 없다" 로 그리고, 그것이 FIX-15 가 몇 달 안 잡힌 방식이다.
    if (rows === null) failedSources.push(source);
    else items.push(...rows);
  }

  const sorted = sortDisputeQueue(items);

  return { items: sorted, summary: queueSummary(sorted), failedSources };
}

/** 한 건만. 조율 화면이 상세를 그릴 때 쓴다. */
export async function loadBookingDispute(id: string): Promise<{
  id: string;
  bookingId: string;
  reasonCode: string;
  status: string;
  createdAt: string;
  proposalNote: string | null;
  resolutionNote: string | null;
  coupleAgreed: boolean;
  vendorAgreed: boolean;
  evidenceCount: number;
} | null> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("disputes")
    .select(
      "id, booking_id, reason_code, status, created_at, proposal_note, resolution_note, couple_agreed, vendor_agreed, evidence_paths",
    )
    .eq("id", id)
    .maybeSingle();

  if (error || !data) return null;

  const row = data as {
    id: string; booking_id: string; reason_code: string; status: string; created_at: string;
    proposal_note: string | null; resolution_note: string | null;
    couple_agreed: boolean; vendor_agreed: boolean; evidence_paths: string[] | null;
  };

  return {
    id: row.id,
    bookingId: row.booking_id,
    reasonCode: row.reason_code,
    status: row.status,
    createdAt: row.created_at,
    proposalNote: row.proposal_note,
    resolutionNote: row.resolution_note,
    coupleAgreed: row.couple_agreed,
    vendorAgreed: row.vendor_agreed,
    // **증빙 경로를 내보내지 않는다**(§5.3). 몇 건인지만 낸다 — 열람은 서명 URL 경로로
    // 따로 열어야 하고 그 자리는 아직 없다.
    evidenceCount: row.evidence_paths?.length ?? 0,
  };
}
