import type { NextRequest } from "next/server";

import { recordEvent } from "@/lib/audit/record";
import { fail, failValidation, ok } from "@/lib/api/response";
import { DeletionRequestSchema } from "@/lib/core/schemas/me";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSessionUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";

/**
 * POST/DELETE /api/me/delete-request — 계정·데이터 삭제 요청 (F-C-23, 명세서 §4.2)
 *
 * **접수까지만 한다.** 여기서 데이터를 지우지 않는다 — §7.3 이 "접수 후 SLA 내 처리하고
 * F-A-08 에서 추적한다" 로 정한 흐름이고, 즉시 삭제하면 오조작을 되돌릴 수 없으며
 * 법정 보존 대상을 가려낼 시간도 없다.
 *
 * `DELETE` 는 **요청을 거두는 것**이지 계정을 지우는 것이 아니다. 접수(`pending`)
 * 상태에서만 통하며, 그 경계는 앱이 아니라 **RLS 정책**이 갖는다(0018) —
 * `using(status='pending')` + `with check(status='cancelled')` 조합이라
 * 다른 전이는 애초에 0행이 된다.
 */
export async function POST(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "ME_INVALID_BODY", "요청 본문을 읽을 수 없습니다.");
  }

  const parsed = DeletionRequestSchema.safeParse(body);
  if (!parsed.success) return failValidation(parsed.error.issues);

  const supabase = await createClient();

  const { data: created, error } = await supabase
    .from("data_deletion_requests")
    .insert({ user_id: user.id, scope: parsed.data.scope, status: "pending" })
    .select("id, scope, status, requested_at")
    .maybeSingle();

  // 열린 요청은 사람당 하나다(0018 부분 유니크). 두 개면 어느 것을 처리했는지,
  // SLA 를 어느 쪽 기준으로 재는지 정할 수 없다.
  if (error?.code === "23505") {
    return fail(409, "ME_DELETE_REQUEST_OPEN", "이미 접수된 삭제 요청이 있어요.");
  }

  if (error?.code === "42501") {
    return fail(403, "ME_DELETE_REQUEST_FORBIDDEN", "요청할 권한이 없습니다.");
  }

  if (error || !created) {
    return fail(500, "ME_DELETE_REQUEST_FAILED", "요청을 접수하지 못했습니다.");
  }

  // 증적을 남긴다(D-23). **사유 본문은 넣지 않는다** — 개인정보가 섞일 수 있고,
  // 분쟁에 필요한 것은 '무엇을 썼는가' 가 아니라 '언제 어떤 상태였는가' 다(§7.3).
  const admin = createAdminClient();
  await recordEvent({
    entityType: "data_deletion_request",
    entityId: created.id,
    eventType: "deletion_requested",
    afterState: created.scope,
    actor: { id: user.id, role: user.role },
  });

  return ok(
    { id: created.id, scope: created.scope, status: created.status, requestedAt: created.requested_at },
    { status: 201 },
  );
}

export async function DELETE(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  const id = request.nextUrl.searchParams.get("id");
  if (!id) return fail(422, "ME_DELETE_REQUEST_ID_REQUIRED", "거둘 요청을 지정해 주세요.");

  const supabase = await createClient();

  const { data: cancelled } = await supabase
    .from("data_deletion_requests")
    .update({ status: "cancelled", completed_at: new Date().toISOString() })
    .eq("id", id)
    .select("id");

  // UPDATE 는 정책에 막혀도 에러가 아니라 0행이다. 거뒀다고 답하면 안 된다.
  if (!cancelled || cancelled.length === 0) {
    return fail(
      409,
      "ME_DELETE_REQUEST_NOT_CANCELLABLE",
      "이미 처리가 시작됐거나 끝난 요청이라 거둘 수 없어요.",
    );
  }

  const admin = createAdminClient();
  await recordEvent({
    entityType: "data_deletion_request",
    entityId: id,
    eventType: "deletion_request_cancelled",
    afterState: "cancelled",
    actor: { id: user.id, role: user.role },
  });

  return ok({ id, status: "cancelled" });
}
