import type { SupabaseClient } from "@supabase/supabase-js";

import {
  basisOf,
  budgetLine,
  cartLabel,
  categoryFill,
  nextCartSeq,
  type BudgetLine,
  type CartChoice,
  type CategoryFill,
} from "@/lib/core/cart/multi-cart";
import { loadPlannerRateRecords, resolvePlannerRateBp, selectedPlannerByCategory } from "@/lib/planners/rates";
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
 * 장바구니 조회 · 합계 (S3-05 → IDEA-01 · F-C-25, D-16 · D-17 · D-19)
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
 *
 * ── IDEA-01 로 바뀐 것 ──────────────────────────────────────────────────────
 * 장바구니가 **커플당 최대 N개**가 됐다. 그래서 이 파일의 단위는 '한 장바구니' 가 아니라
 * **'커플의 장바구니 전부'**(`loadCarts`)다. 화면이 탭을 그리려면 어느 탭이든 총액과
 * 예산 대비를 보여야 하므로, 하나만 골라 읽고 나머지를 나중에 읽으면 조회가 N배가 된다.
 * 항목·상품·업체·옵션·요율을 **한 번씩** 읽고 장바구니별로 나눈다.
 */
export type CartItemView = {
  itemId: string;
  /** 어느 장바구니의 항목인가. 이동·복사 대상을 화면이 알아야 한다(IDEA-01). */
  cartId: string;
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
  cartId: string;
  /** 이름 없는 장바구니의 호칭(IDEA-01). 이름이 있어도 화면에 함께 보인다. */
  seq: number;
  name: string | null;
  label: string;
  updatedAt: string;
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
  /** 카테고리 채움. 기준(`cart.core_categories`)이 없으면 null — 판정하지 않는다. */
  fill: CategoryFill | null;
  /** 예산 대비. 예산이 미정이면 `none` 이며 화면은 기준선을 그리지 않는다. */
  budget: BudgetLine;
};

export type CartsView = {
  coupleId: string;
  /** 활성 장바구니. 순번 오름차순이다. */
  carts: CartView[];
  /**
   * 담기 기본 대상 — **가장 최근에 손댄 장바구니**다. 항목을 담고 빼면 부모의
   * `updated_at` 이 올라간다(0027 트리거). 하나도 없으면 null 이고, 그때는 담는 순간
   * 만든다.
   */
  currentCartId: string | null;
  /** 활성 장바구니 상한. **값은 `app_settings.cart.max_active` 가 갖는다.** */
  limit: number;
  /** 설정 행이 있었는가. 없으면 상한 1로 좁힌 상태다(0027 과 같은 규칙). */
  limitConfigured: boolean;
  /** 다음에 만들어질 순번. 자리가 없으면 null 이다. */
  nextSeq: number | null;
  /** `couples.total_budget`. null 이면 예산 미정이다 — 0으로 두지 않는다. */
  budgetTotal: number | null;
  /** 채움 판정 기준. null 이면 설정이 없어 판정하지 않는다. */
  coreCategories: string[] | null;
};

type CartRow = {
  id: string;
  couple_id: string;
  seq: number;
  name: string | null;
  updated_at: string;
};

type ItemRow = {
  id: string;
  cart_id: string;
  product_id: string;
  vendor_id: string;
  options_json: Record<string, unknown>;
  planner_selected: boolean;
  added_by: string;
  price_at_add: number;
  created_at: string;
};

const ITEM_SELECT =
  "id, cart_id, product_id, vendor_id, options_json, planner_selected, added_by, price_at_add, created_at";

// =============================================================================
// 운영 파라미터 (§7.4 — 값은 app_settings 가 갖는다)
// =============================================================================

/**
 * `app_settings` 를 읽는다. `app_settings` 에는 클라이언트 정책이 없으므로 서비스롤이
 * 읽는다(0024 에서 세운 방식과 같다).
 */
