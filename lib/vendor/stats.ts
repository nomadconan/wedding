import {
  measured,
  notYet,
  pricePositionBp,
  profileGaps,
  restricted,
  slotUtilizationBp,
  type MetricValue,
  type ProfileGap,
} from "@/lib/core/stats/metric";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * 업체 통계 집계 (S2-08 · F-V-12)
 *
 * **새 테이블도 캐시도 만들지 않는다.** 지금 있는 데이터를 그때그때 센다.
 * 업체당 상품·슬롯 수가 수천 건을 넘기면 집계 테이블을 검토하겠지만, 그 시점 전에
 * 캐시를 만들면 무효화 규칙만 늘고 값이 어긋난다.
 *
 * 자기 업체 데이터는 **호출자가 넘긴 세션 클라이언트**로 읽는다 — RLS 가 경계다.
 * 지역 시세(타 업체 포함)만 서비스롤로 읽되 **익명 집계 결과만** 돌려준다(§7.7).
 */
/**
 * 최소 인터페이스. 세션·서비스롤 클라이언트를 모두 받아야 하고 쿼리 모양이 여럿이라
 * 빌더 타입을 그대로 옮기면 체인이 깊어 `TS2589` 가 난다(S2-04 에서 겪었다).
 * 반환은 호출 지점에서 좁힌다.
 */
type QueryBuilder = {
  select: (columns: string) => QueryBuilder;
  eq: (column: string, value: string) => QueryBuilder;
  limit: (count: number) => QueryBuilder;
  maybeSingle: () => PromiseLike<{ data: Record<string, never> | null; error?: unknown }>;
} & PromiseLike<{ data: unknown[] | null; error?: unknown }>;

type Reader = { from: (table: string) => unknown };

/** 호출 지점에서 좁힌다. 빌더 타입을 인자로 요구하면 실제 클라이언트가 들어오지 못한다. */
const table = (client: Reader, name: string) => client.from(name) as QueryBuilder;

export type VendorStats = {
  application: {
    vendorStatus: string;
    applicationStatus: string | null;
    reviewNote: string | null;
  };
  products: {
    total: MetricValue;
    published: MetricValue;
    draft: MetricValue;
    addOnsUndeclared: MetricValue;
  };
  inventory: {
    slotsTotal: MetricValue;
    slotsUpcoming: MetricValue;
    blocked: MetricValue;
    utilizationBp: MetricValue;
  };
  pricing: {
    rulesTotal: MetricValue;
    rulesActive: MetricValue;
  };
  profile: {
    gaps: ProfileGap[];
    mediaCount: MetricValue;
  };
  market: {
    pricePosition: MetricValue<{ percentileBp: number; sampleSize: number }>;
  };
  /** 아직 셀 수단이 없는 지표들. 화면이 자리를 만들고 근거를 보여준다. */
  funnel: {
    impressions: MetricValue;
    inquiries: MetricValue;
    consultations: MetricValue;
    bookings: MetricValue;
    contracts: MetricValue;
  };
  settlement: {
    thisMonthNet: MetricValue;
  };
  reviews: {
    ratingAvg: MetricValue;
  };
};

