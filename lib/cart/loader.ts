import { PLANNER_FEE_SCOPE_ORDER, resolveRate, type RateRecord } from "@/lib/core/pricing/rates";
import {
  ADDED_BY_TEXT,
  addedByLabelOf,
  priceChangeOf,
  type AddedByLabel,
  type ItemVisibility,
  type PriceChange,
} from "@/lib/core/schemas/cart";
import { calculateOrderTotal, type OrderTotal } from "@/lib/core/pricing/order";
import type { OrderAddOns } from "@/lib/core/schemas/order";
import { summarizeAddOns } from "@/lib/core/schemas/product-option";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * 장바구니 조회 · 합계 (S3-05 · F-C-25, D-16 · D-17 · D-19)
 *
 * **금액은 현재가로 계산한다.** `cart_items.price_at_add` 는 "담을 때보다 얼마 올랐다"를
 * 말하기 위한 기준점이며 합계에 들어가지 않는다(S3-04 에서 정한 규칙). 그래서 아래
 * `calculateOrderTotal` 입력에는 `price_at_add` 를 넣을 자리 자체가 없다.
 *
 * **요율은 저장하지 않고 매번 해석한다**(D-16 · D-17). 계약이 확정되는 순간에만
 * `bookings` 로 스냅샷된다.
 *
 * **플래너 요율은 서비스롤로 읽는다.** `planner_fee_rates` 는 §3.9 상 운영자·당사자
 * 전용이라 소비자 세션으로는 보이지 않는다. 요율 자체를 내보내지 않고 **계산된
 * 금액만** 화면에 준다 — S3-03 에서 프라이싱 룰을 다룬 방식과 같다.
 */
export type CartItemView = {
  itemId: string;
  productId: string;
  vendorId: string | null;
  vendorName: string | null;
  category: string | null;
  productName: string | null;
  /** 현재 판매가. 상품이 내려갔으면 null 이다. */
  basePrice: number | null;
  priceIncludesVat: boolean;
  addOns: OrderAddOns;
  addOnList: { id: string; name: string; price: number; isMandatory: boolean; note: string | null }[];
  /** 업체가 밝힌 포함 항목 수. 비교표(S3-07)의 축이다. */
  includedItemCount: number;
  /** 비교표(S3-07)의 조건 축. 없으면 업체가 적지 않은 것이다 — '해당 없음'과 구분한다. */
  capacityMin: number | null;
  capacityMax: number | null;
  regionCode: string | null;
  options: Record<string, unknown>;
  plannerSelected: boolean;
  /** 이 항목에 붙는 플래너 수수료. 요율이 없으면 null 이며 화면은 '미정'으로 적는다. */
  plannerFeeAmount: number | null;
  plannerRateMissing: boolean;
  addedBy: AddedByLabel;
  addedByText: string;
  addedAt: string;
  priceAtAdd: number;
  priceChange: PriceChange;
  visibility: ItemVisibility;
};

export type CartView = {
  cartId: string | null;
  coupleId: string;
  items: CartItemView[];
  /** 지금 볼 수 있는 항목만으로 계산한 합계. */
  total: OrderTotal | null;
  /**
   * **플래너를 전부 뺀 기준**의 같은 합계.
   *
   * 비교표(S3-07)가 "같은 조건으로 보기" 를 제공하려면 두 기준이 모두 필요하다.
   * 요율은 서버만 알기 때문에 클라이언트가 다시 계산할 수 없어, 두 벌을 함께 내려준다.
   * **장바구니의 실제 선택은 건드리지 않는다** — 표시 기준일 뿐이다.
   */
  totalWithoutPlanner: OrderTotal | null;
  /** 내려간 상품 때문에 합계에서 빠진 항목 수. 숨기지 않고 알린다. */
  excludedCount: number;
};

type CartRow = {
  id: string;
  product_id: string;
  vendor_id: string;
  options_json: Record<string, unknown>;
  planner_selected: boolean;
  added_by: string;
  price_at_add: number;
  created_at: string;
};

/** 최소 인터페이스만 요구한다 — 세션·익명 클라이언트 양쪽을 받기 위해서다. */
type Reader = { from: (table: string) => unknown };

/**
 * 커플의 활성 장바구니. 없으면 만들지 않고 null 이다(빈 화면은 행 없이도 그린다).
 *
 * @param session 로그인 사용자 클라이언트. **장바구니는 이걸로 읽는다** — 내 커플 것만
 *                보이는 경계가 RLS 여야 하고, 서비스롤로 읽으면 그 경계가 코드로 넘어온다.
 * @param publicClient 익명 클라이언트. **상품·업체는 이걸로 읽는다** — 누가 보든 같은
 *                공개 카탈로그여야 하고, 내려간 상품이 장바구니에서만 살아 있으면 안 된다.
 */
