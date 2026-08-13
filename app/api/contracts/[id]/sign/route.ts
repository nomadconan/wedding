import type { NextRequest } from "next/server";

import { fail, failValidation, ok } from "@/lib/api/response";
import { isFailure, signContract } from "@/lib/contract/actions";
import { ipHash } from "@/lib/contract/hash";
import type { SignerRole } from "@/lib/core/contract/contract";
import { SignContractRequestSchema } from "@/lib/core/schemas/payment";
import { findMyCouple } from "@/lib/couple/membership";
import { getSessionUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";

/**
 * POST /api/contracts/[id]/sign — 3자 전자서명 (F-C-15 · §4.2 · S5-05 · D-28)
 *
 * ── 역할을 입력으로 받지 않는다 ─────────────────────────────────────────────
 * 어느 편인지는 **서버가 세션으로 판정한다.** 받으면 고객이 업체 칸에 서명하는
 * 요청을 만들 수 있고, 0029 의 트리거가 막더라도 그런 모양의 API 를 두지 않는다.
 *
 * ── 커플은 소유자만 서명한다 ────────────────────────────────────────────────
 * §1.4 가 "결제·계약 서명 권한은 소유자와 분리" 라고 적었고 RLS 도 `is_couple_owner`
 * 로 쓰여 있다. 배우자는 계약을 **볼 수는** 있지만 서명하지 않는다 — 계약서 본문에는
 * 양측이 당사자로 적힌다(서명 주체와 계약 당사자는 다른 층위다).
 */
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "CONTRACT_INVALID_BODY", "요청 본문을 읽을 수 없습니다.");
  }

  const parsed = SignContractRequestSchema.safeParse(body);
  if (!parsed.success) return failValidation(parsed.error.issues);

  // 이 계약이 내게 보이는가 — RLS 에게 묻는다(0029: 커플·업체·플래너).
  const supabase = await createClient();
  const { data: contractRow } = await supabase
    .from("contracts")
    .select("id, booking_id, planner_id")
    .eq("id", params.id)
    .maybeSingle();

  const contract = contractRow as {
    id: string;
    booking_id: string;
    planner_id: string | null;
  } | null;

  if (!contract) return fail(404, "CONTRACT_NOT_FOUND", "계약을 찾을 수 없습니다.");

  const { data: bookingRow } = await supabase
    .from("bookings")
    .select("id, couple_id, vendor_id")
    .eq("id", contract.booking_id)
    .maybeSingle();

  const booking = bookingRow as { couple_id: string; vendor_id: string } | null;
  if (!booking) return fail(404, "CONTRACT_BOOKING_NOT_FOUND", "예약을 찾을 수 없습니다.");

  const role = await resolveSignerRole({
    userId: user.id,
    coupleId: booking.couple_id,
    vendorId: booking.vendor_id,
    plannerId: contract.planner_id,
    supabase,
  });

  if (role === null) {
    return fail(403, "CONTRACT_NOT_SIGNER", "이 계약의 서명 당사자가 아니에요.");
  }

  const result = await signContract({
    contractId: contract.id,
    role,
    actorId: user.id,
    expectedContentHash: parsed.data.contentHash,
    ipHash: ipHash(request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null),
  });

  if (isFailure(result)) return fail(result.status, result.code, result.message);

  return ok(result);
}

type Reader = Awaited<ReturnType<typeof createClient>>;

async function resolveSignerRole(input: {
  userId: string;
  coupleId: string;
  vendorId: string;
  plannerId: string | null;
  supabase: Reader;
}): Promise<SignerRole | null> {
  const membership = await findMyCouple(input.userId);

  // **소유자만** 서명한다. 배우자(partner)는 열람까지다(§1.4).
  if (membership?.coupleId === input.coupleId) {
    return membership.role === "owner" ? "couple" : null;
  }

  const { data: member } = await input.supabase
    .from("vendor_members")
    .select("vendor_id")
    .eq("vendor_id", input.vendorId)
    .eq("user_id", input.userId)
    .maybeSingle();

  if (member) return "vendor";

  if (input.plannerId !== null) {
    const { data: planner } = await input.supabase
      .from("planners")
      .select("id")
      .eq("id", input.plannerId)
      .eq("user_id", input.userId)
      .maybeSingle();

    if (planner) return "planner";
  }

  return null;
}
