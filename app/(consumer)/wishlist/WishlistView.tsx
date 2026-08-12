"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { formatKrw } from "@/components/domain/PriceDisplay";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/EmptyState";
import type { WishlistItemView } from "@/lib/cart/wishlist";
import {
  CART_CHOOSE_TARGET_LABEL,
  type CartChoice,
} from "@/lib/core/cart/multi-cart";
import {
  COUPLE_SYNC_NOTICE,
  PRICE_CHANGE_LABEL,
  UNAVAILABLE_ITEM_NOTE,
  WISHLIST_EMPTY_TITLE,
} from "@/lib/core/schemas/cart";
import { bpToPercentText } from "@/lib/core/pricing/dynamic";
import { VENDOR_CATEGORY_LABEL, type VendorCategory } from "@/lib/core/schemas/vendor";

/**
 * 찜 (F-C-26, §6.2 `/wishlist`)
 *
 * **담은 시점 가격 대비 변동을 말하는 것이 이 화면의 일이다.** 그래서 장바구니와 달리
 * `price_at_add` 를 앞세운다.
 *
 * **'변동 없음'으로 뭉개지 않는 상태가 둘 있다** — 담은 시점 가격이 없는 경우(업체 찜)와
 * 상품이 내려가 현재가가 없는 경우다. 둘 다 "그대로예요" 라고 적으면 사실이 아니다.
 *
 * TODO(O-11): 실시간 반영은 Realtime 결정 후. TODO(S4-13): 가격 변동 **알림**
 * (`wishlist-price-watch` 배치)은 알림 인프라가 붙은 뒤에 연결한다.
 */
