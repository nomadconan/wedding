import type { EvaluablePriceRule } from "@/lib/core/pricing/dynamic";
import type { PriceRuleCondition, PriceRuleType } from "@/lib/core/schemas/price-rule";

/**
 * 프라이싱 룰 공통 조각 (S2-06)
 *
 * `route.ts` 는 HTTP 메서드 외의 export 를 허용하지 않으므로 공유물을 여기에 둔다.
 */
export const PRICE_RULE_COLUMNS =
  "id, vendor_id, product_id, rule_type, condition_json, adjust_type, adjust_value, floor_price, cap_price, priority, is_active, created_at, updated_at";

export type PriceRuleRow = {
  id: string;
  vendor_id: string;
  product_id: string | null;
  rule_type: PriceRuleType;
  condition_json: Record<string, unknown>;
  adjust_type: string;
  adjust_value: number | string;
  floor_price: number | null;
  cap_price: number | null;
  priority: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

/**
 * DB 행을 평가 가능한 룰로 옮긴다.
 *
 * `adjust_value` 는 numeric 이라 드라이버가 **문자열로** 돌려줄 수 있다.
 * 여기서 정수로 확정한다 — 엔진은 정수만 다룬다(DB CHECK 가 정수를 보장한다).
 */
export function toEvaluableRule(row: PriceRuleRow): EvaluablePriceRule {
  return {
    id: row.id,
    ruleType: row.rule_type,
    condition: { ruleType: row.rule_type, ...row.condition_json } as PriceRuleCondition,
    adjustType: row.adjust_type as EvaluablePriceRule["adjustType"],
    adjustValue: Math.trunc(Number(row.adjust_value)),
    floorPrice: row.floor_price,
    capPrice: row.cap_price,
    priority: row.priority,
    isActive: row.is_active,
    createdAt: row.created_at,
    productId: row.product_id,
  };
}

/** 조건에서 판별자를 뺀 나머지만 `condition_json` 에 넣는다. 룰 종류는 컬럼이 갖는다. */
export function toConditionJson(condition: PriceRuleCondition): Record<string, unknown> {
  const { ruleType: _ruleType, ...rest } = condition;

  return rest;
}
