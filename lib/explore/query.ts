import { createClient as createSupabaseClient, type SupabaseClient } from "@supabase/supabase-js";
import type { ZodIssue } from "zod";

import { compareByGap, priceGapBp } from "@/lib/core/pricing/price-index";
import { indexKey, loadPriceIndexMap } from "@/lib/pricing/price-index-query";
import {
  EXPLORE_FILTER_LABEL,
  EXPLORE_PAGE_SIZE,
  ExploreFilterSchema,
  activeFilterKeys,
  availabilityOf,
  rankRelaxationHints,
  withoutFilter,
  type AvailabilityState,
  type ExploreFilter,
  type RelaxationHint,
} from "@/lib/core/schemas/explore";

/**
 * 탐색 조회 (S3-03 · §4.2 GET /api/vendors)
 *
 * 화면(서버 컴포넌트)과 API 가 **같은 함수**를 쓴다. 목록 화면이 자기 쿼리를 따로
 * 쓰면 필터 해석이 둘로 갈리고, 그러면 API 로 확인한 결과와 화면이 달라진다.
 *
 * **읽기 전용이며 익명 클라이언트로 조회한다.** 탐색은 비로그인도 가능해야 하고(§1.4),
 * RLS 의 공개 정책(`vendors_select_public`·`products_select_public`)이 그대로 경계가
 * 된다. 서비스롤을 쓰지 않는 이유가 여기 있다 — 서비스롤로 읽으면 게시되지 않은
 * 상품을 걸러 내는 책임이 전부 애플리케이션 코드로 넘어온다.
 */
export type ExploreRow = {
  vendorId: string;
  vendorName: string;
  category: string;
  regionCode: string | null;
  styleTags: string[];
  productId: string;
  productName: string;
  basePrice: number;
  priceIncludesVat: boolean;
  includedItemCount: number;
  capacityMin: number | null;
  capacityMax: number | null;
  addOns: { declaredAt: string | null; count: number; total: number };
  /**
   * 참가격 중앙값 대비 편차(bp). 음수면 지수보다 싸다.
   * **지수가 없으면 null 이다** — 0을 주면 "딱 중간값" 이라는 없는 사실을 말하게 된다.
   */
  gapBp: number | null;
  /** 비교 기준이 된 중앙값. 화면이 "무엇과 견줬는지" 를 밝히기 위해 함께 준다. */
  indexP50: number | null;
  availability: AvailabilityState;
  createdAt: string;
};

export type ExploreResult = {
  rows: ExploreRow[];
  total: number;
  page: number;
  pageSize: number;
  /** 적용된 정렬 기준 코드. **응답에 반드시 실린다**(D-03 · §4.2). */
  sort: ExploreFilter["sort"];
  appliedFilters: string[];
  /** 0건일 때만 채운다. 어느 조건을 풀면 결과가 나오는지. */
  relaxationHints: RelaxationHint[];
  /**
   * '자리 있는 곳만' 은 슬롯을 본 뒤에야 판정되므로 후보를 앞에서 잘라 읽는다.
   * 그 상한에 걸렸으면 **숨기지 않고 알린다** — 조용히 자르면 "이게 전부" 로 읽힌다.
   */
  truncated: boolean;
};

/** 슬롯 판정이 필요할 때 한 번에 훑는 후보 수 상한. */
export const AVAILABILITY_SCAN_LIMIT = 200;

/**
 * 조회 방식 옵션 (S7-02).
 *
 * 조건 검색(`/search`)은 **부합도로 줄을 세운다**(§5.5 3단계). 그 순서는 슬롯·스타일·수용
 * 인원을 맞춰 본 뒤에야 나오므로 DB 가 정렬할 수 없다 — 참가격 편차 정렬이 메모리에서
 * 서는 것과 같은 사정이다.
 *
 * **그렇다고 조건 검색이 자기 쿼리를 따로 쓰게 두지 않는다.** 필터 해석이 두 벌이 되면
 * 같은 조건이 `/explore` 와 `/search` 에서 다른 결과를 낸다. 그래서 조회는 이 함수 하나로
 * 두고 **순서만 호출자가 갈아 끼운다.**
 */
