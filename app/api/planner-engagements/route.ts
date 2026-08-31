import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, failValidation, ok } from "@/lib/api/response";
import { findMyCouple } from "@/lib/couple/membership";
import { DELEGATABLE_SCOPES, CLOSED_SCOPES } from "@/lib/core/planner/delegation";
import { DelegationOfferSchema } from "@/lib/core/schemas/planner";
import {
  delegationMessages,
  loadCoupleDelegations,
  offerDelegation,
} from "@/lib/planners/delegation";
import { getSessionUser } from "@/lib/supabase/auth";

/**
 * GET/POST /api/planner-engagements — 열람 권한 위임 (F-C-18 · §3.7 · S6-04)
 *
 * **명세 §4.2 에 없던 엔드포인트다.** §4.2 는 `GET/PUT /api/planner-scopes`(과금 축 ·
 * F-C-31)만 적었고 위임 축에는 API 가 배정돼 있지 않았다 — 화면만으로는 `pending`
 * 을 만들 경로가 없다. **명세 반영을 제안한다**(§7.5).
 *
 * **`coupleId` 를 입력으로 받지 않는다** — 세션이 정한다(FIX-45 와 같은 자리).
 * **`status` 도 받지 않는다** — 제안은 언제나 `pending` 이고 수락은 플래너의 몫이다.
 *
 * **두 축이 연동되지 않는다는 사실을 본문에 싣는다**(함정 3 · D-43). 화면에서만
 * 적으면 이 API 를 쓰는 다음 사람은 위임을 거두면 수수료도 멈춘다고 읽는다.
 */
export const dynamic = "force-dynamic";

const OfferSchema = DelegationOfferSchema.extend({
  plannerId: z.string().uuid(),
});

export async function GET() {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  const couple = await findMyCouple(user.id);
  if (!couple) return fail(403, "COUPLE_REQUIRED", "커플 계정이 아닙니다.");

  try {
    const payload = await loadCoupleDelegations({ coupleId: couple.coupleId, now: new Date() });

    return ok({
      ...payload,
      canOffer: couple.role === "owner",
      // 고를 수 있는 것과 **고를 수 없는 것**을 함께 낸다 — 없는 항목을 조용히
      // 빼면 "아직 안 만든 것" 인지 "일부러 막은 것" 인지 구분할 수 없다.
      available: DELEGATABLE_SCOPES,
      closed: CLOSED_SCOPES,
    });
  } catch {
    return fail(500, "DELEGATION_LOAD_FAILED", "위임 목록을 불러오지 못했습니다.");
  }
}

export async function POST(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  const couple = await findMyCouple(user.id);
  if (!couple) return fail(403, "COUPLE_REQUIRED", "커플 계정이 아닙니다.");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "DELEGATION_INVALID_BODY", "요청 본문을 읽지 못했습니다.");
  }

  const parsed = OfferSchema.safeParse(body);
  if (!parsed.success) return failValidation(parsed.error.issues);

  const result = await offerDelegation({
    coupleId: couple.coupleId,
    coupleRole: couple.role,
    plannerId: parsed.data.plannerId,
    form: {
      scopes: parsed.data.scopes,
      validFrom: parsed.data.validFrom,
      validTo: parsed.data.validTo,
    },
    actorId: user.id,
    actorRole: user.role,
    now: new Date(),
  });

  if (!result.ok) {
    return fail(result.status, result.code, result.message, {
      // **막은 이유를 전부 싣는다** — 하나씩 알려 주면 고치고 저장하기를 반복한다.
      reasons: delegationMessages(result.errors ?? []),
    });
  }

  return ok({ engagementId: result.engagementId }, { status: 201 });
}