async function readSetting(key: string): Promise<Record<string, unknown> | null> {
  const { data } = await createAdminClient()
    .from("app_settings")
    .select("value_json")
    .eq("key", key)
    .maybeSingle();

  return (data?.value_json ?? null) as Record<string, unknown> | null;
}

/**
 * 활성 장바구니 상한.
 *
 * **설정이 없으면 1이다.** '판정 안 함' 이 아니라 가장 보수적인 값으로 내려간다 —
 * DB 트리거(`cart_active_limit`)와 같은 규칙이며, 두 판정이 어긋나면 화면이 만들 수
 * 있다고 말한 것을 DB 가 거절하는 상태가 된다.
 */
export async function loadCartLimit(): Promise<{ limit: number; configured: boolean }> {
  const value = await readSetting("cart.max_active");
  const max = Number(value?.max);

  return Number.isFinite(max) && max >= 1
    ? { limit: Math.trunc(max), configured: true }
    : { limit: 1, configured: false };
}

/**
 * 채움 판정 기준 카테고리.
 *
 * **없으면 null 이다.** 코드가 목록을 지어내면 "완성" 이라는 거짓말을 하게 된다.
 * `products.category` 값을 그대로 쓴다 — 새 카테고리 체계를 만들지 않는다.
 */
export async function loadCoreCategories(): Promise<string[] | null> {
  const value = await readSetting("cart.core_categories");
  const list = value?.categories;

  if (!Array.isArray(list)) return null;

  const categories = list.filter((item): item is string => typeof item === "string" && item !== "");

  return categories.length > 0 ? categories : null;
}

// =============================================================================
// 조회
// =============================================================================

/**
 * 커플의 활성 장바구니 전부.
 *
 * @param session 로그인 사용자 클라이언트. **장바구니는 이걸로 읽는다** — 내 커플 것만
 *                보이는 경계가 RLS 여야 하고, 서비스롤로 읽으면 그 경계가 코드로 넘어온다.
 * @param publicClient 익명 클라이언트. **상품·업체는 이걸로 읽는다** — 누가 보든 같은
 *                공개 카탈로그여야 하고, 내려간 상품이 장바구니에서만 살아 있으면 안 된다.
 */
export async function loadCarts(
  session: SupabaseClient,
  publicClient: SupabaseClient,
  params: { coupleId: string; viewerId: string; memberIds: string[] },
): Promise<CartsView> {
  const [{ limit, configured }, coreCategories] = await Promise.all([
    loadCartLimit(),
    loadCoreCategories(),
  ]);

  // 예산은 **세션으로 읽는다** — 커플 데이터이므로 경계가 RLS 다.
  const { data: couple } = await session
    .from("couples")
    .select("total_budget")
    .eq("id", params.coupleId)
    .maybeSingle();

  const budgetTotal = (couple?.total_budget ?? null) as number | null;

  // 활성만 읽는다. converted·abandoned 는 상한에서도 화면에서도 빠진다(0027).
  const { data: cartRows } = await session
    .from("carts")
    .select("id, couple_id, seq, name, updated_at")
    .eq("couple_id", params.coupleId)
    .eq("status", "active")
    .order("seq", { ascending: true });

  const carts = (cartRows ?? []) as CartRow[];

  const base = {
    coupleId: params.coupleId,
    limit,
    limitConfigured: configured,
    budgetTotal,
    coreCategories,
  };

  if (carts.length === 0) {
    return {
      ...base,
      carts: [],
      currentCartId: null,
      nextSeq: nextCartSeq([], limit),
    };
  }

  const { data: itemRows } = await session
    .from("cart_items")
    .select(ITEM_SELECT)
    .in(
      "cart_id",
      carts.map((cart) => cart.id),
    )
    .order("created_at", { ascending: true });

  const items = (itemRows ?? []) as ItemRow[];
  const { views, rates } = await buildItemViews(publicClient, items, params);

  const cartViews: CartView[] = carts.map((cart) => {
    const own = views.filter((view) => view.cartId === cart.id);
    const fill = categoryFill({
      coreCategories,
      // 볼 수 없는 항목은 카테고리를 모른다. 채움으로 세지 않는다.
      itemCategories: own.filter((view) => view.basePrice !== null).map((view) => view.category),
    });
    const { total, totalWithoutPlanner, excludedCount } = totalsOf(own, rates);

    return {
      cartId: cart.id,
      seq: cart.seq,
      name: cart.name,
      label: cartLabel({ name: cart.name, seq: cart.seq }),
      updatedAt: cart.updated_at,
      coupleId: cart.couple_id,
      items: own,
      total,
      totalWithoutPlanner,
      excludedCount,
      fill,
      budget: budgetLine({
        budget: budgetTotal,
        total: total?.total ?? null,
        basis: basisOf(fill),
      }),
    };
  });

  // 담기 기본 대상은 **가장 최근에 손댄 장바구니**다. 같은 시각이면 순번이 작은 쪽 —
  // 순서를 유일하게 고정해야 새로 고칠 때마다 대상이 바뀌지 않는다.
  const current = [...cartViews].sort((a, b) =>
    a.updatedAt === b.updatedAt ? a.seq - b.seq : a.updatedAt < b.updatedAt ? 1 : -1,
  )[0];

  return {
    ...base,
    carts: cartViews,
    currentCartId: current?.cartId ?? null,
    nextSeq: nextCartSeq(
      cartViews.map((cart) => cart.seq),
      limit,
    ),
  };
}

