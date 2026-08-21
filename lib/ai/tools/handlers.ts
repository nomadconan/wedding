import {
  emptyResult,
  okResult,
  unavailableResult,
  type ToolResult,
} from "@/lib/core/ai/empty";
import { buildCartCompare } from "@/lib/cart/compare";
import { loadCarts } from "@/lib/cart/loader";
import { couponEligibility, type CouponIssueStatus } from "@/lib/core/coupon/coupon";
import { calculatePenalty, daysUntilEvent } from "@/lib/core/pricing/penalty";
import { PRICE_INDEX_MIN_SAMPLE } from "@/lib/core/pricing/price-index";
import { calculatePlannerFee } from "@/lib/core/pricing/rates";
import {
  dueAtOf,
  resolveSplitPlans,
  splitAmount,
  type DueContext,
} from "@/lib/core/payment/payment";
import { MARKET_SORT_LABEL } from "@/lib/core/planner/profile";
import { dDayState } from "@/lib/core/schemas/home";
import { availabilityOf } from "@/lib/core/schemas/explore";
import {
  isOnboardingComplete,
  type OnboardingQuestion,
} from "@/lib/core/schemas/onboarding";
import type { PenaltyInput } from "@/lib/core/schemas/penalty";
import { priceProductsForDate } from "@/lib/explore/customer-price";
import { loadMarket } from "@/lib/planners/loader";
import { findPriceIndex } from "@/lib/pricing/price-index-query";
import { loadPenaltyRuleSet } from "@/lib/pricing/penalty-rule-set";
import { WAITING_NOTE } from "@/lib/core/schedule/graph";
import { dependencyLevels } from "@/lib/core/schedule/view";
import { bodyToParams, conditionSearch, toSearchInput } from "@/lib/search/query";
import { loadChecklist } from "@/lib/tasks/loader";

import type { ToolContext } from "./context";
import { paymentSplitSetting, plannerRateBpFor } from "./reference";

/**
 * 툴 핸들러 (S7-20 · 명세서 §5.6)
 *
 * **툴은 이미 있는 것을 부른다.** 새 계산도, 새 조회 경로도 만들지 않는다 — 툴이
 * 자기 계산을 갖는 순간 화면이 보여 준 값과 대화가 말하는 값이 갈리고, 그 차이는
 * 사용자가 재현할 수 없다. `search_vendors` 가 `conditionSearch` 를 그대로 부르는 것이
 * 그 원칙의 가장 눈에 띄는 자리다(§5.5 — 파서를 두 벌 두지 않는다).
 *
 * **커플 데이터는 세션 클라이언트로 읽는다.** 이 파일은 서비스롤 클라이언트를
 * import 하지 않으며 `boundary.test.ts` 가 그 사실을 지킨다. 요율·운영 파라미터처럼
 * 커플과 무관한 참조 데이터만 `reference.ts` 를 통해 온다.
 *
 * **돌려주는 것은 모델이 말해도 되는 것 전부다.** 후처리(`postcheck`)가 응답의 수치·
 * 이름을 이 결과와 대조하므로, 여기서 빠뜨린 값은 모델이 말할 수 없다. 반대로 여기에
 * 넣은 값은 말할 수 있다 — 그래서 **원문·연락처·내부 식별자를 넣지 않는다**(§5.3).
 */

export type ToolHandler = (
  args: Record<string, unknown>,
  ctx: ToolContext,
) => Promise<{ result: ToolResult; count?: number; rankingBasis?: { code: string; label: string }[] }>;

/** 커플 구성원 id. 장바구니 작성자 표기에 필요하다 — 세션으로 읽는다(RLS 가 경계다). */
async function memberIdsOf(ctx: ToolContext, coupleId: string): Promise<string[]> {
  const { data } = await ctx.supabase
    .from("couple_members")
    .select("user_id")
    .eq("couple_id", coupleId)
    .in("member_role", ["owner", "partner"]);

  return ((data ?? []) as { user_id: string }[]).map((row) => row.user_id);
}

// =============================================================================
// 커플 맥락
// =============================================================================

