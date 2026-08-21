import type { SupabaseClient } from "@supabase/supabase-js";

import {
  BUDGET_CATEGORIES,
  budgetCategoryOfVendor,
  buildLine,
  donutSegments,
  recommendAllocation,
  summarizeRecommendation,
  totalsOf,
  warningsOf,
  type BudgetCategory,
  type BudgetLine,
  type BudgetTotals,
  type BudgetWarning,
  type DonutSegment,
  type IndexPoint,
  type Recommendation,
  type RecommendationSummary,
} from "@/lib/core/budget/budget";
import { loadPriceIndexMap } from "@/lib/pricing/price-index-query";

/**
 * 예산 조회 (S7-07 · 명세서 §6.2 `/budget` · §4.2 `GET/PUT /api/budget`)
 *
 * ── 세션 클라이언트로 읽는다 ────────────────────────────────────────────────
 * `budgets`·`budget_items`·`expenses`·`bookings`·`payments` 는 전부 커플 스코프
 * RLS 이고 **플래너 위임까지 그쪽이 판정한다**(0005 [12][13][14]). 서비스롤로 읽으면
 * 그 위임 규칙이 이 파일의 조건문으로 내려온다.
 *
 * 예외는 **참가격 지수** 하나다 — 공개 데이터라 익명 클라이언트로 읽는다(§3.9).
 *
 * ── 계약·결제를 저장하지 않고 센다 ──────────────────────────────────────────
 * `budget_items.contracted_amount`·`spent_amount` 는 쓰지 않는다(0045). 저장하면
 * **배치가 돌기 전까지 화면이 거짓말을 한다** — 계약이 확정되는 순간 예산이 바뀌어야
 * 하는데 그 순간을 놓치면 영영 어긋난 채로 남는다(S7-18 의 `ready`·`waiting` 과 같은
 * 판단 · D-71).
 */

export type BudgetExpense = {
  id: string;
  category: BudgetCategory;
  amount: number;
  paidAt: string | null;
  memo: string | null;
};

export type BudgetView = {
  /** `couples.total_budget`. **미정이면 null** 이다 — 0이 아니다. */
  totalBudget: number | null;
  lines: BudgetLine[];
  totals: BudgetTotals;
  warnings: BudgetWarning[];
  donut: DonutSegment[];
  recommendations: Recommendation[];
  recommendation: RecommendationSummary;
  expenses: BudgetExpense[];
  /** 커플의 지역. 지수를 고르는 축이며 **없으면 권장이 서지 않는다.** */
  regionCode: string | null;
};

type BudgetRow = { id: string; allocation_json: Record<string, unknown> | null };

/** 예산 부모 행. **없으면 만든다** — 카테고리 계획이 매달릴 곳이 필요하다. */
export async function ensureBudget(
  client: SupabaseClient,
  coupleId: string,
): Promise<string | null> {
  const { data: existing } = await client
    .from("budgets")
    .select("id")
    .eq("couple_id", coupleId)
    .maybeSingle();

  const found = (existing as { id: string } | null)?.id ?? null;
  if (found !== null) return found;

  const { data: created } = await client
    .from("budgets")
    .insert({ couple_id: coupleId })
    .select("id")
    .maybeSingle();

  // 배우자가 동시에 열면 유니크(0045)가 한쪽을 막는다. 그때는 상대가 만든 행을 읽는다.
  if ((created as { id: string } | null)?.id) return (created as { id: string }).id;

  const { data: again } = await client
    .from("budgets")
    .select("id")
    .eq("couple_id", coupleId)
    .maybeSingle();

  return (again as { id: string } | null)?.id ?? null;
}

/**
 * 확정된 예약을 카테고리별로 센다.
 *
 * **DB 함수를 부른다**(`budget_contracted` · 0045). 처음에는 PostgREST 임베드
 * (`bookings.vendors(category)`)로 업체 카테고리를 읽었는데, `vendors` 는 공개 조건이
 * 붙은 표라 **커플이 그 행을 못 읽으면 임베드가 `null` 로 오고 계약이 통째로 `etc` 로
 * 떨어졌다** — 흐름 점검이 잡았다. 1,200만원짜리 홀 계약이 '기타' 에 붙는 것이며,
 * 더 나쁜 것은 **업체 노출이 바뀌면 이미 잡힌 계약이 카테고리를 옮긴다**는 점이다.
 *
 * 함수는 SECURITY DEFINER 이고 **경계는 함수 안의 권한 검사**다(커플 구성원 또는
 * `budgets` 를 위임받은 플래너). `budgetCategoryOfVendor` 와 같은 표를 쓰며 `db:rls`
 * 가 코드↔DB 를 대조한다.
 */
async function contractedByCategory(
  client: SupabaseClient,
  coupleId: string,
): Promise<{ contracted: Map<BudgetCategory, number>; paid: Map<BudgetCategory, number> }> {
  const contracted = new Map<BudgetCategory, number>();
  const paid = new Map<BudgetCategory, number>();

  const { data } = await client.rpc("budget_contracted", { p_couple_id: coupleId });

  for (const row of (data ?? []) as { category: string; contracted: number; paid: number }[]) {
    // 함수가 모르는 값을 내보내지는 않지만, 어휘가 늘어나는 날 화면이 조용히
    // 항목을 잃지 않도록 여기서도 같은 규칙으로 접는다.
    const category = budgetCategoryOfVendor(row.category) === "etc" && row.category !== "etc"
      ? "etc"
      : (row.category as BudgetCategory);

    contracted.set(category, (contracted.get(category) ?? 0) + Number(row.contracted ?? 0));
    paid.set(category, (paid.get(category) ?? 0) + Number(row.paid ?? 0));
  }

  return { contracted, paid };
}

