import type { NextRequest } from "next/server";

import { fail, failValidation, ok } from "@/lib/api/response";
import { WishlistMutationSchema } from "@/lib/core/schemas/cart";
import { loadWishlist } from "@/lib/cart/wishlist";
import { findMyCouple } from "@/lib/couple/membership";
import { createPublicClient } from "@/lib/explore/query";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSessionUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";

/**
 * GET/POST/DELETE /api/wishlist — 찜 (F-C-26, 명세서 §4.2)
 *
 * **`price_at_add` 대비 현재가 변동을 표시한다**(§4.2). 담은 시점 가격이 없거나
 * 상품이 내려가 현재가가 없는 경우를 '변동 없음'으로 뭉개지 않는다 —
 * 판정은 `lib/core/schemas/cart.ts` 의 `priceChangeOf` 하나가 한다.
 *
 * 가격 변동 **알림**(`wishlist-price-watch` 배치)은 알림 인프라(S4-13)를 기다린다.
 * 여기서는 화면이 볼 때 계산해 보여주는 데까지다.
 */
async function context() {
  const user = await getSessionUser();
  if (!user) return { error: fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.") } as const;

  const membership = await findMyCouple(user.id);
  if (!membership) {
    return { error: fail(404, "COUPLE_NOT_FOUND", "먼저 온보딩을 마쳐 주세요.") } as const;
  }

  return { user, membership } as const;
}

export async function GET() {
  const ctx = await context();
  if ("error" in ctx) return ctx.error;

  const supabase = await createClient();
  const admin = createAdminClient();

  const { data: members } = await admin
    .from("couple_members")
    .select("user_id")
    .eq("couple_id", ctx.membership.coupleId)
    .in("member_role", ["owner", "partner"]);

  const wishlist = await loadWishlist(supabase, createPublicClient(), {
    viewerId: ctx.user.id,
    memberIds: (members ?? []).map((row) => (row as { user_id: string }).user_id),
  });

  return ok(wishlist);
}

export async function POST(request: NextRequest) {
  const ctx = await context();
  if ("error" in ctx) return ctx.error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "WISHLIST_INVALID_BODY", "요청 본문을 읽을 수 없습니다.");
  }

  const parsed = WishlistMutationSchema.safeParse(body);
  if (!parsed.success) return failValidation(parsed.error.issues);

  const publicClient = createPublicClient();
  const { vendorId, productId } = parsed.data;

  // 지금 볼 수 있는 업체·상품만 찜할 수 있다. 미승인 업체를 찜하면 그 존재를 알려 주는 셈이다.
  const { data: vendor } = await publicClient
    .from("vendors")
    .select("id")
    .eq("id", vendorId)
    .eq("status", "active")
    .maybeSingle();

  if (!vendor) return fail(404, "VENDOR_NOT_FOUND", "업체를 찾을 수 없습니다.");

  let priceAtAdd: number | null = null;

  if (productId) {
    const { data: product } = await publicClient
      .from("products")
      .select("id, vendor_id, base_price_total")
      .eq("id", productId)
      .eq("status", "published")
      .not("add_ons_declared_at", "is", null)
      .maybeSingle();

    if (!product || product.vendor_id !== vendorId) {
      return fail(404, "PRODUCT_NOT_AVAILABLE", "지금은 찜할 수 없는 상품이에요.");
    }

    // 상품 찜에는 담은 시점 가격이 **반드시** 있어야 한다. 없으면 변동을 계산할 수 없고,
    // DB 의 `wishlists_price_pair_chk` 도 그 짝을 강제한다(S3-04).
    priceAtAdd = product.base_price_total;
  }

  const supabase = await createClient();

  const { data: created, error } = await supabase
    .from("wishlists")
    .insert({
      couple_id: ctx.membership.coupleId,
      vendor_id: vendorId,
      product_id: productId,
      added_by: ctx.user.id,
      price_at_add: priceAtAdd,
    })
    .select("id")
    .maybeSingle();

  if (error?.code === "23505") return fail(409, "WISHLIST_DUPLICATE", "이미 찜한 곳이에요.");
  if (error?.code === "42501") return fail(403, "WISHLIST_FORBIDDEN", "찜할 권한이 없습니다.");
  if (error || !created) return fail(500, "WISHLIST_ADD_FAILED", "찜하지 못했습니다.");

  const admin = createAdminClient();
  await admin.from("entity_events").insert({
    entity_type: "wishlist",
    entity_id: created.id,
    event_type: "wishlist_added",
    actor_id: ctx.user.id,
    actor_role: ctx.user.role,
    source: "web",
  });

  return ok({ wishlistId: created.id }, { status: 201 });
}

export async function DELETE(request: NextRequest) {
  const ctx = await context();
  if ("error" in ctx) return ctx.error;

  const id = request.nextUrl.searchParams.get("id");
  if (!id) return fail(422, "WISHLIST_ITEM_REQUIRED", "지울 항목을 지정해 주세요.");

  const supabase = await createClient();

  const { data: removed } = await supabase.from("wishlists").delete().eq("id", id).select("id");

  if (!removed || removed.length === 0) {
    return fail(404, "WISHLIST_ITEM_NOT_FOUND", "항목을 찾을 수 없습니다.");
  }

  const admin = createAdminClient();
  await admin.from("entity_events").insert({
    entity_type: "wishlist",
    entity_id: id,
    event_type: "wishlist_removed",
    actor_id: ctx.user.id,
    actor_role: ctx.user.role,
    source: "web",
  });

  return ok({ id });
}
