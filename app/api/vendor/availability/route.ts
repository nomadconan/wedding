import type { NextRequest } from "next/server";

import { fail, failValidation, ok } from "@/lib/api/response";
import { recordEvent } from "@/lib/audit/record";
import { loadAvailability } from "@/lib/consultation/loader";
import { AvailabilityActionSchema } from "@/lib/core/schemas/consultation";
import { getSessionUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";
import { findMemberVendor } from "@/lib/vendor/products";

/**
 * CRUD /api/vendor/availability — 상담 가능 시간대 (F-V-17 · S4-06, §4.3)
 *
 * 표는 이것을 **S4-06** 으로 잡아 두었고 S4-07 의 선행이다. 예약 흐름이 서려면
 * 업체가 시간대를 등록할 수 있어야 하므로 함께 만든다.
 *
 * ── 겹침 판정은 DB 가 한다 ──────────────────────────────────────────────────
 * 0007 이 `vendor_availability_no_overlap`(EXCLUDE)로 같은 업체·같은 요일의 시간대
 * 겹침을 거부한다. 여기서 미리 조회해 확인하지 않는다 — 앱이 확인하는 방식은
 * 동시 등록에서 지고, 판정이 두 곳에 생긴다.
 *
 * **staff 도 등록한다.** 0007 의 정책이 `is_vendor_member` 다 — 일정은 가격·정산이
 * 아니므로 S2-07 의 제한 대상이 아니다.
 */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  const vendor = await findMemberVendor(user.id);
  if (!vendor) return fail(403, "VENDOR_NOT_FOUND", "등록된 업체가 없습니다.");

  const supabase = await createClient();

  return ok({ rules: await loadAvailability(supabase, vendor.id) });
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

  const parsed = AvailabilityActionSchema.safeParse(body);
  if (!parsed.success) return failValidation(parsed.error.issues);

  const supabase = await createClient();
  const action = parsed.data;

  if (action.action === "delete") {
    // RLS 가 자기 업체 것만 지우게 한다(0007). vendor_id 조건은 화면 필터일 뿐이다.
    const { data, error } = await supabase
      .from("vendor_availability")
      .delete()
      .eq("id", action.id)
      .select("id")
      .maybeSingle();

    if (error) return fail(403, "AVAILABILITY_DELETE_FORBIDDEN", "지우지 못했어요.");
    if (!data) return fail(404, "AVAILABILITY_NOT_FOUND", "시간대를 찾을 수 없어요.");

    await recordEvent({
      entityType: "vendor",
      entityId: vendor.id,
      eventType: "availability_removed",
      actor: { id: user.id, role: "vendor" },
      memo: null,
    });

    return ok({ id: action.id });
  }

  const { data, error } = await supabase
    .from("vendor_availability")
    .insert({
      vendor_id: vendor.id,
      weekday: action.weekday,
      start_time: action.startTime,
      end_time: action.endTime,
      slot_minutes: action.slotMinutes,
    })
    .select("id")
    .maybeSingle();

  if (error || !data) {
    // 0007 의 CHECK·EXCLUDE 가 거절한 경우다. DB 예외문을 그대로 흘리지 않고
    // 무엇이 문제인지 우리 문장으로 바꾼다.
    return fail(
      422,
      "AVAILABILITY_INVALID",
      "이미 등록한 시간대와 겹치거나, 슬롯 길이가 구간보다 길어요.",
    );
  }

  await recordEvent({
    entityType: "vendor",
    entityId: vendor.id,
    eventType: "availability_added",
    actor: { id: user.id, role: "vendor" },
    memo: `weekday=${action.weekday} slot=${action.slotMinutes}`,
  });

  return ok({ id: (data as { id: string }).id }, { status: 201 });
}
