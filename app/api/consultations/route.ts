import type { NextRequest } from "next/server";

import { fail, failValidation, ok } from "@/lib/api/response";
import {
  KST_OFFSET_MINUTES,
  cancelConsultation,
  createConsultation,
  payDeposit,
} from "@/lib/consultation/actions";
import {
  loadAvailability,
  loadConsultationSettings,
  loadMyConsultations,
  loadTakenSlots,
} from "@/lib/consultation/loader";
import { slotsForDate } from "@/lib/core/consultation/consultation";
import { ConsultationActionSchema } from "@/lib/core/schemas/consultation";
import { findMyCouple } from "@/lib/couple/membership";
import { getSessionUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";

/**
 * GET/POST /api/consultations — 상담·탐방 예약 (F-C-29, §4.2)
 *
 * **커플 id 를 입력으로 받지 않는다** — 세션에서 찾는다(장바구니·채팅·문의와 같은 규칙).
 *
 * `GET` 은 두 가지를 한다 — 인자가 없으면 내 예약 목록, `vendorId`+`date` 가 있으면
 * **그 날짜에 고를 수 있는 슬롯**이다. §4.2 가 정한 표면을 늘리지 않기 위해서다.
 * 슬롯 조회는 **로그인 없이도 된다** — 업체 상세에서 "언제 가능한가" 를 먼저 보고
 * 로그인하는 흐름이 자연스럽고, `vendor_availability` 는 0007 이 공개 열람으로 열었다.
 */
export async function GET(request: NextRequest) {
  const vendorId = request.nextUrl.searchParams.get("vendorId");
  const date = request.nextUrl.searchParams.get("date");
  const supabase = await createClient();

  // ── 슬롯 조회 ─────────────────────────────────────────────────────────────
  if (vendorId && date) {
    const rules = await loadAvailability(supabase, vendorId);
    const settings = await loadConsultationSettings();

    if (rules.length === 0) {
      return ok({ slots: [], rules: [], deposit: settings, hasAvailability: false });
    }

    // 그 지역 하루의 경계를 UTC 로 옮겨 이미 잡힌 시각을 읽는다.
    const from = new Date(
      Date.parse(`${date}T00:00:00Z`) - KST_OFFSET_MINUTES * 60_000,
    ).toISOString();
    const to = new Date(
      Date.parse(`${date}T00:00:00Z`) - KST_OFFSET_MINUTES * 60_000 + 86_400_000,
    ).toISOString();

    // 다른 커플의 예약은 RLS 상 보이지 않는다. **시각만** 서비스롤로 읽어 내보낸다 —
    // 누가 잡았는지는 나가지 않는다.
    const taken = await loadTakenSlots(vendorId, from, to);

    return ok({
      slots: slotsForDate(rules, date, KST_OFFSET_MINUTES, taken),
      rules,
      deposit: settings,
      hasAvailability: true,
    });
  }

  // ── 내 예약 목록 ──────────────────────────────────────────────────────────
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  try {
    // RLS 가 커플·업체·위임 플래너를 가른다(§3.9).
    return ok({
      consultations: await loadMyConsultations(supabase),
      settings: await loadConsultationSettings(),
    });
  } catch {
    return fail(500, "CONSULTATION_LOAD_FAILED", "예약을 불러오지 못했습니다.");
  }
}

export async function POST(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "CONSULTATION_INVALID_BODY", "요청 본문을 읽을 수 없습니다.");
  }

  const parsed = ConsultationActionSchema.safeParse(body);
  if (!parsed.success) return failValidation(parsed.error.issues);

  const supabase = await createClient();
  const action = parsed.data;
  // '지금' 을 여기서 한 번 만들어 넘긴다 — 함수마다 시계를 읽으면 판정과 기록이
  // 서로 다른 시각을 보게 된다(S2-06 규칙).
  const now = new Date();

  if (action.action === "cancel") {
    const result = await cancelConsultation(supabase, {
      consultationId: action.consultationId,
      reason: action.reason,
      actorId: user.id,
      now,
    });

    return "status" in result
      ? fail(result.status, result.code, result.message)
      : ok({ consultationId: result.consultationId, verdict: result.verdict });
  }

  if (action.action === "pay_deposit") {
    const result = await payDeposit(supabase, {
      consultationId: action.consultationId,
      idempotencyKey: action.idempotencyKey,
      actorId: user.id,
    });

    return "status" in result ? fail(result.status, result.code, result.message) : ok(result);
  }

  // ── 신청 ──────────────────────────────────────────────────────────────────
  const membership = await findMyCouple(user.id);
  if (!membership) {
    return fail(403, "CONSULTATION_COUPLE_REQUIRED", "온보딩을 먼저 마쳐야 예약할 수 있어요.");
  }

  const result = await createConsultation(supabase, {
    coupleId: membership.coupleId,
    vendorId: action.vendorId,
    actorId: user.id,
    type: action.type,
    scheduledAt: action.scheduledAt,
    location: action.location,
    now,
  });

  return "status" in result
    ? fail(result.status, result.code, result.message)
    : ok(result, { status: 201 });
}
