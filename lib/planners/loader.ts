import {
  MARKET_SORTS,
  PLANNER_STATUS_DETAIL,
  PLANNER_STATUS_LABEL,
  contractMetric,
  filterMarket,
  reviewMetric,
  sortMarket,
  type MarketSort,
  type MetricDisplay,
  type PlannerStatus,
} from "@/lib/core/planner/profile";
import type { PlannerCategory } from "@/lib/core/planner/scope";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * 플래너 마켓·프로필 조회 (S6-02)
 *
 * **읽기는 호출자가 넘긴 세션 클라이언트로 한다.** `planners` 정책은 `active` 만
 * 공개하고 본인·운영자에게 그 밖을 연다(0005·0037) — 읽히면 볼 자격이 있는 것이다.
 * 여기서 status 로 다시 거르지 않는다(§5.5).
 *
 * **실적은 함수로 읽는다.** 계약 건수는 `planner_contract_count`(0037)가 개수만
 * 돌려준다 — 뷰로 만들면 `planner_settlements` 가 조인 경로로 노출되고, 그것은
 * FIX-13·14 가 지적한 "소유자 필터 없는 뷰" 와 같은 사고다.
 */
type Reader = Awaited<ReturnType<typeof import("@/lib/supabase/server").createClient>>;

export type PlannerCard = {
  id: string;
  headline: string;
  bio: string;
  careerYears: number;
  categories: PlannerCategory[];
  regions: string[];
  status: PlannerStatus;
  statusLabel: string;
  createdAt: string;
  contractCount: number;
  /** 화면이 그대로 그리는 실적 표시. **못 세는 지표는 0이 아니다.** */
  metrics: { contracts: MetricDisplay; reviews: MetricDisplay };
};

export type MarketPayload = {
  planners: PlannerCard[];
  sort: MarketSort;
  filter: { category: string | null; region: string | null };
  /** 목록에 실제로 쓰인 정렬 기준 코드. **응답에 항상 포함한다**(§2.2). */
  sortBasis: MarketSort;
};

const COLUMNS = "id, user_id, profile_json, regions, status, created_at";

function toCard(row: Record<string, unknown>, contractCount: number): PlannerCard {
  const profile = (row.profile_json ?? {}) as Record<string, unknown>;
  const status = row.status as PlannerStatus;

  return {
    id: row.id as string,
    headline: (profile.headline as string | undefined) ?? "",
    bio: (profile.bio as string | undefined) ?? "",
    careerYears: Number(profile.careerYears ?? 0),
    categories: ((profile.categories as string[] | undefined) ?? []) as PlannerCategory[],
    regions: ((row.regions as string[] | null) ?? []) as string[],
    status,
    statusLabel: PLANNER_STATUS_LABEL[status] ?? status,
    createdAt: row.created_at as string,
    contractCount,
    metrics: {
      contracts: contractMetric(contractCount),
      // **리뷰는 0이 아니라 "아직 세지 않는다"** — 0은 평가가 나쁜 것처럼 읽힌다.
      reviews: reviewMetric(),
    },
  };
}

/** 실적 건수를 함수로 읽는다. 금액·기간은 나가지 않는다(0037). */
async function contractCounts(ids: readonly string[]): Promise<Map<string, number>> {
  const admin = createAdminClient();
  const counts = new Map<string, number>();

  for (const id of ids) {
    const { data } = await admin.rpc("planner_contract_count", { p_planner_id: id });

    counts.set(id, Number(data ?? 0));
  }

  return counts;
}

export async function loadMarket(
  client: Reader,
  options: { sort?: string | null; category?: string | null; region?: string | null } = {},
): Promise<MarketPayload> {
  const { data } = await client.from("planners").select(COLUMNS).eq("status", "active");

  const rows = (data ?? []) as unknown as Record<string, unknown>[];
  const counts = await contractCounts(rows.map((row) => row.id as string));

  const cards = rows.map((row) => toCard(row, counts.get(row.id as string) ?? 0));

  const sort: MarketSort = (MARKET_SORTS as readonly string[]).includes(options.sort ?? "")
    ? (options.sort as MarketSort)
    : "contracts";

  const filtered = filterMarket(cards, {
    category: options.category ?? null,
    region: options.region ?? null,
  });

  return {
    planners: sortMarket(filtered, sort),
    sort,
    filter: { category: options.category ?? null, region: options.region ?? null },
    // 정렬 기준 코드를 **항상** 함께 내보낸다 — "유료 노출 없음" 을 화면으로 증명한다.
    sortBasis: sort,
  };
}

export type PlannerDetail = PlannerCard & { statusDetail: string };

export async function loadPlanner(client: Reader, id: string): Promise<PlannerDetail | null> {
  const { data } = await client.from("planners").select(COLUMNS).eq("id", id).maybeSingle();

  const row = data as unknown as Record<string, unknown> | null;
  if (!row) return null;

  const counts = await contractCounts([row.id as string]);
  const card = toCard(row, counts.get(row.id as string) ?? 0);

  return { ...card, statusDetail: PLANNER_STATUS_DETAIL[card.status] ?? "" };
}

/** 로그인한 사용자의 플래너 프로필. 없으면 null(아직 등록하지 않음). */
export async function loadMyPlanner(client: Reader, userId: string): Promise<PlannerDetail | null> {
  const { data } = await client
    .from("planners")
    .select(COLUMNS)
    .eq("user_id", userId)
    .maybeSingle();

  const row = data as unknown as Record<string, unknown> | null;
  if (!row) return null;

  const counts = await contractCounts([row.id as string]);
  const card = toCard(row, counts.get(row.id as string) ?? 0);

  return { ...card, statusDetail: PLANNER_STATUS_DETAIL[card.status] ?? "" };
}
