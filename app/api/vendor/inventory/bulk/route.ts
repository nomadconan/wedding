import type { NextRequest } from "next/server";

import { fail, failValidation, ok } from "@/lib/api/response";
import { parseInventoryCsv } from "@/lib/core/inventory/csv";
import {
  InventoryBulkSchema,
  SLOT_BULK_MAX,
  expandRepeatRule,
  findDuplicateSlots,
  type SlotInput,
} from "@/lib/core/schemas/inventory";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSessionUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";
import { findMemberVendor } from "@/lib/vendor/products";

/**
 * POST /api/vendor/inventory/bulk — 슬롯 일괄 등록·반복 규칙·CSV·블록 (F-V-05, §4.3)
 *
 * 한 엔드포인트가 세 모드를 받는다(`repeat` / `csv` / `block`). §4.3 의 API 표면을
 * 늘리지 않기 위해서다.
 *
 * 인가: 쓰기는 **업체 멤버**면 된다. 재고는 가격·정산이 아니므로 **staff 도 등록한다**
 * (§3.9, S2-07 에서 확인한 경계와 같다). 최종 경계는 RLS 다.
 *
 * **부분 반영하지 않는다.** 중복이든 형식 오류든 하나라도 걸리면 아무것도 넣지 않고
 * 무엇이 문제인지 돌려준다. 절반만 들어간 재고는 어느 날짜가 반영됐는지 모른 채
 * 다시 올리게 만들고, 그 재시도가 중복·누락을 만든다.
 */
export async function POST(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "VENDOR_INVALID_BODY", "요청 본문을 읽을 수 없습니다.");
  }

  const parsed = InventoryBulkSchema.safeParse(body);
  if (!parsed.success) return failValidation(parsed.error.issues);

  const vendor = await findMemberVendor(user.id);
  if (!vendor) return fail(404, "VENDOR_NOT_FOUND", "등록된 업체가 없습니다.");

  const supabase = await createClient();
  const input = parsed.data;

  // ── 블록·해제 ─────────────────────────────────────────────────────────────
  if (input.mode === "block") {
    const { from, to, times, status } = input.range;

    let query = supabase
      .from("inventory_slots")
      .update({ status })
      .eq("vendor_id", vendor.id)
      .gte("slot_date", from)
      .lte("slot_date", to);

    if (times.length > 0) query = query.in("slot_time", times.map((time) => `${time}:00`));

    const { data: updated, error } = await query.select("id");

    if (error) return fail(500, "VENDOR_SLOT_SAVE_FAILED", "슬롯 상태를 바꾸지 못했습니다.");

    if (!updated || updated.length === 0) {
      return fail(
        422,
        "VENDOR_SLOT_NONE_MATCHED",
        "해당 기간에 바꿀 슬롯이 없습니다. 먼저 슬롯을 등록해 주세요.",
      );
    }

    await writeEvent(user, vendor.id, status === "blocked" ? "blocked" : "unblocked", updated.length);

    return ok({ mode: "block", affected: updated.length, status });
  }

  // ── 슬롯 만들기 (반복 규칙 / CSV) ─────────────────────────────────────────
  let slots: SlotInput[];

  if (input.mode === "repeat") {
    slots = expandRepeatRule(input.rule);

    if (slots.length === 0) {
      return fail(422, "VENDOR_SLOT_EMPTY", "조건에 맞는 날짜가 없습니다. 요일과 기간을 확인해 주세요.");
    }
  } else {
    const result = parseInventoryCsv(input.csv);

    if (!result.ok) {
      return fail(422, "VENDOR_SLOT_CSV_INVALID", "CSV 를 읽지 못했습니다.", result.errors);
    }

    slots = result.slots;
  }

  if (slots.length > SLOT_BULK_MAX) {
    return fail(
      422,
      "VENDOR_SLOT_TOO_MANY",
      `한 번에 ${SLOT_BULK_MAX}개까지 등록할 수 있습니다. 기간을 나눠 주세요. (요청 ${slots.length}개)`,
    );
  }

  // 요청 안에서의 중복. DB UNIQUE 와 같은 기준으로 먼저 걸러 준다.
  const duplicates = findDuplicateSlots(slots);
  if (duplicates.length > 0) {
    return fail(422, "VENDOR_SLOT_DUPLICATE", "같은 날짜·시각이 요청 안에 중복돼 있습니다.", [
      ...new Set(duplicates),
    ]);
  }

  const rows = slots.map((slot) => ({
    vendor_id: vendor.id,
    product_id: slot.productId,
    slot_date: slot.date,
    slot_time: `${slot.time}:00`,
    capacity: slot.capacity,
    // 예약(4단계)이 붙기 전까지 remaining 은 capacity 와 같이 시작한다.
    // 줄이는 지점은 bookings 확정 처리다 — inventory_slots.remaining 주석 참조.
    remaining: slot.capacity,
    status: "open" as const,
  }));

  const { data: created, error } = await supabase
    .from("inventory_slots")
    .insert(rows)
    .select("id");

  if (error?.code === "23505") {
    return fail(
      409,
      "VENDOR_SLOT_EXISTS",
      "이미 등록된 날짜·시각이 있습니다. 기존 슬롯을 지우거나 기간을 조정해 주세요.",
    );
  }

  // INSERT 는 RLS 위반이 에러(42501)로 온다.
  if (error?.code === "42501") {
    return fail(403, "VENDOR_SLOT_FORBIDDEN", "재고 등록은 업체 멤버만 할 수 있습니다.");
  }

  if (error || !created) {
    return fail(500, "VENDOR_SLOT_SAVE_FAILED", "슬롯을 저장하지 못했습니다.");
  }

  await writeEvent(user, vendor.id, "created", created.length, input.mode);

  return ok({ mode: input.mode, created: created.length }, { status: 201 });
}

/**
 * 슬롯 변경 증적(D-23).
 * 슬롯 하나하나가 아니라 **작업 단위**로 남긴다 — 2000건을 넣었다고 이벤트가 2000개 쌓이면
 * 타임라인에서 정작 무슨 일이 있었는지 읽히지 않는다.
 */
async function writeEvent(
  user: { id: string; role: string | null },
  vendorId: string,
  action: string,
  count: number,
  mode?: string,
) {
  const admin = createAdminClient();

  await admin.from("entity_events").insert({
    entity_type: "vendor",
    entity_id: vendorId,
    event_type: `inventory_slots_${action}`,
    actor_id: user.id,
    actor_role: user.role,
    after_state: String(count),
    source: "web",
    memo: mode ? `${mode} · ${count}건` : `${count}건`,
  });

  await admin.from("audit_logs").insert({
    actor_id: user.id,
    actor_role: user.role,
    action: `vendor_inventory_${action}`,
    target_type: "vendor",
    target_id: vendorId,
    after_json: { count, mode: mode ?? null },
  });
}
