import { readSetting } from "@/lib/app-settings";
import type { BookingStatus } from "@/lib/core/booking/console";
import { createClient } from "@/lib/supabase/server";

/**
 * 거래 사슬 — **세 면이 같은 사실을 읽는 한 자리** (C-1)
 *
 * ══════════════════════════════════════════════════════════════════════════
 * **왜 한 자리인가**
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 소비자·업체·운영자가 같은 거래를 본다. 조회를 면마다 따로 쓰면 **같은 예약이
 * 화면마다 다른 상태로 보이는 날**이 온다 — 한쪽은 계약을 '취소됨' 으로, 다른 쪽은
 * '진행 중' 으로 그리고, 그때 어느 쪽이 맞는지 답할 수 없다.
 *
 * 그래서 **사실을 모으는 일**은 여기 하나이고, **무엇을 보여줄지**는 면마다 다르다.
 * 이 함수는 판단하지 않는다 — 판단은 `lib/core/booking/console.ts`(순수)가 하고
 * 각 면의 로더가 그 결과를 자기 모양으로 접는다.
 *
 * ── 운영자는 왜 이 길을 안 쓰는가 ──────────────────────────────────────────
 * 여기는 **세션 클라이언트**로 읽는다. `bookings_select` 가 커플·업체·위임 플래너를
 * 가르고 **운영자는 그 셋에 없다**. 운영자에게 정책을 열면 `contracts.clauses_json`·
 * `pdf_path` 같은 칸까지 함께 열리므로(정책은 행을 가르지 칸을 가르지 않는다)
 * 운영자는 **definer 함수가 투영한 것만** 본다(0074 · D-120).
 *
 * ── 임베드를 쓰지 않는다 (함정 1) ──────────────────────────────────────────
 * PostgREST 임베드로 한 번에 끌면 공개 조건이 붙은 표의 행이 **조용히 빠져**
 * 계약이 있는 예약이 "계약 없음" 으로 그려진다. 표마다 따로 묻고 코드가 맞춘다.
 */

export type ChainContract = {
  id: string;
  status: string;
  issuedAt: string | null;
  activatedAt: string | null;
  cancelledAt: string | null;
};

export type ChainSchedule = {
  id: string;
  seq: number;
  amount: number;
  status: string;
  dueAt: string | null;
};

export type ChainFacts = {
  booking: {
    id: string;
    status: BookingStatus;
    coupleId: string;
    vendorId: string;
    productId: string | null;
    quoteId: string | null;
    totalAmount: number;
    depositAmount: number;
    createdAt: string;
    acceptedAt: string | null;
    declinedAt: string | null;
    declineReason: string | null;
  };
  /** 살아 있는 계약 하나. 취소된 것밖에 없으면 그중 가장 최근. */
  liveContract: ChainContract | null;
  /** 취소분 포함 전부. **낸 돈은 취소돼도 사실이다.** */
  contracts: ChainContract[];
  schedules: ChainSchedule[];
  /** 결제 완료 시각. 타임라인이 그대로 쓴다. */
  paidAts: string[];
  hasEscrowHold: boolean;
  hasReview: boolean;
  /** `escrow.enabled` — **O-03 대기**. 값이 없으면 꺼짐이다. */
  escrowEnabled: boolean;
};

const BOOKING_COLUMNS =
  "id, status, couple_id, vendor_id, product_id, quote_id, total_amount, deposit_amount, created_at, accepted_at, declined_at, decline_reason";

/**
 * 거래 하나의 사실을 모은다.
 *
 * **RLS 가 안 보여주면 null 이다** — 남의 예약의 존재 여부를 알려주지 않는다.
 * 세 면 중 어느 면이 부르든 경계는 같다.
 */