export async function loadBudget(
  client: SupabaseClient,
  publicClient: SupabaseClient,
  input: { coupleId: string },
): Promise<BudgetView> {
  const { data: couple } = await client
    .from("couples")
    .select("total_budget, region_code")
    .eq("id", input.coupleId)
    .maybeSingle();

  const coupleRow = (couple ?? null) as { total_budget: number | null; region_code: string | null } | null;
  const totalBudget = coupleRow?.total_budget ?? null;
  const regionCode = coupleRow?.region_code ?? null;

  const budgetId = await ensureBudget(client, input.coupleId);

  const { data: itemRows } = budgetId
    ? await client
        .from("budget_items")
        .select("category, planned_amount")
        .eq("budget_id", budgetId)
    : { data: [] };

  const planned = new Map<BudgetCategory, number>();
  for (const row of (itemRows ?? []) as { category: string; planned_amount: number }[]) {
    planned.set(row.category as BudgetCategory, row.planned_amount);
  }

  const { data: expenseRows } = await client
    .from("expenses")
    .select("id, category, amount, paid_at, memo")
    .eq("couple_id", input.coupleId)
    .order("paid_at", { ascending: false, nullsFirst: false })
    .limit(200);

  const expenses = ((expenseRows ?? []) as {
    id: string;
    category: string;
    amount: number;
    paid_at: string | null;
    memo: string | null;
  }[]).map((row) => ({
    id: row.id,
    category: row.category as BudgetCategory,
    amount: row.amount,
    paidAt: row.paid_at === null ? null : row.paid_at.slice(0, 10),
    memo: row.memo,
  }));

  const manualSpent = new Map<BudgetCategory, number>();
  for (const expense of expenses) {
    manualSpent.set(expense.category, (manualSpent.get(expense.category) ?? 0) + expense.amount);
  }

  const { contracted, paid } = await contractedByCategory(client, input.coupleId);

  const lines = BUDGET_CATEGORIES.map((category) =>
    buildLine({
      category,
      // **계획이 없는 카테고리는 `null` 이다** — 0원 계획과 구분한다.
      planned: planned.has(category) ? (planned.get(category) as number) : null,
      contracted: contracted.get(category) ?? 0,
      paid: paid.get(category) ?? 0,
      manualSpent: manualSpent.get(category) ?? 0,
    }),
  );

  const totals = totalsOf({ totalBudget, lines });

  return {
    totalBudget,
    lines,
    totals,
    warnings: warningsOf({ totals, lines }),
    donut: donutSegments({ lines, unallocated: totals.unallocated }),
    ...(await recommendationOf(publicClient, regionCode)),
    expenses,
    regionCode,
  };
}

/**
 * 권장 배분.
 *
 * **지역이 없으면 권장하지 않는다.** 지수는 지역·카테고리 축이라 지역 없이는 어느
 * 칸을 볼지 정할 수 없고, 임의의 지역을 골라 권하면 그 값은 이 커플과 무관한 숫자다.
 */
async function recommendationOf(
  publicClient: SupabaseClient,
  regionCode: string | null,
): Promise<{ recommendations: Recommendation[]; recommendation: RecommendationSummary }> {
  if (regionCode === null) {
    const recommendations = recommendAllocation({ index: [] });

    return { recommendations, recommendation: summarizeRecommendation(recommendations) };
  }

  const map = await loadPriceIndexMap(
    publicClient,
    BUDGET_CATEGORIES.map((category) => ({ regionCode, category })),
  );

  const index: IndexPoint[] = [...map.values()].map((row) => ({
    category: row.category,
    p50: row.p50,
    sampleSize: row.sampleSize,
    sourceLabel: row.sourceLabel,
  }));

  const recommendations = recommendAllocation({ index });

  return { recommendations, recommendation: summarizeRecommendation(recommendations) };
}

/**
 * 홈이 쓰는 예산 게이지 (S3-11 · §6.2).
 *
 * **`/budget` 과 같은 함수를 부른다** — 두 화면이 다른 총액을 말하면 사용자는 어느
 * 쪽이 맞는지 묻게 된다(S7-08 이 '다음 할 일' 에서 세운 규칙과 같다).
 */
export type BudgetGauge = {
  totalBudget: number | null;
  committed: number;
  remaining: number | null;
  overBy: number | null;
  /** 소진 비율(bp). 총예산이 없으면 `null` — **0이 아니다.** */
  usedBp: number | null;
  warningCount: number;
};

export async function loadBudgetGauge(
  client: SupabaseClient,
  publicClient: SupabaseClient,
  input: { coupleId: string },
): Promise<BudgetGauge> {
  const view = await loadBudget(client, publicClient, input);

  return gaugeOf(view);
}

export function gaugeOf(view: BudgetView): BudgetGauge {
  const { totals } = view;

  return {
    totalBudget: totals.totalBudget,
    committed: totals.committed,
    remaining: totals.remaining,
    overBy: totals.overBy,
    usedBp:
      totals.totalBudget === null || totals.totalBudget <= 0
        ? null
        : Math.round((totals.committed * 10_000) / totals.totalBudget),
    warningCount: view.warnings.length,
  };
}