/**
 * 담기 대상 목록과 "어느 장바구니에 이미 있는가".
 *
 * 담기 버튼·찜 화면은 총액을 필요로 하지 않는다. 그래서 `loadCarts` 를 부르지 않고
 * **가벼운 조회 두 번**으로 끝낸다 — 목록 화면에서 상품마다 요율까지 해석하면 카드
 * 하나가 여러 질의를 끌고 온다.
 *
 * **세션으로 읽는다.** S3-03 은 이 조회를 서비스롤로 했는데, 그러면 "내 커플 것만
 * 보인다" 는 경계가 RLS 가 아니라 `eq("couple_id", ...)` 를 잊지 않는 코드가 된다.
 */
export async function loadCartTargets(
  session: SupabaseClient,
  coupleId: string,
): Promise<{ choices: CartChoice[]; productCarts: Map<string, string[]> }> {
  const { data: cartRows } = await session
    .from("carts")
    .select("id, seq, name")
    .eq("couple_id", coupleId)
    .eq("status", "active")
    .order("seq", { ascending: true });

  const carts = (cartRows ?? []) as { id: string; seq: number; name: string | null }[];

  const choices: CartChoice[] = carts.map((cart) => ({
    cartId: cart.id,
    seq: cart.seq,
    label: cartLabel({ name: cart.name, seq: cart.seq }),
  }));

  if (carts.length === 0) return { choices, productCarts: new Map() };

  const { data: itemRows } = await session
    .from("cart_items")
    .select("cart_id, product_id")
    .in(
      "cart_id",
      carts.map((cart) => cart.id),
    );

  const productCarts = new Map<string, string[]>();

  for (const row of (itemRows ?? []) as { cart_id: string; product_id: string }[]) {
    productCarts.set(row.product_id, [...(productCarts.get(row.product_id) ?? []), row.cart_id]);
  }

  return { choices, productCarts };
}

/** 어느 장바구니에 이미 담겼는지 표시한 선택지. 그 장바구니는 고를 수 없다. */
export function choicesFor(
  targets: { choices: CartChoice[]; productCarts: Map<string, string[]> },
  productId: string,
): CartChoice[] {
  const holding = targets.productCarts.get(productId) ?? [];

  return targets.choices.map((choice) => ({
    ...choice,
    contains: holding.includes(choice.cartId),
  }));
}

/** 순번으로 장바구니를 고른다. 없으면 첫 번째로 떨어진다(URL 이 낡았을 수 있다). */
export function pickCartBySeq(view: CartsView, seq: number | null): CartView | null {
  if (view.carts.length === 0) return null;

  return view.carts.find((cart) => cart.seq === seq) ?? view.carts[0];
}

