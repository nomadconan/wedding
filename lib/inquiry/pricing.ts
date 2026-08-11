import { evaluatePriceRules, type PriceEvaluation } from "@/lib/core/pricing/dynamic";
import { leadTimeDays, occupancyRatioBp } from "@/lib/core/schemas/explore";
import { createAdminClient } from "@/lib/supabase/admin";
import { PRICE_RULE_COLUMNS, toEvaluableRule, type PriceRuleRow } from "@/lib/vendor/price-rules";

/**
 * 견적 상한 계산 (S4-12 · F-V-07)
 *
 * **업체는 상한을 정하지 않는다.** 상한은 (가) 업체가 등록한 상품 가격과 (나) 업체가
 * 미리 등록한 프라이싱 룰이 정한다. 그래서 이 함수의 입력에 업체가 손으로 넣는 값이
 * 하나도 없다 — 상품 id 와 예식일뿐이다.
 *
 * ── 왜 상한이 필요한가 ──────────────────────────────────────────────────────
 * 고객은 탐색·장바구니에서 **그 날짜 조건의 최종가**를 이미 봤다(S3-03
 * `customer-price.ts` 가 같은 엔진으로 계산한다). 견적이 그보다 비싸면 고객이 본
 * 화면이 거짓이 되고, 그건 가격 정찰제(D-03)의 정면 위반이다. 할증이 필요하면
 * `price_rules` 로 **미리** 등록해야 하고, 그때는 사유 라벨이 고객에게 공개되므로
 * "왜 이 가격인가" 를 고객이 알 수 있다.
 *
 * ── 왜 서비스롤로 룰을 읽는가 ───────────────────────────────────────────────
 * `price_rules` 는 RLS 상 업체 멤버 전용이다. 지금 호출자는 그 업체 멤버라 세션으로도
 * 읽히지만, **고객 화면에서도 같은 상한을 다시 계산해 보여줘야** 하므로(견적을 받은
 * 고객이 "정가 대비 얼마 깎였나" 를 본다) 한 경로로 통일한다. `floor_price` 같은
 * 값은 응답에 싣지 않는다 — 결과 금액과 사유 라벨까지만 나간다(S3-03 과 같은 규칙).
 *
 * ── 재현 가능성 ─────────────────────────────────────────────────────────────
 * `asOf` 를 **호출자가 넘긴다.** 안에서 `new Date()` 를 부르면 같은 요청이 시각에
 * 따라 다른 상한을 내고, 그러면 견적서에 박아 둔 스냅샷과 나중 계산이 어긋난다
 * (S2-06 이 `leadTimeDays` 를 호출자에게 넘긴 것과 같은 규칙).
 */
export type QuoteCap = {
  /** 룰 적용 전 기준가(products.base_price_total). */
  basePrice: number;
  /** 룰 적용 후 상한. 업체는 이 이하로만 제시할 수 있다. */
  capPrice: number;
  /** 계산에 쓴 사실. 견적서에 그대로 박는다. */
  context: {
    asOf: string;
    eventDate: string;
    leadTimeDays: number;
    occupancyRatioBp: number | null;
  };
  /** 적용된 룰 단계. 룰 내용이 아니라 **무엇이 금액을 바꿨는지**만 담는다. */
  steps: {
    ruleId: string;
    ruleType: string;
    label: string;
    before: number;
    after: number;
    reason: string;
  }[];
};

const RULE_TYPE_LABEL: Record<string, string> = {
  season: "시즌",
  weekday: "요일",
  leadtime: "예식일까지 남은 기간",
  occupancy: "잔여 자리",
};

/**
 * 상품 하나의 견적 상한.
 *
 * @param asOf 기준일(YYYY-MM-DD). 라우트가 만들어 넘기고 응답·스냅샷에 같이 싣는다.
 */
export async function quoteCapFor(input: {
  vendorId: string;
  productId: string;
  basePrice: number;
  eventDate: string;
  asOf: string;
}): Promise<QuoteCap> {
  const admin = createAdminClient();

  const { data: ruleRows } = await admin
    .from("price_rules")
    .select(PRICE_RULE_COLUMNS)
    .eq("vendor_id", input.vendorId);

  // 그날의 잔여율. 슬롯이 없으면 null 이고, 그러면 잔여율 룰은 적용되지 않는다
  // (엔진이 그렇게 판정한다 — 없는 정보로 금액을 움직이지 않는다).
  const { data: slotRows } = await admin
    .from("inventory_slots")
    .select("status, capacity, remaining, product_id")
    .eq("vendor_id", input.vendorId)
    .eq("slot_date", input.eventDate);

  const slots = ((slotRows ?? []) as {
    status: string;
    capacity: number;
    remaining: number;
    product_id: string | null;
  }[]).filter((slot) => slot.product_id === null || slot.product_id === input.productId);

  const rules = ((ruleRows ?? []) as PriceRuleRow[]).map(toEvaluableRule);
  const days = leadTimeDays(input.asOf, input.eventDate);
  const occupancy = occupancyRatioBp(slots);

  const evaluation: PriceEvaluation = evaluatePriceRules(input.basePrice, rules, {
    eventDate: input.eventDate,
    leadTimeDays: days,
    occupancyRatioBp: occupancy,
    productId: input.productId,
  });

  return {
    basePrice: evaluation.basePrice,
    capPrice: evaluation.finalPrice,
    context: {
      asOf: input.asOf,
      eventDate: input.eventDate,
      leadTimeDays: days,
      occupancyRatioBp: occupancy,
    },
    steps: evaluation.steps
      .filter((step) => step.applied && step.priceAfter !== step.priceBefore)
      .map((step) => ({
        ruleId: step.ruleId,
        ruleType: step.ruleType,
        label: step.label ?? RULE_TYPE_LABEL[step.ruleType] ?? step.ruleType,
        before: step.priceBefore,
        after: step.priceAfter,
        reason: step.reason,
      })),
  };
}
