import type { NextRequest } from "next/server";

import { recordEvent } from "@/lib/audit/record";
import { fail, failValidation, ok } from "@/lib/api/response";
import {
  VendorMemberRoleChangeSchema,
  removeBlocker,
  roleChangeBlocker,
} from "@/lib/core/schemas/vendor-member";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSessionUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";
import { loadVendorMembers } from "@/lib/vendor/members";
import { findMemberVendor } from "@/lib/vendor/products";

/**
 * PATCH/DELETE /api/vendor/members/[userId] — 권한 변경·제거 (F-V-13, §4.3)
 *
 * 판정은 `lib/core` 의 순수 함수(`roleChangeBlocker`·`removeBlocker`)로 한다.
 * **화면이 쓰는 함수와 같은 것**이라 화면은 통과인데 서버가 막는 상황이 생기지 않는다.
 * DB 에도 같은 규칙이 있다 — 마지막 owner 는 트리거가, 자기 제거는 RLS 가 막는다.
 */

/**
 * 행위자가 이 업체의 owner 인가.
 *
 * 업무 규칙(마지막 대표·자기 제거)보다 **권한을 먼저** 본다.
 * staff 에게 "마지막 대표는 제거할 수 없습니다"(422)라고 답하면 권한 문제를 입력 문제로
 * 오인시키고, 조건만 맞으면 가능하다는 인상을 준다. 최종 경계는 여전히 RLS 다.
 */
async function actorIsOwner(vendorId: string, userId: string): Promise<boolean> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("vendor_members")
    .select("vendor_role")
    .eq("vendor_id", vendorId)
    .eq("user_id", userId)
    .maybeSingle();

  return data?.vendor_role === "owner";
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ userId: string }> },
) {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  const { userId } = await context.params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "VENDOR_INVALID_BODY", "요청 본문을 읽을 수 없습니다.");
  }

  const parsed = VendorMemberRoleChangeSchema.safeParse(body);
  if (!parsed.success) return failValidation(parsed.error.issues);

  const vendor = await findMemberVendor(user.id);
  if (!vendor) return fail(404, "VENDOR_NOT_FOUND", "등록된 업체가 없습니다.");

  if (!(await actorIsOwner(vendor.id, user.id))) {
    return fail(403, "VENDOR_MEMBER_FORBIDDEN", "권한 변경은 업체 대표 계정만 할 수 있습니다.");
  }

  const members = await loadVendorMembers(vendor.id);
  const blocker = roleChangeBlocker(
    members.map((member) => ({ userId: member.userId, role: member.role })),
    userId,
    parsed.data.role,
  );

  if (blocker) {
    return fail(422, "VENDOR_MEMBER_ROLE_BLOCKED", blocker.message, [blocker]);
  }

  const supabase = await createClient();
  const { data: updated, error } = await supabase
    .from("vendor_members")
    .update({ vendor_role: parsed.data.role })
    .eq("vendor_id", vendor.id)
    .eq("user_id", userId)
    .select("id, user_id, vendor_role")
    .maybeSingle();

  if (error) return fail(500, "VENDOR_MEMBER_SAVE_FAILED", "권한을 바꾸지 못했습니다.");
  if (!updated) {
    return fail(403, "VENDOR_MEMBER_FORBIDDEN", "권한 변경은 업체 대표 계정만 할 수 있습니다.");
  }

  const before = members.find((member) => member.userId === userId);
  const admin = createAdminClient();

  await admin.from("audit_logs").insert({
    actor_id: user.id,
    actor_role: user.role,
    action: "vendor_member_role_change",
    target_type: "vendor",
    target_id: vendor.id,
    before_json: { member_user_id: userId, vendor_role: before?.role ?? null },
    after_json: { member_user_id: userId, vendor_role: parsed.data.role },
  });

  await recordEvent({
    entityType: "vendor",
    entityId: vendor.id,
    eventType: "vendor_member_role_changed",
    beforeState: before?.role ?? null,
    afterState: parsed.data.role,
    actor: { id: user.id, role: user.role },
  });

  return ok({ member: updated });
}

export async function DELETE(
  _request: NextRequest,
  context: { params: Promise<{ userId: string }> },
) {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  const { userId } = await context.params;

  const vendor = await findMemberVendor(user.id);
  if (!vendor) return fail(404, "VENDOR_NOT_FOUND", "등록된 업체가 없습니다.");

  if (!(await actorIsOwner(vendor.id, user.id))) {
    return fail(403, "VENDOR_MEMBER_FORBIDDEN", "멤버 제거는 업체 대표 계정만 할 수 있습니다.");
  }

  const members = await loadVendorMembers(vendor.id);
  const blocker = removeBlocker(
    members.map((member) => ({ userId: member.userId, role: member.role })),
    userId,
    user.id,
  );

  if (blocker) {
    return fail(422, "VENDOR_MEMBER_REMOVE_BLOCKED", blocker.message, [blocker]);
  }

  const supabase = await createClient();
  const { data: deleted, error } = await supabase
    .from("vendor_members")
    .delete()
    .eq("vendor_id", vendor.id)
    .eq("user_id", userId)
    .select("id, user_id, vendor_role")
    .maybeSingle();

  if (error) return fail(500, "VENDOR_MEMBER_DELETE_FAILED", "멤버를 제거하지 못했습니다.");
  if (!deleted) {
    return fail(403, "VENDOR_MEMBER_FORBIDDEN", "멤버 제거는 업체 대표 계정만 할 수 있습니다.");
  }

  const admin = createAdminClient();

  await admin.from("audit_logs").insert({
    actor_id: user.id,
    actor_role: user.role,
    action: "vendor_member_remove",
    target_type: "vendor",
    target_id: vendor.id,
    before_json: { member_user_id: userId, vendor_role: deleted.vendor_role },
  });

  await recordEvent({
    entityType: "vendor",
    entityId: vendor.id,
    eventType: "vendor_member_removed",
    beforeState: deleted.vendor_role,
    actor: { id: user.id, role: user.role },
  });

  return ok({ userId });
}