export type SearchVendorsOptions = {
  /** 페이지 크기 대신 상한까지 후보를 읽는다. 메모리 정렬이 필요한 호출자용. */
  scanAll?: boolean;
  /** 페이지를 자르기 전에 적용할 순서. 상품 id 나열을 돌려준다. */
  rank?: (candidates: RankCandidate[]) => string[];
};

/**
 * 랭킹 함수에 넘기는 후보. **DB 행 타입이 아니다** — `lib/core` 가 DB 를 모른 채로
 * 남아야 Expo 전환 때 그대로 옮겨진다(CLAUDE.md §3.1).
 */
export type RankCandidate = {
  productId: string;
  basePrice: number;
  regionCode: string | null;
  styleTags: string[];
  capacityMin: number | null;
  capacityMax: number | null;
  availabilityKind: AvailabilityState["kind"];
};

/**
 * 쿼리 스트링 -> 필터 입력.
 *
 * **API 와 화면이 같은 파서를 쓴다.** 목록 화면이 자기 파싱을 따로 하면 같은 URL 로
 * 다른 결과가 나올 수 있고, 그러면 사용자가 공유한 링크가 다른 화면을 연다.
 */
export function toFilterInput(params: URLSearchParams) {
  const number = (key: string) => {
    const raw = params.get(key);

    return raw === null || raw.trim() === "" ? null : Number(raw);
  };

  const text = (key: string) => {
    const raw = params.get(key);

    return raw === null || raw.trim() === "" ? null : raw.trim();
  };

  return {
    region: text("region"),
    category: text("category"),
    budgetMin: number("budgetMin"),
    budgetMax: number("budgetMax"),
    guestCount: number("guestCount"),
    date: text("date"),
    styleTags: params.getAll("styleTags").filter((value) => value.trim() !== ""),
    onlyAvailable: params.get("onlyAvailable") === "true",
    sort: text("sort") ?? undefined,
    page: number("page") ?? undefined,
  };
}

