import type { ConsultationView } from "@/lib/core/schemas/consultation";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * 상담·탐방 서버 공통 조각 (S4-07)
 *
 * `route.ts` 는 HTTP 메서드 외의 export 를 허용하지 않으므로 화면·API·배치가 함께
 * 쓰는 것을 여기에 둔다.
 *
 * **세션 클라이언트로 읽는다.** 0025 의 정책이 그대로 경계다 — 커플·업체·**위임
 * 플래너**가 본다. 서비스롤은 운영 파라미터와 보증금 쓰기에만 쓴다.
 */
type Client = Awaited<ReturnType<typeof import("@/lib/supabase/server").createClient>>;

export const CONSULTATION_COLUMNS =
  "id, couple_id, vendor_id, planner_id, type, scheduled_at, duration_minutes, status, location, requested_at, approved_at, rejected_at, reject_reason, cancelled_at, cancel_reason, confirm_due_at, couple_confirmed_at, vendor_confirmed_at, couple_outcome, vendor_outcome, outcome, created_at";

type ConsultationRow = {
  id: string;
  couple_id: string;
  vendor_id: string;
  planner_id: string | null;
  type: ConsultationView["type"];
  scheduled_at: string;
  duration_minutes: number;
  status: string;
  location: string | null;
  reject_reason: string | null;
  cancel_reason: string | null;
  confirm_due_at: string | null;
  couple_outcome: string | null;
  vendor_outcome: string | null;
  outcome: string | null;
  created_at: string;
};

// =============================================================================
// 운영 파라미터 (§3.11 NOTE · §7.4 — 값은 app_settings 가 갖는다)
// =============================================================================

/**
 * 행이 없으면 **null** 이다. 코드가 숫자를 지어내지 않는다 — 지어낸 금액을 청구하거나
 * 지어낸 기한으로 노쇼를 판정할 수는 없다.
 */
async function readSetting(key: string): Promise<Record<string, unknown> | null> {
  const { data } = await createAdminClient()
    .from("app_settings")
    .select("value_json")
    .eq("key", key)
    .maybeSingle();

  return (data?.value_json ?? null) as Record<string, unknown> | null;
}

export type ConsultationSettings = {
  /** 보증금액. null 이면 보증금 없이 진행한다. */
  depositAmount: number | null;
  currency: string;
  /** 무료 취소 기한(시간). null 이면 언제 취소해도 무료다. */
  freeCancelHours: number | null;
  /** 이행 확인 응답 기한(시간). null 이면 자동 판정을 걸지 않는다. */
  confirmDueHours: number | null;
};

export async function loadConsultationSettings(): Promise<ConsultationSettings> {
  const [deposit, cancel, confirm] = await Promise.all([
    readSetting("consultation.deposit_amount"),
    readSetting("consultation.free_cancel_hours"),
    readSetting("consultation.confirm_due_hours"),
  ]);

  const amount = Number(deposit?.amount);
  const cancelHours = Number(cancel?.hours);
  const confirmHours = Number(confirm?.hours);

  return {
    depositAmount: Number.isFinite(amount) && amount > 0 ? Math.trunc(amount) : null,
    currency: typeof deposit?.currency === "string" ? deposit.currency : "KRW",
    freeCancelHours:
      Number.isFinite(cancelHours) && cancelHours > 0 ? Math.trunc(cancelHours) : null,
    confirmDueHours:
      Number.isFinite(confirmHours) && confirmHours > 0 ? Math.trunc(confirmHours) : null,
  };
}

// =============================================================================
// 조회
// =============================================================================

type DepositRow = {
  id: string;
  consultation_id: string;
  amount: number;
  status: string;
  resolution_reason: string | null;
};

async function depositsFor(
  supabase: Client,
  consultationIds: string[],
): Promise<Map<string, DepositRow>> {
  const map = new Map<string, DepositRow>();
  if (consultationIds.length === 0) return map;

  // RLS 가 가른다 — 커플은 owner 만, 업체는 멤버만 본다(§3.9). 못 보는 사람에게는
  // 그냥 null 로 나가고, 화면은 "보증금 정보를 볼 수 없다" 가 아니라 그 자리를 비운다.
  const { data } = await supabase
    .from("consultation_deposits")
    .select("id, consultation_id, amount, status, resolution_reason")
    .in("consultation_id", consultationIds);

  for (const row of (data ?? []) as DepositRow[]) map.set(row.consultation_id, row);

  return map;
}