export async function loadChainFacts(bookingId: string): Promise<ChainFacts | null> {
  const supabase = await createClient();

  const { data: bookingRow } = await supabase
    .from("bookings")
    .select(BOOKING_COLUMNS)
    .eq("id", bookingId)
    .maybeSingle();

  const booking = bookingRow as {
    id: string;
    status: BookingStatus;
    couple_id: string;
    vendor_id: string;
    product_id: string | null;
    quote_id: string | null;
    total_amount: number;
    deposit_amount: number;
    created_at: string;
    accepted_at: string | null;
    declined_at: string | null;
    decline_reason: string | null;
  } | null;

  if (!booking) return null;

  const [contractResult, paymentResult, escrowResult, reviewResult] = await Promise.all([
    supabase
      .from("contracts")
      .select("id, status, issued_at, activated_at, cancelled_at")
      .eq("booking_id", bookingId)
      .order("created_at", { ascending: false }),
    supabase
      .from("payments")
      .select("paid_at, status")
      .eq("booking_id", bookingId)
      .order("paid_at", { ascending: true }),
    supabase.from("escrow_holds").select("id").eq("booking_id", bookingId).limit(1),
    supabase.from("reviews").select("id").eq("booking_id", bookingId).limit(1),
  ]);

  const contracts = ((contractResult.data ?? []) as {
    id: string;
    status: string;
    issued_at: string | null;
    activated_at: string | null;
    cancelled_at: string | null;
  }[]).map(
    (row): ChainContract => ({
      id: row.id,
      status: row.status,
      issuedAt: row.issued_at,
      activatedAt: row.activated_at,
      cancelledAt: row.cancelled_at,
    }),
  );

  const liveContract = contracts.find((row) => row.status !== "cancelled") ?? contracts[0] ?? null;

  // **회차는 예약이 아니라 계약에 달린다**(`payment_schedules.contract_id`).
  // **취소된 계약의 회차도 포함한다** — 낸 돈은 그대로 사실이다.
  const contractIds = contracts.map((row) => row.id);
  const schedules =
    contractIds.length === 0
      ? []
      : (((
          await supabase
            .from("payment_schedules")
            .select("id, seq, amount, status, due_at")
            .in("contract_id", contractIds)
            .order("seq", { ascending: true })
        ).data ?? []) as {
          id: string;
          seq: number;
          amount: number;
          status: string;
          due_at: string | null;
        }[]).map(
          (row): ChainSchedule => ({
            id: row.id,
            seq: row.seq,
            amount: row.amount,
            status: row.status,
            dueAt: row.due_at,
          }),
        );

  const paidAts = ((paymentResult.data ?? []) as { paid_at: string | null; status: string }[])
    .filter((row) => row.status === "paid" && row.paid_at !== null)
    .map((row) => row.paid_at as string);

  return {
    booking: {
      id: booking.id,
      status: booking.status,
      coupleId: booking.couple_id,
      vendorId: booking.vendor_id,
      productId: booking.product_id,
      quoteId: booking.quote_id,
      totalAmount: booking.total_amount,
      depositAmount: booking.deposit_amount,
      createdAt: booking.created_at,
      acceptedAt: booking.accepted_at,
      declinedAt: booking.declined_at,
      declineReason: booking.decline_reason,
    },
    liveContract,
    contracts,
    schedules,
    paidAts,
    hasEscrowHold: ((escrowResult.data ?? []) as { id: string }[]).length > 0,
    hasReview: ((reviewResult.data ?? []) as { id: string }[]).length > 0,
    escrowEnabled: await readEscrowEnabled(),
  };
}

/**
 * `escrow.enabled` — **O-03 대기**.
 *
 * 값이 없으면 **켜진 것으로도 꺼진 것으로도 읽지 않고 꺼짐으로 둔다**: 안전거래는
 * 돈을 붙잡는 기능이라 "모르겠으면 열어 둔다" 가 성립하지 않는다. 화면은 그것을
 * "아직 열려 있지 않다(법무 검토 중)" 로 적으며, 그것은 '이 예약에 잔금이 없다' 와
 * **다른 문장**이다(함정 2).
 */
async function readEscrowEnabled(): Promise<boolean> {
  return (await readSetting("escrow.enabled"))?.enabled === true;
}
