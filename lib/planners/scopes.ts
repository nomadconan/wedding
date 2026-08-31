import { recordEvent } from "@/lib/audit/record";
import { engagementPhase } from "@/lib/core/planner/delegation";
import {
  PLANNER_CATEGORIES,
  PLANNER_CATEGORY_LABEL,
  type Amount,
  type PlannerCategory,
  type ScopeChangeError,
  type ScopeFeeLine,
  type ScopeRow,
  type ScopeSelection,
  SCOPE_CHANGE_MESSAGE,
  diffScopes,
  scopeFeeLine,
  scopeFeeTotal,
  validateScopeSelection,
} from "@/lib/core/planner/scope";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import { loadPlannerRateRecords, resolvePlannerRateBp } from "./rates";

/**
 * 카테고리별 부분 선택 과금 (S6-03 · F-C-31 · §4.2 `GET/PUT /api/planner-scopes`)
 *
 * **읽기는 세션, 쓰기는 서비스롤이다**(이 리포의 공통 방식). `planner_scopes_select`
 * 가 커플 구성원·해당 플래너·운영자로 가르므로 목록에서 다시 거르지 않는다(§5.5).
 *
 * **임베드를 쓰지 않는다**(함정 1). `planner_scopes` 에서 `planners` 를 한 번에 끌면
 * 공개가 내려간 플래너의 행이 **조용히 빠져** 선택이 사라진 것처럼 보인다. 표마다
 * 따로 묻고 **못 본 것은 null 로 남긴다.**
 *
 * ── 이 파일이 답하는 것 ─────────────────────────────────────────────────────
 * "고르면 총액이 얼마가 되는가"(F-C-31 — 선택 즉시 반영)와 "언제 실제로 걸리는가"
 * (D-17 — 계약이 성사돼야 발생). 앞의 것은 **담긴 항목의 판매가**로 계산하고, 뒤의
 * 것은 계약 발행이 `planner_scopes` 를 읽어 집행한다(`lib/contract/actions.ts`).
 *
 * **요율이 없으면 0으로 접지 않는다**(함정 2 · O-02). 0원과 "기준을 모른다" 는 화면에서
 * 겹쳐 읽히므로 금액을 미정으로 남기고 화면이 그 사실을 적는다.
 */

export type ScopeCategoryView = ScopeFeeLine & {
  label: string;
  /** 고른 플래너 이름. **못 읽으면 null 이며 지어내지 않는다.** */
  plannerHeadline: string | null;
  /** 이 카테고리를 언제부터 맡겼는가. 안 골랐으면 null. */
  selectedAt: string | null;
};

/** 지금 카테고리를 맡길 수 있는 플래너 — **활성 위임이 있는 사람만**이다. */
export type DelegatedPlanner = { plannerId: string; headline: string | null };

export type ScopePayload = {
  categories: ScopeCategoryView[];
  /** 선택된 카테고리의 수수료 합계. 한 줄이라도 미정이면 미정이다. */
  feeTotal: Amount;
  delegated: DelegatedPlanner[];
  /** 커플 구성원 누구나 고른다(0036). 화면이 버튼을 열지 말지 판단하는 데 쓴다. */
  canSelect: boolean;
  /**
   * **집행 지점.** 이 선택을 실제로 읽는 코드가 어디인가 — 계약 발행이다.
   * 본문에 실어 두어 API 를 쓰는 쪽도 "화면 표시일 뿐" 이라고 읽지 않게 한다(함정 3).
   */
  enforcedAt: "contract_issue";
  /**
   * 열람 위임과 **연동하지 않는다**(D-43). 여기서 빼도 위임은 그대로다.
   */
  delegationAxisLinked: false;
};

type ScopeRecord = {
  id: string;
  category: string;
  planner_id: string;
  status: string;
  selected_at: string;
  released_at: string | null;
};

/** 지금 활성인 위임의 플래너들. 만료·대기·거절은 빠진다(순수 함수가 판정한다). */
async function delegatedPlanners(
  client: Awaited<ReturnType<typeof createClient>>,
  coupleId: string,
  now: Date,
): Promise<DelegatedPlanner[]> {
  const { data } = await client
    .from("planner_engagements")
    .select("planner_id, status, valid_from, valid_to")
    .eq("couple_id", coupleId);

  const rows = (data ?? []) as {
    planner_id: string;
    status: string;
    valid_from: string | null;
    valid_to: string | null;
  }[];

  const ids = [
    ...new Set(
      rows
        .filter(
          (row) =>
            engagementPhase(
              { status: row.status, validFrom: row.valid_from, validTo: row.valid_to },
              now,
            ) === "effective",
        )
        .map((row) => row.planner_id),
    ),
  ];

  if (ids.length === 0) return [];

  const { data: plannerRows } = await client
    .from("planners")
    .select("id, profile_json")
    .in("id", ids);

  const headlines = new Map<string, string>();
  for (const row of (plannerRows ?? []) as {
    id: string;
    profile_json: { headline?: string } | null;
  }[]) {
    const headline = row.profile_json?.headline;
    if (typeof headline === "string" && headline.length > 0) headlines.set(row.id, headline);
  }

  return ids.map((plannerId) => ({ plannerId, headline: headlines.get(plannerId) ?? null }));
}

