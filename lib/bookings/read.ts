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
import { readSetting } from "@/lib/app-settings";
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
  const supabase = await createClient();

  const { data: bookingRow } = await supabase
    .from("bookings")
    .select(
      "id, status, vendor_id, couple_id, total_amount, created_at, updated_at, accepted_at, declined_at, decline_reason",
    )
    .eq("id", bookingId)
    .maybeSingle();

  const booking = bookingRow as {
    id: string;
    status: BookingStatus;
    vendor_id: string;
    couple_id: string;
    total_amount: number;
    created_at: string;
    updated_at: string | null;
    accepted_at: string | null;
    declined_at: string | null;
    decline_reason: string | null;
  } | null;

  // **RLS 가 안 보여주면 없는 것과 같게 답한다** — 남의 예약의 존재 여부를 알려주지
  // 않는다(`loadReviewFormContext` 와 같은 규칙).
  if (!booking) return null;

  const [contractResult, paymentResult, escrowResult, reviewResult, nameMap] =
    await Promise.all([
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
      supabase
        .from("escrow_holds")
        .select("id")
        .eq("booking_id", bookingId)
        .limit(1),
      supabase
        .from("reviews")
        .select("id")
        .eq("booking_id", bookingId)
        .limit(1),
      vendorNames([booking.vendor_id]),
    ]);

  const contracts = (contractResult.data ?? []) as {
    id: string;
    status: string;
    issued_at: string | null;
    activated_at: string | null;
    cancelled_at: string | null;
  }[];
  const live =
    contracts.find((row) => row.status !== "cancelled") ?? contracts[0] ?? null;

  // **회차는 예약이 아니라 계약에 달린다**(`payment_schedules.contract_id`). 임베드로 한 번에
  // 끌면 공개 조건이 붙은 표에서 행이 조용히 빠진다(함정 1) — 이미 읽은 계약
  // id 로 따로 묻는다. **취소된 계약의 회차도 포함한다** — 낸 돈은 그대로 사실이다.
  const contractIds = contracts.map((row) => row.id);
  const scheduleRows =
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
        }[]);

  const schedules = viewSchedules({
    schedules: scheduleRows.map((row) => ({
      id: row.id,
      seq: row.seq,
      amount: row.amount,
      status: row.status as ScheduleView["status"],
      dueAt: row.due_at,
    })),
    contractActive: live?.status === "active",
    now,
  });

  const paidAts = (
    (paymentResult.data ?? []) as { paid_at: string | null; status: string }[]
  )
    .filter((row) => row.status === "paid" && row.paid_at !== null)
    .map((row) => row.paid_at as string);

  const escrowEnabled = await readEscrowEnabled();
  const alreadyReviewed =
    ((reviewResult.data ?? []) as { id: string }[]).length > 0;
  const reviewable =
    !alreadyReviewed &&
    (booking.status === "confirmed" || booking.status === "fulfilled");

  const row: BookingListRow = {
    id: booking.id,
    status: booking.status,
    vendorId: booking.vendor_id,
    vendorName: nameMap.get(booking.vendor_id) ?? "이름을 불러오지 못했습니다",
    totalAmount: booking.total_amount,
    createdAt: booking.created_at,
    acceptedAt: booking.accepted_at,
    declinedAt: booking.declined_at,
    declineReason: booking.decline_reason,
  };

  return {
    booking: row,
    decision: decisionOf(row),
    timeline: bookingTimeline({
      createdAt: booking.created_at,
      acceptedAt: booking.accepted_at,
      declinedAt: booking.declined_at,
      declineReason: booking.decline_reason,
      contractIssuedAt: live?.issued_at ?? null,
      contractActivatedAt: live?.activated_at ?? null,
      paidAts,
      // 해지 시각은 계약이 갖는다 — 예약 표에는 취소 시각 칸이 없고, **없는 칸을
      // 만들지 않는다**(계약이 이미 그 사실을 적고 있다).
      cancelledAt: live?.cancelled_at ?? null,
      fulfilledAt: null,
    }),
    entries: entryPoints({
      bookingId: booking.id,
      status: booking.status,
      acceptedAt: booking.accepted_at,
      declinedAt: booking.declined_at,
      contractId: live?.id ?? null,
      contractActive: live?.status === "active",
      hasPayableSchedule: schedules.some((schedule) => schedule.payable),
      escrowEnabled,
      hasEscrowHold: ((escrowResult.data ?? []) as { id: string }[]).length > 0,
      reviewable,
      reviewBlockedReason: alreadyReviewed
        ? REVIEW_BLOCK_MESSAGE.already_written
        : REVIEW_BLOCK_MESSAGE.booking_not_reviewable,
    }),
    schedules,
    contractId: live?.id ?? null,
    contractStatus: live?.status ?? null,
    escrowEnabled,
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

/**
 * `escrow.enabled` — **O-03 대기**.
 *
 * 값이 없으면 **켜진 것으로도 꺼진 것으로도 읽지 않고 꺼짐으로 둔다**: 안전거래는
 * 돈을 붙잡는 기능이라 "모르겠으면 열어 둔다" 가 성립하지 않는다. 화면은 그것을
 * "아직 열려 있지 않다(법무 검토 중)" 로 적는다 — '이 예약에 잔금이 없다' 와 다른
 * 문장이다(함정 2).
 */
async function readEscrowEnabled(): Promise<boolean> {
  // **이미 있는 독자를 쓴다.** 같은 키를 두 곳이 다른 모양으로 읽으면
  // 언젠가 한쪽만 고쳐진다(`lib/escrow/actions.ts` 가 같은 줄을 쓴다).
  return (await readSetting("escrow.enabled"))?.enabled === true;
}