function toView(row: ConsultationRow, vendorName: string, deposit: DepositRow | null): ConsultationView {
  return {
    id: row.id,
    coupleId: row.couple_id,
    vendorId: row.vendor_id,
    vendorName,
    plannerId: row.planner_id,
    type: row.type,
    scheduledAt: row.scheduled_at,
    durationMinutes: row.duration_minutes,
    status: row.status,
    location: row.location,
    rejectReason: row.reject_reason,
    cancelReason: row.cancel_reason,
    confirmDueAt: row.confirm_due_at,
    coupleOutcome: row.couple_outcome,
    vendorOutcome: row.vendor_outcome,
    outcome: row.outcome,
    deposit: deposit
      ? {
          id: deposit.id,
          amount: deposit.amount,
          status: deposit.status,
          resolutionReason: deposit.resolution_reason,
        }
      : null,
    createdAt: row.created_at,
  };
}

/**
 * 내 상담 목록.
 *
 * RLS 가 커플·업체·**위임 플래너**를 모두 통과시키므로, 이 함수 하나로 세 화면이
 * 다른 목록을 얻는다 — 플래너는 자기가 위임받은 커플의 일정을 그대로 본다(§3.9).
 */
export async function loadMyConsultations(
  supabase: Client,
  options?: { vendorId?: string },
): Promise<ConsultationView[]> {
  let query = supabase.from("consultations").select(CONSULTATION_COLUMNS);
  if (options?.vendorId) query = query.eq("vendor_id", options.vendorId);

  const { data, error } = await query.order("scheduled_at", { ascending: false }).limit(100);

  if (error) throw new Error("CONSULTATION_LOAD_FAILED");

  const rows = (data ?? []) as ConsultationRow[];
  if (rows.length === 0) return [];

  const { data: vendorRows } = await supabase
    .from("vendors")
    .select("id, name")
    .in("id", [...new Set(rows.map((row) => row.vendor_id))]);

  const vendorNames = new Map(
    ((vendorRows ?? []) as { id: string; name: string }[]).map((row) => [row.id, row.name]),
  );

  const deposits = await depositsFor(supabase, rows.map((row) => row.id));

  return rows.map((row) =>
    toView(row, vendorNames.get(row.vendor_id) ?? "이름을 불러오지 못한 업체", deposits.get(row.id) ?? null),
  );
}

export async function loadConsultation(
  supabase: Client,
  id: string,
): Promise<ConsultationView | null> {
  const { data } = await supabase
    .from("consultations")
    .select(CONSULTATION_COLUMNS)
    .eq("id", id)
    .maybeSingle();

  if (!data) return null;

  const row = data as ConsultationRow;

  const { data: vendor } = await supabase
    .from("vendors")
    .select("name")
    .eq("id", row.vendor_id)
    .maybeSingle();

  const deposits = await depositsFor(supabase, [row.id]);

  return toView(row, (vendor as { name?: string } | null)?.name ?? "", deposits.get(row.id) ?? null);
}

// =============================================================================
// 가능 시간대 (F-V-17 · S4-06)
// =============================================================================

export type AvailabilityRow = {
  id: string;
  weekday: number;
  startTime: string;
  endTime: string;
  slotMinutes: number;
};

/** 0007 의 RLS 가 active 업체는 공개 열람을 허용한다 — 비로그인도 읽는다. */
export async function loadAvailability(
  supabase: Client,
  vendorId: string,
): Promise<AvailabilityRow[]> {
  const { data } = await supabase
    .from("vendor_availability")
    .select("id, weekday, start_time, end_time, slot_minutes")
    .eq("vendor_id", vendorId)
    .order("weekday")
    .order("start_time");

  return ((data ?? []) as {
    id: string;
    weekday: number;
    start_time: string;
    end_time: string;
    slot_minutes: number;
  }[]).map((row) => ({
    id: row.id,
    weekday: row.weekday,
    startTime: row.start_time,
    endTime: row.end_time,
    slotMinutes: row.slot_minutes,
  }));
}

/**
 * 이미 잡힌 시각.
 *
 * **서비스롤로 읽는다.** 다른 커플의 예약은 RLS 상 보이지 않는데, 슬롯이 찼는지는
 * 알려 줘야 한다. 내보내는 것은 **시각 목록뿐**이고 누가 잡았는지는 나가지 않는다 —
 * 프라이싱 룰을 서버가 계산해 금액만 내보낸 것(S3-03)과 같은 방식이다.
 */
export async function loadTakenSlots(
  vendorId: string,
  fromIso: string,
  toIso: string,
): Promise<string[]> {
  const { data } = await createAdminClient()
    .from("consultations")
    .select("scheduled_at")
    .eq("vendor_id", vendorId)
    .in("status", ["approved", "confirmed"])
    .gte("scheduled_at", fromIso)
    .lt("scheduled_at", toIso);

  return ((data ?? []) as { scheduled_at: string }[]).map((row) => row.scheduled_at);
}