const getCoupleContext: ToolHandler = async (_args, ctx) => {
  if (ctx.coupleId === null) return { result: unavailableResult("no_couple") };

  const { data: couple } = await ctx.supabase
    .from("couples")
    .select("wedding_date, region_code, total_budget, guest_count")
    .eq("id", ctx.coupleId)
    .maybeSingle();

  if (!couple) return { result: unavailableResult("no_couple") };

  const row = couple as {
    wedding_date: string | null;
    region_code: string | null;
    total_budget: number | null;
    guest_count: number | null;
  };

  const { data: answers } = await ctx.supabase
    .from("onboarding_answers")
    .select("question_key")
    .eq("couple_id", ctx.coupleId);

  const memberIds = await memberIdsOf(ctx, ctx.coupleId);

  return {
    result: okResult({
      asOf: ctx.asOf,
      weddingDate: row.wedding_date,
      // **예식일 미정은 0일이 아니다.** 상태로 돌려주고 모델이 그 상태를 말한다.
      dDay: dDayState(ctx.asOf, row.wedding_date),
      regionCode: row.region_code,
      guestCount: row.guest_count,
      totalBudget: row.total_budget,
      budgetDecided: row.total_budget !== null,
      onboardingComplete: isOnboardingComplete(
        ((answers ?? []) as { question_key: string }[]).map(
          (item) => item.question_key as OnboardingQuestion,
        ),
      ),
      partnerLinked: memberIds.length >= 2,
    }),
  };
};

// =============================================================================
// 참가격 — 표본이 부족하면 분포를 내지 않는다
// =============================================================================

const searchPriceIndex: ToolHandler = async (args, ctx) => {
  const region = String(args.region);
  const category = String(args.category);

  const row = await findPriceIndex(ctx.publicClient, { regionCode: region, category });

  if (row === null) return { result: emptyResult("no_sample", { region, category }) };

  if (row.sampleSize < PRICE_INDEX_MIN_SAMPLE) {
    return {
      result: emptyResult("not_enough_sample", {
        region,
        category,
        sampleSize: row.sampleSize,
        minSample: PRICE_INDEX_MIN_SAMPLE,
      }),
    };
  }

  return {
    result: okResult({
      region,
      category,
      p25: row.p25,
      p50: row.p50,
      p75: row.p75,
      sampleSize: row.sampleSize,
      // 출처를 모르면 라벨을 만들지 않는다 — 지수의 신뢰 근거가 출처다(S3-08).
      source: row.sourceLabel,
      collectedAt: row.collectedAt,
    }),
    count: row.sampleSize,
  };
};

// =============================================================================
// 업체 조회 — 조건 검색과 **같은 함수**를 부른다 (§5.5)
// =============================================================================

const searchVendors: ToolHandler = async (args, ctx) => {
  const params = bodyToParams({ ...args, asOf: ctx.asOf });
  const input = toSearchInput(params);

  if (!input.ok) {
    return { result: emptyResult("no_match", { reason: "invalid_condition" }) };
  }

  const outcome = await conditionSearch(ctx.publicClient, input.input);

  if (!outcome.ok) return { result: emptyResult("no_match", { reason: "query_failed" }) };

  const { result } = outcome;
  const basis = [{ code: result.ranking.code, label: rankingLabel(result.ranking.code) }];

  const rows = result.rows.slice(0, 5).map((row) => ({
    vendorId: row.vendorId,
    vendorName: row.vendorName,
    productName: row.productName,
    basePrice: row.basePrice,
    regionCode: row.regionCode,
    availability: row.availability.kind,
    fitScore: row.fit === null ? null : { score: row.fit.score, max: row.fit.max },
  }));

  if (rows.length === 0) {
    return {
      // **어느 조건을 풀면 몇 건인지**를 함께 준다(§5.6 no_match).
      result: emptyResult("no_match", {
        conditions: result.conditions.map((condition) => condition.field),
        relaxationHints: result.relaxationHints,
      }),
      rankingBasis: basis,
    };
  }

  return {
    result: okResult({
      asOf: result.asOf,
      conditions: result.conditions.map((condition) => ({
        field: condition.field,
        value: condition.value,
      })),
      // **기준 코드 없는 결과를 돌려주지 않는다**(§5.5 4단계 · D-03).
      ranking: { code: result.ranking.code, weights: result.ranking.rules },
      total: result.total,
      rows,
    }),
    count: result.total,
    rankingBasis: basis,
  };
};

