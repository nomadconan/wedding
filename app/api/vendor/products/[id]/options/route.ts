import type { NextRequest } from "next/server";

import { fail, failValidation, ok } from "@/lib/api/response";
import {
  PRODUCT_OPTION_MAX,
  ProductOptionInputSchema,
  summarizeAddOns,
} from "@/lib/core/schemas/product-option";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSessionUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";
import { OPTION_COLUMNS, loadOptions, toOptionRow } from "@/lib/vendor/product-options";

/**
 * GET/POST /api/vendor/products/[id]/options — 추가금 사전 등록 (F-V-04, §4.3)
 *
 *  * 쓰기는 사용자 세션 클라이언트로 한다. `product_options` 는 가격 정보라 RLS 가
 *    **owner 전용**이며(§3.9) 그것이 최종 경계다. staff 는 INSERT 42501 → 403.
 *  * 항목이 바뀌어도 **확정을 강제로 지우지 않는다.** 게시 중인 상품의 확정을 지우면
 *    게시 조건 CHECK 와 충돌하고, 업체가 항목 하나 고쳤다고 노출이 사라진다.
 *    대신 확정 시각보다 나중에 바뀐 항목이 있으면 `needsRedeclaration` 이 **재확정 필요**로
 *    표시하고, 재게시할 때 API 가 막는다. 새 항목은 즉시 고객 목록에 보이므로
 *    "사전 미등록 항목" 이 되지는 않는다.
 */
export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  const { id } = await context.params;
  const supabase = await createClient();

  const { data: product, error: productError } = await supabase
    .from("products")
    .select("id, add_ons_declared_at")
    .eq("id", id)
    .maybeSingle();

  if (productError) return fail(500, "VENDOR_OPTION_LOAD_FAILED", "추가금을 불러오지 못했습니다.");
  if (!product) return fail(404, "VENDOR_PRODUCT_NOT_FOUND", "상품을 찾을 수 없습니다.");

  const options = await loadOptions(supabase, id);

  return ok({
    options,
    declaredAt: product.add_ons_declared_at,
    addOns: summarizeAddOns(product.add_ons_declared_at, options),
  });
}

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  const { id } = await context.params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "VENDOR_INVALID_BODY", "요청 본문을 읽을 수 없습니다.");
  }

  const parsed = ProductOptionInputSchema.safeParse(body);
  if (!parsed.success) return failValidation(parsed.error.issues);

  const supabase = await createClient();

  const { data: product } = await supabase
    .from("products")
    .select("id")
    .eq("id", id)
    .maybeSingle();

  if (!product) return fail(404, "VENDOR_PRODUCT_NOT_FOUND", "상품을 찾을 수 없습니다.");

  const existing = await loadOptions(supabase, id);
  if (existing.length >= PRODUCT_OPTION_MAX) {
    return fail(
      422,
      "VENDOR_OPTION_LIMIT",
      `추가금 항목은 상품당 ${PRODUCT_OPTION_MAX}개까지 등록할 수 있습니다.`,
    );
  }

  const { data: created, error } = await supabase
    .from("product_options")
    .insert(toOptionRow(id, parsed.data))
    .select(OPTION_COLUMNS)
    .maybeSingle();

  // INSERT 는 RLS 위반이 에러(42501)로 온다. 500 으로 뭉뚱그리지 않는다.
  if (error?.code === "42501" || (!error && !created)) {
    return fail(403, "VENDOR_OPTION_FORBIDDEN", "추가금은 업체 대표 계정만 등록할 수 있습니다.");
  }

  if (error || !created) {
    return fail(500, "VENDOR_OPTION_SAVE_FAILED", "추가금을 저장하지 못했습니다.");
  }

  const admin = createAdminClient();
  await admin.from("audit_logs").insert({
    actor_id: user.id,
    actor_role: user.role,
    action: "vendor_product_option_create",
    target_type: "product",
    target_id: id,
    after_json: { name: created.name, price: created.price, is_mandatory: created.is_mandatory },
  });

  return ok({ option: created }, { status: 201 });
}
