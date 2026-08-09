"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * 담기 · 찜 버튼 (S3-05 · F-C-25 · F-C-26)
 *
 * S3-03 이 자리만 만들어 둔 버튼에 동작을 붙인 것이다. 목록 카드와 업체 상세가 같은
 * 컴포넌트를 쓴다 — 두 곳에 각각 fetch 를 쓰면 오류 문구와 담긴 상태 처리가 갈린다.
 *
 * **비로그인은 로그인으로 보낸다**(§1.4 — 탐색은 열려 있고 담기부터 로그인이 필요하다).
 * 목록·상세는 서버 컴포넌트라 담긴 상태는 서버가 내려주고, 담은 뒤에는 `router.refresh()`
 * 로 그 상태를 다시 받는다.
 */
export type CartActionsProps = {
  productId: string;
  vendorId: string;
  /** 서버가 내려준 담김 상태. */
  inCart: boolean;
  inWishlist: boolean;
  signedIn: boolean;
  /** 로그인 후 돌아올 경로. */
  next: string;
};

export function CartActions({
  productId,
  vendorId,
  inCart,
  inWishlist,
  signedIn,
  next,
}: CartActionsProps) {
  const router = useRouter();
  const [pending, setPending] = useState<"cart" | "wishlist" | null>(null);
  const [error, setError] = useState<string | null>(null);

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

      router.refresh();
    } catch {
      setError("처리하지 못했어요. 잠시 후 다시 시도해 주세요.");
    } finally {
      setPending(null);
    }
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

  return (
    <div className="flex flex-1 flex-col gap-1">
      <div className="flex gap-2">
        <button
          type="button"
          data-testid="add-to-cart"
          data-state={inCart ? "in-cart" : "not-in-cart"}
          disabled={pending !== null || inCart}
          onClick={() => post("/api/cart", { action: "add", productId, options: {} }, "cart")}
          className="flex-1 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
        >
          {inCart ? "담김" : pending === "cart" ? "담는 중…" : "담기"}
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

      {error ? (
        <p role="alert" className="text-caption text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export default CartActions;