function rankingLabel(code: string): string {
  return code === "condition_fit" ? "조건 부합도" : "가격 낮은 순";
}

// =============================================================================
// 그날 자리와 가격
// =============================================================================

const getVendorAvailability: ToolHandler = async (args, ctx) => {
  const vendorId = String(args.vendorId);
  const date = String(args.date);

  const { data: vendor } = await ctx.publicClient
    .from("vendors")
    .select("id, name")
    .eq("id", vendorId)
    .eq("status", "active")
    .maybeSingle();

  // 승인되지 않은 업체는 **존재 여부도 알리지 않는다**(라우트와 같은 판단).
  if (!vendor) return { result: emptyResult("no_match", { reason: "vendor_not_found" }) };

  const { data: slotRows } = await ctx.publicClient
    .from("inventory_slots")
    .select("slot_time, product_id, capacity, remaining, status")
    .eq("vendor_id", vendorId)
    .eq("slot_date", date);

  const slots = ((slotRows ?? []) as {
    slot_time: string | null;
    product_id: string | null;
    capacity: number;
    remaining: number;
    status: string;
  }[]).map((slot) => ({ ...slot }));

  const { data: productRows } = await ctx.publicClient
    .from("products")
    .select("id, name, base_price_total")
    .eq("vendor_id", vendorId)
    .eq("status", "published")
    .not("add_ons_declared_at", "is", null);

  const products = ((productRows ?? []) as {
    id: string;
    name: string;
    base_price_total: number;
  }[]).map((product) => ({ ...product }));

  if (products.length === 0) {
    return { result: emptyResult("no_match", { reason: "no_published_product" }) };
  }

  const slotsOf = (productId: string) =>
    slots.filter((slot) => slot.product_id === productId || slot.product_id === null);

  const priced = await Promise.all(
    products.map(async (product) => {
      const single = await priceProductsForDate(
        vendorId,
        [{ productId: product.id, basePrice: product.base_price_total }],
        date,
        ctx.asOf,
        slotsOf(product.id),
      );

      return { product, price: single.get(product.id) ?? null };
    }),
  );

  return {
    result: okResult({
      vendorName: (vendor as { name: string }).name,
      date,
      asOf: ctx.asOf,
      availability: availabilityOf(slots).kind,
      products: priced.map(({ product, price }) => ({
        productName: product.name,
        availability: availabilityOf(slotsOf(product.id)).kind,
        basePrice: price?.basePrice ?? product.base_price_total,
        finalPrice: price?.finalPrice ?? null,
        // 금액을 바꾼 **이유만** 밝힌다. 룰 내용은 내보내지 않는다(S2-06).
        reasons: (price?.reasons ?? []).map((reason) => reason.label),
      })),
    }),
    count: products.length,
  };
};

// =============================================================================
// 장바구니
// =============================================================================

async function cartsViewOf(ctx: ToolContext, coupleId: string) {
  return loadCarts(ctx.supabase, ctx.publicClient, {
    coupleId,
    viewerId: ctx.userId,
    memberIds: await memberIdsOf(ctx, coupleId),
  });
}

const getCartSummary: ToolHandler = async (_args, ctx) => {
  if (ctx.coupleId === null) return { result: unavailableResult("no_couple") };

  const view = await cartsViewOf(ctx, ctx.coupleId);

  if (view.carts.length === 0) {
    return { result: emptyResult("no_match", { reason: "cart_empty" }) };
  }

  return {
    result: okResult({
      budgetTotal: view.budgetTotal,
      carts: view.carts.map((cart) => ({
        label: cart.label,
        itemCount: cart.items.length,
        // 합계는 **툴이 계산한다.** 모델이 더하지 않는다(§5.6).
        total: cart.total?.total ?? null,
        excludedCount: cart.excludedCount,
        budget: cart.budget,
        missingCategories: cart.fill?.missing ?? [],
        coverageJudged: cart.fill !== null,
      })),
    }),
    count: view.carts.length,
  };
};