export async function loadCart(
  session: Reader,
  publicClient: Reader,
  params: { coupleId: string; viewerId: string; memberIds: string[] },
): Promise<CartView> {
  const admin = createAdminClient();
  const mine = session as {
    from: (table: string) => {
      select: (columns: string) => {
        eq: (column: string, value: string) => {
          eq: (column: string, value: string) => { maybeSingle: () => PromiseLike<{ data: { id: string } | null }> };
          order: (column: string, options: { ascending: boolean }) => PromiseLike<{ data: unknown[] | null }>;
        };
      };
    };
  };

  const { data: cart } = await mine
    .from("carts")
    .select("id")
    .eq("couple_id", params.coupleId)
    .eq("status", "active")
    .maybeSingle();

  const empty = {
    cartId: null as string | null,
    coupleId: params.coupleId,
    items: [] as CartItemView[],
    total: null,
    totalWithoutPlanner: null,
    excludedCount: 0,
  };

  if (!cart) return empty;

  const { data: itemRows } = await mine
    .from("cart_items")
    .select("id, product_id, vendor_id, options_json, planner_selected, added_by, price_at_add, created_at")
    .eq("cart_id", cart.id)
    .order("created_at", { ascending: true });

  const items = (itemRows ?? []) as CartRow[];

  if (items.length === 0) return { ...empty, cartId: cart.id };

  // **상품은 공개 조건으로 읽는다.** 내려간 상품이 장바구니에서만 살아 있으면
  // 고객이 살 수 없는 것을 살 수 있는 것처럼 합산하게 된다.
  const client = publicClient as {
    from: (table: string) => {
      select: (columns: string) => {
        in: (column: string, values: string[]) => PromiseLike<{ data: unknown[] | null }>;
      };
    };
  };

  const { data: productRows } = await client
    .from("products")
    .select(
      "id, vendor_id, name, category, base_price_total, price_includes_vat, add_ons_declared_at, capacity_min, capacity_max, included_items_json",
    )
    .in("id", [...new Set(items.map((item) => item.product_id))]);

  const products = new Map(
    ((productRows ?? []) as {
      id: string;
      vendor_id: string;
      name: string;
      category: string;
      base_price_total: number;
      price_includes_vat: boolean;
      add_ons_declared_at: string | null;
      capacity_min: number | null;
      capacity_max: number | null;
      included_items_json: unknown;
    }[]).map((row) => [row.id, row]),
  );

  const visibleIds = [...products.keys()];

  const { data: vendorRows } = visibleIds.length
    ? await client
        .from("vendors")
        .select("id, name, region_code")
        .in("id", [...new Set([...products.values()].map((product) => product.vendor_id))])
    : { data: [] };

  const vendors = new Map(
    ((vendorRows ?? []) as { id: string; name: string; region_code: string | null }[]).map(
      (row) => [row.id, row],
    ),
  );

  const { data: optionRows } = visibleIds.length
    ? await client
        .from("product_options")
        .select("id, product_id, name, price, is_mandatory, trigger_condition")
        .in("product_id", visibleIds)
    : { data: [] };

  const options = (optionRows ?? []) as {
    id: string;
    product_id: string;
    name: string;
    price: number;
    is_mandatory: boolean;
    trigger_condition: Record<string, unknown> | null;
  }[];

  const plannerRates = await loadPlannerRates(admin);
  const at = new Date().toISOString();

  const views: CartItemView[] = items.map((item) => {
    const product = products.get(item.product_id);
    const vendor = product ? (vendors.get(product.vendor_id) ?? null) : null;
    const productOptions = product ? options.filter((o) => o.product_id === product.id) : [];
    const addOns = product
      ? summarizeAddOns(product.add_ons_declared_at, productOptions)
      : ({ kind: "unknown" } as const);

    const addedBy = addedByLabelOf(item.added_by, params.viewerId, params.memberIds);
    const rate = product ? resolvePlannerRate(plannerRates, product.category, at) : null;

    return {
      itemId: item.id,
      productId: item.product_id,
      vendorId: product?.vendor_id ?? null,
      vendorName: vendor?.name ?? null,
      category: product?.category ?? null,
      productName: product?.name ?? null,
      basePrice: product?.base_price_total ?? null,
      priceIncludesVat: product?.price_includes_vat ?? true,
      addOns,
      addOnList: productOptions.map((option) => ({
        id: option.id,
        name: option.name,
        price: option.price,
        isMandatory: option.is_mandatory,
        note: (option.trigger_condition?.description as string | undefined) ?? null,
      })),
      includedItemCount: Array.isArray(product?.included_items_json)
        ? (product.included_items_json as unknown[]).length
        : 0,
      capacityMin: product?.capacity_min ?? null,
      capacityMax: product?.capacity_max ?? null,
      regionCode: vendor?.region_code ?? null,
      options: item.options_json ?? {},
      plannerSelected: item.planner_selected,
      plannerFeeAmount: null,
      plannerRateMissing: product !== undefined && rate === null,
      addedBy,
      addedByText: ADDED_BY_TEXT[addedBy],
      addedAt: item.created_at,
      priceAtAdd: item.price_at_add,
      priceChange: priceChangeOf(item.price_at_add, product?.base_price_total ?? null),
      visibility: product ? { kind: "visible" } : { kind: "unavailable" },
    };
  });

  const priceable = views.filter((view) => view.basePrice !== null);

  const lineOf = (view: CartItemView, plannerSelected: boolean) => ({
    lineId: view.itemId,
    category: view.category ?? undefined,
    salePrice: view.basePrice!,
    addOns: view.addOns,
    plannerSelected,
    plannerFeeRateBp: resolvePlannerRate(plannerRates, view.category ?? "", at),
    // 업체 정산 요율이다. **고객 화면에는 쓰지 않는다.**
    // 여기서 넘기는 0은 정산 계산을 성립시키기 위한 자리채움이며, 그래서
    // 이 함수는 결과의 settlement 를 밖으로 내보내지 않는다(위 CartItemView 참조).
    feeRateBp: 0,
  });

  const total =
    priceable.length === 0
      ? null
      : calculateOrderTotal(priceable.map((view) => lineOf(view, view.plannerSelected)));

  // 비교표가 쓰는 '플래너 빼고 같은 조건' 기준. 요율은 서버만 알기 때문에 여기서 함께 낸다.
  const totalWithoutPlanner =
    priceable.length === 0
      ? null
      : calculateOrderTotal(priceable.map((view) => lineOf(view, false)));

  // 항목별 플래너 금액을 되돌려 담는다. 화면이 다시 계산하지 않게 하기 위해서다.
  if (total) {
    for (const line of total.lines) {
      const view = views.find((item) => item.itemId === line.lineId);
      if (!view) continue;

      view.plannerFeeAmount =
        line.plannerFee.kind === "selected" && typeof line.plannerFee.amount === "number"
          ? line.plannerFee.amount
          : null;
    }
  }

  return {
    cartId: cart.id,
    coupleId: params.coupleId,
    items: views,
    total,
    totalWithoutPlanner,
    excludedCount: views.length - priceable.length,
  };
}

