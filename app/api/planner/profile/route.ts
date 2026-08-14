import type { NextRequest } from "next/server";

import { fail, failValidation, ok } from "@/lib/api/response";
import { PlannerListingSchema, PlannerProfileSchema } from "@/lib/core/schemas/planner";
import { changeListing, isPlannerFailure, upsertProfile } from "@/lib/planners/actions";
import { loadMyPlanner } from "@/lib/planners/loader";
import { getSessionUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";

/**
 * 플래너 본인 프로필 (F-C-18 · §4 보완 제안)
 *
 *  - `GET`   내 프로필. 없으면 `null`(아직 등록하지 않음).
 *  - `PUT`   등록·수정. **요금을 받지 않는다** — 요율은 `planner_fee_rates` 가 갖는다(D-16).
 *  - `POST`  공개 신청 · 내리기.
 *
 * ── 공개는 심사의 결과다 ────────────────────────────────────────────────────
 * `PUT`·`POST` 어디서도 `status='active'` 를 받지 않는다. 본인이 보낼 수 있는 것은
 * **신청**(`pending`)과 **내리기**(`paused`)뿐이며, 0037 트리거가 자가 공개를 막는다.
 * 열어 두면 누구나 빈 프로필로 마켓에 나가고 심사가 형해화된다.
 *
 * ── 왜 `/api/planner/*` 인가 ────────────────────────────────────────────────
 * `/api/planners`(복수)는 **소비자용 마켓**이고 이쪽은 **본인 콘솔**이다. 인가 전제가
 * 달라(공개 vs 본인) 경로를 갈랐다 — 업체가 `/api/vendor/*` 와 `/api/vendors` 를
 * 가른 것과 같은 모양이다.
 */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  return ok({ planner: await loadMyPlanner(await createClient(), user.id) });
}

export async function PUT(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "PLANNER_INVALID_BODY", "요청 본문을 읽을 수 없습니다.");
  }

  const parsed = PlannerProfileSchema.safeParse(body);
  if (!parsed.success) return failValidation(parsed.error.issues);

  const result = await upsertProfile({ userId: user.id, profile: parsed.data });

  return isPlannerFailure(result)
    ? fail(result.status, result.code, result.message)
    : ok(result, { status: result.created ? 201 : 200 });
}

export async function POST(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "PLANNER_INVALID_BODY", "요청 본문을 읽을 수 없습니다.");
  }

  const parsed = PlannerListingSchema.safeParse(body);
  if (!parsed.success) return failValidation(parsed.error.issues);

  const result = await changeListing({ userId: user.id, action: parsed.data.action });

  return isPlannerFailure(result) ? fail(result.status, result.code, result.message) : ok(result);
}