/** 익명 읽기 클라이언트. 쿠키를 보지 않으므로 항상 공개 정책으로 판정된다. */
export function createPublicClient(): SupabaseClient {
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

/**
 * 게시된 상품만 고른다.
 *
 * RLS 가 이미 `status='published'` + 업체 `active` 로 막고 있지만 **여기서도 건다.**
 * 특히 `add_ons_declared_at is not null` 은 DB CHECK 가 게시 시점에만 보장하는
 * 조건이라, 조회에서 한 번 더 확인해야 층이 둘이 된다(F-V-04 — 사전 미등록 항목은
 * 사후 청구할 수 없으므로 미확정 상품이 고객에게 보이면 안 된다).
 */
const PRODUCT_SELECT =
  "id, name, base_price_total, price_includes_vat, included_items_json, capacity_min, capacity_max, created_at, add_ons_declared_at, vendor_id";

type ProductRow = {
  id: string;
  name: string;
  base_price_total: number;
  price_includes_vat: boolean;
  included_items_json: unknown;
  capacity_min: number | null;
  capacity_max: number | null;
  created_at: string;
  add_ons_declared_at: string | null;
  vendor_id: string;
};

type VendorRow = {
  id: string;
  name: string;
  category: string;
  region_code: string | null;
  style_tags: string[] | null;
};

function baseProductQuery(client: SupabaseClient, filter: ExploreFilter) {
  let query = client
    .from("products")
    .select(PRODUCT_SELECT, { count: "exact" })
    .eq("status", "published")
    .not("add_ons_declared_at", "is", null);

  if (filter.budgetMin !== null) query = query.gte("base_price_total", filter.budgetMin);
  if (filter.budgetMax !== null) query = query.lte("base_price_total", filter.budgetMax);

  // 하객 수는 상품이 밝힌 수용 범위 안에 들어야 한다.
  // **범위를 적지 않은 상품은 거르지 않는다** — 안 적은 것과 "수용 불가"는 다르다.
  if (filter.guestCount !== null) {
    query = query
      .or(`capacity_min.is.null,capacity_min.lte.${filter.guestCount}`)
      .or(`capacity_max.is.null,capacity_max.gte.${filter.guestCount}`);
  }

  switch (filter.sort) {
    case "price_asc":
      query = query.order("base_price_total", { ascending: true }).order("id", { ascending: true });
      break;
    case "price_desc":
      query = query.order("base_price_total", { ascending: false }).order("id", { ascending: true });
      break;
    case "recent":
      query = query.order("created_at", { ascending: false }).order("id", { ascending: true });
      break;
    case "price_index_gap":
      // 편차는 참가격 인덱스와 맞춰 봐야 나오므로 DB 가 정렬할 수 없다. 후보를 넉넉히
      // 읽어 메모리에서 세운다('자리 있는 곳만' 과 같은 방식이며 상한을 화면에 알린다).
      query = query.order("base_price_total", { ascending: true }).order("id", { ascending: true });
      break;
  }

  return query;
}

/** 업체 조건(지역·카테고리·스타일)에 맞는 업체 id. null 이면 업체 조건이 없다는 뜻이다. */
async function vendorIdsFor(
  client: SupabaseClient,
  filter: ExploreFilter,
): Promise<string[] | null> {
  const hasVendorFilter =
    filter.region !== null || filter.category !== null || filter.styleTags.length > 0;

  if (!hasVendorFilter) return null;

  let query = client.from("vendors").select("id").eq("status", "active");

  if (filter.category !== null) query = query.eq("category", filter.category);
  // 지역은 자유 입력이라 부분 일치로 본다("서울" 로 "서울 강남" 을 찾을 수 있어야 한다).
  if (filter.region !== null) query = query.ilike("region_code", `%${filter.region}%`);
  if (filter.styleTags.length > 0) query = query.overlaps("style_tags", filter.styleTags);

  const { data } = await query;

  return (data ?? []).map((row) => (row as { id: string }).id);
}

/**
 * 그 날짜의 예약 가능 여부를 **상품별로** 판정한다.
 *
 * 업체 단위로 묶으면 안 된다 — `inventory_slots.product_id` 는 널일 수 있고(업체 전체
 * 슬롯), 특정 상품에만 달린 슬롯도 있다(S2-05). 업체에 슬롯이 하나라도 있으면
 * "이 업체는 그날 가능" 이라고 말해 버리면, **다른 상품의 자리를 이 상품의 자리라고
 * 하는 것**이 된다. 날짜를 보고 고르는 화면에서 그건 그냥 틀린 정보다.
 */
async function availabilityByProduct(
  client: SupabaseClient,
  products: { id: string; vendor_id: string }[],
  date: string | null,
): Promise<Map<string, AvailabilityState>> {
  const map = new Map<string, AvailabilityState>();
  if (date === null || products.length === 0) return map;

  const { data } = await client
    .from("inventory_slots")
    .select("vendor_id, product_id, status, capacity, remaining")
    .in("vendor_id", [...new Set(products.map((product) => product.vendor_id))])
    .eq("slot_date", date);

  const slots = (data ?? []) as {
    vendor_id: string;
    product_id: string | null;
    status: string;
    capacity: number;
    remaining: number;
  }[];

  for (const product of products) {
    // 이 상품에 달린 슬롯 + 상품을 지정하지 않은 업체 전체 슬롯.
    const mine = slots.filter(
      (slot) =>
        slot.vendor_id === product.vendor_id &&
        (slot.product_id === product.id || slot.product_id === null),
    );

    map.set(product.id, availabilityOf(mine));
  }

  return map;
}

/** 추가금 사전표 요약을 상품별로 모은다. */
async function addOnsByProduct(
  client: SupabaseClient,
  productIds: string[],
): Promise<Map<string, { count: number; total: number }>> {
  const map = new Map<string, { count: number; total: number }>();
  if (productIds.length === 0) return map;

  const { data } = await client
    .from("product_options")
    .select("product_id, price")
    .in("product_id", productIds);

  for (const row of (data ?? []) as { product_id: string; price: number }[]) {
    const current = map.get(row.product_id) ?? { count: 0, total: 0 };
    map.set(row.product_id, { count: current.count + 1, total: current.total + row.price });
  }

  return map;
}

/** 결과 건수만 센다. 0건 안내에서 "이걸 풀면 몇 건" 을 말하기 위한 것이다. */
async function countFor(client: SupabaseClient, filter: ExploreFilter): Promise<number> {
  const vendorIds = await vendorIdsFor(client, filter);
  if (vendorIds !== null && vendorIds.length === 0) return 0;

  let query = baseProductQuery(client, filter);
  if (vendorIds !== null) query = query.in("vendor_id", vendorIds);

  const { data, count } = await query.range(0, AVAILABILITY_SCAN_LIMIT - 1);

  // 날짜 조건이 없으면 DB 가 센 값이 곧 결과다.
  if (!filter.onlyAvailable || filter.date === null) return count ?? 0;

  const rows = (data ?? []) as ProductRow[];
  const availability = await availabilityByProduct(client, rows, filter.date);

  return rows.filter((row) => availability.get(row.id)?.kind === "available").length;
}

export async function searchVendors(
  client: SupabaseClient,
  input: unknown,
  options?: SearchVendorsOptions,
): Promise<{ ok: true; result: ExploreResult } | { ok: false; issues: ZodIssue[] }> {
  const parsed = ExploreFilterSchema.safeParse(input);
  if (!parsed.success) return { ok: false, issues: parsed.error.issues };

  const filter = parsed.data;
  const vendorIds = await vendorIdsFor(client, filter);

  const empty: ExploreResult = {
    rows: [],
    total: 0,
    page: filter.page,
    pageSize: EXPLORE_PAGE_SIZE,
    sort: filter.sort,
    appliedFilters: activeFilterKeys(filter),
    relaxationHints: [],
    truncated: false,
  };

  if (vendorIds !== null && vendorIds.length === 0) {
    return { ok: true, result: { ...empty, relaxationHints: await hintsFor(client, filter) } };
  }

  const from = (filter.page - 1) * EXPLORE_PAGE_SIZE;

  let query = baseProductQuery(client, filter);
  if (vendorIds !== null) query = query.in("vendor_id", vendorIds);

  // '자리 있는 곳만'(슬롯)과 '참가격 대비'(지수)는 다른 테이블을 봐야 판정되므로
  // 페이지를 잘라내기 전에 후보를 넉넉히 읽는다. 상한에 걸리면 화면이 그 사실을 알린다.
  const scanAll = options?.scanAll === true || filter.onlyAvailable || filter.sort === "price_index_gap";
  const fetchTo = scanAll ? AVAILABILITY_SCAN_LIMIT - 1 : from + EXPLORE_PAGE_SIZE - 1;
  const fetchFrom = scanAll ? 0 : from;

  const { data, count, error } = await query.range(fetchFrom, fetchTo);
  if (error) throw error;

  let products = (data ?? []) as ProductRow[];

  const vendorLookup = await vendorsByIds(client, [...new Set(products.map((p) => p.vendor_id))]);
  const availability = await availabilityByProduct(client, products, filter.date);

  let total = count ?? products.length;
  const truncated = scanAll && (count ?? 0) > AVAILABILITY_SCAN_LIMIT;

  if (filter.onlyAvailable) {
    products = products.filter((row) => availability.get(row.id)?.kind === "available");
    total = products.length;
  }

  // 참가격 인덱스는 지역·카테고리 칸으로 붙는다(S3-08).
  const indexMap = await loadPriceIndexMap(
    client,
    products.flatMap((product) => {
      const vendor = vendorLookup.get(product.vendor_id);

      return vendor?.region_code ? [{ regionCode: vendor.region_code, category: vendor.category }] : [];
    }),
  );

  const gapOf = (product: ProductRow): { gapBp: number | null; p50: number | null } => {
    const vendor = vendorLookup.get(product.vendor_id);
    const row = vendor?.region_code
      ? (indexMap.get(indexKey(vendor.region_code, vendor.category)) ?? null)
      : null;
    const p50 = row?.p50 ?? null;

    return { gapBp: priceGapBp(product.base_price_total, p50), p50 };
  };

  if (filter.sort === "price_index_gap") {
    // 기준이 없는 항목은 **빼지 않고 맨 뒤에** 둔다(compareByGap).
    products = [...products].sort((a, b) =>
      compareByGap(
        { id: a.id, gapBp: gapOf(a).gapBp },
        { id: b.id, gapBp: gapOf(b).gapBp },
      ),
    );
  }

  /**
   * 호출자가 준 순서(조건 부합도 등)를 **페이지를 자르기 전에** 적용한다.
   * 자른 뒤에 세우면 한 페이지 안에서만 줄이 바뀌어 순서가 거짓이 된다.
   */
  if (options?.rank) {
    const order = options.rank(
      products.map((product) => {
        const vendor = vendorLookup.get(product.vendor_id);

        return {
          productId: product.id,
          basePrice: product.base_price_total,
          regionCode: vendor?.region_code ?? null,
          styleTags: vendor?.style_tags ?? [],
          capacityMin: product.capacity_min,
          capacityMax: product.capacity_max,
          availabilityKind: (availability.get(product.id) ?? { kind: "unknown" }).kind,
        };
      }),
    );

    const position = new Map(order.map((id, index) => [id, index]));
    // 순서에 없는 상품은 뒤로 보낸다. 조용히 빼면 결과 수와 목록이 어긋난다.
    products = [...products].sort(
      (a, b) =>
        (position.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (position.get(b.id) ?? Number.MAX_SAFE_INTEGER),
    );
  }

  if (scanAll) {
    if (filter.onlyAvailable) total = products.length;
    products = products.slice(from, from + EXPLORE_PAGE_SIZE);
  }

  const addOns = await addOnsByProduct(client, products.map((row) => row.id));

  const rows: ExploreRow[] = products.flatMap((product) => {
    const vendor = vendorLookup.get(product.vendor_id);
    // 업체가 안 보이면(비활성 등) 상품도 노출하지 않는다. RLS 가 이미 막지만 층을 하나 더 둔다.
    if (!vendor) return [];

    const summary = addOns.get(product.id) ?? { count: 0, total: 0 };

    return [{
      vendorId: vendor.id,
      vendorName: vendor.name,
      category: vendor.category,
      regionCode: vendor.region_code,
      styleTags: vendor.style_tags ?? [],
      productId: product.id,
      productName: product.name,
      basePrice: product.base_price_total,
      priceIncludesVat: product.price_includes_vat,
      includedItemCount: Array.isArray(product.included_items_json)
        ? product.included_items_json.length
        : 0,
      capacityMin: product.capacity_min,
      capacityMax: product.capacity_max,
      addOns: { declaredAt: product.add_ons_declared_at, ...summary },
      ...(() => {
        const { gapBp, p50 } = gapOf(product);

        return { gapBp, indexP50: p50 };
      })(),
      availability: availability.get(product.id) ?? { kind: "unknown" },
      createdAt: product.created_at,
    }];
  });

  return {
    ok: true,
    result: {
      ...empty,
      rows,
      total,
      truncated,
      relaxationHints: rows.length === 0 ? await hintsFor(client, filter) : [],
    },
  };
}

async function vendorsByIds(
  client: SupabaseClient,
  ids: string[],
): Promise<Map<string, VendorRow>> {
  const map = new Map<string, VendorRow>();
  if (ids.length === 0) return map;

  const { data } = await client
    .from("vendors")
    .select("id, name, category, region_code, style_tags")
    .in("id", ids)
    .eq("status", "active");

  for (const row of (data ?? []) as VendorRow[]) map.set(row.id, row);

  return map;
}

/**
 * 0건일 때 **어느 조건을 풀면 결과가 나오는지** 센다.
 *
 * "조건을 바꿔 보세요" 는 안내가 아니다. 무엇을 바꿔야 하는지 모르면 사용자는
 * 아무거나 지우다 나간다. 조건을 하나씩 뺀 건수를 실제로 세서 효과 순으로 제안한다.
 */
async function hintsFor(client: SupabaseClient, filter: ExploreFilter): Promise<RelaxationHint[]> {
  const keys = activeFilterKeys(filter);
  if (keys.length === 0) return [];

  const counted = await Promise.all(
    keys.map(async (key) => ({
      key,
      label: EXPLORE_FILTER_LABEL[key],
      count: await countFor(client, withoutFilter(filter, key)),
    })),
  );

  return rankRelaxationHints(counted);
}

