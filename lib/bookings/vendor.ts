import { recordEvent } from "@/lib/audit/record";
import {
  type BookingStatus,
  DECIDE_BLOCK_MESSAGE,
  type IssueBlockReason,
  type VendorLane,
  canDecide,
  canIssueContract,
  groupByLane,
} from "@/lib/core/booking/console";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

/**
 * 업체 예약 보드 · 승인·거절 (S5-10 · F-V-08 · §6.3 `/vendor/bookings`)
 *
 * **읽기는 세션, 쓰기는 서비스롤이다**(D-62). `bookings_select` 정책이 업체 멤버를
 * 가르므로 목록은 세션으로 읽고, 결정은 0065 가 표에서 쓰기를 걷었으므로 서버가 한다 —
 * 그리고 그것이 **FIX-44 를 막은 방식**이다(당사자가 직접 쓸 수 있으면 승인이라는
 * 심사 자체가 없는 것과 같다).
 */

export type VendorBookingRow = {
  id: string;
  status: BookingStatus;
  coupleId: string;
  totalAmount: number;
  depositAmount: number;
  createdAt: string;
  acceptedAt: string | null;
  declinedAt: string | null;
  declineReason: string | null;
  productName: string | null;
  contractId: string | null;
  contractStatus: string | null;
  canDecide: boolean;
  decideBlockedReason: string | null;
  canIssue: boolean;
  issueBlockedReason: IssueBlockReason | null;
};

export type VendorBoard = {
  lanes: { lane: VendorLane; label: string; hint: string; rows: VendorBookingRow[] }[];
  total: number;
};

export async function loadVendorBookings(vendorId: string): Promise<VendorBoard> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("bookings")
    .select(
      "id, status, couple_id, product_id, total_amount, deposit_amount, created_at, accepted_at, declined_at, decline_reason",
    )
    .eq("vendor_id", vendorId)
    .order("created_at", { ascending: false })
    .limit(300);

  if (error) throw new Error("VENDOR_BOOKING_LOAD_FAILED");

  const rows = (data ?? []) as {
    id: string;
    status: BookingStatus;
    couple_id: string;
    product_id: string | null;
    total_amount: number;
    deposit_amount: number;
    created_at: string;
    accepted_at: string | null;
    declined_at: string | null;
    decline_reason: string | null;
  }[];

  // **임베드를 쓰지 않는다**(함정 1) — 상품·계약을 각각 따로 묻고 코드가 맞춘다.
  const [products, contracts] = await Promise.all([
    productNames(rows.map((row) => row.product_id).filter((id): id is string => id !== null)),
    liveContracts(rows.map((row) => row.id)),
  ]);

  const mapped: VendorBookingRow[] = rows.map((row) => {
    const contract = contracts.get(row.id) ?? null;
    const decide = canDecide({
      status: row.status,
      acceptedAt: row.accepted_at,
      declinedAt: row.declined_at,
    });
    const issue = canIssueContract({
      status: row.status,
      acceptedAt: row.accepted_at,
      declinedAt: row.declined_at,
      hasLiveContract: contract !== null && contract.status !== "cancelled",
    });

    return {
      id: row.id,
      status: row.status,
      coupleId: row.couple_id,
      totalAmount: row.total_amount,
      depositAmount: row.deposit_amount,
      createdAt: row.created_at,
      acceptedAt: row.accepted_at,
      declinedAt: row.declined_at,
      declineReason: row.decline_reason,
      // **"상품 없음" 으로 접지 않는다** — 상품 없이 만든 예약(직접 견적)이 실제로 있다.
      productName: row.product_id === null ? null : (products.get(row.product_id) ?? null),
      contractId: contract?.id ?? null,
      contractStatus: contract?.status ?? null,
      canDecide: decide.allowed,
      decideBlockedReason: decide.reason === null ? null : DECIDE_BLOCK_MESSAGE[decide.reason],
      canIssue: issue.allowed,
      issueBlockedReason: issue.reason,
    };
  });

  return { lanes: groupByLane(mapped), total: mapped.length };
}

async function productNames(ids: readonly string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();

  const supabase = await createClient();
  const { data } = await supabase.from("products").select("id, name").in("id", unique);

  return new Map(((data ?? []) as { id: string; name: string }[]).map((row) => [row.id, row.name]));
}

async function liveContracts(
  bookingIds: readonly string[],
): Promise<Map<string, { id: string; status: string }>> {
  if (bookingIds.length === 0) return new Map();

  const supabase = await createClient();
  const { data } = await supabase
    .from("contracts")
    .select("id, booking_id, status, created_at")
    .in("booking_id", [...bookingIds])
    .order("created_at", { ascending: false });

  const map = new Map<string, { id: string; status: string }>();
  for (const row of (data ?? []) as {
    id: string;
    booking_id: string;
    status: string;
    created_at: string;
  }[]) {
    const seen = map.get(row.booking_id);
    // 취소되지 않은 계약을 우선한다 — 예약당 유효 계약은 하나다(D-21).
    if (!seen || (seen.status === "cancelled" && row.status !== "cancelled")) {
      map.set(row.booking_id, { id: row.id, status: row.status });
    }
  }

  return map;
}

