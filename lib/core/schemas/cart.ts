import { z } from "zod";

import { AMOUNT_UNKNOWN, isUnknownAmount, type Amount } from "../pricing/amount";

/**
 * 장바구니 · 찜 (S3-05 · 명세서 §2.1 F-C-25·F-C-26, §4.2, §6.2, D-19)
 *
 * 프레임워크를 모르는 순수 모듈이다. 화면과 API 가 같은 함수를 써야 "장바구니에서 본 값"과
 * "합계"가 갈리지 않는다.
 *
 * **S3-04 에서 정한 것을 그대로 지킨다.**
 *  - 장바구니 금액은 **현재가**를 따라간다. `price_at_add` 는 기준점일 뿐 합산에 넣지 않는다.
 *  - 찜은 `price_at_add` 가 **비교 기준점**이다. 담은 시점 대비 변동을 말하는 것이 기능이다.
 *  - 요율은 저장하지 않는다. `planner_selected` 는 선택 여부일 뿐이고 수수료는 매번 계산한다.
 */

// =============================================================================
// API 입력
// =============================================================================

/**
 * 장바구니 쓰기.
 *
 * `POST /api/cart` 하나에 동작을 실어 보낸다. §4.2 의 API 표면(`GET/POST/DELETE`)을
 * 늘리지 않기 위해서다 — S2-02 가 미디어 변경을 프로필 PUT 에 함께 실은 것과 같은 방식이다.
 */
export const CartMutationSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("add"),
    productId: z.string().uuid("상품을 찾을 수 없습니다."),
    /** 선택한 옵션. 같은 상품이라도 옵션이 다르면 별개 항목이다(S3-04). */
    options: z.record(z.unknown()).default({}),
  }),
  z.object({
    action: z.literal("set_planner"),
    itemId: z.string().uuid(),
    selected: z.boolean(),
  }),
  z.object({
    action: z.literal("set_options"),
    itemId: z.string().uuid(),
    options: z.record(z.unknown()).default({}),
  }),
  /** 찜에서 장바구니로 옮긴다. 찜 행은 지운다 — 같은 것을 두 곳에 두면 상태가 갈린다. */
  z.object({
    action: z.literal("move_from_wishlist"),
    wishlistId: z.string().uuid(),
  }),
]);

export type CartMutation = z.infer<typeof CartMutationSchema>;

export const WishlistMutationSchema = z.object({
  action: z.literal("add"),
  vendorId: z.string().uuid("업체를 찾을 수 없습니다."),
  /** 없으면 **업체 찜**이다(F-C-26 — "관심 업체·상품 저장"). */
  productId: z.string().uuid().nullable().default(null),
});

export type WishlistMutation = z.infer<typeof WishlistMutationSchema>;

// =============================================================================
// 담은 시점 대비 가격 변동 (F-C-26)
// =============================================================================

/**
 * **'변동 없음'으로 뭉개면 안 되는 상태가 둘 있다.**
 *  - `unknown`     담은 시점 가격이 없다(업체 찜 등). 비교할 기준이 없다는 뜻이다.
 *  - `unavailable` 상품이 내려갔거나 업체가 노출되지 않는다. 현재가가 존재하지 않는다.
 * 둘 다 "그대로예요" 라고 적으면 사실이 아닌 말을 하는 것이다.
 */
export type PriceChange =
  | { kind: "same"; price: number }
  | { kind: "up"; from: number; to: number; diff: number; rateBp: number }
  | { kind: "down"; from: number; to: number; diff: number; rateBp: number }
  | { kind: "unknown" }
  | { kind: "unavailable"; from: number | null };

