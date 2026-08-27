import type { NextRequest } from "next/server";
import { z } from "zod";

import { loadEntityTimeline } from "@/lib/admin/audit";
import { fail, failValidation, ok } from "@/lib/api/response";
import { getSessionUser, isOperator } from "@/lib/supabase/auth";

/**
 * GET /api/admin/entity-events — 분쟁 조사용 타임라인 (F-A-12·F-A-16, §4.3)
 *
 * 엔티티 하나를 기준으로 **상태 전이·행위 이력을 시간순**으로 낸다. §4.3 이 이 경로를
 * **읽기 전용**으로 못 박았으므로 POST·PATCH 를 두지 않는다 — 증적은 조사하는 것이지
 * 고치는 것이 아니고, 0053 이 DB 트리거로도 같은 말을 한다(`EVIDENCE_APPEND_ONLY`).
 *
 * **S8-03(분쟁 조율)이 이 경로를 그대로 쓴다.** 조율 화면이 자기 타임라인을 따로 만들면
 * 같은 사건이 두 화면에서 다르게 보이고, 그때 어느 쪽이 증거인지 답할 수 없다.
 */
export const dynamic = "force-dynamic";

const QuerySchema = z
  .object({
    entityType: z.string().trim().min(1).max(80),
    entityId: z.string().uuid(),
  })
  .strict();

export async function GET(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");
  if (!isOperator(user)) return fail(403, "ADMIN_FORBIDDEN", "권한이 없습니다.");

  const parsed = QuerySchema.safeParse({
    entityType: request.nextUrl.searchParams.get("entityType") ?? undefined,
    entityId: request.nextUrl.searchParams.get("entityId") ?? undefined,
  });

  // **여기서는 조건을 버리지 않고 거절한다.** 목록 화면과 다른 판단이다 — 대상을 못
  // 알아들은 채로 조회하면 **엉뚱한 엔티티의 타임라인**을 그 대상의 것인 양 보여준다.
  if (!parsed.success) return failValidation(parsed.error.issues);

  try {
    const payload = await loadEntityTimeline(parsed.data.entityType, parsed.data.entityId);

    return ok({
      entityType: parsed.data.entityType,
      entityId: parsed.data.entityId,
      entries: payload.entries,
      actors: payload.actors,
      // 빈 타임라인과 "못 읽었다" 를 구분할 수 있게 개수를 함께 낸다.
      count: payload.entries.length,
    });
  } catch {
    return fail(500, "AUDIT_LOAD_FAILED", "타임라인을 불러오지 못했습니다.");
  }
}
