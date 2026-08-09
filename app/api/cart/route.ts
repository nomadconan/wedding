import type { NextRequest } from "next/server";

import { fail, failValidation, ok } from "@/lib/api/response";
import { CartMutationSchema } from "@/lib/core/schemas/cart";
import { loadCart } from "@/lib/cart/loader";
import { findMyCouple } from "@/lib/couple/membership";
import { createPublicClient } from "@/lib/explore/query";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSessionUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";

/**
 * GET/POST/DELETE /api/cart — 장바구니 (F-C-25, 명세서 §4.2)
 *
 * **응답에 합산 총액을 싣는다**(§4.2). 금액은 **현재가**로 계산하며 `price_at_add` 는
 * 합산에 들어가지 않는다(S3-04 에서 정한 규칙).
 *
 * 쓰기는 `POST` 하나에 동작을 실어 보낸다 — §4.2 가 정한 API 표면(`GET/POST/DELETE`)을
 * 늘리지 않기 위해서다. S2-02 가 미디어 변경을 프로필 PUT 에 함께 실은 것과 같은 방식이다.
 *
 * 담기·비우기 같은 상태 변경은 `entity_events` 에 남긴다(D-23). 커플 화면이
 * "누가 무엇을 했는지" 를 그 기록으로 말한다.
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

/** 커플 구성원 id. 작성자 표기를 '배우자'와 '그 외'로 가르기 위해 쓴다. */
async function memberIdsOf(coupleId: string): Promise<string[]> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("couple_members")
    .select("user_id")
    .eq("couple_id", coupleId)
    .in("member_role", ["owner", "partner"]);

  return (data ?? []).map((row) => (row as { user_id: string }).user_id);
}

export async function GET() {
  const ctx = await context();
  if ("error" in ctx) return ctx.error;

  const supabase = await createClient();

  const cart = await loadCart(supabase, createPublicClient(), {
    coupleId: ctx.membership.coupleId,
    viewerId: ctx.user.id,
    memberIds: await memberIdsOf(ctx.membership.coupleId),
  });

  return ok(cart);
}