const compareCarts: ToolHandler = async (_args, ctx) => {
  if (ctx.coupleId === null) return { result: unavailableResult("no_couple") };

  const view = await cartsViewOf(ctx, ctx.coupleId);

  if (view.carts.length < 2) {
    return { result: emptyResult("no_match", { reason: "needs_two_carts" }) };
  }

  const compare = buildCartCompare(view, { basis: "as_selected", selected: [] });

  return {
    result: okResult({
      basis: compare.basis,
      budgetTotal: compare.budgetTotal,
      columns: compare.columns.map((column) => ({
        label: column.label,
        total: column.total,
        itemCount: column.itemCount,
        missing: column.missing,
      })),
      // **카테고리 구성이 다르면 최저 총액을 정하지 않는다**(IDEA-01). 사유를 그대로 준다.
      lowest: compare.lowest,
      coverageJudged: compare.coverageJudged,
    }),
    count: compare.columns.length,
  };
};

// =============================================================================
// 위약금 — 결정적 계산, LLM 미사용
// =============================================================================

const simulatePenalty: ToolHandler = async (args) => {
  const input = args as unknown as PenaltyInput;
  const { ruleSet, source } = await loadPenaltyRuleSet(input.category);

  let result;
  try {
    result = calculatePenalty(input, ruleSet);
  } catch {
    // 룰 세트가 입력을 감당하지 못한다. **부분 결과를 내보내지 않는다.**
    return { result: unavailableResult("rule_missing", "S5-08") };
  }

  return {
    result: okResult({
      daysBeforeEvent: daysUntilEvent(input.cancelDate, input.eventDate),
      band: { code: result.bandCode, label: result.bandLabel },
      standard: result.standard,
      contract: result.contract,
      excessPenalty: result.excessPenalty,
      depositRefundable: result.depositRefundable,
      basisRef: result.basisRef,
      ruleVersion: result.ruleVersion,
      // 경고와 고지를 **결과에 실어** 돌려준다. 모델이 이 문장을 지어내지 않게 한다.
      notes: result.notes,
      disclaimer: result.disclaimer,
      /** 법무 검수 전 가정치인가. 화면·대화가 그 사실을 함께 말한다(§7.7). */
      isDraft: ruleSet.isDraft,
      ruleSource: source,
    }),
  };
};

// =============================================================================
// 분할 회차 미리보기
// =============================================================================

const previewPaymentSchedule: ToolHandler = async (args, ctx) => {
  const totalAmount = Number(args.totalAmount);
  const eventDate = args.eventDate === undefined ? null : String(args.eventDate);

  const resolution = resolveSplitPlans(await paymentSplitSetting());

  // **값이 없으면 회차를 지어내지 않는다**(§7.4 · O-02 계열 원칙).
  if (!resolution.ok) return { result: unavailableResult("setting_missing", "S5-06") };

  const installments = splitAmount(totalAmount, resolution.plans);
  const context: DueContext = { contractIssuedAt: null, eventDate };

  return {
    result: okResult({
      totalAmount,
      asOf: ctx.asOf,
      installments: installments.map((installment, index) => ({
        seq: index + 1,
        amount: installment.amount,
        ratioBp: resolution.plans[index]?.ratioBp ?? null,
        // 기준 사건이 아직 없으면 기한은 null 이다. 없는 날짜를 만들지 않는다.
        dueAt: dueAtOf(resolution.plans[index], context),
      })),
    }),
    count: installments.length,
  };
};

// =============================================================================
// 플래너 요율
// =============================================================================

