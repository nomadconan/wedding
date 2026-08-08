// 주문 합계 입출력 스키마 (S5-02 · 명세서 §6 공통 UI 규칙, D-16 · D-17)
//
// 화면(`components/domain/PriceDisplay`)이 그대로 받을 수 있는 형태로 맞춰 둔다.
// 값의 의미는 도메인이 정하고 문자열 표기는 화면이 정한다 — 여기에 '미정' 같은
// 표시 문구를 넣지 않는다.

import { z } from "zod";

import { AMOUNT_UNKNOWN } from "../pricing/amount";
import { BasisPointSchema, MoneySchema } from "./rates";

/** 금액 값. 확정 정수이거나 명시적 미정이다. */
export const AmountValueSchema = z.union([MoneySchema, z.literal(AMOUNT_UNKNOWN)]);

/**
 * 추가금 상태.
 *
 * "없다"(none)와 "업체가 등록하지 않았다"(unknown)는 전혀 다른 정보다.
 * 후자를 0원으로 접으면 총액이 실제보다 작게 보인다.
 */
export const OrderAddOnsSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  /** 필수 추가금이 이미 판매가에 반영돼 있다. 총액에 다시 더하지 않는다. */
  z.object({ kind: z.literal("included") }),
  z.object({
    kind: z.literal("listed"),
    count: z.number().int().min(0),
    /** 사전 등록 추가금의 상한 합계. 없으면 금액 미정이다. */
    total: MoneySchema.optional(),
  }),
  z.object({ kind: z.literal("unknown") }),
]);

export type OrderAddOns = z.infer<typeof OrderAddOnsSchema>;

/** 플래너 수수료 상태. 미선택도 값의 하나이며 화면에서 행이 사라지지 않는다(D-17). */
export const OrderPlannerFeeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("not_selected") }),
  z.object({
    kind: z.literal("selected"),
    amount: AmountValueSchema,
    /** 합계에서 플래너를 붙인 카테고리 수. 단품에서는 넣지 않는다. */
    categoryCount: z.number().int().min(0).optional(),
  }),
  z.object({ kind: z.literal("unavailable") }),
]);

export type OrderPlannerFee = z.infer<typeof OrderPlannerFeeSchema>;

/** 주문 한 줄의 입력. */
export const OrderLineInputSchema = z.object({
  /** 장바구니 항목 id 등 호출자가 붙이는 식별자. 계산에는 쓰지 않는다. */
  lineId: z.string().min(1).optional(),
  /** 카테고리 코드. 플래너 부분 선택 단위다(F-C-31). */
  category: z.string().min(1).optional(),
  /** 업체가 등록한 판매가. 그대로 고객 노출가다(D-16). */
  salePrice: MoneySchema,
  addOns: OrderAddOnsSchema,
  /** 이 항목에 플래너를 쓸 것인가(cart_items.planner_selected). */
  plannerSelected: z.boolean(),
  /** 이 항목이 플래너 선택 대상인가. 기본 true. */
  plannerAvailable: z.boolean().optional(),
  /** 해석된 업체 수수료 요율. 고객 총액이 아니라 정산에 쓴다. */
  feeRateBp: BasisPointSchema,
  /** 해석된 플래너 요율. 아직 해석되지 않았으면 null — 그때 수수료는 미정이다. */
  plannerFeeRateBp: BasisPointSchema.nullable().optional(),
});

export type OrderLineInput = z.infer<typeof OrderLineInputSchema>;
