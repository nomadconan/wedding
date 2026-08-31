import type { NextRequest } from "next/server";

import { fail, failValidation, ok } from "@/lib/api/response";
import { findMyCouple } from "@/lib/couple/membership";
import { DelegationActionSchema } from "@/lib/core/schemas/planner";
import { plannerIdOf, respondToDelegation } from "@/lib/planners/delegation";
import { getSessionUser } from "@/lib/supabase/auth";

/**
 * PATCH /api/planner-engagements/[id] — 수락 · 거절 · 회수 (S6-04)
 *
 * **상태 문자열을 받지 않고 행위를 받는다.** 상태를 그대로 받으면 "누가 무엇으로
 * 옮길 수 있는가" 를 요청 본문이 정하게 된다 — 그 표는 순수 함수(`transitionAllowed`)
 * 가 갖고 DB 트리거가 같은 표를 든다.
 *
 * **DELETE 가 없다.** 해제는 상태 변경이지 삭제가 아니다(D-23) — 지우면 "언제부터
 * 언제까지 봤는가" 를 재현할 수 없다. 0069 가 권한과 정책을 함께 걷었다.
 */
export const dynamic = "force-dynamic";

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "DELEGATION_INVALID_BODY", "요청 본문을 읽지 못했습니다.");
  }

  const parsed = DelegationActionSchema.safeParse(body);
  if (!parsed.success) return failValidation(parsed.error.issues);

  // 한 사람이 커플 구성원이면서 플래너일 수 있다(로컬 시드는 갈라 두었지만 실서비스는
  // 막지 않는다). 그래서 **둘 다 조회하고 행위가 어느 자격을 요구하는지로 가른다.**
  const [couple, plannerId] = await Promise.all([findMyCouple(user.id), plannerIdOf(user.id)]);

  const result = await respondToDelegation({
    engagementId: params.id,
    action: parsed.data.action,
    actorId: user.id,
    actorRole: user.role,
    couple,
    plannerId,
  });

  if (!result.ok) return fail(result.status, result.code, result.message);

  return ok({ engagementId: result.engagementId });
}
