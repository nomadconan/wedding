import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, failValidation, ok } from "@/lib/api/response";
import { applyVerdict } from "@/lib/consultation/actions";
import { isOpenFor } from "@/lib/core/dispute/queue";
import { loadDisputeQueue } from "@/lib/dispute/loader";
import { getSessionUser, isOperator } from "@/lib/supabase/auth";

/**
 * GET/PATCH /api/admin/consultation-disputes — 노쇼 분쟁 조율 (F-A-16, §4.3 · S4-10)
 *
 * **S4-10 이 남겨 둔 자리다** — 큐는 S4-07 부터 쌓이고 있었고(`status='disputed'` ·
 * 부분 인덱스) 운영자 화면만 8단계로 미뤄져 있었다. S8-03 이 그 화면을 세우면서
 * 이 경로도 함께 연다.
 *
 * **집행은 여기서 새로 만들지 않는다.** 보증금의 판정·정산은 `applyVerdict` 가 이미
 * 하고 있고(S4-09), 그 함수가 무응답의 기본값(**환불** · D-22)을 들고 있다.
 * 조율 콘솔이 같은 판정을 다시 구현하면 **어느 한쪽의 기본값이 조용히 바뀐다**
 * (S5-09 가 이행 확인을 공통화하지 않은 것과 같은 이유 · D-121).
 *
 * `force-dynamic` (FIX-22 계열).
 */
export const dynamic = "force-dynamic";

/**
 * 운영자가 정하는 것은 **양측의 이행 결과**이고 돈의 방향은 `applyVerdict` 가 정한다.
 * 금액을 입력받지 않는다 — `/admin/penalties`·`/admin/settlements` 와 같은 규칙이다.
 */
const PatchSchema = z
  .object({
    consultationId: z.string().uuid(),
    couple: z.enum(["fulfilled", "no_show_couple", "no_show_vendor", "undetermined"]),
    vendor: z.enum(["fulfilled", "no_show_couple", "no_show_vendor", "undetermined"]),
    reason: z.string().trim().min(1, "조율 사유를 적어 주세요.").max(1_000),
  })
  .strict();

export async function GET() {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");
  if (!isOperator(user)) return fail(403, "ADMIN_FORBIDDEN", "권한이 없습니다.");

  const payload = await loadDisputeQueue();
  const items = payload.items.filter((item) => item.source === "consultation");

  return ok({
    items,
    open: items.filter((item) => isOpenFor("consultation", item.status)).length,
    // **읽지 못한 것과 없는 것을 가른다** — 실패를 '분쟁 없음' 으로 그리지 않는다.
    failed: payload.failedSources.includes("consultation"),
  });
}

export async function PATCH(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");
  if (!isOperator(user)) return fail(403, "ADMIN_FORBIDDEN", "권한이 없습니다.");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "DISPUTE_INVALID_BODY", "요청 본문을 읽지 못했습니다.");
  }

  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) return failValidation(parsed.error.issues);

  try {
    // 기존 판정 경로를 그대로 부른다. 무응답 기본값도 그쪽 규칙이다.
    const verdict = await applyVerdict(
      parsed.data.consultationId,
      parsed.data.couple,
      parsed.data.vendor,
      user.id,
    );

    return ok({ consultationId: parsed.data.consultationId, verdict });
  } catch {
    return fail(500, "DISPUTE_VERDICT_FAILED", "조율 결과를 적용하지 못했습니다.");
  }
}