type PlannerRateReader = {
  from: (table: string) => {
    select: (columns: string) => PromiseLike<{ data: unknown[] | null }>;
  };
};

/** 플래너 요율 후보. 소비자 세션으로는 볼 수 없으므로 서비스롤이 읽는다(§3.9). */
async function loadPlannerRates(admin: unknown): Promise<RateRecord[]> {
  const client = admin as PlannerRateReader;

  const { data } = await client
    .from("planner_fee_rates")
    .select("id, scope_type, scope_key, fee_rate_bp, effective_from, effective_to");

  return ((data ?? []) as {
    id: string;
    scope_type: string;
    scope_key: string | null;
    fee_rate_bp: number;
    effective_from: string;
    effective_to: string | null;
  }[]).map((row) => ({
    id: row.id,
    scopeType: row.scope_type as RateRecord["scopeType"],
    scopeKey: row.scope_key,
    feeRateBp: row.fee_rate_bp,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
  }));
}

/**
 * 카테고리에 적용되는 플래너 요율.
 *
 * 플래너를 아직 고르지 않았으므로 `planner` 스코프 키가 없다 — 해석은 카테고리 → 전역
 * 순으로 내려간다. **없으면 null 이다.** 임의 기본값을 만들면 고객이 본 금액과 계약
 * 금액이 달라진다(S2-03 에서 세운 원칙).
 */
function resolvePlannerRate(records: RateRecord[], category: string, at: string): number | null {
  if (records.length === 0) return null;

  const resolved = resolveRate(records, {
    scopeCandidates: PLANNER_FEE_SCOPE_ORDER,
    ...(category === "" ? {} : { scopeKeys: { category } }),
    at,
  });

  return resolved.ok ? resolved.feeRateBp : null;
}