export async function POST(request: NextRequest) {
  const ctx = await context();
  if ("error" in ctx) return ctx.error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "CART_INVALID_BODY", "요청 본문을 읽을 수 없습니다.");
  }

  const parsed = CartMutationSchema.safeParse(body);
  if (!parsed.success) return failValidation(parsed.error.issues);

  const supabase = await createClient();
  const admin = createAdminClient();
  const { user, membership } = ctx;

  const event = async (eventType: string, entityId: string, after?: string) => {
    await admin.from("entity_events").insert({
      entity_type: "cart",
      entity_id: entityId,
      event_type: eventType,
      actor_id: user.id,
      actor_role: user.role,
      ...(after === undefined ? {} : { after_state: after }),
      source: "web",
    });
  };

  // ── 플래너 선택 토글 ──────────────────────────────────────────────────────
  // **커플 당사자만 바꿀 수 있다.** 이 스위치는 플래너 자신의 수수료가 붙느냐를 정하므로
  // 플래너가 켤 수 있으면 이해충돌이다(S3-04 에서 RLS 로도 막아 뒀다).
  if (parsed.data.action === "set_planner") {
    const { data: updated } = await supabase
      .from("cart_items")
      .update({ planner_selected: parsed.data.selected })
      .eq("id", parsed.data.itemId)
      .select("id");

    if (!updated || updated.length === 0) {
      return fail(403, "CART_ITEM_FORBIDDEN", "이 항목을 바꿀 권한이 없습니다.");
    }

    await event("cart_planner_toggled", parsed.data.itemId, String(parsed.data.selected));

    return ok({ itemId: parsed.data.itemId, plannerSelected: parsed.data.selected });
  }

  // ── 옵션 변경 ─────────────────────────────────────────────────────────────
  if (parsed.data.action === "set_options") {
    const { data: updated, error } = await supabase
      .from("cart_items")
      .update({ options_json: parsed.data.options })
      .eq("id", parsed.data.itemId)
      .select("id");

    // 같은 상품·같은 옵션이 이미 있다. 조용히 덮으면 항목 하나가 사라진다.
    if (error?.code === "23505") {
      return fail(409, "CART_ITEM_DUPLICATE", "같은 옵션의 항목이 이미 담겨 있어요.");
    }

    if (!updated || updated.length === 0) {
      return fail(403, "CART_ITEM_FORBIDDEN", "이 항목을 바꿀 권한이 없습니다.");
    }

    await event("cart_options_changed", parsed.data.itemId);

    return ok({ itemId: parsed.data.itemId });
  }

  // ── 담기 (찜에서 옮기기 포함) ─────────────────────────────────────────────
  let productId: string;
  let options: Record<string, unknown> = {};
  let wishlistId: string | null = null;

  if (parsed.data.action === "move_from_wishlist") {
    const { data: wish } = await supabase
      .from("wishlists")
      .select("id, product_id")
      .eq("id", parsed.data.wishlistId)
      .maybeSingle();

    if (!wish) return fail(404, "WISHLIST_ITEM_NOT_FOUND", "찜한 항목을 찾을 수 없습니다.");

    // 업체 찜에는 상품이 없다. 무엇을 담을지 정할 수 없으므로 옮길 수 없다.
    if (!wish.product_id) {
      return fail(422, "WISHLIST_VENDOR_ONLY", "업체 찜은 상품을 골라야 담을 수 있어요.");
    }

    productId = wish.product_id;
    wishlistId = wish.id;
  } else {
    productId = parsed.data.productId;
    options = parsed.data.options;
  }

  // 담을 수 있는 것은 **지금 팔고 있는 상품**뿐이다. 공개 조건으로 확인한다.
  const { data: product } = await createPublicClient()
    .from("products")
    .select("id, vendor_id, base_price_total")
    .eq("id", productId)
    .eq("status", "published")
    .not("add_ons_declared_at", "is", null)
    .maybeSingle();

  if (!product) return fail(404, "PRODUCT_NOT_AVAILABLE", "지금은 담을 수 없는 상품이에요.");

  // 활성 장바구니가 없으면 만든다. 부분 유니크가 커플당 하나를 보장한다(S3-04).
  let cartId: string;
  const { data: existing } = await supabase
    .from("carts")
    .select("id")
    .eq("couple_id", membership.coupleId)
    .eq("status", "active")
    .maybeSingle();

  if (existing) {
    cartId = existing.id;
  } else {
    const { data: created, error } = await supabase
      .from("carts")
      .insert({ couple_id: membership.coupleId, status: "active" })
      .select("id")
      .maybeSingle();

    if (error?.code === "42501") {
      return fail(403, "CART_FORBIDDEN", "장바구니를 만들 권한이 없습니다.");
    }

    if (error || !created) return fail(500, "CART_CREATE_FAILED", "장바구니를 만들지 못했습니다.");

    cartId = created.id;
    await event("cart_created", cartId);
  }

  const { data: item, error: addError } = await supabase
    .from("cart_items")
    .insert({
      cart_id: cartId,
      vendor_id: product.vendor_id,
      product_id: product.id,
      options_json: options,
      added_by: user.id,
      // 담은 시점 가격. **표시·합산에 쓰지 않는다** — "담을 때보다 올랐다"를 말하기
      // 위한 기준점이다(S3-04).
      price_at_add: product.base_price_total,
    })
    .select("id")
    .maybeSingle();

  if (addError?.code === "23505") {
    return fail(409, "CART_ITEM_DUPLICATE", "이미 담은 상품이에요.");
  }

  if (addError?.code === "42501") {
    return fail(403, "CART_FORBIDDEN", "담을 권한이 없습니다.");
  }

  if (addError || !item) return fail(500, "CART_ADD_FAILED", "담지 못했습니다.");

  // 옮기기였으면 찜에서 뺀다. 같은 것을 두 곳에 두면 상태가 갈린다.
  if (wishlistId) {
    await supabase.from("wishlists").delete().eq("id", wishlistId);
  }

  await event(wishlistId ? "cart_item_moved_from_wishlist" : "cart_item_added", item.id);

  return ok({ cartId, itemId: item.id }, { status: 201 });
}

export async function DELETE(request: NextRequest) {
  const ctx = await context();
  if ("error" in ctx) return ctx.error;

  const itemId = request.nextUrl.searchParams.get("itemId");
  if (!itemId) return fail(422, "CART_ITEM_REQUIRED", "지울 항목을 지정해 주세요.");

  const supabase = await createClient();

  const { data: removed } = await supabase
    .from("cart_items")
    .delete()
    .eq("id", itemId)
    .select("id");

  // DELETE 는 RLS 에 막혀도 에러가 아니라 0행이다. 지웠다고 답하면 안 된다.
  if (!removed || removed.length === 0) {
    return fail(404, "CART_ITEM_NOT_FOUND", "항목을 찾을 수 없습니다.");
  }

  const admin = createAdminClient();
  await admin.from("entity_events").insert({
    entity_type: "cart",
    entity_id: itemId,
    event_type: "cart_item_removed",
    actor_id: ctx.user.id,
    actor_role: ctx.user.role,
    source: "web",
  });

  return ok({ itemId });
}
