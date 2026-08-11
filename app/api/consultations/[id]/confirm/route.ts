import type { NextRequest } from "next/server";

import { fail, failValidation, ok } from "@/lib/api/response";
import { submitConfirmation } from "@/lib/consultation/actions";
import type { ConsultationOutcome } from "@/lib/core/consultation/consultation";
import { ConfirmConsultationSchema } from "@/lib/core/schemas/consultation";
import { findMyCouple } from "@/lib/couple/membership";
import { getSessionUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";
import { findMemberVendor } from "@/lib/vendor/products";

/**
 * POST /api/consultations/[id]/confirm — 이행 확인 (§3.11, §4.2)
 *
 * §4.2: "**고객·업체 양측이 각각 호출**한다. 양측 일치 시 자동 환불·몰취,
 * 불일치·무응답 시 `disputed` 전환".
 *
 * ── 어느 편인지는 **서버가 세션으로 판정한다** ──────────────────────────────
 * 입력으로 받지 않는다. 받으면 고객이 업체 칸에 답하는 요청을 만들 수 있고, DB
 * 트리거가 막더라도 그런 모양의 API 를 두지 않는다. 그래서 이 라우트 하나로 양측을
 * 받되, **무엇을 쓸지는 세션이 정한다.**
 *
 * 한 사람이 커플 당사자이면서 그 업체 멤버일 수는 없다(그런 상태면 애초에 예약이
 * 성립하지 않는다). 그래도 순서를 정해 둔다 — 커플 쪽을 먼저 본다.
 */
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "CONSULTATION_INVALID_BODY", "요청 본문을 읽을 수 없습니다.");
  }

  const parsed = ConfirmConsultationSchema.safeParse(body);
  if (!parsed.success) return failValidation(parsed.error.issues);

  const supabase = await createClient();

  // 이 예약이 내게 보이는가 — **RLS 에게 묻는다**. 읽히면 당사자다.
  const { data: row } = await supabase
    .from("consultations")
    .select("id, couple_id, vendor_id")
    .eq("id", params.id)
    .maybeSingle();

  if (!row) return fail(404, "CONSULTATION_NOT_FOUND", "예약을 찾을 수 없습니다.");

  const consultation = row as { couple_id: string; vendor_id: string };

  const membership = await findMyCouple(user.id);
  const vendor = await findMemberVendor(user.id);

  const side: "couple" | "vendor" | null =
    membership?.coupleId === consultation.couple_id
      ? "couple"
      : vendor?.id === consultation.vendor_id
        ? "vendor"
        : null;

  // 위임 플래너는 예약을 **볼 수** 있지만 이행 확인은 할 수 없다 —
  // 노쇼 판정의 주체는 실제로 그 자리에 있었던 당사자여야 한다(0025 트리거도 막는다).
  if (side === null) {
    return fail(
      403,
      "CONSULTATION_NOT_PARTY",
      "이행 확인은 예약 당사자(고객·업체)만 할 수 있어요.",
    );
  }

  const result = await submitConfirmation(supabase, {
    consultationId: params.id,
    side,
    outcome: parsed.data.outcome as ConsultationOutcome,
    actorId: user.id,
    now: new Date(),
  });

  return "status" in result
    ? fail(result.status, result.code, result.message)
    : ok({
        consultationId: result.consultationId,
        // 아직 한쪽만 답했으면 null 이다 — 기한이 지나면 배치가 마무리한다.
        verdict: result.verdict,
      });
}