/** 담긴 항목을 카테고리로 묶는다. **활성 장바구니만** 센다(0027 과 같은 기준). */
async function cartLinesByCategory(
  client: Awaited<ReturnType<typeof createClient>>,
  coupleId: string,
): Promise<Map<string, { itemCount: number; salePriceTotal: number }>> {
  const lines = new Map<string, { itemCount: number; salePriceTotal: number }>();

  const { data: cartRows } = await client
    .from("carts")
    .select("id")
    .eq("couple_id", coupleId)
    .eq("status", "active");

  const cartIds = ((cartRows ?? []) as { id: string }[]).map((row) => row.id);
  if (cartIds.length === 0) return lines;

  const { data: itemRows } = await client
    .from("cart_items")
    .select("id, product_id")
    .in("cart_id", cartIds);

  const productIds = [
    ...new Set(((itemRows ?? []) as { product_id: string }[]).map((row) => row.product_id)),
  ];
  if (productIds.length === 0) return lines;

  // **상품은 공개 조건으로 읽는다** — 내려간 상품이 합계에 남으면 살 수 없는 것을
  // 살 수 있는 것처럼 센다(장바구니가 세운 같은 규칙).
  const { data: productRows } = await client
    .from("products")
    .select("id, category, base_price_total")
    .in("id", productIds);

  const products = new Map(
    ((productRows ?? []) as { id: string; category: string; base_price_total: number }[]).map(
      (row) => [row.id, row],
    ),
  );

  for (const item of (itemRows ?? []) as { product_id: string }[]) {
    const product = products.get(item.product_id);
    if (!product) continue;

    const current = lines.get(product.category) ?? { itemCount: 0, salePriceTotal: 0 };

    lines.set(product.category, {
      itemCount: current.itemCount + 1,
      salePriceTotal: current.salePriceTotal + product.base_price_total,
    });
  }

  return lines;
}

export async function loadScopePayload(input: {
  coupleId: string;
  now: Date;
}): Promise<ScopePayload> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("planner_scopes")
    .select("id, category, planner_id, status, selected_at, released_at")
    .eq("couple_id", input.coupleId)
    .eq("status", "selected");

  if (error) throw new Error("SCOPE_LOAD_FAILED");

  const selected = new Map<string, ScopeRecord>();
  for (const row of (data ?? []) as unknown as ScopeRecord[]) selected.set(row.category, row);

  const [delegated, cartLines, rates] = await Promise.all([
    delegatedPlanners(supabase, input.coupleId, input.now),
    cartLinesByCategory(supabase, input.coupleId),
    loadPlannerRateRecords(),
  ]);

  const headlineOf = new Map(delegated.map((item) => [item.plannerId, item.headline]));
  const at = input.now.toISOString();

  const categories: ScopeCategoryView[] = PLANNER_CATEGORIES.map((category) => {
    const row = selected.get(category) ?? null;
    const cart = cartLines.get(category) ?? { itemCount: 0, salePriceTotal: 0 };
    const plannerId = row?.planner_id ?? null;

    const line = scopeFeeLine({
      category,
      selected: row !== null,
      plannerId,
      itemCount: cart.itemCount,
      salePriceTotal: cart.salePriceTotal,
      // **누구를 골랐는가가 판정에 들어간다**(§3.8 — 좁은 범위가 이긴다).
      rateBp: resolvePlannerRateBp({ records: rates, category, plannerId, at }),
    });

    return {
      ...line,
      label: PLANNER_CATEGORY_LABEL[category],
      plannerHeadline: plannerId === null ? null : (headlineOf.get(plannerId) ?? null),
      selectedAt: row?.selected_at ?? null,
    };
  });

  return {
    categories,
    feeTotal: scopeFeeTotal(categories),
    delegated,
    canSelect: delegated.length > 0,
    enforcedAt: "contract_issue",
    delegationAxisLinked: false,
  };
}

// =============================================================================
// 변경 — 해제는 상태 변경, 선택은 새 행 (D-23)
// =============================================================================

export type ScopeWriteResult =
  | { ok: true; selected: number; released: number }
  | {
      ok: false;
      status: number;
      code: string;
      message: string;
      errors?: ScopeChangeError[];
    };