const explainPlannerFee: ToolHandler = async (args, ctx) => {
  const category = String(args.category);
  const amount = Number(args.amount);

  const rate = await plannerRateBpFor(category, `${ctx.asOf}T00:00:00Z`);

  if (rate === null) return { result: unavailableResult("setting_missing", "S5-03") };

  return {
    result: okResult({
      category,
      amount,
      feeRateBp: rate.rateBp,
      scopeType: rate.scopeType,
      // 선택한 카테고리에만 붙는다(D-17). 계산은 순수 함수가 한다.
      feeAmount: calculatePlannerFee({ salePrice: amount, feeRateBp: rate.rateBp, selected: true }),
      notSelectedFeeAmount: 0,
    }),
  };
};

// =============================================================================
// 플래너 마켓
// =============================================================================

const searchPlanners: ToolHandler = async (args, ctx) => {
  const market = await loadMarket(ctx.supabase as never, {
    category: args.category === undefined ? null : String(args.category),
    region: args.region === undefined ? null : String(args.region),
  });

  const basis = [
    { code: market.sortBasis, label: MARKET_SORT_LABEL[market.sortBasis] },
  ];

  if (market.planners.length === 0) {
    return { result: emptyResult("no_match", { filter: market.filter }), rankingBasis: basis };
  }

  return {
    result: okResult({
      // 정렬 기준 코드를 **항상** 함께 내보낸다(§2.2).
      sortBasis: market.sortBasis,
      planners: market.planners.slice(0, 5).map((planner) => ({
        headline: planner.headline,
        careerYears: planner.careerYears,
        categories: planner.categories,
        regions: planner.regions,
        // **후기는 0이 아니라 "아직 세지 않는다"**(S6-02). 지표를 그대로 옮긴다.
        metrics: planner.metrics,
      })),
    }),
    count: market.planners.length,
    rankingBasis: basis,
  };
};

// =============================================================================
// 쿠폰 — 못 쓰는 사유를 감추지 않는다 (F-C-36)
// =============================================================================

const listCoupons: ToolHandler = async (args, ctx) => {
  const orderAmount = args.orderAmount === undefined ? null : Number(args.orderAmount);

  const { data } = await ctx.supabase
    .from("coupon_issues")
    .select(
      "id, status, expires_at, coupons(name, discount_type, discount_value, max_discount_amount, min_order_amount, status, valid_from, total_quantity, issued_count, issuer_type)",
    );

  const rows = (data ?? []) as unknown as {
    id: string;
    status: CouponIssueStatus;
    expires_at: string | null;
    coupons: {
      name: string;
      discount_type: "amount" | "rate";
      discount_value: number;
      max_discount_amount: number | null;
      min_order_amount: number;
      status: "active" | "paused" | "ended";
      valid_from: string | null;
      total_quantity: number | null;
      issued_count: number;
      issuer_type: "platform" | "vendor";
    } | null;
  }[];

  const usable = rows.filter((row) => row.coupons !== null);

  if (usable.length === 0) return { result: emptyResult("no_match", { reason: "no_coupon" }) };

  const now = new Date(`${ctx.asOf}T00:00:00Z`);

  const coupons = usable.map((row) => {
    const definition = row.coupons as NonNullable<(typeof usable)[number]["coupons"]>;

    const eligibility = couponEligibility({
      coupon: {
        discountType: definition.discount_type,
        discountValue: definition.discount_value,
        maxDiscountAmount: definition.max_discount_amount,
        minOrderAmount: definition.min_order_amount,
        status: definition.status,
        validFrom: definition.valid_from,
        totalQuantity: definition.total_quantity,
        issuedCount: definition.issued_count,
      },
      issue: { status: row.status, expiresAt: row.expires_at },
      orderAmount: orderAmount ?? 0,
      now,
    });

    return {
      name: definition.name,
      discountType: definition.discount_type,
      discountValue: definition.discount_value,
      minOrderAmount: definition.min_order_amount,
      expiresAt: row.expires_at,
      usable: eligibility.ok,
      // **못 쓰는 사유를 함께 준다.** 감추면 고객은 "쿠폰이 없다" 고 이해한다.
      blockReason: eligibility.ok ? null : eligibility.reason,
      blockDetail: eligibility.ok ? null : eligibility.detail,
      discountAmount: eligibility.ok ? eligibility.discountAmount : null,
    };
  });

  return { result: okResult({ orderAmount, coupons }), count: coupons.length };
};

