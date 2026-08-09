"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { useState } from "react";

import { BrokerNotice } from "@/components/domain/BrokerNotice";
import { PriceDisplay, formatKrw } from "@/components/domain/PriceDisplay";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { EmptyState } from "@/components/ui/EmptyState";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import type { CartItemView, CartView as CartData } from "@/lib/cart/loader";
import {
  AMOUNT_UNKNOWN,
  CART_EMPTY_TITLE,
  COUPLE_SYNC_NOTICE,
  PRICE_CHANGE_LABEL,
  UNAVAILABLE_ITEM_NOTE,
} from "@/lib/core/schemas/cart";
import { VENDOR_CATEGORY_LABEL, type VendorCategory } from "@/lib/core/schemas/vendor";

/**
 * 장바구니 (F-C-25, §6.2 `/cart`)
 *
 * **업체별로 묶는다.** 계약·결제가 업체 단위로 일어나고(`bookings.vendor_id`), 플래너
 * 선택도 카테고리 = 업체 단위라 묶음이 곧 의사결정 단위다. 375px 에서 평면 목록은
 * 항목마다 업체명을 반복해야 해 정보량만 늘어난다(§6 — 화면당 정보량 최소화).
 *
 * **금액은 서버가 계산한 값을 그대로 그린다.** 화면이 다시 더하면 서버 합계와 갈린다.
 * `price_at_add` 는 "담을 때보다 올랐다" 를 말하는 데만 쓰고 합산에 넣지 않는다(S3-04).
 *
 * TODO(O-11): Supabase Realtime 이 결정되면 여기서 `cart_items` 를 구독해 배우자의
 * 변경을 즉시 반영한다. 지금은 내가 바꾼 것만 즉시 반영하고 상대 변경은 새로 고칠 때
 * 보인다는 사실을 화면에 적는다(`COUPLE_SYNC_NOTICE`).
 */