export function priceChangeOf(priceAtAdd: number | null, currentPrice: Amount | null): PriceChange {
  if (currentPrice === null || isUnknownAmount(currentPrice)) {
    return { kind: "unavailable", from: priceAtAdd };
  }

  if (priceAtAdd === null) return { kind: "unknown" };
  if (priceAtAdd === currentPrice) return { kind: "same", price: currentPrice };

  const diff = Math.abs(currentPrice - priceAtAdd);
  // 기준이 0이면 비율을 만들 수 없다. 0으로 나누지 않고 0bp 로 둔다.
  const rateBp = priceAtAdd === 0 ? 0 : Math.round((diff * 10_000) / priceAtAdd);

  return currentPrice > priceAtAdd
    ? { kind: "up", from: priceAtAdd, to: currentPrice, diff, rateBp }
    : { kind: "down", from: priceAtAdd, to: currentPrice, diff, rateBp };
}

export const PRICE_CHANGE_LABEL: Record<PriceChange["kind"], string> = {
  same: "담을 때와 같아요",
  up: "담을 때보다 올랐어요",
  down: "담을 때보다 내렸어요",
  unknown: "담은 시점 가격이 없어요",
  unavailable: "지금은 가격을 확인할 수 없어요",
};

// =============================================================================
// 항목 노출 상태
// =============================================================================

/**
 * 담아 둔 항목이 지금도 볼 수 있는가.
 *
 * **숨기지 않는다.** 커플이 직접 담은 것이라 말없이 사라지면 "내가 담은 게 없어졌다"가
 * 되고 이유를 알 방법이 없다. 게다가 행은 DB 에 남아 있으므로, 화면에서만 감추면
 * 다시 담을 때 유니크 제약(`uq_wishlists_target`·`uq_cart_items_product_options`)에
 * 걸려 사용자가 원인을 알 수 없는 오류를 만난다.
 *
 * 그래서 **비활성 상태로 남기고 삭제만 열어 둔다.**
 */
export type ItemVisibility =
  | { kind: "visible" }
  /** 상품이 내려갔거나 업체가 노출 대상이 아니다. 어느 쪽인지는 고객에게 알리지 않는다. */
  | { kind: "unavailable" };

export const UNAVAILABLE_ITEM_NOTE =
  "업체가 내렸거나 판매를 멈춘 상품이에요. 담은 시점 정보만 남아 있습니다.";

// =============================================================================
// 작성자 표기 (§2.1 · D-19)
// =============================================================================

/** 커플 중 누가 담았는지. 이름을 노출하지 않고 관계로만 적는다. */
export type AddedByLabel = "me" | "partner" | "other";

export function addedByLabelOf(addedBy: string, viewerId: string, memberIds: string[]): AddedByLabel {
  if (addedBy === viewerId) return "me";

  return memberIds.includes(addedBy) ? "partner" : "other";
}

export const ADDED_BY_TEXT: Record<AddedByLabel, string> = {
  me: "내가 담음",
  partner: "배우자가 담음",
  other: "함께 준비하는 사람이 담음",
};

// =============================================================================
// 커플 동시 편집 (D-19)
// =============================================================================

/**
 * **실시간 반영은 이번에 넣지 않는다.**
 *
 * §2.1 F-C-25 는 "한쪽이 담으면 상대 화면에 즉시 반영" 을 요구하지만, Supabase Realtime
 * 도입은 **O-11 미결**이다. 폴링도 후보였으나 장바구니는 변경이 드문 화면이라 주기 조회는
 * 비용만 늘고(§6 WebView 성능 가드), 커플 둘이 같은 순간에 같은 화면을 보는 경우도 드물다.
 *
 * 그래서 **내가 바꾼 것은 즉시 반영하고(서버 갱신 후 새로 그림), 상대가 바꾼 것은
 * 새로 고칠 때 보인다**는 사실을 화면에 적는다. 감추면 "안 담겼나?" 로 읽힌다.
 * 연결 지점은 `app/(consumer)/cart/CartView.tsx` 의 TODO(O-11) 에 표시했다.
 */
export const COUPLE_SYNC_NOTICE =
  "배우자가 방금 바꾼 내용은 새로 고치면 보여요. 실시간 반영은 준비 중입니다.";

export const CART_EMPTY_TITLE = "아직 담은 상품이 없어요";
export const WISHLIST_EMPTY_TITLE = "아직 찜한 곳이 없어요";
export { AMOUNT_UNKNOWN, isUnknownAmount, type Amount };