export function scopeMessages(errors: readonly ScopeChangeError[]) {
  return errors.map((code) => ({ code, message: SCOPE_CHANGE_MESSAGE[code] }));
}

/**
 * 원하는 상태로 맞춘다.
 *
 * **`coupleId` 를 입력으로 받지 않는다** — 세션이 정한다(FIX-45 와 같은 자리: 이
 * 선택은 **그 커플이 낼 수수료**를 정한다).
 *
 * **전부 지우고 다시 넣지 않는다.** 바뀐 것만 움직인다 — 안 바뀐 행을 해제했다가
 * 다시 선택하면 "그 사이에는 안 썼다" 는 거짓 구간이 이력에 남는다(D-23).
 */
export async function updateScopes(input: {
  coupleId: string;
  desired: readonly ScopeSelection[];
  actorId: string;
  actorRole: string | null;
  now: Date;
}): Promise<ScopeWriteResult> {
  const supabase = await createClient();

  const delegated = await delegatedPlanners(supabase, input.coupleId, input.now);
  const validation = validateScopeSelection(
    input.desired,
    delegated.map((item) => item.plannerId),
  );

  if (!validation.ok) {
    return {
      ok: false,
      status: 422,
      code: "SCOPE_SELECTION_INVALID",
      message: "카테고리 선택을 저장할 수 없습니다.",
      errors: validation.errors,
    };
  }

  const admin = createAdminClient();

  const { data: currentRows } = await admin
    .from("planner_scopes")
    .select("id, category, planner_id, status, selected_at, released_at")
    .eq("couple_id", input.coupleId)
    .eq("status", "selected");

  const records = (currentRows ?? []) as unknown as ScopeRecord[];
  const current: ScopeRow[] = records.map((row) => ({
    category: row.category,
    plannerId: row.planner_id,
    status: "selected",
    selectedAt: row.selected_at,
    releasedAt: row.released_at,
  }));

  const diff = diffScopes(current, input.desired);

  // **해제가 먼저다.** 같은 카테고리에 동시에 선택된 것은 하나이므로(0036 부분 유니크)
  // 플래너를 바꿀 때 새 행을 먼저 넣으면 유니크에 걸린다.
  for (const item of diff.release) {
    const row = records.find((record) => record.category === item.category);
    if (!row) continue;

    const { error } = await admin
      .from("planner_scopes")
      // **시각은 트리거가 적는다**(0070). 여기서 넣으면 지어낸 시각이 된다.
      .update({ status: "released" })
      .eq("id", row.id);

    if (error) {
      return {
        ok: false,
        status: 500,
        code: "SCOPE_RELEASE_FAILED",
        message: "카테고리를 해제하지 못했습니다.",
      };
    }

    await recordEvent({
      entityType: "planner_scope",
      entityId: row.id,
      eventType: "planner_scope_released",
      actor: { id: input.actorId, role: input.actorRole },
      beforeState: "selected",
      afterState: "released",
      // **금액을 담지 않는다**(§7.3) — 계약이 갖는다.
      memo: `category=${item.category}`,
    });
  }

  for (const item of diff.select) {
    const { data: created, error } = await admin
      .from("planner_scopes")
      .insert({
        couple_id: input.coupleId,
        planner_id: item.plannerId,
        category: item.category,
        // **`selected_by` 를 트리거가 아니라 여기서 넘긴다** — 서비스롤 세션에는
        // `auth.uid()` 가 없기 때문이다. 로그인 세션이 표를 직접 두드리면 트리거가
        // `auth.uid()` 를 우선하므로 위조할 수 없다(0070).
        selected_by: input.actorId,
      })
      .select("id")
      .maybeSingle();

    if (error || !created) {
      // 활성 위임이 없으면 트리거가 막는다 — 화면이 왜 막혔는지 말할 수 있게 가른다.
      const noEngagement = (error?.message ?? "").includes("위임이 활성");

      return {
        ok: false,
        status: noEngagement ? 422 : 500,
        code: noEngagement ? "SCOPE_NO_ENGAGEMENT" : "SCOPE_SELECT_FAILED",
        message: noEngagement
          ? "위임이 활성 상태인 플래너만 카테고리에 지정할 수 있어요."
          : "카테고리를 선택하지 못했습니다.",
        ...(noEngagement ? { errors: ["planner_not_delegated" as ScopeChangeError] } : {}),
      };
    }

    await recordEvent({
      entityType: "planner_scope",
      entityId: (created as { id: string }).id,
      eventType: "planner_scope_selected",
      actor: { id: input.actorId, role: input.actorRole },
      beforeState: null,
      afterState: "selected",
      memo: `category=${item.category}`,
    });
  }

  return { ok: true, selected: diff.select.length, released: diff.release.length };
}

export type { PlannerCategory };
