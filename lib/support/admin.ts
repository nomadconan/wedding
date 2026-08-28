import { recordEvent } from "@/lib/audit/record";
import {
  type QueueCount,
  type TicketActionInput,
  type TicketCategory,
  type TicketSummary,
  type VendorSanctionInput,
  canApply,
  statusAfter,
  summarize,
} from "@/lib/core/support/ticket";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

/**
 * CS·신고 콘솔 (S8-09 · F-A-06)
 *
 * **읽는 방식을 셋으로 가른다**(D-120 과 같은 갈림길).
 *
 * | 대상 | 방식 | 왜 |
 * |---|---|---|
 * | 티켓 | 세션 + **운영자 정책** | 본문을 읽지 않고는 처리할 수 없다 — **행이 목적**이다(D-115) |
 * | 옆 큐 열린 건수 | 세션 + 각 표의 운영자 정책 | **합계만** 필요하다. 합치지 않고 가리키기만 한다 |
 * | 처리·제재 | **서비스롤** | 운영자에게 UPDATE 를 주면 컬럼 권한이 역할 단위라 **신고자에게도 같은 칸이 열린다**(D-62 · D-130) |
 *
 * **담당자 이름은 좁게만 연다.** `profiles` 정책이 운영자를 모르므로 임베드하면
 * 이름이 조용히 null 이 되고(함정 1 · S8-02 가 물린 자리) 정책을 주면 이름 하나에
 * 프로필이 통째로 열린다 — S8-02 가 만든 `admin_actor_labels()` 를 그대로 쓴다.
 */

export type TicketRow = {
  id: string;
  category: TicketCategory;
  subject: string;
  body: string | null;
  status: string;
  assigneeId: string | null;
  assigneeName: string | null;
  reporterId: string | null;
  resolution: string | null;
  resolvedAt: string | null;
  createdAt: string;
};

export type SupportConsole = {
  tickets: TicketRow[];
  summary: TicketSummary;
  /** 옆 큐 열린 건수. **0건도 줄을 남긴다** — 사라지면 그 큐가 없는 줄 안다. */
  siblings: QueueCount[];
  /** 지금 공개 중지된 업체. 제재를 되돌릴 자리가 화면에 있어야 한다. */
  suspendedVendors: { id: string; name: string }[];
};

const TICKET_COLUMNS =
  "id, category, subject, body, status, assignee_id, reporter_id, resolution, resolved_at, created_at";

export async function loadSupportConsole(): Promise<SupportConsole> {
  const supabase = await createClient();

  const [
    { data: ticketData, error },
    { data: communityData },
    { data: reviewData },
    { data: findingData },
    { data: vendorData },
  ] = await Promise.all([
    supabase.from("tickets").select(TICKET_COLUMNS).order("created_at", { ascending: false }).limit(300),
    // **합계만 필요하다.** 각 표의 운영자 정책으로 읽고 건수만 센다 — 합치지 않는다.
    supabase.from("community_reports").select("id").eq("status", "open").limit(500),
    supabase.from("review_reports").select("id").eq("status", "open").limit(500),
    supabase.from("finding_reports").select("id").eq("status", "open").limit(500),
    supabase.from("vendors").select("id, name").eq("status", "suspended").limit(200),
  ]);

  if (error) throw new Error("SUPPORT_LOAD_FAILED");

  const rows = (ticketData ?? []) as {
    id: string;
    category: TicketCategory;
    subject: string;
    body: string | null;
    status: string;
    assignee_id: string | null;
    reporter_id: string | null;
    resolution: string | null;
    resolved_at: string | null;
    created_at: string;
  }[];

  const names = await loadActorNames(
    supabase,
    rows.map((row) => row.assignee_id).filter((id): id is string => id !== null),
  );

  const tickets: TicketRow[] = rows.map((row) => ({
    id: row.id,
    category: row.category,
    subject: row.subject,
    body: row.body,
    status: row.status,
    assigneeId: row.assignee_id,
    assigneeName: row.assignee_id === null ? null : (names.get(row.assignee_id) ?? null),
    // **신고자 id 는 화면에 그리지 않는다** — 처리에 필요한 것은 내용이지 사람이 아니다.
    reporterId: row.reporter_id,
    resolution: row.resolution,
    resolvedAt: row.resolved_at,
    createdAt: row.created_at,
  }));

  return {
    tickets,
    summary: summarize(tickets),
    siblings: [
      { key: "community", open: (communityData ?? []).length },
      { key: "review", open: (reviewData ?? []).length },
      { key: "finding", open: (findingData ?? []).length },
    ],
    suspendedVendors: (vendorData ?? []) as { id: string; name: string }[],
  };
}