// =============================================================================
// 등록표
// =============================================================================

// =============================================================================
// 준비 순서 (S7-19 · F-C-37)
// =============================================================================

/**
 * **화면과 같은 조회를 부른다** — `loadChecklist` 하나다(`GET /api/tasks/graph` 도
 * 같은 함수를 부른다). 툴이 자기 조회를 가지면 대화가 말하는 순서와 화면이 그리는
 * 순서가 갈리고, 그 차이는 사용자가 재현할 수 없다(§5.6 · `search_vendors` 와 같은 규칙).
 *
 * **모델에게 주는 것은 제목·카테고리·기한·판정뿐이다.** 태스크 id·간선 id 를 넣지
 * 않는다 — 후처리가 대조할 값이 아니고 모델이 말할 이유도 없다(§5.3). 대신
 * `blockedByTitles` 로 **무엇을 먼저 해야 하는지**를 이름으로 준다: "이걸 먼저 해야
 * 저게 됩니다" 가 이 툴이 답해야 하는 문장이다(§2.1 F-C-37).
 *
 * **모델이 세지 않는다** — 남은 건수·단계 수는 여기서 계산해 넘긴다(§5.6 "AI 는
 * 산술을 하지 않는다").
 */
const getTaskGraph: ToolHandler = async (_args, ctx) => {
  if (ctx.coupleId === null) return { result: unavailableResult("no_couple") };

  const view = await loadChecklist(ctx.supabase, { coupleId: ctx.coupleId, today: ctx.asOf });

  if (view.tasks.length === 0) {
    // **아직 만들지 않은 것**이지 순서가 없는 것이 아니다 — 자동 생성은 사용자가 누른다(D-73).
    return { result: emptyResult("no_match", { reason: "no_tasks_yet" }) };
  }

  const titleById = new Map(view.tasks.map((task) => [task.id, task.title]));
  const layout = dependencyLevels(view.tasks, view.edges);

  const describe = (task: (typeof view.tasks)[number]) => ({
    title: task.title,
    category: task.category,
    dueDate: task.dueDate,
    readiness: task.readiness,
    blockedByTitles: task.blockedBy.map((id) => titleById.get(id) ?? "목록에 없는 일"),
  });

  return {
    result: okResult({
      asOf: ctx.asOf,
      // 세는 일은 툴이 한다. 모델은 이 값을 옮겨 적을 뿐이다.
      total: view.tasks.length,
      readyCount: view.tasks.filter((task) => task.readiness === "ready").length,
      waitingCount: view.tasks.filter((task) => task.readiness === "waiting").length,
      doneCount: view.tasks.filter((task) => task.readiness === "done").length,
      next: view.next.map(describe),
      // 단계는 **위상 순서 그대로**다. 화면(D 의존 관계 뷰)과 같은 계산을 쓴다.
      levels: layout.levels.map((level) => ({
        depth: level.depth,
        tasks: level.tasks.map(describe),
      })),
      // **순환을 숨기지 않는다.** 단계를 정할 수 없었다는 사실을 그대로 넘긴다.
      unorderedCount: layout.cycle.length,
      progress: view.progress,
      // `waiting` 을 '못 한다' 로 말하지 않게 문구를 함께 넘긴다(§3.2 · D-71).
      waitingNote: WAITING_NOTE,
    }),
    count: view.tasks.length,
  };
};

export const TOOL_HANDLERS: Record<string, ToolHandler> = {
  get_couple_context: getCoupleContext,
  search_price_index: searchPriceIndex,
  search_vendors: searchVendors,
  get_vendor_availability: getVendorAvailability,
  get_cart_summary: getCartSummary,
  compare_carts: compareCarts,
  simulate_penalty: simulatePenalty,
  preview_payment_schedule: previewPaymentSchedule,
  explain_planner_fee: explainPlannerFee,
  search_planners: searchPlanners,
  list_coupons: listCoupons,
  get_task_graph: getTaskGraph,
};

export function hasToolHandler(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(TOOL_HANDLERS, name);
}
