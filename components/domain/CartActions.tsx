"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import {
  CART_CHOOSE_TARGET_LABEL,
  type CartChoice,
} from "@/lib/core/cart/multi-cart";

/**
 * 담기 · 찜 버튼 (S3-05 · F-C-25 · F-C-26 · IDEA-01)
 *
 * S3-03 이 자리만 만들어 둔 버튼에 동작을 붙인 것이다. 목록 카드와 업체 상세가 같은
 * 컴포넌트를 쓴다 — 두 곳에 각각 fetch 를 쓰면 오류 문구와 담긴 상태 처리가 갈린다.
 *
 * **비로그인은 로그인으로 보낸다**(§1.4 — 탐색은 열려 있고 담기부터 로그인이 필요하다).
 * 목록·상세는 서버 컴포넌트라 담긴 상태는 서버가 내려주고, 담은 뒤에는 `router.refresh()`
 * 로 그 상태를 다시 받는다.
 *
 * ── 어느 장바구니에 담는가 (IDEA-01) ────────────────────────────────────────
 * 장바구니가 여러 개가 되면서 **'담김' 의 의미가 바뀌었다.** 예전에는 담긴 상품을 다시
 * 담을 이유가 없어 버튼을 잠갔는데, 이제는 **같은 상품을 두 장바구니에 담는 것이 정상
 * 동선**이다 — 홀만 바꿔 견주려면 스드메는 양쪽에 다 있어야 한다.
 *
 * 그래서:
 *  - 장바구니가 하나뿐이고 이미 담겼으면 → 예전처럼 잠근다(할 일이 없다).
 *  - 둘 이상이면 → **어디로 담을지 고르게 한다.** 이미 그 장바구니에 있는 것만 잠근다
 *    (같은 상품·같은 옵션 중복은 DB 가 막는다 — `uq_cart_items_product_options`).
 */
export type CartActionsProps = {
  productId: string;
  vendorId: string;
  /** 서버가 내려준 담김 상태. 하나라도 담겨 있으면 true 다. */
  inCart: boolean;
  inWishlist: boolean;
  signedIn: boolean;
  /** 로그인 후 돌아올 경로. */
  next: string;
  /** 담을 수 있는 장바구니. 비어 있으면 담는 순간 서버가 만든다. */
  carts?: CartChoice[];
};

export function CartActions({
  productId,
  vendorId,
  inCart,
  inWishlist,
  signedIn,
  next,
  carts = [],
}: CartActionsProps) {
  const router = useRouter();
  const [pending, setPending] = useState<"cart" | "wishlist" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);

  async function post(path: string, body: unknown, key: "cart" | "wishlist") {
    setPending(key);
    setError(null);

    try {
      const response = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json();

      if (!response.ok || !payload.ok) {
        setError(payload.error?.message ?? "처리하지 못했어요.");

        return;
      }

      setChoosing(false);
      router.refresh();
    } catch {
      setError("처리하지 못했어요. 잠시 후 다시 시도해 주세요.");
    } finally {
      setPending(null);
    }
  }

  function addTo(cartId?: string) {
    return post(
      "/api/cart",
      { action: "add", productId, options: {}, ...(cartId === undefined ? {} : { cartId }) },
      "cart",
    );
  }

  if (!signedIn) {
    return (
      <a
        href={`/login?next=${encodeURIComponent(next)}`}
        data-testid="add-to-cart-guest"
        className="flex-1 rounded-md bg-secondary px-3 py-2 text-center text-sm font-medium text-secondary-foreground"
      >
        로그인하고 담기
      </a>
    );
  }

  const multi = carts.length > 1;
  // 하나뿐일 때만 '담김' 으로 잠근다. 여럿이면 다른 장바구니에 담을 일이 남아 있다.
  const locked = !multi && inCart;

  return (
    <div className="flex flex-1 flex-col gap-1">
      <div className="flex gap-2">
        <button
          type="button"
          data-testid="add-to-cart"
          data-state={inCart ? "in-cart" : "not-in-cart"}
          disabled={pending !== null || locked}
          onClick={() => (multi ? setChoosing((open) => !open) : void addTo())}
          className="flex-1 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
        >
          {locked ? "담김" : pending === "cart" ? "담는 중…" : multi ? "담기 …" : "담기"}
        </button>

        <button
          type="button"
          data-testid="add-to-wishlist"
          data-state={inWishlist ? "in-wishlist" : "not-in-wishlist"}
          disabled={pending !== null || inWishlist}
          onClick={() => post("/api/wishlist", { action: "add", vendorId, productId }, "wishlist")}
          className="rounded-md border border-border px-3 py-2 text-sm font-medium text-foreground disabled:opacity-60"
        >
          {inWishlist ? "찜함" : "찜"}
        </button>
      </div>

      {multi && choosing ? (
        <div className="space-y-1 rounded-md border border-border p-2" data-testid="cart-choose">
          <p className="text-caption text-muted-foreground">{CART_CHOOSE_TARGET_LABEL}</p>
          {carts.map((cart) => (
            <button
              key={cart.cartId}
              type="button"
              disabled={pending !== null || cart.contains === true}
              onClick={() => void addTo(cart.cartId)}
              data-testid="cart-choose-option"
              data-cart-id={cart.cartId}
              data-state={cart.contains === true ? "contains" : "available"}
              className="w-full rounded-md border border-border px-2 py-1.5 text-left text-caption text-foreground disabled:opacity-60"
            >
              {cart.seq}. {cart.label}
              {cart.contains === true ? " · 이미 담김" : ""}
            </button>
          ))}
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="text-caption text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export default CartActions;
