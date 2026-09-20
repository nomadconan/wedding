import { leadTimeOf, type LeadTime } from "@/lib/core/product/lead-time";
import { NO_INDEX_BASELINE_NOTE, priceGapBp } from "@/lib/core/pricing/price-index";
import { effectiveStyleTags, type EffectiveStyleTags } from "@/lib/core/product/concept";
import { descriptionSource } from "@/lib/core/product/content";
import { priceBaselineView, type PhotoView, type PriceBaselineView } from "@/lib/core/product/detail";
import { productRatingCaption, type VendorRating } from "@/lib/core/review/rating";
import { summarizeAddOns, type AddOnSummary } from "@/lib/core/schemas/product-option";
import { createPublicClient } from "@/lib/explore/query";
import { indexKey, loadPriceIndexMap } from "@/lib/pricing/price-index-query";
import { loadProductRating, loadProductReviews, type PublicReview } from "@/lib/reviews/read";
import { MEDIA_BUCKET, publicMediaUrl } from "@/lib/vendor/product-media";

/**
 * 상품 상세 조회 (C-2c · 명세서 §2.1 F-C-38 · §4.2 `GET /api/products/[id]` · §6.2)
 *
 * ── 화면과 API 가 **같은 함수**를 쓴다 ──────────────────────────────────────
 * 완료 조건이 *"가격이 업체 상세와 같은 함수로 계산된다"* 다. 화면이 자기 쿼리를
 * 따로 쓰면 API 로 확인한 값과 화면이 달라지고, 그때 어느 쪽이 맞는지 답할 수 없다
 * (`lib/explore/query.ts` 가 탐색에서 같은 이유로 같은 모양을 쓴다).
 *
 * ── **익명 클라이언트로 읽는다** ────────────────────────────────────────────
 * 이 화면은 비로그인이 본다. 서비스롤로 읽으면 *게시되지 않은 상품을 걸러 내는
 * 책임이 전부 애플리케이션 코드로 넘어온다* — 한 줄만 빠뜨려도 초안이 공개된다.
 * 익명으로 읽으면 **RLS 가 그대로 경계**다:
 *   · `products_select_public`  게시 + 업체 active
 *   · `product_options_select_public`  위 정책에 기대어 초안의 추가금이 안 보인다
 *   · `vendor_media_select_public`  게시 상품의 사진만(C-2b 가 조건을 직접 넣었다)
 *   · `price_rules` 는 **공개 정책 자체가 없다** — floor/cap 이 나가지 않는다
 *
 * ── 가격은 **저장하지 않고 계산한다** ───────────────────────────────────────
 * 참가격 편차(bp)는 `priceGapBp` 가 정수로 만든다. 기준이 없으면 **0이 아니라 null**
 * 이고 화면이 "비교 기준이 없다" 고 적는다.
 */

/** 화면·API 가 함께 읽는 컬럼. 한 곳에서 관리해야 응답 모양이 갈라지지 않는다. */
const PRODUCT_COLUMNS =
  "id, vendor_id, category, name, base_price_total, price_includes_vat, included_items_json, " +
  "capacity_min, capacity_max, add_ons_declared_at, summary, description_json, style_tags, " +
  "lead_time_days, lead_time_note, published_at";

export type ProductDetail = {
  id: string;
  vendorId: string;
  vendorName: string;
  vendorCategory: string;
  vendorRegionCode: string | null;
  name: string;
  summary: string | null;
  /** 본문 **원문**. 블록은 화면이 `descriptionBlocks` 로 계산한다(D-97). */
  descriptionSource: string | null;
  category: string;
  basePrice: number;
  priceIncludesVat: boolean;
  includedItems: { label?: string; name?: string; note?: string | null }[];
  capacityMin: number | null;
  /**
   * 주문 기한(C-4b). **값과 근거가 한 덩어리**이며 한쪽만 있으면 `null` 이다.
   * 날짜로 바꾸는 일은 여기서 하지 않는다 — 예식일은 **보는 커플마다 다르고**,
   * 이 로더는 비로그인도 쓴다(`orderDeadline` 이 세션 있는 조각에서 계산한다).
   */
  leadTime: LeadTime | null;
  capacityMax: number | null;
  /** 추가금 사전표. **업체 상세와 같은 함수**(`summarizeAddOns`)가 만든다. */
  addOns: AddOnSummary;
  options: { id: string; name: string; price: number; isMandatory: boolean; condition: string | null }[];
  photos: PhotoView[];
  /** 컨셉(C-2d). **상품이 비면 업체 태그를 상속하고 출처를 함께 준다.** */
  styleTags: EffectiveStyleTags;
  baseline: PriceBaselineView;
  /** 상품 단위 검증 후기(C-2e). **평균은 건수·문구와 한 덩어리로 나간다.** */
  reviews: { rating: VendorRating; caption: string; items: PublicReview[] };
  publishedAt: string | null;
};

type ProductRow = {
  id: string;
  vendor_id: string;
  category: string;
  name: string;
  base_price_total: number;
  price_includes_vat: boolean;
  included_items_json: unknown;
  capacity_min: number | null;
  capacity_max: number | null;
  add_ons_declared_at: string | null;
  summary: string | null;
  description_json: unknown;
  style_tags: string[] | null;
  lead_time_days: number | null;
  lead_time_note: string | null;
  published_at: string | null;
};