export function CartView({ cart }: { cart: CartData }) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function call(body: unknown, key: string) {
    setPending(key);
    setError(null);

    try {
      const response = await fetch("/api/cart", {
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

  async function remove(itemId: string) {
    setPending(itemId);
    setError(null);

    try {
      const response = await fetch(`/api/cart?itemId=${encodeURIComponent(itemId)}`, {
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

  if (cart.items.length === 0) {
    return (
      <EmptyState
        assetId="explore.empty"
        title={CART_EMPTY_TITLE}
        description="마음에 드는 업체를 담아 두면 총액을 한눈에 비교할 수 있어요."
        action={
          <Link href="/explore" className="text-sm font-medium text-brand-600">
            업체 둘러보기
          </Link>
        }
      />
    );
  }

  // 업체별 묶음. 볼 수 없는 항목은 마지막에 따로 모은다.
  const groups = new Map<string, CartItemView[]>();
  const unavailable: CartItemView[] = [];

  for (const item of cart.items) {
    if (item.visibility.kind === "unavailable") {
      unavailable.push(item);
      continue;
    }

    const key = item.vendorId ?? "unknown";
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }

  return (
    <div className="space-y-4" data-testid="cart-view">
      <p className="text-caption text-muted-foreground" data-testid="couple-sync-notice">
        {COUPLE_SYNC_NOTICE}
      </p>

      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}

      {[...groups.entries()].map(([vendorId, items]) => (
        <Card key={vendorId} data-testid="cart-group" data-vendor-id={vendorId}>
          <CardContent className="space-y-4 pt-5">
            <div className="flex items-center justify-between gap-2">
              <Link
                href={`/explore/${vendorId}`}
                className="truncate text-sm font-semibold text-foreground"
              >
                {items[0].vendorName}
              </Link>
              <span className="shrink-0 text-caption text-muted-foreground">
                {items[0].category
                  ? (VENDOR_CATEGORY_LABEL[items[0].category as VendorCategory] ?? items[0].category)
                  : ""}
              </span>
            </div>

            {items.map((item) => (
              <div key={item.itemId} className="space-y-2" data-testid="cart-item">
                <Separator />

                <div className="flex items-start justify-between gap-2">
                  <p className="min-w-0 truncate text-sm text-foreground">{item.productName}</p>
                  <Badge variant="secondary" data-testid="added-by">
                    {item.addedByText}
                  </Badge>
                </div>

                <PriceDisplay
                  amount={item.basePrice ?? 0}
                  basePrice={item.basePrice ?? 0}
                  taxIncluded={item.priceIncludesVat}
                  addOns={item.addOns}
                  plannerFee={
                    item.plannerSelected
                      ? {
                          kind: "selected",
                          // 요율이 없으면 금액을 지어내지 않는다. 서버가 계산하지 못한
                          // 항목은 명시적 '미정'이며, PriceDisplay 가 그대로 '미정'으로 적는다.
                          amount: item.plannerFeeAmount ?? AMOUNT_UNKNOWN,
                        }
                      : { kind: "not_selected" }
                  }
                  size="sm"
                  label="판매가"
                />

                {/* 담을 때보다 값이 바뀌었으면 알린다. 합산에는 쓰지 않는다. */}
                {item.priceChange.kind === "up" || item.priceChange.kind === "down" ? (
                  <p
                    className={`text-caption ${item.priceChange.kind === "up" ? "text-warning" : "text-success"}`}
                    data-testid="price-change"
                    data-state={item.priceChange.kind}
                  >
                    {PRICE_CHANGE_LABEL[item.priceChange.kind]} · 담을 때{" "}
                    {formatKrw(item.priceChange.from)}원 → 지금 {formatKrw(item.priceChange.to)}원
                  </p>
                ) : null}

                {/* 카테고리별 플래너 선택(D-17 · F-C-31). 선택 즉시 총액에 반영된다. */}
                <div className="flex items-center gap-2">
                  <Checkbox
                    id={`planner-${item.itemId}`}
                    checked={item.plannerSelected}
                    disabled={pending !== null}
                    onCheckedChange={(checked) =>
                      call(
                        { action: "set_planner", itemId: item.itemId, selected: checked === true },
                        item.itemId,
                      )
                    }
                  />
                  <Label htmlFor={`planner-${item.itemId}`} className="font-normal">
                    이 항목은 플래너에게 맡길래요
                  </Label>
                </div>

                {item.plannerSelected && item.plannerRateMissing ? (
                  <p className="text-caption text-warning" data-testid="planner-rate-missing">
                    플래너 수수료율이 아직 설정되지 않아 금액을 계산할 수 없어요.
                  </p>
                ) : null}

                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={pending !== null}
                  onClick={() => remove(item.itemId)}
                  data-testid="remove-item"
                >
                  빼기
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      ))}

      {unavailable.length > 0 ? (
        <Card data-testid="cart-unavailable">
          <CardContent className="space-y-3 pt-5">
            <p className="text-sm font-medium text-foreground">지금은 볼 수 없는 항목</p>
            <p className="text-caption text-muted-foreground">{UNAVAILABLE_ITEM_NOTE}</p>

            {unavailable.map((item) => (
              <div key={item.itemId} className="flex items-center justify-between gap-2">
                <span className="text-caption text-muted-foreground">
                  담을 때 {formatKrw(item.priceAtAdd)}원 · {item.addedByText}
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={pending !== null}
                  onClick={() => remove(item.itemId)}
                >
                  빼기
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

      {/* 합계. 서버가 계산한 값을 그대로 그린다. */}
      {cart.total ? (
        <Card>
          <CardContent className="pt-5">
            <PriceDisplay
              amount={cart.total.total}
              basePrice={cart.total.basePrice}
              taxIncluded
              addOns={cart.total.addOns}
              plannerFee={cart.total.plannerFee}
              variant="sum"
              itemCount={cart.total.itemCount}
              size="lg"
            />

            {cart.excludedCount > 0 ? (
              <p className="pt-2 text-caption text-warning" data-testid="excluded-note">
                지금은 볼 수 없는 항목 {cart.excludedCount}건은 합계에서 뺐어요.
              </p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {/* 비교 진입(§6.2 /cart 핵심 요소). 담은 것을 나란히 견주는 화면으로 간다. */}
      <Link
        href="/explore/compare"
        className="block rounded-md border border-border px-3 py-2 text-center text-sm font-medium text-foreground"
        data-testid="go-compare"
      >
        담은 것 비교하기
      </Link>

      {/* 거래로 이어지는 화면이므로 중개자 지위를 고지한다(D-24 · §6). */}
      <BrokerNotice variant="inline" />
    </div>
  );
}

export default CartView;
