import { CartActions } from "@/components/domain/CartActions";
import { PriceDisplay, formatKrw } from "@/components/domain/PriceDisplay";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/EmptyState";
import { ADD_ONS_POLICY_NOTICE, summarizeAddOns } from "@/lib/core/schemas/product-option";
import { findMyCouple } from "@/lib/couple/membership";
import { createPublicClient } from "@/lib/explore/query";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSessionUser } from "@/lib/supabase/auth";

/**
 * 상품 목록 · 추가금 사전표 (F-C-10, §6.2 `/explore/[vendorId]`)
 *
 * **총액·포함 항목·추가금을 한 블록에서 본다**(§6 공통 UI 규칙 — 스크롤해야 추가금을
 * 발견하는 구조는 규칙 위반이다).
 *
 * 조회를 페이지가 아니라 여기서 하는 이유: 페이지가 업체를 찾지 못하면 `notFound()` 로
 * **404 를 내야 하는데**, 라우트에 `loading.tsx` 를 두면 응답이 먼저 흘러나가 상태 코드가
 * 200 으로 굳는다. 그래서 업체 조회만 페이지에 남기고 나머지를 Suspense 안으로 내렸다.
 */
export async function VendorProducts({ vendorId }: { vendorId: string }) {
  const client = createPublicClient();

  const { data: productRows } = await client
    .from("products")
    .select(
      "id, name, base_price_total, price_includes_vat, included_items_json, capacity_min, capacity_max, add_ons_declared_at",
    )
    .eq("vendor_id", vendorId)
    .eq("status", "published")
    .not("add_ons_declared_at", "is", null)
    .order("base_price_total", { ascending: true });

  const products = (productRows ?? []) as {
    id: string;
    name: string;
    base_price_total: number;
    price_includes_vat: boolean;
    included_items_json: unknown;
    capacity_min: number | null;
    capacity_max: number | null;
    add_ons_declared_at: string | null;
  }[];

  if (products.length === 0) {
    return (
      <EmptyState
        assetId="explore.empty"
        title="게시된 상품이 아직 없어요"
        description="이 업체는 아직 상품을 게시하지 않았습니다."
      />
    );
  }

  const { data: optionRows } = await client
    .from("product_options")
    .select("id, product_id, name, price, is_mandatory, trigger_condition")
    .in(
      "product_id",
      products.map((product) => product.id),
    )
    .order("price", { ascending: false });

  const options = (optionRows ?? []) as {
    id: string;
    product_id: string;
    name: string;
    price: number;
    is_mandatory: boolean;
    trigger_condition: Record<string, unknown>;
  }[];

  const user = await getSessionUser();
  const inCart = user ? await cartProducts(user.id) : new Set<string>();
  const wished = user ? await wishedProducts(user.id) : new Set<string>();

  return (
    <div className="space-y-4">
      {products.map((product) => {
        const productOptions = options.filter((option) => option.product_id === product.id);
        const summary = summarizeAddOns(product.add_ons_declared_at, productOptions);
        const included = Array.isArray(product.included_items_json)
          ? (product.included_items_json as { label?: string; name?: string }[])
          : [];

        return (
          <Card key={product.id} data-testid="vendor-product">
            <CardHeader>
              <CardTitle className="text-base">{product.name}</CardTitle>
              {product.capacity_min !== null || product.capacity_max !== null ? (
                <CardDescription>
                  수용 인원 {product.capacity_min ?? "-"} ~ {product.capacity_max ?? "-"}명
                </CardDescription>
              ) : null}
            </CardHeader>

            <CardContent className="space-y-4">
              {/* 총액이 가장 크고, 추가금은 같은 블록 안에 있다(§6 · D-18). */}
              <PriceDisplay
                amount={product.base_price_total}
                basePrice={product.base_price_total}
                taxIncluded={product.price_includes_vat}
                addOns={summary}
                // 탐색 단계에서는 아직 플래너를 고르지 않았다. 행은 숨기지 않는다(D-17).
                plannerFee={{ kind: "not_selected" }}
                size="md"
                label="판매가"
              />

              {included.length > 0 ? (
                <div className="space-y-1" data-testid="included-items">
                  <p className="text-unit text-muted-foreground">포함 항목</p>
                  <ul className="space-y-0.5">
                    {included.map((item, index) => (
                      <li key={index} className="text-sm text-foreground">
                        · {item.label ?? item.name ?? "항목"}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {/* 추가금 사전표. 같은 화면에서 확인 가능해야 한다(§6). */}
              <div className="space-y-1" data-testid="add-on-table">
                <p className="text-unit text-muted-foreground">추가금 사전표</p>

                {summary.kind === "none" ? (
                  <p className="text-sm text-success">등록된 추가금이 없습니다.</p>
                ) : summary.kind === "unknown" ? (
                  <p className="text-sm text-warning">업체가 추가금을 등록하지 않았습니다.</p>
                ) : (
                  <ul className="space-y-1">
                    {productOptions.map((option) => (
                      <li key={option.id} className="flex justify-between gap-2 text-sm">
                        <span className="min-w-0 text-foreground">
                          {option.name}
                          <span className="ml-1 text-caption text-muted-foreground">
                            {option.is_mandatory
                              ? "필수"
                              : String(option.trigger_condition?.description ?? "조건부")}
                          </span>
                        </span>
                        <span data-amount="" className="shrink-0 text-unit font-medium">
                          {formatKrw(option.price)}원
                        </span>
                      </li>
                    ))}
                  </ul>
                )}

                <p className="text-caption text-muted-foreground">{ADD_ONS_POLICY_NOTICE}</p>
              </div>

              <div className="flex">
                <CartActions
                  productId={product.id}
                  vendorId={vendorId}
                  inCart={inCart.has(product.id)}
                  inWishlist={wished.has(product.id)}
                  signedIn={Boolean(user)}
                  next={`/explore/${vendorId}`}
                />
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

async function cartProducts(userId: string): Promise<Set<string>> {
  const membership = await findMyCouple(userId);
  if (!membership) return new Set();

  const admin = createAdminClient();

  const { data: cart } = await admin
    .from("carts")
    .select("id")
    .eq("couple_id", membership.coupleId)
    .eq("status", "active")
    .maybeSingle();

  if (!cart) return new Set();

  const { data: items } = await admin.from("cart_items").select("product_id").eq("cart_id", cart.id);

  return new Set((items ?? []).map((item) => (item as { product_id: string }).product_id));
}

export default VendorProducts;

/** 우리 커플이 찜한 상품 id. 버튼의 '찜함' 표시에만 쓴다. */
async function wishedProducts(userId: string): Promise<Set<string>> {
  const membership = await findMyCouple(userId);
  if (!membership) return new Set();

  const admin = createAdminClient();

  const { data } = await admin
    .from("wishlists")
    .select("product_id")
    .eq("couple_id", membership.coupleId)
    .not("product_id", "is", null);

  return new Set(
    (data ?? []).map((row) => (row as { product_id: string }).product_id),
  );
}
