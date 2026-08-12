import type { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import { recordEvent } from "@/lib/audit/record";
import { fail, failValidation, ok } from "@/lib/api/response";
import { duplicateCartName } from "@/lib/core/cart/multi-cart";
import { CartMutationSchema } from "@/lib/core/schemas/cart";
import { loadCartLimit, loadCarts } from "@/lib/cart/loader";
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
 *
 * ── IDEA-01 ────────────────────────────────────────────────────────────────
 * 장바구니가 **커플당 최대 N개**가 됐다. 그래서 이 라우트에 장바구니 자체를 다루는
 * 동작(만들기·이름·치우기·복제)과 항목 이동·복사가 붙었다.
 *
 * **상한은 DB 가 강제한다**(0027 트리거). 여기서 `app_settings` 를 읽어 미리 판정하는
 * 것은 **문구를 위한 것**이다 — "최대 5개" 라고 말해 주려면 값을 알아야 하고, 트리거가
 * 돌려주는 예외 문구를 그대로 고객에게 보이고 싶지 않다. 경계는 여전히 DB 다.
 *
 * **어느 장바구니에 담을지 안 적으면** 가장 최근에 손댄 장바구니로 간다. 하나뿐인
 * 사람에게 매번 고르라고 물으면 담기가 두 번의 동작이 되기 때문이다. 둘 이상일 때
 * 고르게 하는 것은 화면의 일이며, 그때도 남의 장바구니 id 를 적으면 RLS 가 막는다.
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

  const carts = await loadCarts(supabase, createPublicClient(), {
    coupleId: ctx.membership.coupleId,
    viewerId: ctx.user.id,
    memberIds: await memberIdsOf(ctx.membership.coupleId),
  });

  return ok(carts);
}

// =============================================================================
// 장바구니 만들기 — 상한은 DB, 문구는 여기
// =============================================================================

type CreateResult = { cartId: string; seq: number } | { status: number; code: string; message: string };

async function createCart(
  supabase: SupabaseClient,
  coupleId: string,
  name: string | null,
): Promise<CreateResult> {
  const { limit } = await loadCartLimit();

  // 미리 세어 문구를 만든다. **판정의 최종 경계는 트리거**이므로 아래 23514 처리를
  // 지우면 안 된다 — 배우자의 동시 요청은 이 카운트를 지나간다(D-19).
  const { data: existing } = await supabase
    .from("carts")
    .select("id")
    .eq("couple_id", coupleId)
    .eq("status", "active");

  if ((existing ?? []).length >= limit) {
    return {
      status: 422,
      code: "CART_LIMIT_REACHED",
      message: `장바구니는 최대 ${limit}개까지 만들 수 있어요. 쓰지 않는 장바구니를 치워 주세요.`,
    };
  }

  const { data: created, error } = await supabase
    .from("carts")
    .insert({ couple_id: coupleId, status: "active", name })
    .select("id, seq")
    .maybeSingle();

  // 트리거가 상한을 막았다(carts_active_limit). 동시 요청이 겹친 경우다.
  if (error?.code === "23514") {
    return {
      status: 422,
      code: "CART_LIMIT_REACHED",
      message: `장바구니는 최대 ${limit}개까지 만들 수 있어요.`,
    };
  }

  if (error?.code === "42501") {
    return { status: 403, code: "CART_FORBIDDEN", message: "장바구니를 만들 권한이 없습니다." };
  }

  if (error || !created) {
    return { status: 500, code: "CART_CREATE_FAILED", message: "장바구니를 만들지 못했습니다." };
  }

  return { cartId: created.id as string, seq: created.seq as number };
}

/**
 * 담을 대상 장바구니.
 *
 * 지정이 있으면 **내 커플의 활성 장바구니인지 확인한다** — RLS 가 남의 것을 보여주지
 * 않으므로 조회 결과가 없다는 것이 곧 권한 없음이다. 지정이 없으면 가장 최근에 손댄
 * 것으로 가고, 하나도 없으면 만든다.
 */
