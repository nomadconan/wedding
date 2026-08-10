import type { NextRequest } from "next/server";

import { recordEvent } from "@/lib/audit/record";
import { fail, failValidation, ok } from "@/lib/api/response";
import {
  VENDOR_MEDIA_MAX,
  VendorProfileUpdateSchema,
  diffProfileFields,
} from "@/lib/core/schemas/vendor-profile";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSessionUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";

/**
 * GET/PUT /api/vendor/profile — 업체 프로필 관리 (F-V-02, 명세서 §4.3)
 *
 * 인가
 *  - 조회·수정 모두 **사용자 세션 클라이언트**로 한다. `vendors` 에는 이미 RLS 가 있고
 *    (`vendors_update_owner` = owner 전용) 그것이 최종 경계다(§1.4 NOTE).
 *    서비스롤은 **정책이 없는 증적 테이블**(`audit_logs`·`entity_events`)에만 쓴다.
 *  - 그래서 staff 가 프로필 수정을 시도하면 RLS 가 0행을 돌려주고 여기서 403 이 나간다.
 *    미디어는 멤버(staff 포함)가 다룰 수 있다 — 기존 정책 그대로다.
 *
 * 변경 이력(F-V-02 "변경 이력 보관")
 *  - `audit_logs.before_json/after_json` 에 **바뀐 필드만** 남긴다. 안 바뀐 값까지 넣으면
 *    무엇이 달라졌는지 읽을 수 없다.
 *  - 상태 전이는 `entity_events` 에도 남긴다(D-23).
 */
const MEDIA_BUCKET = "vendor-media";

/** 프로필 컬럼만 고른다. 심사 대상 정보(name·category·status)는 여기서 바뀌지 않는다. */
const PROFILE_COLUMNS =
  "id, name, category, status, region_code, address, address_detail, capacity_min, capacity_max, facilities, style_tags, intro";

function safeFileName(fileName: string): string {
  const ext = fileName.includes(".") ? fileName.split(".").pop()!.toLowerCase().slice(0, 8) : "bin";
  const stamp = Math.random().toString(36).slice(2, 10);

  return `${stamp}.${ext.replace(/[^a-z0-9]/g, "") || "bin"}`;
}

/** 세션 사용자가 속한 업체 1곳. 멤버가 아니면 null. */
async function findMemberVendorId(userId: string): Promise<string | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("vendor_members")
    .select("vendor_id")
    .eq("user_id", userId)
    .limit(1)
    .maybeSingle();

  return data?.vendor_id ?? null;
}

export async function GET() {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  const supabase = await createClient();

  // RLS 가 자기 업체만 보여준다. 여기서 vendor_id 를 신뢰할 필요가 없다.
  const { data: vendor, error } = await supabase
    .from("vendors")
    .select(PROFILE_COLUMNS)
    .limit(1)
    .maybeSingle();

  if (error) return fail(500, "VENDOR_PROFILE_LOAD_FAILED", "프로필을 불러오지 못했습니다.");
  if (!vendor) return fail(404, "VENDOR_NOT_FOUND", "등록된 업체가 없습니다.");

  const { data: media } = await supabase
    .from("vendor_media")
    .select("id, type, storage_path, sort_order, alt_text")
    .eq("vendor_id", vendor.id)
    .order("sort_order", { ascending: true });

  return ok({ vendor, media: media ?? [] });
}