/**
 * 상품 한 개.
 *
 * **경로의 업체와 상품의 업체가 다르면 null 이다.** RLS 는 "그 상품이 공개인가" 만
 * 보고 이 짝은 보지 않는다 — 확인하지 않으면 `/explore/<A>/<B의 상품>` 이 열린다.
 * 없는 것과 못 보는 것을 구분해 알려 주지 않는다(둘 다 404).
 */
export async function loadProductDetail(input: {
  vendorId: string;
  productId: string;
}): Promise<ProductDetail | null> {
  const client = createPublicClient();

  const { data: productRow } = await client
    .from("products")
    .select(PRODUCT_COLUMNS)
    .eq("id", input.productId)
    .maybeSingle();

  const product = productRow as ProductRow | null;
  if (!product) return null;
  if (product.vendor_id !== input.vendorId) return null;

  // 업체는 익명 정책이 active 만 준다 — 심사 중 업체의 상품은 여기서 걸린다.
  // (상품 정책도 같은 조건을 보지만 **이름·지역을 이 화면이 쓰므로** 어차피 읽는다.)
  const { data: vendorRow } = await client
    .from("vendors")
    .select("id, name, category, region_code, style_tags")
    .eq("id", input.vendorId)
    .maybeSingle();

  const vendor = vendorRow as {
    id: string;
    name: string;
    category: string;
    region_code: string | null;
    style_tags: string[] | null;
  } | null;
  if (!vendor) return null;

  const { data: optionRows } = await client
    .from("product_options")
    .select("id, product_id, name, price, is_mandatory, trigger_condition")
    .eq("product_id", product.id)
    .order("price", { ascending: false });

  const options = (optionRows ?? []) as {
    id: string;
    name: string;
    price: number;
    is_mandatory: boolean;
    trigger_condition: { description?: string | null } | null;
  }[];

  const { data: mediaRows } = await client
    .from("vendor_media")
    .select("id, storage_path, alt_text, type, sort_order")
    .eq("product_id", product.id)
    .order("sort_order", { ascending: true });

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const photos: PhotoView[] = ((mediaRows ?? []) as {
    id: string;
    storage_path: string;
    alt_text: string | null;
    type: string;
  }[])
    .filter((row) => row.type === "photo")
    .map((row) => ({
      id: row.id,
      url: publicMediaUrl(supabaseUrl, row.storage_path),
      altText: row.alt_text,
    }));

  // 참가격 — **탐색 목록과 같은 키·같은 함수**를 쓴다.
  // 후기도 같은 로더가 싣는다 — 화면과 API 가 다른 것을 보지 않게(C-2c 의 규칙).
  const [rating, reviewItems] = await Promise.all([
    loadProductRating(product.id),
    loadProductReviews(product.id),
  ]);

  const indexMap = await loadPriceIndexMap(client, [
    { regionCode: vendor.region_code ?? "", category: vendor.category },
  ]);
  const index = indexMap.get(indexKey(vendor.region_code ?? "", vendor.category)) ?? null;

  return {
    id: product.id,
    vendorId: vendor.id,
    vendorName: vendor.name,
    vendorCategory: vendor.category,
    vendorRegionCode: vendor.region_code,
    name: product.name,
    summary: product.summary,
    descriptionSource: descriptionSource(product.description_json),
    category: product.category,
    basePrice: product.base_price_total,
    priceIncludesVat: product.price_includes_vat,
    includedItems: Array.isArray(product.included_items_json)
      ? (product.included_items_json as ProductDetail["includedItems"])
      : [],
    capacityMin: product.capacity_min,
    capacityMax: product.capacity_max,
    leadTime: leadTimeOf({ days: product.lead_time_days, note: product.lead_time_note }),
    // **업체 상세와 같은 호출**이다(`VendorProducts` 와 인자가 같다) — 두 화면이
    // 추가금을 다르게 요약하면 같은 상품이 두 값을 말한다.
    addOns: summarizeAddOns(product.add_ons_declared_at, options),
    options: options.map((option) => ({
      id: option.id,
      name: option.name,
      price: option.price,
      isMandatory: option.is_mandatory,
      condition: option.trigger_condition?.description ?? null,
    })),
    photos,
    // **상속 규칙은 순수 함수 하나**가 갖는다 — 탐색 질의도 같은 함수를 쓴다.
    styleTags: effectiveStyleTags({
      productTags: product.style_tags,
      vendorTags: vendor.style_tags,
    }),
    reviews: { rating, caption: productRatingCaption(rating), items: reviewItems },
    baseline: priceBaselineView({
      gapBp: priceGapBp(product.base_price_total, index?.p50 ?? null),
      p50: index?.p50 ?? null,
      sampleSize: index?.sampleSize ?? null,
      sourceNote: index?.sourceNote ?? null,
      noBaselineNote: NO_INDEX_BASELINE_NOTE,
    }),
    publishedAt: product.published_at,
  };
}

export { MEDIA_BUCKET };