/** 오늘(UTC) 기준 'YYYY-MM-DD'. 슬롯 날짜는 date 타입이라 타임존 변환이 끼어들지 않는다. */
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function loadVendorStats(
  supabase: Reader,
  vendor: { id: string; category: string; regionCode: string | null; status: string },
  options: { canSeeFinancials: boolean },
): Promise<VendorStats> {
  const today = todayIso();

  const [{ data: products }, { data: slots }, { data: rules }, { data: media }, { data: application }] =
    await Promise.all([
      table(supabase, "products")
        .select("id, status, base_price_total, add_ons_declared_at")
        .eq("vendor_id", vendor.id),
      table(supabase, "inventory_slots")
        .select("slot_date, capacity, remaining, status")
        .eq("vendor_id", vendor.id),
      table(supabase, "price_rules").select("id, is_active").eq("vendor_id", vendor.id),
      table(supabase, "vendor_media").select("id").eq("vendor_id", vendor.id),
      table(supabase, "vendor_applications")
        .select("status, review_note")
        .eq("vendor_id", vendor.id)
        .maybeSingle(),
    ]);

  const productRows = (products ?? []) as {
    status: string;
    base_price_total: number;
    add_ons_declared_at: string | null;
  }[];
  const slotRows = (slots ?? []) as {
    slot_date: string;
    capacity: number;
    remaining: number;
    status: string;
  }[];
  const upcoming = slotRows.filter((slot) => slot.slot_date >= today);

  const { data: profile } = await table(supabase, "vendors")
    .select("address, capacity_max, facilities, intro")
    .eq("id", vendor.id)
    .maybeSingle();

  // 문의 수 (S4-12 가 연결했다). RLS 가 자기 업체에 온 것만 보여주므로 여기서
  // 다시 좁히는 `eq` 는 화면 필터일 뿐이다.
  // `count` 대신 행을 세는 이유 — 이 파일의 `QueryBuilder` 는 데이터만 다루는 얇은
  // 타입이고, 다른 지표도 전부 같은 방식으로 센다. 한 지표를 위해 타입을 넓히지 않는다.
  const { data: inquiryRows } = await table(supabase, "inquiry_targets")
    .select("id")
    .eq("vendor_id", vendor.id);

  const inquiryCount = (inquiryRows ?? []).length;

  // 상담·탐방 수 (S4-07 이 연결했다). RLS 가 자기 업체 것만 보여준다.
  const { data: consultationRows } = await table(supabase, "consultations")
    .select("id")
    .eq("vendor_id", vendor.id);

  const consultationCount = (consultationRows ?? []).length;

  return {
    application: {
      vendorStatus: vendor.status,
      applicationStatus: ((application as Record<string, unknown> | null)?.status as string) ?? null,
      reviewNote: ((application as Record<string, unknown> | null)?.review_note as string) ?? null,
    },

    products: {
      total: measured(productRows.length),
      published: measured(productRows.filter((row) => row.status === "published").length),
      draft: measured(productRows.filter((row) => row.status === "draft").length),
      addOnsUndeclared: measured(productRows.filter((row) => !row.add_ons_declared_at).length),
    },

    inventory: {
      slotsTotal: measured(slotRows.length),
      slotsUpcoming: measured(upcoming.length),
      blocked: measured(slotRows.filter((slot) => slot.status === "blocked").length),
      // 앞으로의 슬롯만 본다. 지난 날짜의 소진율은 지금 판단에 쓸모가 없다.
      utilizationBp: slotUtilizationBp(upcoming),
    },

    pricing: {
      rulesTotal: measured((rules ?? []).length),
      rulesActive: measured(
        ((rules ?? []) as { is_active: boolean }[]).filter((rule) => rule.is_active).length,
      ),
    },

    profile: {
      gaps: profile
        ? profileGaps({
            address: (profile as Record<string, unknown>).address as string | null,
            capacityMax: (profile as Record<string, unknown>).capacity_max as number | null,
            facilities: (profile as Record<string, unknown>).facilities as string[] | null,
            intro: (profile as Record<string, unknown>).intro as string | null,
            mediaCount: (media ?? []).length,
          })
        : [],
      mediaCount: measured((media ?? []).length),
    },

    market: {
      pricePosition: await loadPricePosition(vendor, productRows),
    },

    // ── 퍼널 ────────────────────────────────────────────────────────────────
    // 셀 수 있는 것만 숫자로 적는다. 나머지는 0이 아니라 '아직' 이다 — 0으로 적으면
    // "0건 왔다"로 읽히는데 실제로는 받을 수단이 없는 것이고, 그 둘은 업체가 내릴
    // 판단이 다르다.
    funnel: {
      impressions: notYet("탐색 화면이 없어 노출을 셀 수 없습니다.", "S3-03"),
      inquiries: measured(inquiryCount ?? 0),
      consultations: measured(consultationCount),
      bookings: notYet("예약·계약 기능이 아직 없습니다.", "S5-06"),
      contracts: notYet("전자계약 기능이 아직 없습니다.", "S5-04"),
    },

    settlement: {
      thisMonthNet: options.canSeeFinancials
        ? notYet("정산 기능이 아직 없습니다.", "S5-07")
        : restricted("정산 금액은 업체 대표 계정만 볼 수 있습니다."),
    },

    reviews: {
      ratingAvg: notYet("검증 후기 기능이 아직 없습니다.", "S8-11"),
    },
  };
}

/**
 * 지역 내 가격 포지션.
 *
 * 타 업체 상품을 세야 하므로 **서비스롤**로 읽는다. 대신
 *  * 같은 지역·카테고리의 **게시된** 상품만 보고,
 *  * 업체별 대표가(가장 낮은 게시가) 하나씩만 표본에 넣고,
 *  * 결과로 **백분위와 표본 수만** 돌려준다. 가격도 업체명도 밖으로 나가지 않는다(§7.7).
 */
async function loadPricePosition(
  vendor: { id: string; category: string; regionCode: string | null },
  products: { status: string; base_price_total: number }[],
): Promise<MetricValue<{ percentileBp: number; sampleSize: number }>> {
  const myPublished = products
    .filter((row) => row.status === "published")
    .map((row) => row.base_price_total);

  if (myPublished.length === 0) {
    return notYet("게시된 상품이 있어야 내 위치를 계산할 수 있습니다.", "S2-03");
  }

  if (!vendor.regionCode) {
    return notYet("업체 프로필에 지역을 입력하면 표시됩니다.", "S2-02");
  }

  const myPrice = Math.min(...myPublished);
  const admin = createAdminClient();

  const { data: peers } = await admin
    .from("products")
    .select("vendor_id, base_price_total, vendors!inner(region_code, category, status)")
    .eq("status", "published")
    .eq("vendors.region_code", vendor.regionCode)
    .eq("vendors.category", vendor.category)
    .eq("vendors.status", "active")
    .neq("vendor_id", vendor.id);

  // 업체마다 대표가 하나만. 상품을 많이 올린 업체가 분포를 끌고 가지 않게 한다.
  const lowestByVendor = new Map<string, number>();
  for (const row of (peers ?? []) as { vendor_id: string; base_price_total: number }[]) {
    const current = lowestByVendor.get(row.vendor_id);
    if (current === undefined || row.base_price_total < current) {
      lowestByVendor.set(row.vendor_id, row.base_price_total);
    }
  }

  return pricePositionBp(myPrice, [...lowestByVendor.values()]);
}
