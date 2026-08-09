import { evaluatePriceRules } from "@/lib/core/pricing/dynamic";
import {
  availabilityOf,
  discountRateBp,
  leadTimeDays,
  occupancyRatioBp,
  type AvailabilityState,
} from "@/lib/core/schemas/explore";
import { createAdminClient } from "@/lib/supabase/admin";
import { PRICE_RULE_COLUMNS, toEvaluableRule, type PriceRuleRow } from "@/lib/vendor/price-rules";

/**
 * 고객이 보는 조건부 가격 (S3-03 · F-C-12)
 *
 * **왜 서비스롤로 룰을 읽는가.**
 * `price_rules` 는 RLS 상 업체 멤버 전용이다(§3.9). 그럴 만한 이유가 있다 — 룰에는
 * `floor_price`(그 업체가 받아들일 수 있는 최저가)가 들어 있고, 그건 고객이 알 일이
 * 아니라 **경쟁 업체가 알면 안 되는 값**이다. 그래서 룰 자체를 공개하지 않고,
 * 서버가 계산해 **결과 금액과 사유 라벨만** 내보낸다. F-C-12 가 요구하는 것도
 * "최종가 · 정가 대비 할인율 · 할인 사유 라벨" 까지다.
 *
 * **왜 계산 근거를 함께 돌려주는가.**
 * S2-06 에서 세운 규칙 — 서버가 '오늘'을 마음대로 정하면 같은 요청이 시각에 따라 다른
 * 답을 낸다. 업체 시뮬레이션은 `leadTimeDays` 를 호출자가 넘겨 그 문제를 피했는데,
 * 고객 화면에서는 남은 일수가 고객이 조작할 값이 아니라 **사실**이다. 그래서 서버가
 * 계산하되 `asOf`·`leadTimeDays`·`occupancyRatioBp` 를 **응답에 실어** 재현 가능하게
 * 만든다. 값을 감추지 않는 것이 결정성의 실질이다.
 */
export type CustomerPrice = {
  basePrice: number;
  finalPrice: number;
  /** 정가 대비 할인율(bp). 할증이면 음수다. */
  discountRateBp: number;
  /** 적용된 룰의 표시 라벨. 금액을 바꾼 이유만 밝히고 룰 내용은 내보내지 않는다. */
  reasons: { ruleType: string; label: string; before: number; after: number }[];
  /** 계산에 쓴 사실들. 이게 있어야 고객이 본 금액을 나중에 재현할 수 있다. */
  context: { asOf: string; eventDate: string; leadTimeDays: number; occupancyRatioBp: number | null };
};

const RULE_TYPE_LABEL: Record<string, string> = {
  season: "시즌",
  weekday: "요일",
  leadtime: "예식일까지 남은 기간",
  occupancy: "잔여 자리",
};

export type PricedProduct = {
  productId: string;
  basePrice: number;
};

/**
 * 날짜 조건이 붙은 최종가를 상품별로 계산한다.
 *
 * `asOf` 는 **호출자가 넘긴다.** 라우트가 요청 시각의 날짜를 만들어 넣고 응답에 같이
 * 싣는다 — 이 함수 안에서 `new Date()` 를 부르면 계산과 표기가 갈릴 수 있다.
 */
export async function priceProductsForDate(
  vendorId: string,
  products: PricedProduct[],
  eventDate: string,
  asOf: string,
  slots: { status: string; capacity: number; remaining: number }[],
): Promise<Map<string, CustomerPrice>> {
  const priced = new Map<string, CustomerPrice>();
  if (products.length === 0) return priced;

  const admin = createAdminClient();
  const { data } = await admin
    .from("price_rules")
    .select(PRICE_RULE_COLUMNS)
    .eq("vendor_id", vendorId);

  const rules = ((data ?? []) as PriceRuleRow[]).map(toEvaluableRule);
  const days = leadTimeDays(asOf, eventDate);
  const occupancy = occupancyRatioBp(slots);

  for (const product of products) {
    const evaluation = evaluatePriceRules(product.basePrice, rules, {
      eventDate,
      leadTimeDays: days,
      occupancyRatioBp: occupancy,
      productId: product.productId,
    });

    priced.set(product.productId, {
      basePrice: evaluation.basePrice,
      finalPrice: evaluation.finalPrice,
      discountRateBp: discountRateBp(evaluation.basePrice, evaluation.finalPrice),
      reasons: evaluation.steps
        .filter((step) => step.applied && step.priceAfter !== step.priceBefore)
        .map((step) => ({
          ruleType: step.ruleType,
          label: step.label ?? RULE_TYPE_LABEL[step.ruleType] ?? step.ruleType,
          before: step.priceBefore,
          after: step.priceAfter,
        })),
      context: { asOf, eventDate, leadTimeDays: days, occupancyRatioBp: occupancy },
    });
  }

  return priced;
}

/** 슬롯 목록을 그대로 상태로 옮긴다. 화면과 API 가 같은 판정을 쓰기 위한 얇은 재수출이다. */
export function stateOfSlots(
  slots: { status: string; capacity: number; remaining: number }[],
): AvailabilityState {
  return availabilityOf(slots);
}
