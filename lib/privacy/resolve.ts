import { recordEvent } from "@/lib/audit/record";
import {
  type DeletionAction,
  type DeletionStatus,
  canApply,
  isTerminal,
  statusAfter,
} from "@/lib/core/privacy/deletion";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * 삭제 요청 처리 (S8-04 · F-A-08)
 *
 * **변경은 서비스롤 경유다**(D-62). 조회는 RLS(`data_deletion_requests_select_operator`)가
 * 경계이지만, 처리는 **되돌릴 수 없는 조치**라 운영자에게 UPDATE 정책을 주지 않는다 —
 * 정책을 주면 그 권한이 클라이언트 번들이 닿는 자리에 놓인다(S7-17 이 모더레이션에서
 * 내린 판단과 같다).
 *
 * **판정은 세 층이 같은 말을 한다.** 화면(`deletionProblem`) · 이 함수 · DB CHECK.
 * 한 층만 두면 다른 경로로 들어온 요청이 사유 없이 지나간다.
 */
export type ResolveInput = {
  requestId: string;
  action: DeletionAction;
  reason: string;
  operatorId: string;
  operatorRole: string | null;
  now: string;
};

export type ResolveResult =
  | { ok: true; status: DeletionStatus }
  | { ok: false; status: number; code: string; message: string };

export async function resolveDeletionRequest(input: ResolveInput): Promise<ResolveResult> {
  const admin = createAdminClient();

  const { data: current, error: loadError } = await admin
    .from("data_deletion_requests")
    .select("id, status")
    .eq("id", input.requestId)
    .maybeSingle();

  if (loadError) {
    return { ok: false, status: 500, code: "PRIVACY_LOAD_FAILED", message: "요청을 불러오지 못했습니다." };
  }
  if (!current) {
    return { ok: false, status: 404, code: "PRIVACY_NOT_FOUND", message: "요청을 찾을 수 없습니다." };
  }

  const before = (current as { status: DeletionStatus }).status;

  if (!canApply(before, input.action)) {
    return {
      ok: false,
      status: 409,
      code: "PRIVACY_INVALID_TRANSITION",
      message: isTerminal(before)
        ? "이미 끝난 요청입니다. 되돌리려면 새 요청으로 접수해 주세요."
        : "지금 상태에서는 할 수 없는 조치입니다.",
    };
  }

  const after = statusAfter(input.action);
  // `completed`·`rejected`·`cancelled` 에는 `completed_at` 이 필수다(0004 CHECK).
  // `in_progress` 는 끝난 것이 아니므로 비워 둔다 — 채우면 "언제 끝났나" 가 거짓이 된다.
  const completedAt = isTerminal(after) ? input.now : null;

  const { error: updateError } = await admin
    .from("data_deletion_requests")
    .update({
      status: after,
      completed_at: completedAt,
      resolved_by: input.operatorId,
      resolution_reason: input.reason,
    })
    // **낙관적 잠금.** 그 사이 다른 운영자가 처리했으면 덮어쓰지 않는다.
    .eq("id", input.requestId)
    .eq("status", before);

  if (updateError) {
    return { ok: false, status: 500, code: "PRIVACY_UPDATE_FAILED", message: "처리하지 못했습니다." };
  }

  // 상태 변경을 증적으로 남긴다. **사유 본문을 담지 않는다**(§7.3) — 행이 이미 갖고
  // 있고 옮겨 적으면 두 곳이 갈린다. 남길 사실은 **전이와 범위**다.
  await recordEvent({
    entityType: "data_deletion_request",
    entityId: input.requestId,
    eventType: `deletion_request_${input.action}`,
    actor: { id: input.operatorId, role: input.operatorRole },
    beforeState: before,
    afterState: after,
    source: "admin",
  });

  // 운영자 액션은 `audit_logs` 에도 남긴다(§7.2 · 공통 제약).
  // **근거가 된 이벤트 id 를 함께 남긴다** — 방금 쓴 증적이 이 결정의 근거다.
  const { data: basisRows } = await admin
    .from("entity_events")
    .select("id")
    .eq("entity_type", "data_deletion_request")
    .eq("entity_id", input.requestId)
    .order("occurred_at", { ascending: false })
    .limit(10);

  const basis = ((basisRows ?? []) as { id: string }[]).map((row) => row.id);

  await admin.from("audit_logs").insert({
    actor_id: input.operatorId,
    actor_role: input.operatorRole,
    action: `deletion_request_${input.action}`,
    target_type: "data_deletion_request",
    target_id: input.requestId,
    before_json: { status: before },
    after_json: { status: after },
    // 빈 배열은 CHECK 이 막는다 — '아무것도 안 보고 정했다' 는 상태가 없다.
    resolution_basis: basis.length > 0 ? basis : null,
  });

  return { ok: true, status: after };
}
