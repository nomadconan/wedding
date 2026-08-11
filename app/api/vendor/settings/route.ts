import type { NextRequest } from "next/server";

import { fail, failValidation, ok } from "@/lib/api/response";
import { VendorSettingsActionSchema } from "@/lib/core/schemas/vendor-settings";
import { businessHoursProblem } from "@/lib/core/vendor/vendor-settings";
import { getSessionUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";
import { loadVendorMembers } from "@/lib/vendor/members";
import { findMemberVendor } from "@/lib/vendor/products";
import {
  loadVendorChannelPrefs,
  loadVendorSettings,
  saveVendorChannel,
  saveVendorSettings,
} from "@/lib/vendor/settings";
import { createTemplate, deleteTemplate, loadTemplates } from "@/lib/vendor/templates";

/**
 * GET/POST /api/vendor/settings — 업체 알림·연동 설정 (F-V-14, §4.3)
 *
 * §6.3 에 전용 라우트가 없던 자리를 채운다(커버리지 표의 지시).
 *
 * **`vendor_id` 를 입력으로 받지 않는다** — 세션에서 찾는다.
 * **권한은 RLS 가 가른다**: 조직 설정·채널은 owner, 템플릿은 멤버(0026).
 * 여기서 역할을 다시 판정하지 않는다 — 경계가 둘이 되지 않게(CLAUDE.md §5.5).
 */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  const vendor = await findMemberVendor(user.id);
  if (!vendor) return fail(403, "VENDOR_NOT_FOUND", "등록된 업체가 없습니다.");

  const supabase = await createClient();

  try {
    const members = await loadVendorMembers(vendor.id);

    return ok({
      settings: await loadVendorSettings(supabase, vendor.id),
      channels: await loadVendorChannelPrefs(supabase, vendor.id),
      templates: await loadTemplates(supabase, vendor.id),
      members: members.map((member) => ({
        userId: member.userId,
        displayName: member.displayName,
        role: member.role,
      })),
      // 화면이 "지금 내가 대표인가" 를 알아야 편집 칸을 그릴지 정한다.
      // **최종 경계는 RLS 이고 이 값은 UX 보조다**(§1.4 NOTE).
      isOwner: members.some((member) => member.userId === user.id && member.role === "owner"),
    });
  } catch {
    return fail(500, "VENDOR_SETTINGS_LOAD_FAILED", "설정을 불러오지 못했습니다.");
  }
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

  const parsed = VendorSettingsActionSchema.safeParse(body);
  if (!parsed.success) return failValidation(parsed.error.issues);

  const supabase = await createClient();
  const action = parsed.data;

  if (action.action === "update_settings") {
    if (action.businessHours) {
      const problem = businessHoursProblem(action.businessHours);
      if (problem) return fail(422, "VENDOR_BUSINESS_HOURS_INVALID", problem);
    }

    const result = await saveVendorSettings(supabase, {
      vendorId: vendor.id,
      actorId: user.id,
      patch: {
        ...(action.recipientMode === undefined ? {} : { recipientMode: action.recipientMode }),
        ...(action.defaultAssigneeId === undefined
          ? {}
          : { defaultAssigneeId: action.defaultAssigneeId }),
        ...(action.businessHours === undefined ? {} : { businessHours: action.businessHours }),
        ...(action.deferOffhours === undefined ? {} : { deferOffhours: action.deferOffhours }),
      },
    });

    return "status" in result ? fail(result.status, result.code, result.message) : ok(result);
  }

  if (action.action === "update_channel") {
    const result = await saveVendorChannel(supabase, {
      vendorId: vendor.id,
      actorId: user.id,
      topic: action.topic,
      channel: action.channel,
      enabled: action.enabled,
    });

    return "status" in result ? fail(result.status, result.code, result.message) : ok(result);
  }

  if (action.action === "delete_template") {
    const result = await deleteTemplate(supabase, {
      vendorId: vendor.id,
      actorId: user.id,
      id: action.id,
    });

    return "status" in result ? fail(result.status, result.code, result.message) : ok(result);
  }

  const result = await createTemplate(supabase, {
    vendorId: vendor.id,
    actorId: user.id,
    kind: action.kind,
    title: action.title,
    payload: action.payload,
  });

  return "status" in result
    ? fail(result.status, result.code, result.message)
    : ok(result, { status: 201 });
}