export function WishlistView({
  items,
  unavailableCount,
  carts,
}: {
  items: WishlistItemView[];
  unavailableCount: number;
  /**
   * 담을 수 있는 장바구니(IDEA-01). **둘 이상이면 어디로 보낼지 고르는 단계가 생긴다** —
   * 서버가 임의로 고르면 방금 만든 비교용 장바구니가 아니라 엉뚱한 곳에 들어간다.
   * 하나뿐이면 묻지 않는다(고를 것이 없다).
   */
  carts: CartChoice[];
}) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function move(item: WishlistItemView, cartId?: string) {
    setPending(item.id);
    setError(null);

    try {
      const response = await fetch("/api/cart", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "move_from_wishlist",
          wishlistId: item.id,
          // 지정하지 않으면 서버가 가장 최근에 쓴 장바구니로 보낸다. 고를 것이 하나뿐일
          // 때 묻지 않기 위한 길이다.
          ...(cartId === undefined ? {} : { cartId }),
        }),
      });
      const payload = await response.json();

      if (!response.ok || !payload.ok) {
        setError(payload.error?.message ?? "옮기지 못했어요.");

        return;
      }

      router.refresh();
    } catch {
      setError("옮기지 못했어요. 잠시 후 다시 시도해 주세요.");
    } finally {
      setPending(null);
    }
  }

  async function remove(id: string) {
    setPending(id);
    setError(null);

    try {
      const response = await fetch(`/api/wishlist?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      const payload = await response.json();

      if (!response.ok || !payload.ok) {
        setError(payload.error?.message ?? "빼지 못했어요.");

        return;
      }

      router.refresh();
    } catch {
      setError("빼지 못했어요. 잠시 후 다시 시도해 주세요.");
    } finally {
      setPending(null);
    }
  }

  if (items.length === 0) {
    return (
      <EmptyState
        assetId="explore.empty"
        title={WISHLIST_EMPTY_TITLE}
        description="관심 있는 업체를 찜해 두면 가격이 바뀔 때 알아볼 수 있어요."
        action={
          <Link href="/explore" className="text-sm font-medium text-brand-600">
            업체 둘러보기
          </Link>
        }
      />
    );
  }

  return (
    <div className="space-y-3" data-testid="wishlist-view">
      <p className="text-caption text-muted-foreground">{COUPLE_SYNC_NOTICE}</p>

      {unavailableCount > 0 ? (
        <p className="text-caption text-warning" data-testid="wishlist-unavailable-note">
          지금은 볼 수 없는 항목 {unavailableCount}건이 있어요. {UNAVAILABLE_ITEM_NOTE}
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}

      {items.map((item) => {
        const unavailable = item.visibility.kind === "unavailable";

        return (
          <Card key={item.id} data-testid="wishlist-item" data-state={item.visibility.kind}>
            <CardContent className="space-y-2 pt-5">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  {unavailable ? (
                    <p className="truncate text-sm text-muted-foreground">
                      지금은 볼 수 없는 항목
                    </p>
                  ) : (
                    <Link
                      href={`/explore/${item.vendorId}`}
                      className="block truncate text-sm font-semibold text-foreground"
                    >
                      {item.vendorName}
                    </Link>
                  )}
                  <p className="truncate text-caption text-muted-foreground">
                    {item.vendorOnly
                      ? "업체 찜"
                      : (item.productName ?? "상품")}
                    {item.category
                      ? ` · ${VENDOR_CATEGORY_LABEL[item.category as VendorCategory] ?? item.category}`
                      : ""}
                  </p>
                </div>
                <Badge variant="secondary">{item.addedByText}</Badge>
              </div>

              {/* 업체 찜에는 비교할 가격이 없다. 없는 비교를 지어내지 않는다. */}
              {item.vendorOnly ? null : (
                <div data-testid="price-change" data-state={item.priceChange.kind}>
                  {item.priceChange.kind === "up" || item.priceChange.kind === "down" ? (
                    <>
                      <p className="flex items-baseline gap-1">
                        <span data-amount="" className="text-amount-sm text-foreground">
                          {formatKrw(item.priceChange.to)}
                        </span>
                        <span className="text-sm text-muted-foreground">원</span>
                      </p>
                      <p
                        className={`text-caption ${item.priceChange.kind === "up" ? "text-warning" : "text-success"}`}
                      >
                        {PRICE_CHANGE_LABEL[item.priceChange.kind]} · 담을 때{" "}
                        {formatKrw(item.priceChange.from)}원 ·{" "}
                        {bpToPercentText(item.priceChange.rateBp)}
                      </p>
                    </>
                  ) : item.priceChange.kind === "same" ? (
                    <>
                      <p className="flex items-baseline gap-1">
                        <span data-amount="" className="text-amount-sm text-foreground">
                          {formatKrw(item.priceChange.price)}
                        </span>
                        <span className="text-sm text-muted-foreground">원</span>
                      </p>
                      <p className="text-caption text-muted-foreground">
                        {PRICE_CHANGE_LABEL.same}
                      </p>
                    </>
                  ) : (
                    // unknown · unavailable — '변동 없음'과 절대 같은 문구가 되지 않는다.
                    <p className="text-caption text-muted-foreground">
                      {PRICE_CHANGE_LABEL[item.priceChange.kind]}
                      {item.priceAtAdd !== null
                        ? ` · 담을 때 ${formatKrw(item.priceAtAdd)}원`
                        : ""}
                    </p>
                  )}
                </div>
              )}

              <div className="flex gap-2">
                {/* 장바구니가 둘 이상이면 **어디로 보낼지 고른다**(IDEA-01). 하나뿐이면
                    묻지 않는다 — 고를 것이 없는데 묻는 것은 단계만 늘리는 일이다. */}
                {!item.vendorOnly && !unavailable && carts.length <= 1 ? (
                  <Button
                    type="button"
                    size="sm"
                    disabled={pending !== null}
                    onClick={() => move(item)}
                    data-testid="move-to-cart"
                  >
                    장바구니로 옮기기
                  </Button>
                ) : null}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={pending !== null}
                  onClick={() => remove(item.id)}
                  data-testid="remove-wishlist"
                >
                  빼기
                </Button>
              </div>

              {/* 여러 장바구니 — 어디로 보낼지 고른다. 접어 두는 이유는 찜 목록이
                  카드의 연속이라, 항목마다 버튼 다섯을 펼치면 목록이 읽히지 않는다. */}
              {!item.vendorOnly && !unavailable && carts.length > 1 ? (
                <details className="rounded-md border border-border px-3 py-2" data-testid="move-to-cart-choose">
                  <summary className="cursor-pointer text-caption font-medium text-foreground">
                    {CART_CHOOSE_TARGET_LABEL}
                  </summary>
                  <div className="space-y-1.5 pt-2">
                    {carts.map((cart) => (
                      <Button
                        key={cart.cartId}
                        type="button"
                        variant="outline"
                        size="sm"
                        className="w-full justify-start"
                        disabled={pending !== null}
                        onClick={() => move(item, cart.cartId)}
                        data-testid="move-to-cart"
                        data-cart-id={cart.cartId}
                      >
                        {cart.seq}. {cart.label}
                      </Button>
                    ))}
                  </div>
                </details>
              ) : null}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

export default WishlistView;
