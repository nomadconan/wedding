import type { NextRequest } from "next/server";

import { recordEvent } from "@/lib/audit/record";
import { fail, failValidation, ok } from "@/lib/api/response";
import { PriceRuleInputSchema } from "@/lib/core/schemas/price-rule";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSessionUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";
import { PRICE_RULE_COLUMNS, toConditionJson } from "@/lib/vendor/price-rules";
import { findMemberVendor } from "@/lib/vendor/products";

/**
 * GET/POST /api/vendor/price-rules — 다이내믹 프라이싱 룰 (F-V-06, §4.3)
 *
 * 쓰기는 사용자 세션 클라이언트로 한다. `price_rules` 는 **가격 테이블**이라 RLS 가
 * owner 전용으로 막고 있고(§3.9) 그것이 최종 경계다. staff 는 INSERT 42501 → 403.
 * S2-03(판매가)·S2-04(추가금)와 같은 경계다.
 */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  const supabase = await createClient();

  // RLS 가 자기 업체 룰만 보여준다. 순서는 엔진의 전순서와 같게 맞춘다.
  const { data, error } = await supabase
    .from("price_rules")
    .select(PRICE_RULE_COLUMNS)
    .order("priority", { ascending: true })
    .order("created_at", { ascending: true });

  if (error) return fail(500, "VENDOR_PRICE_RULE_LOAD_FAILED", "룰을 불러오지 못했습니다.");

  return ok({ rules: data ?? [] });
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

  const parsed = PriceRuleInputSchema.safeParse(body);
  if (!parsed.success) return failValidation(parsed.error.issues);

  const input = parsed.data;
  const vendor = await findMemberVendor(user.id);
  if (!vendor) return fail(404, "VENDOR_NOT_FOUND", "등록된 업체가 없습니다.");

  const supabase = await createClient();

  const { data: created, error } = await supabase
    .from("price_rules")
    .insert({
      vendor_id: vendor.id,
      product_id: input.productId,
      rule_type: input.ruleType,
      condition_json: toConditionJson(input.condition),
      adjust_type: input.adjustType,
      adjust_value: input.adjustValue,
      floor_price: input.floorPrice,
      cap_price: input.capPrice,
      priority: input.priority,
      is_active: input.isActive,
    })
    .select(PRICE_RULE_COLUMNS)
    .maybeSingle();

  // INSERT 는 RLS 위반이 에러(42501)로 온다.
  if (error?.code === "42501" || (!error && !created)) {
    return fail(403, "VENDOR_PRICE_RULE_FORBIDDEN", "가격 룰은 업체 대표 계정만 등록할 수 있습니다.");
  }

  if (error || !created) {
    return fail(500, "VENDOR_PRICE_RULE_SAVE_FAILED", "룰을 저장하지 못했습니다.");
  }

  const admin = createAdminClient();

  await admin.from("audit_logs").insert({
    actor_id: user.id,
    actor_role: user.role,
    action: "vendor_price_rule_create",
    target_type: "vendor",
    target_id: vendor.id,
    after_json: {
      rule_id: created.id,
      rule_type: input.ruleType,
      adjust_type: input.adjustType,
      adjust_value: input.adjustValue,
      priority: input.priority,
    },
  });

  await recordEvent({
    entityType: "vendor",
    entityId: vendor.id,
    eventType: "price_rule_created",
    afterState: input.ruleType,
    actor: { id: user.id, role: user.role },
  });

  return ok({ rule: created }, { status: 201 });
}
