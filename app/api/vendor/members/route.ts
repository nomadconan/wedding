import type { NextRequest } from "next/server";

import { fail, failValidation, ok } from "@/lib/api/response";
import {
  UNREGISTERED_INVITE_MESSAGE,
  VendorMemberInviteSchema,
} from "@/lib/core/schemas/vendor-member";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSessionUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";
import { findUserByEmail, loadVendorMembers } from "@/lib/vendor/members";
import { findMemberVendor } from "@/lib/vendor/products";

/**
 * GET/POST /api/vendor/members — 멤버 초대·권한 설정 (F-V-13, 명세서 §4.3)
 *
 *  * 쓰기는 사용자 세션 클라이언트로 한다. `vendor_members` INSERT 정책이
 *    **owner 전용**이며(§3.9) 그것이 최종 경계다. staff 는 42501 → 403.
 *  * **미가입 이메일 초대는 이번 범위가 아니다**(S2-09). `vendor_members.user_id` 가
 *    `auth.users` FK 라 계정 없이는 행을 만들 수 없고, 초대 대기 테이블·메일 발송·수락
 *    화면이 함께 필요하다. 메일 발송은 알림 인프라(S4-13)에 의존하므로 지금 만들면
 *    발송 경로를 두 번 만들게 된다. 그래서 지금은 **가입된 이메일만** 연결한다.
 */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  const vendor = await findMemberVendor(user.id);
  if (!vendor) return fail(404, "VENDOR_NOT_FOUND", "등록된 업체가 없습니다.");

  return ok({ members: await loadVendorMembers(vendor.id) });
}

export async function POST(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "VENDOR_INVALID_BODY", "요청 본문을 읽을 수 없습니다.");
  }

  const parsed = VendorMemberInviteSchema.safeParse(body);
  if (!parsed.success) return failValidation(parsed.error.issues);

  const { email, role } = parsed.data;

  const vendor = await findMemberVendor(user.id);
  if (!vendor) return fail(404, "VENDOR_NOT_FOUND", "등록된 업체가 없습니다.");

  const invited = await findUserByEmail(email);
  if (!invited) {
    return fail(422, "VENDOR_MEMBER_NOT_REGISTERED", UNREGISTERED_INVITE_MESSAGE);
  }

  const members = await loadVendorMembers(vendor.id);
  if (members.some((member) => member.userId === invited.id)) {
    return fail(409, "VENDOR_MEMBER_EXISTS", "이미 이 업체의 멤버입니다.");
  }

  const supabase = await createClient();
  const { data: created, error } = await supabase
    .from("vendor_members")
    .insert({ vendor_id: vendor.id, user_id: invited.id, vendor_role: role })
    .select("id, user_id, vendor_role, created_at")
    .maybeSingle();

  // INSERT 는 RLS 위반이 에러(42501)로 온다. 500 으로 뭉뚱그리지 않는다.
  if (error?.code === "42501" || (!error && !created)) {
    return fail(403, "VENDOR_MEMBER_FORBIDDEN", "멤버 초대는 업체 대표 계정만 할 수 있습니다.");
  }

  if (error || !created) {
    return fail(500, "VENDOR_MEMBER_SAVE_FAILED", "멤버를 추가하지 못했습니다.");
  }

  const admin = createAdminClient();

  await admin.from("audit_logs").insert({
    actor_id: user.id,
    actor_role: user.role,
    action: "vendor_member_invite",
    target_type: "vendor",
    target_id: vendor.id,
    // 이메일 원문을 남기지 않는다. 대상은 user_id 로 식별된다(CLAUDE.md §5.3).
    after_json: { member_user_id: invited.id, vendor_role: role },
  });

  await admin.from("entity_events").insert({
    entity_type: "vendor",
    entity_id: vendor.id,
    event_type: "vendor_member_invited",
    actor_id: user.id,
    actor_role: user.role,
    after_state: role,
    source: "web",
  });

  return ok({ member: created }, { status: 201 });
}