// =============================================================================
// 결정 — 승인·거절
// =============================================================================

export type DecideResult =
  | { ok: true; bookingId: string; decision: "accepted" | "declined" }
  | { ok: false; status: number; code: string; message: string };

/**
 * 예약 승인·거절 (F-V-08).
 *
 * **업체 편인지는 서버가 세션으로 판정한다** — 입력으로 받지 않는다(S5-04 계약 발행과
 * 같은 규칙). 그리고 **결정 자격은 순수 함수 하나**가 판정한다: 화면과 API 가 다른
 * 답을 내면 버튼이 살아 있는데 눌리지 않는다.
 *
 * **거절에는 사유가 필수다**(D-24). 사유 없는 거절은 조율의 근거가 되지 못하고,
 * 나중에 고객이 "왜 거절됐나" 를 물으면 아무도 답할 수 없다. CHECK 이 최종 경계다.
 */
export async function decideBooking(input: {
  bookingId: string;
  decision: "accept" | "decline";
  reason: string | null;
  actorId: string;
  actorRole: string | null;
}): Promise<DecideResult> {
  const supabase = await createClient();

  // **RLS 에게 먼저 묻는다** — 이 예약이 내게 보이는가. 안 보이면 없는 것과 같게 답한다.
  const { data: visible } = await supabase
    .from("bookings")
    .select("id, vendor_id, status, accepted_at, declined_at")
    .eq("id", input.bookingId)
    .maybeSingle();

  const booking = visible as {
    id: string;
    vendor_id: string;
    status: BookingStatus;
    accepted_at: string | null;
    declined_at: string | null;
  } | null;

  if (!booking) {
    return { ok: false, status: 404, code: "BOOKING_NOT_FOUND", message: "예약을 찾을 수 없습니다." };
  }

  // 보이는 것만으로는 부족하다 — 커플 구성원에게도 보인다. **업체 편인지**를 본다.
  const { data: member } = await supabase
    .from("vendor_members")
    .select("vendor_id")
    .eq("vendor_id", booking.vendor_id)
    .eq("user_id", input.actorId)
    .maybeSingle();

  if (!member) {
    return {
      ok: false,
      status: 403,
      code: "BOOKING_NOT_VENDOR",
      message: "예약 승인·거절은 업체가 합니다.",
    };
  }

  const gate = canDecide({
    status: booking.status,
    acceptedAt: booking.accepted_at,
    declinedAt: booking.declined_at,
  });

  if (!gate.allowed) {
    return {
      ok: false,
      status: 409,
      code: "BOOKING_DECISION_CLOSED",
      message: gate.reason === null ? "결정할 수 없습니다." : DECIDE_BLOCK_MESSAGE[gate.reason],
    };
  }

  const reason = (input.reason ?? "").trim();
  if (input.decision === "decline" && reason.length === 0) {
    return {
      ok: false,
      status: 422,
      code: "BOOKING_REASON_REQUIRED",
      message: "거절 사유를 적어 주세요. 사유 없는 거절은 고객에게 아무것도 알려주지 못합니다.",
    };
  }

  const admin = createAdminClient();
  const now = new Date().toISOString();

  const patch =
    input.decision === "accept"
      ? { accepted_at: now, accepted_by: input.actorId }
      : // 거절은 예약을 끝낸다. 상태를 함께 옮기지 않으면 화면이 이 예약을 계속
        // 진행 중으로 그리고 재고도 잡힌 채 남는다(CHECK 이 짝을 강제한다).
        { declined_at: now, decline_reason: reason, status: "cancelled" as const };

  const { error } = await admin.from("bookings").update(patch).eq("id", input.bookingId);

  if (error) {
    return {
      ok: false,
      status: 500,
      code: "BOOKING_DECISION_FAILED",
      message: "결정을 저장하지 못했습니다.",
    };
  }

  await recordEvent({
    entityType: "booking",
    entityId: input.bookingId,
    eventType: input.decision === "accept" ? "booking_accepted" : "booking_declined",
    actor: { id: input.actorId, role: input.actorRole },
    beforeState: "pending",
    afterState: input.decision === "accept" ? "accepted" : "declined",
    source: "web",
    // **사유 본문을 이벤트에 담지 않는다**(§5.3 — 원문을 이벤트에 싣지 않는다).
    // 사유는 `bookings.decline_reason` 이 갖고, 여기에는 그것이 있다는 사실만 남긴다.
    memo: input.decision === "decline" ? "reason_recorded" : null,
  });

  return {
    ok: true,
    bookingId: input.bookingId,
    decision: input.decision === "accept" ? "accepted" : "declined",
  };
}

/** 로그인한 사용자가 속한 업체. 없으면 null — 화면이 "업체 계정이 아니다" 를 그린다. */
export async function vendorOf(userId: string): Promise<string | null> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("vendor_members")
    .select("vendor_id")
    .eq("user_id", userId)
    .limit(1)
    .maybeSingle();

  return (data as { vendor_id: string } | null)?.vendor_id ?? null;
}
