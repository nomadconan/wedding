import type { NextRequest } from "next/server";
import { z } from "zod";

import { recordEvent } from "@/lib/audit/record";
import { fail, failValidation, ok } from "@/lib/api/response";
import {
  ProductInputFieldsSchema,
  ProductStatusSchema,
  capacityRangeIsValid,
} from "@/lib/core/schemas/product";
import { needsRedeclaration } from "@/lib/core/schemas/product-option";
import { resolveVendorCommission } from "@/lib/pricing/vendor-rate";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSessionUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";

import { loadOptions } from "@/lib/vendor/product-options";
import { PRODUCT_COLUMNS, findMemberVendor, publishBlockersOf } from "@/lib/vendor/products";

/**
 * PATCH/DELETE /api/vendor/products/[id] — 상품 수정·게시·삭제 (F-V-03, §4.3)
 *
 * 게시(`status: "published"`)는 **체크리스트를 통과해야** 한다.
 * 화면과 **같은 함수**(`productPublishBlockers`)로 판정하므로 화면은 통과인데 서버가
 * 막는 상황이 생기지 않는다. DB 에도 같은 조건이 CHECK 로 걸려 있어 세 겹이다.
 */
const PatchSchema = ProductInputFieldsSchema.partial()
  .extend({
    status: ProductStatusSchema.optional(),
    /**
     * 추가금 사전 등록 확정(F-V-04).
     * true 면 "지금 목록이 발생 가능한 추가금의 전부"라는 진술이고, false 면 확정을 푼다.
     * 별도 엔드포인트를 만들지 않은 이유: §4.3 의 API 표면을 늘리지 않기 위해서다.
     */
    declareAddOns: z.boolean().optional(),
  })
  .refine((input) => Object.keys(input).length > 0, { message: "변경할 내용이 없습니다." })
  .refine(capacityRangeIsValid, {
    message: "수용 인원 하한이 상한보다 큽니다.",
    path: ["capacityMax"],
  });

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  const { id } = await context.params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "VENDOR_INVALID_BODY", "요청 본문을 읽을 수 없습니다.");
  }

  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) return failValidation(parsed.error.issues);

  const input = parsed.data;
  const supabase = await createClient();

  const { data: before, error: loadError } = await supabase
    .from("products")
    .select(PRODUCT_COLUMNS)
    .eq("id", id)
    .maybeSingle();

  if (loadError) return fail(500, "VENDOR_PRODUCT_LOAD_FAILED", "상품을 불러오지 못했습니다.");
  if (!before) return fail(404, "VENDOR_PRODUCT_NOT_FOUND", "상품을 찾을 수 없습니다.");

  const merged = {
    name: input.name ?? before.name,
    base_price_total: input.basePriceTotal ?? before.base_price_total,
    included_items_json: input.includedItems ?? before.included_items_json,
    // 같은 요청에서 확정하는 경우를 반영해야 게시 판정이 어긋나지 않는다.
    add_ons_declared_at:
      input.declareAddOns === undefined
        ? before.add_ons_declared_at
        : input.declareAddOns
          ? new Date().toISOString()
          : null,
  };

  // 게시 전 체크리스트. 미충족이면 게시할 수 없다(F-V-03).
  if (input.status === "published") {
    const blockers = publishBlockersOf(merged as Parameters<typeof publishBlockersOf>[0]);

    // 확정 이후에 항목이 바뀌었으면 그 확정은 현재 목록을 담보하지 않는다(F-V-04).
    const options = await loadOptions(supabase, id);
    if (needsRedeclaration(merged.add_ons_declared_at, options)) {
      blockers.push({
        code: "ADD_ONS_STALE_DECLARATION",
        message: "추가금 항목이 바뀌었습니다. 목록을 다시 확정한 뒤 게시해 주세요.",
      });
    }

    if (blockers.length > 0) {
      return fail(422, "VENDOR_PRODUCT_NOT_PUBLISHABLE", "게시 조건을 아직 못 채웠습니다.", blockers);
    }
  }

  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.category !== undefined) patch.category = input.category;
  if (input.basePriceTotal !== undefined) patch.base_price_total = input.basePriceTotal;
  if (input.includedItems !== undefined) patch.included_items_json = input.includedItems;
  if (input.capacityMin !== undefined) patch.capacity_min = input.capacityMin;
  if (input.capacityMax !== undefined) patch.capacity_max = input.capacityMax;
  if (input.declareAddOns !== undefined) {
    patch.add_ons_declared_at = merged.add_ons_declared_at;
  }
  if (input.status !== undefined) {
    patch.status = input.status;
    // 최초 게시 시각만 남긴다. 이후 재게시는 entity_events 가 이력을 갖는다.
    if (input.status === "published" && !before.published_at) {
      patch.published_at = new Date().toISOString();
    }
  }

  const { data: updated, error } = await supabase
    .from("products")
    .update(patch)
    .eq("id", id)
    .select(PRODUCT_COLUMNS)
    .maybeSingle();

  if (error) return fail(500, "VENDOR_PRODUCT_SAVE_FAILED", "상품을 저장하지 못했습니다.");

  if (!updated) {
    return fail(403, "VENDOR_PRODUCT_FORBIDDEN", "상품·가격은 업체 대표 계정만 수정할 수 있습니다.");
  }

  const admin = createAdminClient();

  if (input.status !== undefined && input.status !== before.status) {
    await recordEvent({
    entityType: "product",
    entityId: id,
    eventType: `product_${input.status}`,
    beforeState: before.status,
    afterState: input.status,
    actor: { id: user.id, role: user.role },
  });
  }

  // 가격 변경은 정산과 직결되므로 값까지 남긴다(§7.2).
  const priceChanged = before.base_price_total !== updated.base_price_total;

  await admin.from("audit_logs").insert({
    actor_id: user.id,
    actor_role: user.role,
    action: priceChanged ? "vendor_product_price_update" : "vendor_product_update",
    target_type: "product",
    target_id: id,
    before_json: { base_price_total: before.base_price_total, status: before.status },
    after_json: { base_price_total: updated.base_price_total, status: updated.status },
  });

  const vendor = await findMemberVendor(user.id);
  const rate = vendor
    ? await resolveVendorCommission(supabase, {
        vendorId: vendor.id,
        category: updated.category,
        salePrice: updated.base_price_total,
      })
    : { available: false as const, reason: "no_vendor", detail: "등록된 업체가 없습니다." };

  return ok({ product: updated, rate, publishBlockers: publishBlockersOf(updated) });
}

export async function DELETE(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  const { id } = await context.params;
  const supabase = await createClient();

  const { data: deleted, error } = await supabase
    .from("products")
    .delete()
    .eq("id", id)
    .select("id, name, status")
    .maybeSingle();

  if (error) return fail(500, "VENDOR_PRODUCT_DELETE_FAILED", "상품을 삭제하지 못했습니다.");
  if (!deleted) {
    return fail(403, "VENDOR_PRODUCT_FORBIDDEN", "상품은 업체 대표 계정만 삭제할 수 있습니다.");
  }

  const admin = createAdminClient();
  await admin.from("audit_logs").insert({
    actor_id: user.id,
    actor_role: user.role,
    action: "vendor_product_delete",
    target_type: "product",
    target_id: id,
    before_json: { name: deleted.name, status: deleted.status },
  });

  return ok({ id });
}
