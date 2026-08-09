import type { NextRequest } from "next/server";

import { fail, failValidation, ok } from "@/lib/api/response";
import { ProductInputSchema } from "@/lib/core/schemas/product";
import { resolveVendorCommission } from "@/lib/pricing/vendor-rate";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSessionUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";
import { PRODUCT_COLUMNS, findMemberVendor, publishBlockersOf } from "@/lib/vendor/products";

/**
 * GET/POST /api/vendor/products — 상품·판매가 (F-V-03, 명세서 §4.3)
 *
 *  * `base_price_total` 누락·0·음수는 **422** 다. 자유 텍스트 가격 필드가 없다(D-16).
 *  * 응답에 **적용 요율과 예상 정산액**을 포함한다(§4.3 — "F-V-03 안내 표시용").
 *    요율이 없으면 금액을 만들지 않고 `available:false` 로 내려보낸다.
 *  * 쓰기는 사용자 세션 클라이언트로 한다. `products` 는 가격 테이블이라 RLS 가
 *    **owner 전용**으로 막고 있고(§3.9), 그것이 최종 경계다. staff 는 0행 → 403.
 */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  const supabase = await createClient();

  // RLS 가 자기 업체 상품만 보여준다(draft 포함).
  const { data: products, error } = await supabase
    .from("products")
    .select(PRODUCT_COLUMNS)
    .order("created_at", { ascending: false });

  if (error) return fail(500, "VENDOR_PRODUCT_LOAD_FAILED", "상품을 불러오지 못했습니다.");

  const vendor = await findMemberVendor(user.id);
  const rate = vendor
    ? await resolveVendorCommission(supabase, { vendorId: vendor.id, category: vendor.category })
    : { available: false as const, reason: "no_vendor", detail: "등록된 업체가 없습니다." };

  return ok({ products: products ?? [], rate });
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

  const parsed = ProductInputSchema.safeParse(body);
  if (!parsed.success) return failValidation(parsed.error.issues);

  const input = parsed.data;
  const vendor = await findMemberVendor(user.id);
  if (!vendor) return fail(404, "VENDOR_NOT_FOUND", "등록된 업체가 없습니다.");

  const supabase = await createClient();

  const { data: created, error } = await supabase
    .from("products")
    .insert({
      vendor_id: vendor.id,
      category: input.category,
      name: input.name,
      base_price_total: input.basePriceTotal,
      included_items_json: input.includedItems,
      capacity_min: input.capacityMin,
      capacity_max: input.capacityMax,
      // 새 상품은 항상 작성 중으로 시작한다. 게시는 체크리스트를 통과해야 한다.
      status: "draft",
    })
    .select(PRODUCT_COLUMNS)
    .maybeSingle();

  // INSERT 는 UPDATE 와 달리 RLS 위반이 **에러**로 온다(42501). 빈 결과가 아니다.
  // 이걸 500 으로 뭉뚱그리면 "권한 없음" 이 "서버 오류" 로 보인다.
  if (error?.code === "42501" || !created) {
    return fail(403, "VENDOR_PRODUCT_FORBIDDEN", "상품·가격은 업체 대표 계정만 등록할 수 있습니다.");
  }

  if (error) return fail(500, "VENDOR_PRODUCT_SAVE_FAILED", "상품을 저장하지 못했습니다.");

  const admin = createAdminClient();
  await admin.from("entity_events").insert({
    entity_type: "product",
    entity_id: created.id,
    event_type: "product_created",
    actor_id: user.id,
    actor_role: user.role,
    after_state: "draft",
    source: "web",
  });

  await admin.from("audit_logs").insert({
    actor_id: user.id,
    actor_role: user.role,
    action: "vendor_product_create",
    target_type: "product",
    target_id: created.id,
    after_json: { name: created.name, base_price_total: created.base_price_total, status: "draft" },
  });

  const rate = await resolveVendorCommission(supabase, {
    vendorId: vendor.id,
    category: created.category,
    salePrice: created.base_price_total,
  });

  return ok(
    { product: created, rate, publishBlockers: publishBlockersOf(created) },
    { status: 201 },
  );
}