/**
 * 담당자 이름.
 *
 * **`profiles` 를 임베드하지 않는다**(함정 1). 그쪽 정책이 운영자를 모르므로
 * 임베드하면 이름이 조용히 null 이 되고, 정책을 주면 이름 하나에 프로필이 통째로
 * 열린다. S8-02 가 만든 함수가 `display_name`·`role` **두 칸만** 돌려준다.
 */
async function loadActorNames(
  supabase: Awaited<ReturnType<typeof createClient>>,
  ids: string[],
): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();

  // **세션 클라이언트로 부른다.** 이 함수는 SECURITY DEFINER 이지만 경계가
  // `is_operator()` 라 **서비스롤로 부르면 `auth.uid()` 가 없어 막힌다**(S8-01 이
  // 지표 함수에서 정한 것과 같은 규약이고 `db:rls` 가 그것을 확인한다).
  const { data, error } = await supabase.rpc("admin_actor_labels", { p_ids: unique });
  if (error) return new Map();

  return new Map(
    ((data ?? []) as { user_id: string; display_name: string | null }[]).map((row) => [
      row.user_id,
      row.display_name ?? "이름 없음",
    ]),
  );
}

export type SupportResult =
  | { ok: true }
  | { ok: false; status: number; code: string; message: string };

/**
 * 티켓 처리 (F-A-06).
 *
 * **서비스롤로 쓴다**(D-62). 운영자에게 UPDATE 정책을 주면 컬럼 권한이 역할 단위라
 * 신고자에게도 `status`·`resolution` 이 열린다 — FIX-43 이 막으려던 바로 그 상태로
 * 되돌아간다.
 *
 * **담당자를 입력으로 받지 않는다.** 배정은 항상 **자기 자신**이다 — 남을 배정할 수
 * 있으면 "저 사람이 맡았다" 는 기록을 아무나 만들 수 있고, 그 기록이 곧 책임 소재가
 * 된다. 다른 사람에게 넘기려면 그 사람이 직접 맡는다.
 */
export async function applyTicketAction(
  input: TicketActionInput & { operatorId: string; operatorRole: string | null },
): Promise<SupportResult> {
  const admin = createAdminClient();

  const { data: current } = await admin
    .from("tickets")
    .select("id, status, assignee_id")
    .eq("id", input.ticketId)
    .maybeSingle();

  if (!current) {
    return { ok: false, status: 404, code: "TICKET_NOT_FOUND", message: "티켓을 찾을 수 없습니다." };
  }

  if (!canApply(current.status, input.action)) {
    return {
      ok: false,
      status: 409,
      code: "TICKET_TERMINAL",
      message: "이미 종결된 티켓입니다. 다시 열려면 새로 접수해 주세요.",
    };
  }

  const next = statusAfter(input.action);
  const now = new Date().toISOString();

  const { error } = await admin
    .from("tickets")
    .update(
      input.action === "assign"
        ? { status: next, assignee_id: input.operatorId }
        : {
            status: next,
            // 종결에는 사유·처리자·시각이 함께 있어야 한다(DB CHECK 이 같은 말을 한다).
            resolution: input.note,
            resolved_by: input.operatorId,
            resolved_at: now,
            // 맡은 사람이 없는 채로 종결되면 "누가 처리했나" 가 사라진다.
            assignee_id: current.assignee_id ?? input.operatorId,
          },
    )
    .eq("id", input.ticketId);

  if (error) {
    return { ok: false, status: 500, code: "TICKET_UPDATE_FAILED", message: "처리하지 못했습니다." };
  }

  await recordEvent({
    entityType: "ticket",
    entityId: input.ticketId,
    eventType: `ticket_${input.action}ed`,
    actor: { id: input.operatorId, role: input.operatorRole },
    beforeState: current.status,
    afterState: next,
    source: "admin",
    // **본문도 사유도 담지 않는다**(§7.3). 행과 감사 로그가 갖는다.
  });

  await writeAuditLog(admin, {
    actorId: input.operatorId,
    actorRole: input.operatorRole,
    action: `ticket_${input.action}`,
    targetType: "ticket",
    targetId: input.ticketId,
    before: { status: current.status },
    after: { status: next },
  });

  return { ok: true };
}

