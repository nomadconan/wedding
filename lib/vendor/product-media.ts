import { readIntSetting } from "@/lib/app-settings";
import { PRODUCT_MEDIA_TYPE } from "@/lib/core/product/media";

/**
 * 상품 사진 Route Handler·화면 공통 조각 (C-2b)
 *
 * `route.ts` 는 HTTP 메서드 외의 export 를 허용하지 않으므로 공유물을 여기에 둔다
 * (`product-options.ts` 와 같은 자리다).
 */

export const MEDIA_BUCKET = "vendor-media";

export const PRODUCT_MEDIA_COLUMNS =
  "id, vendor_id, product_id, type, storage_path, sort_order, alt_text, created_at";

export type ProductMediaRow = {
  id: string;
  vendor_id: string;
  product_id: string | null;
  type: string;
  storage_path: string;
  sort_order: number;
  alt_text: string | null;
  created_at: string;
};

export type ProductPhoto = {
  id: string;
  path: string;
  sortOrder: number;
  altText: string | null;
};

/**
 * Supabase 빌더 타입을 그대로 받으면 체인이 깊어 `TS2589` 가 난다.
 * 세션·서비스롤 양쪽을 받아야 하므로 최소 인터페이스만 요구한다
 * (`product-options.ts` 가 같은 이유로 같은 모양을 쓴다).
 */
type MediaReader = { from: (table: string) => unknown };

type MediaQuery = {
  select: (columns: string) => {
    eq: (
      column: string,
      value: string,
    ) => {
      order: (
        column: string,
        options: { ascending: boolean },
      ) => PromiseLike<{ data: ProductMediaRow[] | null; error: unknown }>;
    };
  };
};

export function toProductPhoto(row: ProductMediaRow): ProductPhoto {
  return {
    id: row.id,
    path: row.storage_path,
    sortOrder: row.sort_order,
    altText: row.alt_text,
  };
}

/** 상품 사진 목록. 업체가 정한 순서 그대로 — 첫 장이 대표 사진이다. */
export async function loadProductPhotos(
  client: MediaReader,
  productId: string,
): Promise<ProductPhoto[]> {
  const query = client.from("vendor_media") as MediaQuery;
  const { data } = await query
    .select(PRODUCT_MEDIA_COLUMNS)
    .eq("product_id", productId)
    .order("sort_order", { ascending: true });

  return (data ?? []).filter((row) => row.type === PRODUCT_MEDIA_TYPE).map(toProductPhoto);
}

/**
 * 상품당 사진 상한.
 *
 * **행이 없으면 null 이고, 그러면 업로드를 거절한다**(`productMediaProblem`).
 * 코드가 상한을 지어내면 운영이 정한 적 없는 값이 기준처럼 굳는다(§7.4).
 */
export async function readProductMediaLimit(): Promise<number | null> {
  return readIntSetting("products.media_max_per_product", "max");
}

/**
 * 공개 버킷의 열람 주소.
 *
 * **서명 URL 이 아니다.** `vendor-media` 는 공개 버킷이고(§3.10) 상품 사진은
 * 비로그인도 보는 것이라 서명이 의미가 없다 — 5분짜리 주소를 발급하면 캐시도
 * 안 되고 SEO 화면에서 매번 새로 만들어야 한다. 비공개 자료(계약서 원문·심사 서류)는
 * 다른 버킷이며 그쪽은 서명 URL 전용이다.
 */
export function publicMediaUrl(supabaseUrl: string, path: string): string {
  return `${supabaseUrl.replace(/\/$/, "")}/storage/v1/object/public/${MEDIA_BUCKET}/${path}`;
}
