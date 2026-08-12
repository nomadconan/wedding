"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { BrokerNotice } from "@/components/domain/BrokerNotice";
import { PriceDisplay, formatKrw } from "@/components/domain/PriceDisplay";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { EmptyState } from "@/components/ui/EmptyState";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import type { CartItemView, CartView, CartsView } from "@/lib/cart/loader";
import {
  BUDGET_BASIS_NOTE,
  BUDGET_LINE_LABEL,
  BUDGET_UNSET_HINT,
  CART_DISCARD_NOTICE,
  CART_DUPLICATE_NOTICE,
  CART_LIMIT_REACHED_NOTICE,
  CART_NAME_MAX_LENGTH,
  CATEGORY_NOT_ADDED,
  INCOMPLETE_TOTAL_NOTICE,
} from "@/lib/core/cart/multi-cart";
import {
  AMOUNT_UNKNOWN,
  CART_EMPTY_TITLE,
  COUPLE_SYNC_NOTICE,
  PRICE_CHANGE_LABEL,
  UNAVAILABLE_ITEM_NOTE,
} from "@/lib/core/schemas/cart";
import { VENDOR_CATEGORY_LABEL, type VendorCategory } from "@/lib/core/schemas/vendor";

/**
 * 장바구니 (F-C-25, §6.2 `/cart`) — 여러 개 + 예산 기준선 (IDEA-01)
 *
 * **탭 전환은 URL 이 갖는다**(`?cart=<순번>`). 링크를 그대로 공유하면 같은 장바구니가
 * 열려야 하고 뒤로 가기가 선택을 되돌려야 한다 — `/explore` 필터·비교 조건과 같은 방식이다.
 * 클라이언트 상태로 두면 담기·이름 변경 후 `router.refresh()` 할 때 선택이 튄다.
 *
 * **탭에는 이름과 순번을 함께 적는다.** 이름 중복을 허용하기 때문이다(0027 근거 4) —
 * "부모님추천" 이 둘이면 이름만으로는 어느 쪽인지 말할 수 없다.
 *
 * **업체별로 묶는다.** 계약·결제가 업체 단위로 일어나고(`bookings.vendor_id`), 플래너
 * 선택도 카테고리 = 업체 단위라 묶음이 곧 의사결정 단위다. 375px 에서 평면 목록은
 * 항목마다 업체명을 반복해야 해 정보량만 늘어난다(§6 — 화면당 정보량 최소화).
 *
 * **금액은 서버가 계산한 값을 그대로 그린다.** 화면이 다시 더하면 서버 합계와 갈린다.
 * `price_at_add` 는 "담을 때보다 올랐다" 를 말하는 데만 쓰고 합산에 넣지 않는다(S3-04).
 *
 * **이름 편집은 인라인이다.** 한 칸짜리 편집을 별도 화면으로 빼면 375px 에서 이동이
 * 한 번 더 생기고 맥락(총액·담긴 것)이 사라진다. 대신 늘 열려 있지 않고 버튼으로
 * 여닫는다 — 항상 입력칸이면 스크롤 중에 잘못 건드리게 된다.
 *
 * TODO(O-11): S4-04 가 방식을 정했다(소켓은 신호, 진실은 재조회). `carts`·`cart_items`
 * 를 publication 에 더하면 배우자의 변경을 즉시 반영할 수 있다. 아직 붙이지 않았고,
 * 그 사실을 화면에 적는다(`COUPLE_SYNC_NOTICE`).
 */