async function resolveCart(
  supabase: SupabaseClient,
  coupleId: string,
  requested: string | undefined,
): Promise<{ cartId: string; created: boolean } | { status: number; code: string; message: string }> {
  if (requested !== undefined) {
    const { data } = await supabase
      .from("carts")
      .select("id")
      .eq("id", requested)
      .eq("couple_id", coupleId)
      .eq("status", "active")
      .maybeSingle();

    return data
      ? { cartId: data.id as string, created: false }
      : { status: 404, code: "CART_NOT_FOUND", message: "장바구니를 찾을 수 없습니다." };
  }

  const { data: recent } = await supabase
    .from("carts")
    .select("id")
    .eq("couple_id", coupleId)
    .eq("status", "active")
    .order("updated_at", { ascending: false })
    .order("seq", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (recent) return { cartId: recent.id as string, created: false };

  const created = await createCart(supabase, coupleId, null);

  return "status" in created ? created : { cartId: created.cartId, created: true };
}

/** 지금 담을 수 있는 상품인가. 공개 조건으로 확인한다. */
async function availableProduct(productId: string) {
  const { data } = await createPublicClient()
    .from("products")
    .select("id, vendor_id, base_price_total")
    .eq("id", productId)
    .eq("status", "published")
    .not("add_ons_declared_at", "is", null)
    .maybeSingle();

  return data as { id: string; vendor_id: string; base_price_total: number } | null;
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
  const { user, membership } = ctx;

  /**
   * **`entityType` 은 테이블 이름이다.** 장바구니 자체(`carts`)와 담긴 항목
   * (`cart_items`)은 다른 테이블이라 같은 이름으로 적으면 `entity_id` 가 어느 쪽
   * 행인지 알 수 없다. 그 위에는 열람 정책을 쓸 수 없다(S4-03 · 0019).
   */
  const event = (
    entityType: "cart" | "cart_item",
    eventType: string,
    entityId: string,
    afterState?: string,
    memo?: string,
  ) =>
    recordEvent({
      entityType,
      entityId,
      eventType,
      ...(afterState === undefined ? {} : { afterState }),
      ...(memo === undefined ? {} : { memo }),
      actor: { id: user.id, role: user.role },
    });

  // ── 장바구니 만들기 (IDEA-01) ─────────────────────────────────────────────
  if (parsed.data.action === "create_cart") {
    const created = await createCart(supabase, membership.coupleId, parsed.data.name);

    if ("status" in created) return fail(created.status, created.code, created.message);

    await event("cart", "cart_created", created.cartId, "active");

    return ok(created, { status: 201 });
  }

  // ── 이름 바꾸기 ───────────────────────────────────────────────────────────
  // **이름 값을 증적에 적지 않는다.** 고객이 자유롭게 쓰는 문장이라 사람 이름이
  // 들어갈 수 있다(§7.3 — memo 에 식별정보를 넣지 않는다). 남길 사실은 "누가 언제
  // 이름을 바꿨다" 이고, 지금 이름은 `carts.name` 이 들고 있다.
  if (parsed.data.action === "rename_cart") {
    const { data: updated, error } = await supabase
      .from("carts")
      .update({ name: parsed.data.name })
      .eq("id", parsed.data.cartId)
      .select("id, seq, name");

    if (error?.code === "23514") {
      return fail(422, "CART_NAME_INVALID", "이 이름은 쓸 수 없어요.");
    }

    if (!updated || updated.length === 0) {
      return fail(404, "CART_NOT_FOUND", "장바구니를 찾을 수 없습니다.");
    }

    await event(
      "cart",
      "cart_renamed",
      parsed.data.cartId,
      parsed.data.name === null ? "unnamed" : "named",
    );

    return ok({ cartId: parsed.data.cartId, name: parsed.data.name });
  }

  // ── 치우기 ────────────────────────────────────────────────────────────────
  // **행을 지우지 않는다.** `abandoned` 로 옮기면 상한에서 빠지고 화면에서 내려가지만
  // 증적(`entity_events`)이 가리킬 행은 남는다 — 하드 삭제는 커플이 자기 활동 기록을
  // 못 읽게 만든다(0027 근거 3).
  if (parsed.data.action === "discard_cart") {
    const { data: updated } = await supabase
      .from("carts")
      .update({ status: "abandoned" })
      .eq("id", parsed.data.cartId)
      .eq("status", "active")
      .select("id");

    if (!updated || updated.length === 0) {
      return fail(404, "CART_NOT_FOUND", "장바구니를 찾을 수 없습니다.");
    }

    await event("cart", "cart_discarded", parsed.data.cartId, "abandoned");

    return ok({ cartId: parsed.data.cartId, status: "abandoned" });
  }

  // ── 복제 ──────────────────────────────────────────────────────────────────
  // "한 항목만 바꿔 비교하기" 의 출발점이다. **담을 수 없게 된 항목은 옮기지 않고
  // 개수를 알린다** — 살 수 없는 것을 새 장바구니에 넣으면 처음부터 합계에서 빠진
  // 항목을 안고 시작하게 된다.
  if (parsed.data.action === "duplicate_cart") {
    const { data: source } = await supabase
      .from("carts")
      .select("id, seq, name")
      .eq("id", parsed.data.cartId)
      .eq("status", "active")
      .maybeSingle();

    if (!source) return fail(404, "CART_NOT_FOUND", "장바구니를 찾을 수 없습니다.");

    const created = await createCart(
      supabase,
      membership.coupleId,
      duplicateCartName({ name: (source.name ?? null) as string | null }),
    );

    if ("status" in created) return fail(created.status, created.code, created.message);

    const { data: items } = await supabase
      .from("cart_items")
      .select("product_id, options_json, planner_selected")
      .eq("cart_id", source.id);

    let copied = 0;
    let skipped = 0;

    for (const row of (items ?? []) as {
      product_id: string;
      options_json: Record<string, unknown>;
      planner_selected: boolean;
    }[]) {
      const product = await availableProduct(row.product_id);

      if (!product) {
        skipped += 1;
        continue;
      }

      const { error } = await supabase.from("cart_items").insert({
        cart_id: created.cartId,
        vendor_id: product.vendor_id,
        product_id: product.id,
        options_json: row.options_json ?? {},
        // 조건이 같아야 비교가 성립한다. 플래너 선택도 그대로 옮긴다(D-17).
        planner_selected: row.planner_selected,
        added_by: user.id,
        // **담은 시점은 지금**이다. 원본의 값을 물려주면 "담을 때보다 올랐다" 가
        // 새 장바구니에서 거짓이 된다.
        price_at_add: product.base_price_total,
      });

      if (error) skipped += 1;
      else copied += 1;
    }

    await event("cart", "cart_duplicated", created.cartId, "active", `copied=${copied},skipped=${skipped}`);

    return ok({ cartId: created.cartId, seq: created.seq, copied, skipped }, { status: 201 });
  }

  // ── 항목 이동 · 복사 ──────────────────────────────────────────────────────
  if (parsed.data.action === "move_item" || parsed.data.action === "copy_item") {
    const target = await resolveCart(supabase, membership.coupleId, parsed.data.toCartId);
    if ("status" in target) return fail(target.status, target.code, target.message);

    if (parsed.data.action === "move_item") {
      // 원본 소속도 대상 소속도 내 커플이어야 한다 — UPDATE 정책의 USING·WITH CHECK
      // 양쪽이 그것을 본다(0016). 앱이 다시 확인하지 않는 이유는 그쪽이 경계이기 때문이다.
      const { data: moved, error } = await supabase
        .from("cart_items")
        .update({ cart_id: target.cartId })
        .eq("id", parsed.data.itemId)
        .select("id");

      if (error?.code === "23505") {
        return fail(409, "CART_ITEM_DUPLICATE", "그 장바구니에 같은 상품이 이미 있어요.");
      }

      if (!moved || moved.length === 0) {
        return fail(404, "CART_ITEM_NOT_FOUND", "항목을 찾을 수 없습니다.");
      }

      await event("cart_item", "cart_item_moved", parsed.data.itemId, target.cartId);

      return ok({ itemId: parsed.data.itemId, cartId: target.cartId });
    }

    const { data: source } = await supabase
      .from("cart_items")
      .select("product_id, options_json, planner_selected")
      .eq("id", parsed.data.itemId)
      .maybeSingle();

    if (!source) return fail(404, "CART_ITEM_NOT_FOUND", "항목을 찾을 수 없습니다.");

    const product = await availableProduct(source.product_id as string);
    if (!product) return fail(404, "PRODUCT_NOT_AVAILABLE", "지금은 담을 수 없는 상품이에요.");

    const { data: created, error } = await supabase
      .from("cart_items")
      .insert({
        cart_id: target.cartId,
        vendor_id: product.vendor_id,
        product_id: product.id,
        options_json: (source.options_json ?? {}) as Record<string, unknown>,
        planner_selected: source.planner_selected as boolean,
        added_by: user.id,
        price_at_add: product.base_price_total,
      })
      .select("id")
      .maybeSingle();

    if (error?.code === "23505") {
      return fail(409, "CART_ITEM_DUPLICATE", "그 장바구니에 같은 상품이 이미 있어요.");
    }

    if (error || !created) return fail(500, "CART_ADD_FAILED", "담지 못했습니다.");

    await event("cart_item", "cart_item_copied", created.id as string, target.cartId);

    return ok({ itemId: created.id as string, cartId: target.cartId }, { status: 201 });
  }

  // ── 플래너 선택 토글 ──────────────────────────────────────────────────────
  // **커플 당사자만 바꿀 수 있다.** 이 스위치는 플래너 자신의 수수료가 붙느냐를 정하므로
  // 플래너가 켤 수 있으면 이해충돌이다(S3-04 에서 RLS 로도 막아 뒀다).
  // 선택은 **장바구니마다 다를 수 있다**(D-17) — 같은 상품을 두 장바구니에 담고 한쪽만
  // 플래너를 켜면 총액 차이가 그대로 비교값이 된다.
  if (parsed.data.action === "set_planner") {
    const { data: updated } = await supabase
      .from("cart_items")
      .update({ planner_selected: parsed.data.selected })
      .eq("id", parsed.data.itemId)
      .select("id");

    if (!updated || updated.length === 0) {
      return fail(403, "CART_ITEM_FORBIDDEN", "이 항목을 바꿀 권한이 없습니다.");
    }

    await event("cart_item", "cart_planner_toggled", parsed.data.itemId, String(parsed.data.selected));

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

    await event("cart_item", "cart_options_changed", parsed.data.itemId);

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

    productId = wish.product_id as string;
    wishlistId = wish.id as string;
  } else {
    productId = parsed.data.productId;
    options = parsed.data.options;
  }

  // 담을 수 있는 것은 **지금 팔고 있는 상품**뿐이다. 공개 조건으로 확인한다.
  const product = await availableProduct(productId);

  if (!product) return fail(404, "PRODUCT_NOT_AVAILABLE", "지금은 담을 수 없는 상품이에요.");

  const target = await resolveCart(supabase, membership.coupleId, parsed.data.cartId);
  if ("status" in target) return fail(target.status, target.code, target.message);

  if (target.created) await event("cart", "cart_created", target.cartId, "active");

  const { data: item, error: addError } = await supabase
    .from("cart_items")
    .insert({
      cart_id: target.cartId,
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
    return fail(409, "CART_ITEM_DUPLICATE", "이 장바구니에 이미 담은 상품이에요.");
  }

  if (addError?.code === "42501") {
    return fail(403, "CART_FORBIDDEN", "담을 권한이 없습니다.");
  }

  if (addError || !item) return fail(500, "CART_ADD_FAILED", "담지 못했습니다.");

  // 옮기기였으면 찜에서 뺀다. 같은 것을 두 곳에 두면 상태가 갈린다.
  if (wishlistId) {
    await supabase.from("wishlists").delete().eq("id", wishlistId);
  }

  await event(
    "cart_item",
    wishlistId ? "cart_item_moved_from_wishlist" : "cart_item_added",
    item.id as string,
  );

  return ok({ cartId: target.cartId, itemId: item.id as string }, { status: 201 });
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

  await recordEvent({
    entityType: "cart_item",
    entityId: itemId,
    eventType: "cart_item_removed",
    actor: { id: ctx.user.id, role: ctx.user.role },
  });

  return ok({ itemId });
}
