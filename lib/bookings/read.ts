import {
  type BookingStatus,
  type Entry,
  type TimelineStep,
  bookingTimeline,
  decisionOf,
  entryPoints,
} from "@/lib/core/booking/console";
import { type ScheduleView, viewSchedules } from "@/lib/core/payment/checkout";
import { REVIEW_BLOCK_MESSAGE } from "@/lib/core/review/write";
import { loadChainFacts } from "@/lib/bookings/chain";
import { createClient } from "@/lib/supabase/server";

/**
 * 소비자 예약 목록·상세 (S5-10 · §6.2 `/bookings` · `/bookings/[id]`)
 *
 * **세션 클라이언트로 읽는다.** `bookings_select` 정책이 커플 구성원·업체 멤버·위임
 * 플래너를 가른다(D-115 — 행이 목적이면 정책). 서비스롤로 읽으면 그 경계를 우회해
 * "화면에서만 감추는" 상태가 되고, 인가의 최종 경계는 RLS 다.
 *
 * **임베드를 쓰지 않는다**(함정 1). PostgREST 로 `bookings` 에서 `vendors`·`contracts`
 * 를 한 번에 끌면 공개 조건이 붙은 표의 행이 **조용히 빠져** 계약이 있는 예약이
 * "계약 없음" 으로 그려진다. 표마다 따로 묻고 코드가 맞춘다.
 */

export type BookingListRow = {
  id: string;
  status: BookingStatus;
  vendorId: string;
  vendorName: string;
  totalAmount: number;
  createdAt: string;
  acceptedAt: string | null;
  declinedAt: string | null;
  declineReason: string | null;
};

export async function loadBookings(): Promise<BookingListRow[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("bookings")
    .select(
      "id, status, vendor_id, total_amount, created_at, accepted_at, declined_at, decline_reason",
    )
    .order("created_at", { ascending: false })
    .limit(200);

  if (error) throw new Error("BOOKING_LOAD_FAILED");

  const rows = (data ?? []) as {
    id: string;
    status: BookingStatus;
    vendor_id: string;
    total_amount: number;
    created_at: string;
    accepted_at: string | null;
    declined_at: string | null;
    decline_reason: string | null;
  }[];

  const names = await vendorNames(rows.map((row) => row.vendor_id));

  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    vendorId: row.vendor_id,
    // **"등록 업체" 로 접지 않는다** — 이름을 못 읽은 것이지 이름이 없는 것이 아니다.
    vendorName: names.get(row.vendor_id) ?? "이름을 불러오지 못했습니다",
    totalAmount: row.total_amount,
    createdAt: row.created_at,
    acceptedAt: row.accepted_at,
    declinedAt: row.declined_at,
    declineReason: row.decline_reason,
  }));
}

export type BookingDetail = {
  booking: BookingListRow;
  decision: ReturnType<typeof decisionOf>;
  timeline: TimelineStep[];
  entries: Entry[];
  schedules: ScheduleView[];
  contractId: string | null;
  contractStatus: string | null;
  /** 안전거래 파라미터. **미결이면 코드가 대신 답하지 않는다**(O-03). */
  escrowEnabled: boolean;
};

export async function loadBookingDetail(
  bookingId: string,
  now: Date,
): Promise<BookingDetail | null> {
  // **사실은 한 자리에서 모은다**(C-1 · `lib/bookings/chain.ts`). 세 면이 같은 거래를
  // 보므로 조회를 면마다 따로 쓰면 같은 예약이 화면마다 다른 상태로 보이는 날이 온다.
  // 여기서 하는 일은 **소비자 관점으로 접는 것**뿐이다.
  const facts = await loadChainFacts(bookingId);

  // **RLS 가 안 보여주면 없는 것과 같게 답한다** — 남의 예약의 존재 여부를 알려주지
  // 않는다(`loadReviewFormContext` 와 같은 규칙).
  if (!facts) return null;

  const { booking, liveContract: live } = facts;
  const nameMap = await vendorNames([booking.vendorId]);

  const schedules = viewSchedules({
    schedules: facts.schedules.map((schedule) => ({
      id: schedule.id,
      seq: schedule.seq,
      amount: schedule.amount,
      status: schedule.status as ScheduleView["status"],
      dueAt: schedule.dueAt,
    })),
    contractActive: live?.status === "active",
    now,
  });

  const reviewable =
    !facts.hasReview && (booking.status === "confirmed" || booking.status === "fulfilled");

  const row: BookingListRow = {
    id: booking.id,
    status: booking.status,
    vendorId: booking.vendorId,
    vendorName: nameMap.get(booking.vendorId) ?? "이름을 불러오지 못했습니다",
    totalAmount: booking.totalAmount,
    createdAt: booking.createdAt,
    acceptedAt: booking.acceptedAt,
    declinedAt: booking.declinedAt,
    declineReason: booking.declineReason,
  };

  return {
    booking: row,
    decision: decisionOf(row),
    timeline: bookingTimeline({
      createdAt: booking.createdAt,
      acceptedAt: booking.acceptedAt,
      declinedAt: booking.declinedAt,
      declineReason: booking.declineReason,
      contractIssuedAt: live?.issuedAt ?? null,
      contractActivatedAt: live?.activatedAt ?? null,
      paidAts: facts.paidAts,
      // 해지 시각은 계약이 갖는다 — 예약 표에는 취소 시각 칸이 없고, **없는 칸을
      // 만들지 않는다**(계약이 이미 그 사실을 적고 있다).
      cancelledAt: live?.cancelledAt ?? null,
      fulfilledAt: null,
    }),
    entries: entryPoints({
      bookingId: booking.id,
      status: booking.status,
      acceptedAt: booking.acceptedAt,
      declinedAt: booking.declinedAt,
      contractId: live?.id ?? null,
      contractActive: live?.status === "active",
      hasPayableSchedule: schedules.some((schedule) => schedule.payable),
      escrowEnabled: facts.escrowEnabled,
      hasEscrowHold: facts.hasEscrowHold,
      reviewable,
      reviewBlockedReason: facts.hasReview
        ? REVIEW_BLOCK_MESSAGE.already_written
        : REVIEW_BLOCK_MESSAGE.booking_not_reviewable,
    }),
    schedules,
    contractId: live?.id ?? null,
    contractStatus: live?.status ?? null,
    escrowEnabled: facts.escrowEnabled,
  };
}

/** 업체 이름은 **공개 데이터**라 세션으로 읽힌다. 임베드 대신 따로 묻는다(함정 1). */
async function vendorNames(
  ids: readonly string[],
): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();

  const supabase = await createClient();
  const { data } = await supabase
    .from("vendors")
    .select("id, name")
    .in("id", unique);

  return new Map(
    ((data ?? []) as { id: string; name: string }[]).map((row) => [
      row.id,
      row.name,
    ]),
  );
}