export function CartWorkspace({
  view,
  selected,
}: {
  view: CartsView;
  selected: CartView | null;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState(selected?.name ?? "");

  async function call(body: Record<string, unknown>, key: string, after?: (data: unknown) => void) {
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

      after?.(payload.data);
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

  const full = view.nextSeq === null;
  const others = view.carts.filter((cart) => cart.cartId !== selected?.cartId);

  return (
    <div className="space-y-4" data-testid="cart-view">
      {/* ── 장바구니 전환 ─────────────────────────────────────────────────── */}
      <section className="space-y-2" data-testid="cart-switcher">
        <div className="flex items-center justify-between gap-2">
          <p className="text-caption text-muted-foreground">
            장바구니 {view.carts.length}/{view.limit}개
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={pending !== null || full}
            onClick={() => call({ action: "create_cart" }, "create")}
            data-testid="create-cart"
          >
            새 장바구니
          </Button>
        </div>

        {/* 375px 에서 5개 탭은 한 줄에 들어가지 않는다. 이 안에서만 옆으로 밀린다. */}
        <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
          {view.carts.map((cart) => {
            const active = cart.cartId === selected?.cartId;

            return (
              <Link
                key={cart.cartId}
                href={`/cart?cart=${cart.seq}`}
                scroll={false}
                data-testid="cart-tab"
                data-seq={cart.seq}
                data-state={active ? "active" : "inactive"}
                aria-current={active ? "page" : undefined}
                className={`shrink-0 rounded-full border px-3 py-1.5 text-caption font-medium ${
                  active
                    ? "border-brand-600 bg-brand-50 text-brand-600"
                    : "border-border text-muted-foreground"
                }`}
              >
                {cart.seq}. {cart.label}
              </Link>
            );
          })}
        </div>

        {full ? (
          <p className="text-caption text-muted-foreground" data-testid="cart-limit-notice">
            {CART_LIMIT_REACHED_NOTICE}
          </p>
        ) : null}
        {!view.limitConfigured ? (
          <p className="text-caption text-warning" data-testid="cart-limit-unset">
            상한 설정이 없어 한 개로 좁혀 두었어요.
          </p>
        ) : null}
      </section>

      <p className="text-caption text-muted-foreground" data-testid="couple-sync-notice">
        {COUPLE_SYNC_NOTICE}
      </p>

      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}

      {selected === null ? (
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
      ) : (
        <>
          {/* ── 이름 · 복제 · 치우기 ───────────────────────────────────────── */}
          <Card data-testid="cart-header" data-cart-id={selected.cartId}>
            <CardContent className="space-y-3 pt-5">
              {renaming ? (
                <div className="space-y-2">
                  <Label htmlFor="cart-name">장바구니 이름</Label>
                  <Input
                    id="cart-name"
                    value={nameDraft}
                    maxLength={CART_NAME_MAX_LENGTH}
                    placeholder={`장바구니 ${selected.seq}`}
                    onChange={(e) => setNameDraft(e.target.value)}
                    data-testid="cart-name-input"
                  />
                  <p className="text-caption text-muted-foreground">
                    {CART_NAME_MAX_LENGTH}자까지 쓸 수 있어요. 비우면 순번(장바구니{" "}
                    {selected.seq})으로 불러요.
                  </p>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      size="sm"
                      disabled={pending !== null}
                      onClick={() =>
                        call(
                          {
                            action: "rename_cart",
                            cartId: selected.cartId,
                            name: nameDraft.trim() === "" ? null : nameDraft,
                          },
                          "rename",
                          () => setRenaming(false),
                        )
                      }
                      data-testid="cart-name-save"
                    >
                      저장
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setNameDraft(selected.name ?? "");
                        setRenaming(false);
                      }}
                    >
                      취소
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-base font-semibold text-foreground" data-testid="cart-label">
                      {selected.label}
                    </p>
                    <p className="text-caption text-muted-foreground">
                      {selected.seq}번 장바구니 · 담은 것{" "}
                      {selected.items.filter((item) => item.visibility.kind === "visible").length}개
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setNameDraft(selected.name ?? "");
                      setRenaming(true);
                    }}
                    data-testid="cart-rename"
                  >
                    이름
                  </Button>
                </div>
              )}

              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={pending !== null || full}
                  onClick={() => call({ action: "duplicate_cart", cartId: selected.cartId }, "duplicate")}
                  data-testid="duplicate-cart"
                >
                  복제
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={pending !== null}
                  onClick={() => call({ action: "discard_cart", cartId: selected.cartId }, "discard")}
                  data-testid="discard-cart"
                >
                  치우기
                </Button>
              </div>

              <p className="text-caption text-muted-foreground">{CART_DUPLICATE_NOTICE}</p>
              <p className="text-caption text-muted-foreground">{CART_DISCARD_NOTICE}</p>
            </CardContent>
          </Card>

          {/* ── 총액 · 예산 · 채움 ─────────────────────────────────────────── */}
          <Card data-testid="cart-total">
            <CardContent className="space-y-3 pt-5">
              {selected.total ? (
                <PriceDisplay
                  amount={selected.total.total}
                  basePrice={selected.total.basePrice}
                  taxIncluded
                  addOns={selected.total.addOns}
                  plannerFee={selected.total.plannerFee}
                  variant="sum"
                  itemCount={selected.total.itemCount}
                  size="lg"
                />
              ) : (
                <p className="text-sm text-muted-foreground">
                  담은 것이 없어 총액이 없어요. {CATEGORY_NOT_ADDED} 상태예요.
                </p>
              )}

              {/* 예산 기준선. **예산이 미정이면 그리지 않는다** — 0원 대비로 말하지 않는다. */}
              <div data-testid="budget-line" data-state={selected.budget.kind}>
                {selected.budget.kind === "none" ? (
                  <p className="text-caption text-muted-foreground">
                    {BUDGET_LINE_LABEL.none} {BUDGET_UNSET_HINT}
                  </p>
                ) : selected.budget.kind === "unknown" ? (
                  <p className="text-caption text-muted-foreground">{BUDGET_LINE_LABEL.unknown}</p>
                ) : (
                  <div className="space-y-1">
                    <p
                      className={`text-sm font-medium ${
                        selected.budget.kind === "over" ? "text-warning" : "text-success"
                      }`}
                    >
                      {BUDGET_LINE_LABEL[selected.budget.kind]} · 예산{" "}
                      <span data-amount="">{formatKrw(selected.budget.budget)}</span>원
                      {selected.budget.kind === "under" ? (
                        <>
                          {" "}
                          · 여유 <span data-amount="">{formatKrw(selected.budget.remaining)}</span>원
                        </>
                      ) : null}
                      {selected.budget.kind === "over" ? (
                        <>
                          {" "}
                          · 초과 <span data-amount="">{formatKrw(selected.budget.excess)}</span>원
                        </>
                      ) : null}
                    </p>
                    {BUDGET_BASIS_NOTE[selected.budget.basis] === "" ? null : (
                      <p className="text-caption text-muted-foreground" data-testid="budget-basis">
                        {BUDGET_BASIS_NOTE[selected.budget.basis]}
                      </p>
                    )}
                  </div>
                )}
              </div>

              {/* 카테고리 채움. 비어 있으면 '0원' 이 아니라 '아직 안 담음' 이다. */}
              {selected.fill === null ? (
                <p className="text-caption text-muted-foreground" data-testid="fill-unjudged">
                  채움 기준이 설정되지 않아 어느 카테고리가 비었는지 판단하지 않았어요.
                </p>
              ) : (
                <div className="space-y-2" data-testid="category-fill" data-complete={selected.fill.complete}>
                  <div className="flex flex-wrap gap-1.5">
                    {selected.fill.core.map((category) => {
                      const filled = selected.fill!.filled.includes(category);

                      return (
                        <Badge
                          key={category}
                          variant={filled ? "default" : "secondary"}
                          data-testid="fill-chip"
                          data-category={category}
                          data-state={filled ? "filled" : "empty"}
                        >
                          {VENDOR_CATEGORY_LABEL[category as VendorCategory] ?? category}
                          {filled ? "" : ` · ${CATEGORY_NOT_ADDED}`}
                        </Badge>
                      );
                    })}
                    {selected.fill.extra.map((category) => (
                      <Badge key={category} variant="outline" data-testid="fill-extra">
                        {VENDOR_CATEGORY_LABEL[category as VendorCategory] ?? category}
                      </Badge>
                    ))}
                  </div>

                  {selected.fill.complete ? null : (
                    <p className="text-caption text-warning" data-testid="incomplete-total">
                      {INCOMPLETE_TOTAL_NOTICE}
                    </p>
                  )}
                </div>
              )}

              {selected.excludedCount > 0 ? (
                <p className="text-caption text-warning" data-testid="excluded-note">
                  지금은 볼 수 없는 항목 {selected.excludedCount}건은 합계에서 뺐어요.
                </p>
              ) : null}
            </CardContent>
          </Card>

          <CartItems
            cart={selected}
            others={others}
            pending={pending}
            onRemove={remove}
            onCall={call}
          />
        </>
      )}

      {/* 비교 진입(§6.2 /cart 핵심 요소). 담은 것을 나란히 견주는 화면으로 간다. */}
      <Link
        href={view.carts.length >= 2 ? "/explore/compare?mode=carts" : "/explore/compare"}
        className="block rounded-md border border-border px-3 py-2 text-center text-sm font-medium text-foreground"
        data-testid="go-compare"
      >
        {view.carts.length >= 2 ? "장바구니끼리 비교하기" : "담은 것 비교하기"}
      </Link>

      {/* 거래로 이어지는 화면이므로 중개자 지위를 고지한다(D-24 · §6). */}
      <BrokerNotice variant="inline" />
    </div>
  );
}

