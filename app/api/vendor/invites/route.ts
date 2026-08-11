import type { NextRequest } from "next/server";

import { fail, failValidation, ok } from "@/lib/api/response";
import { VendorInviteActionSchema } from "@/lib/core/schemas/vendor-settings";
import { getSessionUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";
import { inviteMember, loadInvites, revokeInvite } from "@/lib/vendor/invites";
import { findMemberVendor } from "@/lib/vendor/products";

/**
 * GET/POST /api/vendor/invites — 미가입자 초대 (F-V-13 잔여 · S2-09, §4.3)
 *
 * S2-07 이 "가입된 이메일만 연결하고 미가입은 422" 로 남긴 자리다.
 *
 * **발행·거둠은 owner 전용**이다 — 0026 정책이 그렇고, `vendor_members` INSERT 가
 * owner 전용인데(0005) 초대가 staff 에게 열려 있으면 그 경계를 우회하는 길이 된다.
 * 여기서 역할을 다시 판정하지 않는다(CLAUDE.md §5.5).
 *
 * **재발송은 새 토큰을 발급한다** — 기존 링크가 유출됐을 수 있으므로 살려 두지 않는다.
 */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  const vendor = await findMemberVendor(user.id);
  if (!vendor) return fail(403, "VENDOR_NOT_FOUND", "등록된 업체가 없습니다.");

  const supabase = await createClient();

  return ok({ invites: await loadInvites(supabase, vendor.id, new Date()) });
}

export async function POST(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  const vendor = await findMemberVendor(user.id);
  if (!vendor) return fail(403, "VENDOR_NOT_FOUND", "등록된 업체가 없습니다.");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "VENDOR_INVALID_BODY", "요청 본문을 읽을 수 없습니다.");
  }

  const parsed = VendorInviteActionSchema.safeParse(body);
  if (!parsed.success) return failValidation(parsed.error.issues);

  const supabase = await createClient();
  const action = parsed.data;
  const now = new Date();

  if (action.action === "revoke") {
    const result = await revokeInvite(supabase, { inviteId: action.id, actorId: user.id });

    return "status" in result ? fail(result.status, result.code, result.message) : ok(result);
  }

  if (action.action === "resend") {
    // 재발송은 같은 이메일로 다시 부르는 것과 같다 — `inviteMember` 가 살아 있는
    // 초대를 찾아 새 토큰을 끼운다. 경로를 둘로 나누면 만료 계산이 갈린다.
    const { data } = await supabase
      .from("vendor_invites")
      .select("email, vendor_role")
      .eq("id", action.id)
      .maybeSingle();

    if (!data) return fail(404, "VENDOR_INVITE_NOT_FOUND", "초대를 찾을 수 없어요.");

    const row = data as { email: string; vendor_role: "owner" | "staff" };
    const result = await inviteMember(supabase, {
      vendorId: vendor.id,
      actorId: user.id,
      email: row.email,
      role: row.vendor_role,
      now,
    });

    return "status" in result ? fail(result.status, result.code, result.message) : ok(result);
  }

  const result = await inviteMember(supabase, {
    vendorId: vendor.id,
    actorId: user.id,
    email: action.email,
    role: action.role,
    now,
  });

  return "status" in result
    ? fail(result.status, result.code, result.message)
    : ok(result, { status: 201 });
}
