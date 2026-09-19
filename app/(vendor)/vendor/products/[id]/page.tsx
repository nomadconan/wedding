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
import { descriptionSource, productContentSuggestions } from "@/lib/core/product/content";
import { summarizeAddOns } from "@/lib/core/schemas/product-option";
import { resolveVendorCommission } from "@/lib/pricing/vendor-rate";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";
import {
  MEDIA_BUCKET,
  loadProductPhotos,
  publicMediaUrl,
  readProductMediaLimit,
} from "@/lib/vendor/product-media";
import { loadOptions } from "@/lib/vendor/product-options";
import { PRODUCT_COLUMNS, findMemberVendor, publishBlockersOf } from "@/lib/vendor/products";

import { ProductForm, type RateInfo } from "../ProductForm";
import { ProductOptions } from "./ProductOptions";
import { ProductPhotos, type ProductPhotoView } from "./ProductPhotos";
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

  // ── 사진 (C-2b) ────────────────────────────────────────────────────────
  // **행이 있다고 파일이 있는 것은 아니다.** 업로드는 브라우저가 Storage 로 직행하므로
  // 중간에 끊기면 행만 남는다. 목록에서 그 자리를 "올리다 만 자리" 로 적으려면
  // 실제 객체가 있는지 봐야 한다 — 없는 것을 있는 척하지 않는다.
  const photoRows = await loadProductPhotos(supabase, product.id);
  const mediaLimit = await readProductMediaLimit();

  const storageAdmin = createAdminClient();
  const objectPaths = new Set<string>();

  if (photoRows.length > 0) {
    const { data: objects } = await storageAdmin.storage
      .from(MEDIA_BUCKET)
      .list(`${product.vendor_id}/products/${product.id}`, { limit: 100 });

    for (const object of objects ?? []) {
      objectPaths.add(`${product.vendor_id}/products/${product.id}/${object.name}`);
    }
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const photos: ProductPhotoView[] = photoRows.map((photo) => ({
    id: photo.id,
    path: photo.path,
    url: publicMediaUrl(supabaseUrl, photo.path),
    altText: photo.altText,
    sortOrder: photo.sortOrder,
    uploaded: objectPaths.has(photo.path),
  }));

  // 완성도 권유. **게시 차단 목록과 다른 자리에 다른 모양으로** 그린다(C-2b).
  const suggestions = productContentSuggestions({
    summary: product.summary,
    description: product.description_json,
    photoCount: photos.filter((photo) => photo.uploaded).length,
    photosMissingAltText: photos.filter((photo) => photo.uploaded && !photo.altText).length,
  });

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

        {/* ── 완성도 (C-2b) ──────────────────────────────────────────────
            **게시 조건이 아니다.** 게시 상태 카드와 떨어뜨려 두고 문구도 다르게
            적는다 — 같은 모양이면 업체는 이것도 못 게시하는 이유로 읽는다. */}
        {suggestions.length > 0 ? (
          <Card data-testid="content-suggestions">
            <CardHeader>
              <CardTitle className="text-base">더 채우면 좋은 것</CardTitle>
              <CardDescription>
                게시를 막지 않습니다. 지금 이대로도 고객에게 보이며, 채우면 더 잘 보입니다.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="space-y-1.5">
                {suggestions.map((suggestion) => (
                  <li key={suggestion.code} className="text-sm text-muted-foreground">
                    {suggestion.message}
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        ) : null}

        <Card>
          <CardHeader>
            <CardTitle className="text-base">상품 사진</CardTitle>
            <CardDescription>
              첫 번째 사진이 목록의 대표 사진입니다. 게시한 상품의 사진만 고객에게 보입니다.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ProductPhotos
              productId={product.id}
              photos={photos}
              limit={mediaLimit}
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
                summary: product.summary,
                descriptionSource: descriptionSource(product.description_json),
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