export async function PUT(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "VENDOR_INVALID_BODY", "요청 본문을 읽을 수 없습니다.");
  }

  const parsed = VendorProfileUpdateSchema.safeParse(body);
  if (!parsed.success) return failValidation(parsed.error.issues);

  const { profile, media } = parsed.data;

  const vendorId = await findMemberVendorId(user.id);
  if (!vendorId) return fail(404, "VENDOR_NOT_FOUND", "등록된 업체가 없습니다.");

  const supabase = await createClient();

  const { data: before, error: beforeError } = await supabase
    .from("vendors")
    .select(PROFILE_COLUMNS)
    .eq("id", vendorId)
    .maybeSingle();

  if (beforeError || !before) {
    return fail(500, "VENDOR_PROFILE_LOAD_FAILED", "프로필을 불러오지 못했습니다.");
  }

  const nextValues = {
    region_code: profile.regionCode,
    address: profile.address,
    address_detail: profile.addressDetail,
    capacity_min: profile.capacityMin,
    capacity_max: profile.capacityMax,
    facilities: profile.facilities,
    // 탐색 스타일 필터의 유일한 데이터 출처다(S3-03 · F-C-10).
    style_tags: profile.styleTags,
    intro: profile.intro,
  };

  // RLS 로 owner 만 통과한다. staff 는 0행이 돌아온다.
  const { data: updated, error: updateError } = await supabase
    .from("vendors")
    .update(nextValues)
    .eq("id", vendorId)
    .select(PROFILE_COLUMNS)
    .maybeSingle();

  if (updateError) {
    return fail(500, "VENDOR_PROFILE_SAVE_FAILED", "프로필을 저장하지 못했습니다.");
  }

  if (!updated) {
    // 정책이 막았다. 화면에서 이미 감췄어도 최종 경계는 여기다.
    return fail(403, "VENDOR_PROFILE_FORBIDDEN", "프로필은 업체 대표 계정만 수정할 수 있습니다.");
  }

  // ── 미디어 ────────────────────────────────────────────────────────────────
  const { data: currentMedia } = await supabase
    .from("vendor_media")
    .select("id, sort_order")
    .eq("vendor_id", vendorId);

  const currentCount = currentMedia?.length ?? 0;

  if (currentCount - media.remove.length + media.add.length > VENDOR_MEDIA_MAX) {
    return fail(
      422,
      "VENDOR_MEDIA_LIMIT",
      `미디어는 업체당 ${VENDOR_MEDIA_MAX}개까지 등록할 수 있습니다.`,
    );
  }

  if (media.remove.length > 0) {
    const { error } = await supabase
      .from("vendor_media")
      .delete()
      .eq("vendor_id", vendorId)
      .in("id", media.remove);

    if (error) return fail(500, "VENDOR_MEDIA_SAVE_FAILED", "미디어를 삭제하지 못했습니다.");
  }

  for (const item of media.updateAlt) {
    await supabase
      .from("vendor_media")
      .update({ alt_text: item.altText })
      .eq("vendor_id", vendorId)
      .eq("id", item.id);
  }

  for (const [index, id] of media.order.entries()) {
    await supabase
      .from("vendor_media")
      .update({ sort_order: index })
      .eq("vendor_id", vendorId)
      .eq("id", id);
  }

  const admin = createAdminClient();
  const uploads: { id: string; type: string; path: string; token: string; signedUrl: string }[] = [];
  let nextSortOrder = media.order.length > 0 ? media.order.length : currentCount;

  for (const item of media.add) {
    const path = `${vendorId}/${item.type}/${safeFileName(item.fileName)}`;

    const { data: signed, error: signError } = await admin.storage
      .from(MEDIA_BUCKET)
      .createSignedUploadUrl(path);

    if (signError || !signed) {
      return fail(500, "VENDOR_MEDIA_URL_FAILED", "업로드 주소를 만들지 못했습니다.");
    }

    const { data: row, error: insertError } = await supabase
      .from("vendor_media")
      .insert({
        vendor_id: vendorId,
        type: item.type,
        storage_path: path,
        sort_order: nextSortOrder,
        alt_text: item.altText,
      })
      .select("id")
      .single();

    if (insertError || !row) {
      return fail(500, "VENDOR_MEDIA_SAVE_FAILED", "미디어 정보를 저장하지 못했습니다.");
    }

    nextSortOrder += 1;
    uploads.push({ id: row.id, type: item.type, path, token: signed.token, signedUrl: signed.signedUrl });
  }

  // ── 변경 이력 ─────────────────────────────────────────────────────────────
  const mediaChanged =
    media.add.length + media.remove.length + media.order.length + media.updateAlt.length > 0;

  const changedFields = diffProfileFields(
    { ...before, media: undefined },
    { ...updated, media: undefined },
  );

  if (mediaChanged) changedFields.push("media");

  if (changedFields.length > 0) {
    const pick = (source: Record<string, unknown>) =>
      Object.fromEntries(changedFields.filter((key) => key !== "media").map((key) => [key, source[key] ?? null]));

    await admin.from("audit_logs").insert({
      actor_id: user.id,
      actor_role: user.role,
      action: "vendor_profile_update",
      target_type: "vendor",
      target_id: vendorId,
      before_json: {
        ...pick(before as Record<string, unknown>),
        ...(mediaChanged ? { media_count: currentCount } : {}),
      },
      after_json: {
        ...pick(updated as Record<string, unknown>),
        ...(mediaChanged
          ? { media_count: currentCount - media.remove.length + media.add.length }
          : {}),
      },
    });

    await recordEvent({
    entityType: "vendor",
    entityId: vendorId,
    eventType: "vendor_profile_updated",
    // 필드 이름만 남긴다. 값은 audit_logs 가 갖는다(CLAUDE.md §5.3).
    memo: changedFields.join(","),
    actor: { id: user.id, role: user.role },
  });
  }

  return ok({ vendor: updated, uploads, changedFields });
}
