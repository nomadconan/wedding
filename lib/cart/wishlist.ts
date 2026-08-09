import {
  ADDED_BY_TEXT,
  addedByLabelOf,
  priceChangeOf,
  type AddedByLabel,
  type ItemVisibility,
  type PriceChange,
} from "@/lib/core/schemas/cart";

/**
 * 찜 조회 (S3-05 · F-C-26)
 *
 * **찜의 `price_at_add` 는 기준점이 아니라 기능이다.** 담은 시점 가격과 현재가를 비교해
 * 변동을 말하는 것이 F-C-26 자체다(장바구니와 반대 — 거기서는 표시·합산에 쓰지 않는다).
 *
 * **내려간 상품·노출되지 않는 업체는 숨기지 않는다.** 커플이 직접 담은 것이라 말없이
 * 사라지면 이유를 알 방법이 없고, 행은 DB 에 남아 있어 다시 찜하면 유니크 제약에 걸린다.
 * 비활성으로 표시하고 삭제만 열어 둔다(`lib/core/schemas/cart.ts` 주석 참조).
 */
export type WishlistItemView = {
  id: string;
  vendorId: string;
  vendorName: string | null;
  category: string | null;
  productId: string | null;
  productName: string | null;
  currentPrice: number | null;
  priceIncludesVat: boolean;
  priceAtAdd: number | null;
  priceChange: PriceChange;
  addedBy: AddedByLabel;
  addedByText: string;
  addedAt: string;
  visibility: ItemVisibility;
  /** 업체 찜인가. 상품이 없으므로 장바구니로 옮길 수 없다. */
  vendorOnly: boolean;
};

type Reader = { from: (table: string) => unknown };

type WishRow = {
  id: string;
  vendor_id: string;
  product_id: string | null;
  price_at_add: number | null;
  added_by: string;
  created_at: string;
};

export async function loadWishlist(
  session: Reader,
  publicClient: Reader,
  params: { viewerId: string; memberIds: string[] },
): Promise<{ items: WishlistItemView[]; unavailableCount: number }> {
  const mine = session as {
    from: (table: string) => {
      select: (columns: string) => {
        order: (column: string, options: { ascending: boolean }) => PromiseLike<{ data: unknown[] | null }>;
      };
    };
  };

  // RLS 가 내 커플 것만 보여준다 — 그것이 경계다.
  const { data } = await mine
    .from("wishlists")
    .select("id, vendor_id, product_id, price_at_add, added_by, created_at")
    .order("created_at", { ascending: false });

  const rows = (data ?? []) as WishRow[];
  if (rows.length === 0) return { items: [], unavailableCount: 0 };

  const client = publicClient as {
    from: (table: string) => {
      select: (columns: string) => {
        in: (column: string, values: string[]) => PromiseLike<{ data: unknown[] | null }>;
      };
    };
  };

  const { data: vendorRows } = await client
    .from("vendors")
    .select("id, name, category")
    .in("id", [...new Set(rows.map((row) => row.vendor_id))]);

  const vendors = new Map(
    ((vendorRows ?? []) as { id: string; name: string; category: string }[]).map((row) => [
      row.id,
      row,
    ]),
  );

  const productIds = rows.map((row) => row.product_id).filter((id): id is string => id !== null);

  const { data: productRows } = productIds.length
    ? await client
        .from("products")
        .select("id, name, base_price_total, price_includes_vat")
        .in("id", [...new Set(productIds)])
    : { data: [] };

  const products = new Map(
    ((productRows ?? []) as {
      id: string;
      name: string;
      base_price_total: number;
      price_includes_vat: boolean;
    }[]).map((row) => [row.id, row]),
  );

  const items: WishlistItemView[] = rows.map((row) => {
    const vendor = vendors.get(row.vendor_id) ?? null;
    const product = row.product_id ? (products.get(row.product_id) ?? null) : null;
    const addedBy = addedByLabelOf(row.added_by, params.viewerId, params.memberIds);

    // 업체 찜은 업체만 보이면 살아 있는 것이다. 상품 찜은 상품까지 보여야 한다.
    const visible = row.product_id === null ? vendor !== null : vendor !== null && product !== null;

    return {
      id: row.id,
      vendorId: row.vendor_id,
      vendorName: vendor?.name ?? null,
      category: vendor?.category ?? null,
      productId: row.product_id,
      productName: product?.name ?? null,
      currentPrice: product?.base_price_total ?? null,
      priceIncludesVat: product?.price_includes_vat ?? true,
      priceAtAdd: row.price_at_add,
      priceChange: priceChangeOf(row.price_at_add, product?.base_price_total ?? null),
      addedBy,
      addedByText: ADDED_BY_TEXT[addedBy],
      addedAt: row.created_at,
      visibility: visible ? { kind: "visible" } : { kind: "unavailable" },
      vendorOnly: row.product_id === null,
    };
  });

  return {
    items,
    unavailableCount: items.filter((item) => item.visibility.kind === "unavailable").length,
  };
}