/** 담긴 항목. 업체별로 묶고, 볼 수 없는 항목은 마지막에 따로 모은다. */
function CartItems({
  cart,
  others,
  pending,
  onRemove,
  onCall,
}: {
  cart: CartView;
  others: CartView[];
  pending: string | null;
  onRemove: (itemId: string) => void;
  onCall: (body: Record<string, unknown>, key: string) => void;
}) {
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

  if (cart.items.length === 0) {
    return (
      <EmptyState
        assetId="explore.empty"
        title="이 장바구니는 비어 있어요"
        description="업체를 담아 두면 이 장바구니의 총액이 계산돼요."
        action={
          <Link href="/explore" className="text-sm font-medium text-brand-600">
            업체 둘러보기
          </Link>
        }
      />
    );
  }

  return (
    <>
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

                {/* 카테고리별 플래너 선택(D-17 · F-C-31). **장바구니마다 다를 수 있다** —
                    같은 상품을 두 장바구니에 담고 한쪽만 켜면 총액 차이가 그대로 비교값이다. */}
                <div className="flex items-center gap-2">
                  <Checkbox
                    id={`planner-${item.itemId}`}
                    checked={item.plannerSelected}
                    disabled={pending !== null}
                    onCheckedChange={(checked) =>
                      onCall(
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

                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={pending !== null}
                    onClick={() => onRemove(item.itemId)}
                    data-testid="remove-item"
                  >
                    빼기
                  </Button>
                </div>

                {/* 다른 장바구니로 옮기기·복사. **접어 둔다** — 항목마다 버튼 넷을
                    펼쳐 두면 375px 에서 정작 상품 정보가 밀린다. */}
                {others.length > 0 ? (
                  <details className="rounded-md border border-border px-3 py-2" data-testid="item-transfer">
                    <summary className="cursor-pointer text-caption font-medium text-foreground">
                      다른 장바구니로
                    </summary>
                    <div className="space-y-2 pt-2">
                      {others.map((other) => (
                        <div key={other.cartId} className="flex items-center justify-between gap-2">
                          <span className="min-w-0 truncate text-caption text-muted-foreground">
                            {other.seq}. {other.label}
                          </span>
                          <div className="flex shrink-0 gap-1.5">
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              disabled={pending !== null}
                              onClick={() =>
                                onCall(
                                  { action: "move_item", itemId: item.itemId, toCartId: other.cartId },
                                  `${item.itemId}:move`,
                                )
                              }
                              data-testid="move-item"
                            >
                              옮기기
                            </Button>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              disabled={pending !== null}
                              onClick={() =>
                                onCall(
                                  { action: "copy_item", itemId: item.itemId, toCartId: other.cartId },
                                  `${item.itemId}:copy`,
                                )
                              }
                              data-testid="copy-item"
                            >
                              복사
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </details>
                ) : null}
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
                  onClick={() => onRemove(item.itemId)}
                >
                  빼기
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}
    </>
  );
}

export default CartWorkspace;
