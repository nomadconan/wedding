import { recordEvent } from "@/lib/audit/record";
import {
  type DisputeAction,
  type DisputeStatus,
  canApply,
  isTerminal,
  statusAfter,
} from "@/lib/core/dispute/mediation";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * 예약 분쟁 조율 (S8-03 · F-A-12 · D-24)
 *
 * **변경은 서비스롤 경유다**(D-62). 조회는 RLS 가 경계이지만 조율 결과는 되돌릴 수
 * 없는 기록이라 운영자에게 UPDATE 정책을 주지 않는다.
 *
 * **여기서 돈을 움직이지 않는다.** 환불·몰취·정산 조정은 각 도메인이 이미 가진
 * 집행 경로(`resolveEscrow`·`applyVerdict`·`resolveCancellation`)가 한다 — 이 함수는
 * `disputes` 표의 조율 기록만 남긴다(D-121: 읽기는 하나로, 집행은 각자).
 * 예약 분쟁 자체에는 걸린 돈이 없다. 돈이 걸린 건은 큐에서 그 도메인으로 넘어간다.
 */
export type MediateInput = {
  disputeId: string;
  action: DisputeAction;
  note: string;
  coupleAgreed: boolean;
  vendorAgreed: boolean;
  operatorId: string;
  operatorRole: string | null;
  now: string;
};

export type MediateResult =
  | { ok: true; status: DisputeStatus }
  | { ok: false; status: number; code: string; message: string };

export async function mediateDispute(input: MediateInput): Promise<MediateResult> {
  const admin = createAdminClient();

  const { data: current, error: loadError } = await admin
    .from("disputes")
    .select("id, status, couple_agreed, vendor_agreed")
    .eq("id", input.disputeId)
    .maybeSingle();

  if (loadError) {
    return { ok: false, status: 500, code: "DISPUTE_LOAD_FAILED", message: "분쟁을 불러오지 못했습니다." };
  }
  if (!current) {
    return { ok: false, status: 404, code: "DISPUTE_NOT_FOUND", message: "분쟁을 찾을 수 없습니다." };
  }

  const before = (current as { status: DisputeStatus }).status;

  if (!canApply(before, input.action)) {
    return {
      ok: false,
      status: 409,
      code: "DISPUTE_INVALID_TRANSITION",
      message: "이미 종결된 건입니다. 다시 다퉈야 하면 새 건으로 접수해 주세요.",
    };
  }

  // **양측 동의 없이는 합의가 아니다.** 화면이 먼저 막지만 다른 경로로 들어온 요청이
  // 있을 수 있고, DB CHECK 가 마지막으로 한 번 더 본다(세 층).
  if (input.action === "agree" && !(input.coupleAgreed && input.vendorAgreed)) {
    return {
      ok: false,
      status: 422,
      code: "DISPUTE_AGREEMENT_INCOMPLETE",
      message: "양측이 모두 동의해야 합의로 기록할 수 있습니다.",
    };
  }

  const after = statusAfter(input.action);
  const terminal = isTerminal(after);

  const patch: Record<string, unknown> = {
    status: after,
    // 동의 여부는 조치와 무관하게 기록한다 — 조율 중에도 한쪽이 먼저 동의할 수 있고
    // 그 진행 상태를 화면이 보여줘야 한다.
    couple_agreed: input.coupleAgreed,
    vendor_agreed: input.vendorAgreed,
  };

  if (input.action === "propose") patch.proposal_note = input.note;
  if (terminal) {
    patch.resolution_note = input.note;
    patch.resolved_by = input.operatorId;
    patch.resolved_at = input.now;
  }

  const { error: updateError } = await admin
    .from("disputes")
    .update(patch)
    .eq("id", input.disputeId)
    // **낙관적 잠금.** 그 사이 다른 운영자가 종결했으면 덮어쓰지 않는다.
    .eq("status", before);

  if (updateError) {
    return { ok: false, status: 500, code: "DISPUTE_UPDATE_FAILED", message: "기록하지 못했습니다." };
  }

  // 상태 전이를 증적으로 남긴다. **사유 본문을 담지 않는다**(§7.3) — 행이 이미 갖고
  // 있고 옮겨 적으면 두 곳이 갈린다. 남길 사실은 전이와 **동의 상태**다.
  await recordEvent({
    entityType: "dispute",
    entityId: input.disputeId,
    eventType: `dispute_${input.action}`,
    actor: { id: input.operatorId, role: input.operatorRole },
    beforeState: before,
    afterState: after,
    source: "admin",
    memo: `agreed:${input.coupleAgreed ? "c" : "-"}${input.vendorAgreed ? "v" : "-"}`,
  });

  // 운영자 액션은 `audit_logs` 에도 남기고 **근거가 된 이벤트 id 를 함께** 남긴다
  // (§7.2 · 공통 제약). 조율은 기록을 근거로 하는 일이라 이 연결이 특히 중요하다.
  const { data: basisRows } = await admin
    .from("entity_events")
    .select("id")
    .eq("entity_type", "dispute")
    .eq("entity_id", input.disputeId)
    .order("occurred_at", { ascending: false })
    .limit(20);

  const basis = ((basisRows ?? []) as { id: string }[]).map((row) => row.id);

  await admin.from("audit_logs").insert({
    actor_id: input.operatorId,
    actor_role: input.operatorRole,
    action: `dispute_${input.action}`,
    target_type: "dispute",
    target_id: input.disputeId,
    before_json: { status: before },
    after_json: { status: after, coupleAgreed: input.coupleAgreed, vendorAgreed: input.vendorAgreed },
    // 빈 배열은 CHECK 이 막는다 — '아무것도 안 보고 정했다' 는 상태가 없다.
    resolution_basis: basis.length > 0 ? basis : null,
  });

  return { ok: true, status: after };
}
