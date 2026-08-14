import {
  ESCROW_STATUS_DETAIL,
  ESCROW_STATUS_LABEL,
  decideRelease,
  type EscrowStatus,
} from "@/lib/core/escrow/escrow";

/**
 * 에스크로 화면·API 가 함께 쓰는 조회 (S5-09)
 *
 * **읽기는 호출자가 넘긴 세션 클라이언트로 한다.** `escrow_holds` 정책은 커플
 * **owner**·업체 멤버·운영자에게만 열려 있다(0035) — 읽히면 당사자다(§5.5).
 */
type Reader = Awaited<ReturnType<typeof import("@/lib/supabase/server").createClient>>;

export type EscrowView = {
  id: string;
  bookingId: string;
  status: EscrowStatus;
  statusLabel: string;
  statusDetail: string;
  heldAmount: number;
  heldAt: string | null;
  confirmDueAt: string | null;
  coupleConfirmed: boolean | null;
  vendorConfirmed: boolean | null;
  releasedAt: string | null;
  refundedAt: string | null;
  resolutionNote: string | null;
  /** 실예치가 켜져 있는가. false 면 절차만 돈 것이다(O-03). */
  simulated: boolean;
  /** 지금 판정하면 어떻게 되는가. 화면이 "무엇을 기다리는지" 를 적는다. */
  pendingDetail: string;
};

const COLUMNS =
  "id, booking_id, status, held_amount, held_at, confirm_due_at, couple_confirmed, vendor_confirmed, released_at, refunded_at, resolution_note, provider";

export async function loadEscrowHolds(
  client: Reader,
  options: { bookingId?: string; disputedOnly?: boolean } = {},
  now: Date = new Date(),
): Promise<EscrowView[]> {
  let query = client.from("escrow_holds").select(COLUMNS).order("created_at", { ascending: false });

  if (options.bookingId) query = query.eq("booking_id", options.bookingId);
  if (options.disputedOnly) query = query.eq("status", "disputed");

  const { data } = await query;

  const rows = (data ?? []) as unknown as Record<string, unknown>[];
  if (rows.length === 0) return [];

  // 예식일은 릴리즈 판정에 들어간다(무응답 폴백이 예식일 경과를 요구한다).
  const bookingIds = rows
    .map((row) => row.booking_id as string | null)
    .filter((value): value is string => value !== null);

  const { data: bookingRows } = await client
    .from("bookings")
    .select("id, couple_id")
    .in("id", bookingIds);

  const coupleOf = new Map(
    ((bookingRows ?? []) as { id: string; couple_id: string }[]).map((row) => [
      row.id,
      row.couple_id,
    ]),
  );

  const { data: coupleRows } = await client
    .from("couples")
    .select("id, wedding_date")
    .in("id", [...new Set(coupleOf.values())]);

  const eventOf = new Map(
    ((coupleRows ?? []) as { id: string; wedding_date: string | null }[]).map((row) => [
      row.id,
      row.wedding_date,
    ]),
  );

  return rows.map((row) => {
    const status = row.status as EscrowStatus;
    const bookingId = (row.booking_id as string | null) ?? "";
    const eventDate = eventOf.get(coupleOf.get(bookingId) ?? "") ?? null;

    const decision = decideRelease({
      coupleConfirmed: (row.couple_confirmed as boolean | null) ?? null,
      vendorConfirmed: (row.vendor_confirmed as boolean | null) ?? null,
      dueAt: (row.confirm_due_at as string | null) ?? null,
      eventDate,
      now,
    });

    return {
      id: row.id as string,
      bookingId,
      status,
      statusLabel: ESCROW_STATUS_LABEL[status],
      statusDetail: ESCROW_STATUS_DETAIL[status],
      heldAmount: (row.held_amount as number) ?? 0,
      heldAt: (row.held_at as string | null) ?? null,
      confirmDueAt: (row.confirm_due_at as string | null) ?? null,
      coupleConfirmed: (row.couple_confirmed as boolean | null) ?? null,
      vendorConfirmed: (row.vendor_confirmed as boolean | null) ?? null,
      releasedAt: (row.released_at as string | null) ?? null,
      refundedAt: (row.refunded_at as string | null) ?? null,
      resolutionNote: (row.resolution_note as string | null) ?? null,
      // provider 가 'none' 이면 실예치 없이 절차만 돈 것이다(O-03 대기).
      simulated: (row.provider as string | null) !== "toss",
      // 종결된 건에는 "무엇을 기다리는가" 가 없다.
      pendingDetail: status === "held" ? decision.detail : ESCROW_STATUS_DETAIL[status],
    };
  });
}
