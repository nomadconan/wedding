import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, failValidation, ok } from "@/lib/api/response";
import { PriceRuleInputSchema } from "@/lib/core/schemas/price-rule";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSessionUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";
import { PRICE_RULE_COLUMNS, toConditionJson } from "@/lib/vendor/price-rules";
import { findMemberVendor } from "@/lib/vendor/products";

/**
 * PATCH/DELETE /api/vendor/price-rules/[id] (F-V-06, §4.3)
 *
 * 조건은 룰 종류와 짝이라 **부분 수정을 받지 않는다.** 조건만 반쯤 바꾸면
 * `rule_type` 과 `condition_json` 이 어긋난 행이 생기고, 그 행은 평가할 수 없다.
 * 그래서 수정은 **전체 교체**다. 켜기·끄기만 바꾸는 경우는 `isActive` 만 보내면 된다.
 */
/** 켜기·끄기·우선순위만 바꾸는 가벼운 수정. */
const LightPatchSchema = z
  .object({
    isActive: z.boolean().optional(),
    priority: z.number().int().min(0).max(9999).optional(),
  })
  .refine((input) => Object.keys(input).length > 0, { message: "변경할 내용이 없습니다." });

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

  // `ruleType` 이 있으면 전체 교체, 없으면 가벼운 수정이다.
  // zod union 에 맡기면 잘못된 전체 교체 요청이 가벼운 수정으로 조용히 통과할 수 있다.
  const isFullReplace =
    typeof body === "object" && body !== null && "ruleType" in (body as Record<string, unknown>);

  const parsed = isFullReplace
    ? PriceRuleInputSchema.safeParse(body)
    : LightPatchSchema.safeParse(body);

  if (!parsed.success) return failValidation(parsed.error.issues);

  const input = parsed.data as Partial<z.output<typeof PriceRuleInputSchema>>;
  const supabase = await createClient();

  const { data: before } = await supabase
    .from("price_rules")
    .select(PRICE_RULE_COLUMNS)
    .eq("id", id)
    .maybeSingle();

  if (!before) return fail(404, "VENDOR_PRICE_RULE_NOT_FOUND", "룰을 찾을 수 없습니다.");

  const patch: Record<string, unknown> = {};
  if (input.ruleType !== undefined) patch.rule_type = input.ruleType;
  if (input.condition !== undefined) patch.condition_json = toConditionJson(input.condition);
  if (input.adjustType !== undefined) patch.adjust_type = input.adjustType;
  if (input.adjustValue !== undefined) patch.adjust_value = input.adjustValue;
  if (input.floorPrice !== undefined) patch.floor_price = input.floorPrice;
  if (input.capPrice !== undefined) patch.cap_price = input.capPrice;
  if (input.priority !== undefined) patch.priority = input.priority;
  if (input.isActive !== undefined) patch.is_active = input.isActive;
  if (input.productId !== undefined) patch.product_id = input.productId;

  const { data: updated, error } = await supabase
    .from("price_rules")
    .update(patch)
    .eq("id", id)
    .select(PRICE_RULE_COLUMNS)
    .maybeSingle();

  if (error) return fail(500, "VENDOR_PRICE_RULE_SAVE_FAILED", "룰을 저장하지 못했습니다.");
  if (!updated) {
    return fail(403, "VENDOR_PRICE_RULE_FORBIDDEN", "가격 룰은 업체 대표 계정만 수정할 수 있습니다.");
  }

  const admin = createAdminClient();

  await admin.from("audit_logs").insert({
    actor_id: user.id,
    actor_role: user.role,
    action: "vendor_price_rule_update",
    target_type: "vendor",
    target_id: before.vendor_id,
    before_json: {
      rule_id: id,
      adjust_value: Number(before.adjust_value),
      priority: before.priority,
      is_active: before.is_active,
    },
    after_json: {
      rule_id: id,
      adjust_value: Number(updated.adjust_value),
      priority: updated.priority,
      is_active: updated.is_active,
    },
  });

  await admin.from("entity_events").insert({
    entity_type: "vendor",
    entity_id: before.vendor_id,
    event_type: "price_rule_updated",
    actor_id: user.id,
    actor_role: user.role,
    before_state: before.is_active ? "active" : "inactive",
    after_state: updated.is_active ? "active" : "inactive",
    source: "web",
  });

  return ok({ rule: updated });
}

export async function DELETE(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  const { id } = await context.params;
  const vendor = await findMemberVendor(user.id);
  if (!vendor) return fail(404, "VENDOR_NOT_FOUND", "등록된 업체가 없습니다.");

  const supabase = await createClient();

  const { data: deleted, error } = await supabase
    .from("price_rules")
    .delete()
    .eq("id", id)
    .select("id, rule_type")
    .maybeSingle();

  if (error) return fail(500, "VENDOR_PRICE_RULE_DELETE_FAILED", "룰을 삭제하지 못했습니다.");
  if (!deleted) {
    return fail(403, "VENDOR_PRICE_RULE_FORBIDDEN", "가격 룰은 업체 대표 계정만 삭제할 수 있습니다.");
  }

  const admin = createAdminClient();

  await admin.from("audit_logs").insert({
    actor_id: user.id,
    actor_role: user.role,
    action: "vendor_price_rule_delete",
    target_type: "vendor",
    target_id: vendor.id,
    before_json: { rule_id: id, rule_type: deleted.rule_type },
  });

  return ok({ id });
}
