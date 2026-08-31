import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, failValidation, ok } from "@/lib/api/response";
import { findMyCouple } from "@/lib/couple/membership";
import {
  SCOPE_CROSS_AXIS_NOTICE,
  SCOPE_ENFORCEMENT_NOTICE,
  SCOPE_RATE_UNKNOWN_NOTICE,
} from "@/lib/core/planner/scope";
import { loadScopePayload, scopeMessages, updateScopes } from "@/lib/planners/scopes";
import { getSessionUser } from "@/lib/supabase/auth";

/**
 * GET/PUT /api/planner-scopes — 카테고리별 플래너 이용 여부 (F-C-31 · §4.2 · S6-03)
 *
 * **`coupleId` 를 입력으로 받지 않는다** — 세션이 정한다. 받으면 남의 커플에 수수료를
 * 붙이는 요청을 만들 수 있고, 그 돈은 **그 커플이 낸다**(FIX-45 와 같은 자리).
 *
 * **PUT 은 원하는 상태 전체를 받는다.** 그러나 **전부 지우고 다시 넣지 않는다** —
 * 서버가 차이만 움직인다. 안 바뀐 행을 해제했다 다시 선택하면 "그 사이에는 안 썼다"
 * 는 거짓 구간이 이력에 남는다(D-23).
 *
 * **변경 시 총액을 다시 계산해 함께 돌려준다**(§4.2 가 요구하는 "선택 즉시 재계산").
 * 화면이 자기 계산으로 그리면 요율을 모르는 클라이언트가 금액을 지어내게 된다.
 *
 * **집행 지점을 본문에 싣는다**(함정 3) — 이 선택은 화면 표시가 아니라 **계약 발행이
 * 읽는 값**이다. 안 적으면 이 API 를 쓰는 다음 사람은 표시용이라고 읽는다.
 */
export const dynamic = "force-dynamic";

const UpdateSchema = z.object({
  selections: z
    .array(
      z.object({
        // 어휘 판정은 순수 함수가 한다 — 여기서는 모양만 본다.
        category: z.string().trim().min(1).max(40),
        plannerId: z.string().uuid(),
      }),
    )
    .max(20),
});

const notices = {
  enforcement: SCOPE_ENFORCEMENT_NOTICE,
  rateUnknown: SCOPE_RATE_UNKNOWN_NOTICE,
  crossAxis: SCOPE_CROSS_AXIS_NOTICE,
};

export async function GET() {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  const couple = await findMyCouple(user.id);
  if (!couple) return fail(403, "COUPLE_REQUIRED", "커플 계정이 아닙니다.");

  try {
    const payload = await loadScopePayload({ coupleId: couple.coupleId, now: new Date() });

    return ok({ ...payload, notices });
  } catch {
    return fail(500, "SCOPE_LOAD_FAILED", "플래너 이용 범위를 불러오지 못했습니다.");
  }
}

export async function PUT(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  const couple = await findMyCouple(user.id);
  if (!couple) return fail(403, "COUPLE_REQUIRED", "커플 계정이 아닙니다.");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "SCOPE_INVALID_BODY", "요청 본문을 읽지 못했습니다.");
  }

  const parsed = UpdateSchema.safeParse(body);
  if (!parsed.success) return failValidation(parsed.error.issues);

  const now = new Date();
  const result = await updateScopes({
    coupleId: couple.coupleId,
    // **커플 구성원 누구나 고른다**(0036) — 결제·서명과 달리 구성 선택이고,
    // 장바구니 항목 토글을 배우자도 바꿀 수 있는 것과 같은 층이다.
    desired: parsed.data.selections as never,
    actorId: user.id,
    actorRole: user.role,
    now,
  });

  if (!result.ok) {
    return fail(result.status, result.code, result.message, {
      reasons: scopeMessages(result.errors ?? []),
    });
  }

  // **바꾼 뒤의 총액을 함께 낸다**(§4.2 — 선택 즉시 재계산).
  const payload = await loadScopePayload({ coupleId: couple.coupleId, now });

  return ok({ ...payload, notices, changed: { selected: result.selected, released: result.released } });
}