export function pickCart(view: CartsView, cartId: string | null): CartView | null {
  if (cartId === null) return null;

  return view.carts.find((cart) => cart.cartId === cartId) ?? null;
}

// =============================================================================
// 항목 → 뷰
// =============================================================================

/**
 * 항목 뷰와 **항목별 플래너 요율**을 함께 만든다.
 *
 * 요율을 `CartItemView` 에 담지 않는 이유 — 그 타입은 클라이언트 컴포넌트로 넘어간다.
 * 요율은 §3.9 상 운영자·당사자 전용이므로 **계산된 금액만** 내보내고, 요율 자체는
 * 서버 안에서만 도는 `Map` 으로 옆에 든다.
 */
async function buildItemViews(
  publicClient: SupabaseClient,
  items: ItemRow[],
  params: { viewerId: string; memberIds: string[]; coupleId: string },
): Promise<{ views: CartItemView[]; rates: Map<string, number | null> }> {
  if (items.length === 0) return { views: [], rates: new Map() };

  // **상품은 공개 조건으로 읽는다.** 내려간 상품이 장바구니에서만 살아 있으면
  // 고객이 살 수 없는 것을 살 수 있는 것처럼 합산하게 된다.
  const { data: productRows } = await publicClient
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
    ? await publicClient
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
    ? await publicClient
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

  // **누구를 골랐는지가 판정에 들어간다**(S6-03 · FIX-52). 예전에는 플래너 키 없이
  // 카테고리 → 전역으로만 풀었는데, §3.8 은 좁은 범위가 이긴다고 정했으므로 플래너
  // 전용 요율이 있으면 **화면 금액과 계약 금액이 달라진다.** 카테고리별로 고른
  // 플래너가 `planner_scopes` 에 있으므로 이제 그 값을 쓴다.
  const [plannerRates, selectedPlanners] = await Promise.all([
    loadPlannerRateRecords(),
    selectedPlannerByCategory(params.coupleId),
  ]);
  const at = new Date().toISOString();
  const rates = new Map<string, number | null>();

  const views: CartItemView[] = items.map((item) => {
    const product = products.get(item.product_id);
    const vendor = product ? (vendors.get(product.vendor_id) ?? null) : null;
    const productOptions = product ? options.filter((o) => o.product_id === product.id) : [];
    const addOns = product
      ? summarizeAddOns(product.add_ons_declared_at, productOptions)
      : ({ kind: "unknown" } as const);

    const addedBy = addedByLabelOf(item.added_by, params.viewerId, params.memberIds);
    const rate = product
      ? resolvePlannerRateBp({
          records: plannerRates,
          category: product.category,
          plannerId: selectedPlanners.get(product.category) ?? null,
          at,
        })
      : null;

    rates.set(item.id, rate);

    return {
      itemId: item.id,
      cartId: item.cart_id,
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

  return { views, rates };
}

/** 한 장바구니의 합계 두 벌. 항목별 플래너 금액도 되돌려 담는다. */
function totalsOf(
  views: CartItemView[],
  rates: Map<string, number | null>,
): {
  total: OrderTotal | null;
  totalWithoutPlanner: OrderTotal | null;
  excludedCount: number;
} {
  const priceable = views.filter((view) => view.basePrice !== null);

  const lineOf = (view: CartItemView, plannerSelected: boolean) => ({
    lineId: view.itemId,
    category: view.category ?? undefined,
    salePrice: view.basePrice!,
    addOns: view.addOns,
    plannerSelected,
    plannerFeeRateBp: rates.get(view.itemId) ?? null,
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

  return { total, totalWithoutPlanner, excludedCount: views.length - priceable.length };
}

// 플래너 요율의 적재·해석은 **`lib/planners/rates.ts` 하나가 든다**(S6-03).
// 여기에 두 번째 해석이 있으면 장바구니와 계약이 서로 다른 답을 낸다 — 실제로
// 그랬다(FIX-52).