/**
 * 업체 공개 중지·재개 (F-A-06 '업체 제재').
 *
 * **집행이 실재한다.** `vendors_select_public` 이 `status = 'active'` 만 공개하므로
 * 중지하면 탐색·검색·상세에서 실제로 사라진다 — 화면이 "중지했다" 고 적으면 그것이
 * 사실이다.
 *
 * **진행 중인 예약·계약은 건드리지 않는다.** 그것은 별도 절차(해지·환불)이고 여기서
 * 함께 처리하면 **되돌릴 수 없는 일 둘을 한 버튼에 묶는 것**이 된다. 화면이 그 사실을
 * 미리 적는다.
 *
 * **심사 상태(`pending`)를 덮지 않는다** — 심사 중인 업체를 '중지' 로 바꾸면 F-A-01 의
 * 심사 큐에서 사라지고, 되돌릴 때 어느 상태로 돌아가야 하는지 알 수 없다.
 */
export async function applyVendorSanction(
  input: VendorSanctionInput & { operatorId: string; operatorRole: string | null },
): Promise<SupportResult> {
  const admin = createAdminClient();

  const { data: vendor } = await admin
    .from("vendors")
    .select("id, status")
    .eq("id", input.vendorId)
    .maybeSingle();

  if (!vendor) {
    return { ok: false, status: 404, code: "VENDOR_NOT_FOUND", message: "업체를 찾을 수 없습니다." };
  }

  const next = input.sanction === "suspend" ? "suspended" : "active";

  if (vendor.status === next) {
    return { ok: false, status: 409, code: "VENDOR_ALREADY_IN_STATE", message: "이미 그 상태입니다." };
  }

  if (input.sanction === "suspend" && vendor.status !== "active") {
    return {
      ok: false,
      status: 409,
      code: "VENDOR_NOT_ACTIVE",
      message: "공개 중인 업체만 중지할 수 있습니다. 심사 중인 업체는 입점 심사에서 다룹니다.",
    };
  }

  if (input.sanction === "reinstate" && vendor.status !== "suspended") {
    return {
      ok: false,
      status: 409,
      code: "VENDOR_NOT_SUSPENDED",
      message: "중지된 업체만 되돌릴 수 있습니다.",
    };
  }

  const { error } = await admin.from("vendors").update({ status: next }).eq("id", input.vendorId);

  if (error) {
    return { ok: false, status: 500, code: "VENDOR_SANCTION_FAILED", message: "조치하지 못했습니다." };
  }

  await recordEvent({
    entityType: "vendor",
    entityId: input.vendorId,
    eventType: input.sanction === "suspend" ? "vendor_suspended" : "vendor_reinstated",
    actor: { id: input.operatorId, role: input.operatorRole },
    beforeState: vendor.status,
    afterState: next,
    source: "admin",
    // **사유 본문을 담지 않는다**(§7.3). 어느 티켓에서 나왔는지만 남긴다 —
    // 그 연결이 나중에 "왜 이 업체가 사라졌나" 의 답이 된다.
    memo: input.ticketId === null ? "source:direct" : `ticket:${input.ticketId.slice(0, 8)}`,
  });

  await writeAuditLog(admin, {
    actorId: input.operatorId,
    actorRole: input.operatorRole,
    action: `vendor_${input.sanction}`,
    targetType: "vendor",
    targetId: input.vendorId,
    before: { status: vendor.status },
    after: { status: next, reason: input.reason, ticketId: input.ticketId },
  });

  return { ok: true };
}

/** 운영자 액션은 `audit_logs` 에도 남기고 **근거 이벤트 id 를 함께** 남긴다(§7.2). */
async function writeAuditLog(
  admin: ReturnType<typeof createAdminClient>,
  input: {
    actorId: string;
    actorRole: string | null;
    action: string;
    targetType: string;
    targetId: string;
    before: Record<string, unknown>;
    after: Record<string, unknown>;
  },
): Promise<void> {
  const { data: basisRows } = await admin
    .from("entity_events")
    .select("id")
    .eq("actor_id", input.actorId)
    .order("occurred_at", { ascending: false })
    .limit(5);

  const basis = ((basisRows ?? []) as { id: string }[]).map((row) => row.id);

  await admin.from("audit_logs").insert({
    actor_id: input.actorId,
    actor_role: input.actorRole,
    action: input.action,
    target_type: input.targetType,
    target_id: input.targetId,
    before_json: input.before,
    after_json: input.after,
    // 빈 배열은 CHECK 이 막는다.
    resolution_basis: basis.length > 0 ? basis : null,
  });
}
