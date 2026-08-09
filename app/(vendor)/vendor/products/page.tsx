import type { Metadata } from "next";
import Link from "next/link";

import { PriceDisplay } from "@/components/domain/PriceDisplay";
import { AdminShell } from "@/components/layout/AdminShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import {
  PRODUCT_STATUS_LABEL,
  VENDOR_PRICING_NOTICE,
  type ProductStatus,
} from "@/lib/core/schemas/product";
import { summarizeAddOns } from "@/lib/core/schemas/product-option";
import { VENDOR_CATEGORY_LABEL, type VendorCategory } from "@/lib/core/schemas/vendor";
import { resolveVendorCommission } from "@/lib/pricing/vendor-rate";
import { requireUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";
import { PRODUCT_COLUMNS, findMemberVendor, publishBlockersOf } from "@/lib/vendor/products";

export const metadata: Metadata = {
  title: "상품·가격 — 웨딩클리어",
};

/**
 * /vendor/products (F-V-03, §6.3)
 *
 * 목록은 **사용자 세션 클라이언트**로 읽는다 — RLS 가 자기 업체 상품만(draft 포함) 보여준다.
 * 금액은 예외 없이 `PriceDisplay` 로 그린다(docs/DESIGN.md §3 원칙 1).
 */
const STATUS_VARIANT: Record<ProductStatus, "default" | "secondary" | "outline"> = {
  draft: "secondary",
  published: "default",
  archived: "outline",
};

export default async function VendorProductsPage() {
  const user = await requireUser("/vendor/products");
  const supabase = await createClient();

  const { data: products, error } = await supabase
    .from("products")
    .select(PRODUCT_COLUMNS)
    .order("created_at", { ascending: false });

  if (error) {
    return (
      <AdminShell role="vendor" title="상품·가격">
        <ErrorState
          code="VENDOR_PRODUCT_LOAD_FAILED"
          title="상품을 불러오지 못했어요"
          description="잠시 후 다시 시도해 주세요."
        />
      </AdminShell>
    );
  }

  const vendor = await findMemberVendor(user.id);

  if (!vendor) {
    return (
      <AdminShell role="vendor" title="상품·가격">
        <Card>
          <CardContent className="pt-6">
            <EmptyState
              assetId="vendor.dashboard.empty"
              title="아직 등록된 업체가 없어요"
              description="입점 신청을 마치면 상품을 등록할 수 있습니다."
              action={
                <Button size="touch" asChild>
                  <Link href="/vendor/apply">입점 신청하러 가기</Link>
                </Button>
              }
            />
          </CardContent>
        </Card>
      </AdminShell>
    );
  }

  const rate = await resolveVendorCommission(supabase, {
    vendorId: vendor.id,
    category: vendor.category,
  });

  // 목록에서도 추가금 상태를 사실대로 보여준다 — '미등록'과 '없음'은 다른 정보다(F-V-04).
  // 상품마다 조회하지 않고 한 번에 읽어 상품별로 나눈다.
  const { data: allOptions } = await supabase
    .from("product_options")
    .select("product_id, price")
    .in("product_id", (products ?? []).map((row) => row.id));

  const optionsByProduct = new Map<string, { price: number }[]>();
  for (const option of allOptions ?? []) {
    const list = optionsByProduct.get(option.product_id) ?? [];
    list.push({ price: option.price });
    optionsByProduct.set(option.product_id, list);
  }

  const published = (products ?? []).filter((row) => row.status === "published").length;

  return (
    <AdminShell
      role="vendor"
      title="상품·가격"
      description={`전체 ${products?.length ?? 0}개 · 고객 노출 중 ${published}개`}
      action={
        <Button asChild>
          <Link href="/vendor/products/new">상품 등록</Link>
        </Button>
      }
    >
      <div className="space-y-4">
        <p className="rounded-lg border border-brand-200 bg-brand-50 p-3 text-sm text-brand-700">
          {VENDOR_PRICING_NOTICE}
          {rate.available ? null : " 현재 적용 요율이 등록되지 않아 예상 정산액은 표시되지 않습니다."}
        </p>

        {!products || products.length === 0 ? (
          <Card>
            <CardContent className="pt-6">
              <EmptyState
                assetId="vendor.dashboard.empty"
                title="등록된 상품이 없습니다"
                description="총액과 포함 항목을 함께 등록하면 고객 탐색 화면에 노출됩니다."
                action={
                  <Button size="touch" asChild>
                    <Link href="/vendor/products/new">첫 상품 등록하기</Link>
                  </Button>
                }
              />
            </CardContent>
          </Card>
        ) : (
          <ul className="grid gap-4 lg:grid-cols-2" data-testid="product-list">
            {products.map((product) => {
              const blockers = publishBlockersOf(product);

              return (
                <li key={product.id}>
                  <Card>
                    <CardHeader className="flex-row items-start justify-between space-y-0">
                      <div>
                        <CardTitle className="text-base">
                          <Link href={`/vendor/products/${product.id}`} className="hover:underline">
                            {product.name}
                          </Link>
                        </CardTitle>
                        <CardDescription>
                          {VENDOR_CATEGORY_LABEL[product.category as VendorCategory] ??
                            product.category}
                          {product.capacity_max
                            ? ` · 최대 ${product.capacity_max}명`
                            : ""}
                        </CardDescription>
                      </div>
                      <Badge variant={STATUS_VARIANT[product.status as ProductStatus]}>
                        {PRODUCT_STATUS_LABEL[product.status as ProductStatus] ?? product.status}
                      </Badge>
                    </CardHeader>

                    <CardContent className="space-y-3">
                      <PriceDisplay
                        label="총액"
                        amount={product.base_price_total}
                        basePrice={product.base_price_total}
                        taxIncluded={product.price_includes_vat}
                        addOns={summarizeAddOns(
                          product.add_ons_declared_at,
                          optionsByProduct.get(product.id) ?? [],
                        )}
                        plannerFee={{ kind: "unavailable" }}
                        size="sm"
                      />

                      {blockers.length > 0 ? (
                        <p className="text-caption text-warning">
                          게시 조건 {blockers.length}건 미충족
                        </p>
                      ) : null}
                    </CardContent>
                  </Card>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </AdminShell>
  );
}
