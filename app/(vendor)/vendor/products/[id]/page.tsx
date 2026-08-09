import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { AdminShell } from "@/components/layout/AdminShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ErrorState } from "@/components/ui/ErrorState";
import {
  PRODUCT_STATUS_LABEL,
  type IncludedItem,
  type ProductStatus,
} from "@/lib/core/schemas/product";
import { summarizeAddOns } from "@/lib/core/schemas/product-option";
import { resolveVendorCommission } from "@/lib/pricing/vendor-rate";
import { requireUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";
import { loadOptions } from "@/lib/vendor/product-options";
import { PRODUCT_COLUMNS, findMemberVendor, publishBlockersOf } from "@/lib/vendor/products";

import { ProductForm, type RateInfo } from "../ProductForm";
import { ProductOptions } from "./ProductOptions";
import { PublishPanel } from "./PublishPanel";

export const metadata: Metadata = {
  title: "상품 상세 — 웨딩클리어",
};

/** /vendor/products/[id] (F-V-03) — 상세·수정·게시. */
export default async function ProductDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await requireUser(`/vendor/products/${id}`);
  const supabase = await createClient();

  const { data: product, error } = await supabase
    .from("products")
    .select(PRODUCT_COLUMNS)
    .eq("id", id)
    .maybeSingle();

  if (error) {
    return (
      <AdminShell role="vendor" title="상품 상세">
        <ErrorState
          code="VENDOR_PRODUCT_LOAD_FAILED"
          title="상품을 불러오지 못했어요"
          description="잠시 후 다시 시도해 주세요."
        />
      </AdminShell>
    );
  }

  // RLS 가 남의 업체 상품을 감춘다. 없는 것과 못 보는 것을 화면에서 구분하지 않는다.
  if (!product) notFound();

  const vendor = await findMemberVendor(user.id);

  const { data: membership } = await supabase
    .from("vendor_members")
    .select("vendor_role")
    .eq("vendor_id", product.vendor_id)
    .eq("user_id", user.id)
    .maybeSingle();

  const canEdit = membership?.vendor_role === "owner";

  const resolved = await resolveVendorCommission(supabase, {
    vendorId: product.vendor_id,
    category: product.category,
    salePrice: product.base_price_total,
  });

  const rate: RateInfo = resolved.available
    ? { available: true, feeRateBp: resolved.feeRateBp, scopeType: resolved.scopeType }
    : { available: false, reason: resolved.reason, detail: resolved.detail };

  const includedItems = (
    Array.isArray(product.included_items_json) ? product.included_items_json : []
  ) as IncludedItem[];

  const status = product.status as ProductStatus;

  // 추가금은 상품 총액과 같은 화면에서 확인할 수 있어야 한다(§6 공통 UI 규칙).
  const options = await loadOptions(supabase, product.id);
  const addOns = summarizeAddOns(product.add_ons_declared_at, options);

  return (
    <AdminShell
      role="vendor"
      title={product.name}
      description={`${PRODUCT_STATUS_LABEL[status]} · 등록 ${product.created_at.slice(0, 10)}`}
      action={
        <div className="flex items-center gap-2">
          <Badge variant={status === "published" ? "default" : "secondary"}>
            {PRODUCT_STATUS_LABEL[status]}
          </Badge>
          <Button variant="outline" asChild>
            <Link href="/vendor/products">목록으로</Link>
          </Button>
        </div>
      }
    >
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">게시 상태</CardTitle>
            <CardDescription>
              게시하면 고객 탐색 화면에 총액과 포함 항목이 그대로 노출됩니다.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <PublishPanel
              productId={product.id}
              status={status}
              blockers={publishBlockersOf(product)}
              canEdit={canEdit}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">추가금 사전 등록</CardTitle>
            <CardDescription>
              발생 가능한 추가금을 빠짐없이 적습니다. 등록하지 않은 항목은 계약 이후 청구할 수
              없습니다.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ProductOptions
              productId={product.id}
              options={options}
              declaredAt={product.add_ons_declared_at}
              canEdit={canEdit}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">상품 정보</CardTitle>
            <CardDescription>
              총액을 바꾸면 감사 로그에 기록되며, 확정된 계약의 정산에는 소급되지 않습니다.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ProductForm
              product={{
                id: product.id,
                name: product.name,
                category: product.category,
                basePriceTotal: product.base_price_total,
                includedItems,
                capacityMin: product.capacity_min,
                capacityMax: product.capacity_max,
                priceIncludesVat: product.price_includes_vat,
              }}
              rate={rate}
              addOns={addOns}
              defaultCategory={vendor?.category ?? product.category}
              canEdit={canEdit}
            />
          </CardContent>
        </Card>
      </div>
    </AdminShell>
  );
}
