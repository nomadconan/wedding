// 주문 합계 계산 (S5-02 · 명세서 §6 공통 UI 규칙, D-16 · D-17)
//
//  * 순수 함수. DB 에 접근하지 않고 해석된 요율을 인자로 받는다.
//  * **업체 수수료는 고객 총액에 더하지 않는다.** 판매가가 그대로 고객 노출가이고
//    수수료는 거기서 차감돼 업체에 정산된다(D-16). 총액에 더하면 이중 청구다.
//  * **플래너 수수료는 선택한 항목에만 가산한다**(D-17).
//  * 어느 값이라도 미정이면 합계도 미정이다. 미정을 0으로 접으면 총액이 실제보다 작게 보인다.

import {
  OrderLineInputSchema,
  type OrderAddOns,
  type OrderLineInput,
  type OrderPlannerFee,
} from "../schemas/order";
import { AMOUNT_UNKNOWN, isUnknownAmount, sumAmounts, type Amount } from "./amount";
import { calculatePlannerFee, calculateSettlement } from "./rates";

export type { OrderAddOns, OrderLineInput, OrderPlannerFee } from "../schemas/order";
export { AMOUNT_UNKNOWN, isUnknownAmount, type Amount } from "./amount";

/** 계산한 주문 한 줄. 화면의 단품 표시(`variant="item"`)에 그대로 대응한다. */
export type OrderLine = {
  lineId?: string;
  category?: string;
  /** 판매가. 내역의 첫 행이다. */
  basePrice: number;
  addOns: OrderAddOns;
  /** 총액에 더해질 추가금. 미등록·상한 미정이면 미정이다. */
  addOnAmount: Amount;
  plannerFee: OrderPlannerFee;
  /** 고객이 낼 금액. 판매가 + 추가금 + 플래너 수수료. */
  total: Amount;
  /** 업체 정산 몫. **고객 화면에 노출하지 않는다.** */
  settlement: { feeRateBp: number; feeAmount: number; netAmount: number };
};

/** 계산한 주문 합계. 화면의 합계 표시(`variant="sum"`)에 그대로 대응한다. */
export type OrderTotal = {
  lines: OrderLine[];
  itemCount: number;
  basePrice: number;
  addOns: OrderAddOns;
  addOnAmount: Amount;
  plannerFee: OrderPlannerFee;
  total: Amount;
  settlement: { feeAmount: number; netAmount: number };
};

/** 입력이 서로 모순될 때 던진다. */
export class OrderInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrderInputError";
  }
}

/**
 * 추가금 상태에서 **총액에 더할 금액**을 뽑는다.
 *
 * `included` 가 0인 이유: 필수 추가금이 이미 판매가에 반영돼 있다는 뜻이라
 * 다시 더하면 이중 계산이 된다.
 */
export function addOnAmountOf(addOns: OrderAddOns): Amount {
  switch (addOns.kind) {
    case "none":
    case "included":
      return 0;

    case "listed":
      return addOns.total === undefined ? AMOUNT_UNKNOWN : addOns.total;

    case "unknown":
      return AMOUNT_UNKNOWN;
  }
}

/** 여러 줄의 추가금 상태를 합계용 하나로 합친다. */
function mergeAddOns(list: readonly OrderAddOns[]): OrderAddOns {
  if (list.some((addOns) => isUnknownAmount(addOnAmountOf(addOns)))) {
    // 한 줄이라도 미정이면 합계 추가금도 미정이다.
    return { kind: "unknown" };
  }

  const listed = list.filter((addOns): addOns is Extract<OrderAddOns, { kind: "listed" }> =>
    addOns.kind === "listed",
  );

  if (listed.length > 0) {
    return {
      kind: "listed",
      count: listed.reduce((sum, addOns) => sum + addOns.count, 0),
      total: listed.reduce((sum, addOns) => sum + (addOns.total ?? 0), 0),
    };
  }

  if (list.some((addOns) => addOns.kind === "included")) return { kind: "included" };

  return { kind: "none" };
}

/** 한 줄의 플래너 수수료 상태를 정한다. 미선택도 값이며 행이 사라지지 않는다. */
function plannerFeeOf(line: OrderLineInput): OrderPlannerFee {
  const available = line.plannerAvailable ?? true;

  if (!available) {
    if (line.plannerSelected) {
      throw new OrderInputError(
        "플래너 선택 대상이 아닌 항목에 plannerSelected=true 가 들어왔습니다. 입력을 확인하세요.",
      );
    }

    return { kind: "unavailable" };
  }

  if (!line.plannerSelected) return { kind: "not_selected" };

  const rateBp = line.plannerFeeRateBp ?? null;

  // 요율이 아직 해석되지 않았다. 임의 기본값을 만들지 않고 미정으로 남긴다.
  if (rateBp === null) return { kind: "selected", amount: AMOUNT_UNKNOWN };

  return {
    kind: "selected",
    amount: calculatePlannerFee({ salePrice: line.salePrice, feeRateBp: rateBp, selected: true }),
  };
}

/** 플래너 수수료 상태에서 총액에 더할 금액을 뽑는다. */
function plannerAmountOf(plannerFee: OrderPlannerFee): Amount {
  return plannerFee.kind === "selected" ? plannerFee.amount : 0;
}

/**
 * 항목별·합계 금액을 계산한다.
 *
 * @param items 장바구니·견적 항목. 각 항목의 요율은 이미 `resolveRate` 로 해석된 값이다.
 */
export function calculateOrderTotal(items: readonly OrderLineInput[]): OrderTotal {
  const parsed = items.map((item) => OrderLineInputSchema.parse(item));

  const lines: OrderLine[] = parsed.map((line) => {
    const addOnAmount = addOnAmountOf(line.addOns);
    const plannerFee = plannerFeeOf(line);
    const settlement = calculateSettlement({
      salePrice: line.salePrice,
      feeRateBp: line.feeRateBp,
    });

    return {
      ...(line.lineId === undefined ? {} : { lineId: line.lineId }),
      ...(line.category === undefined ? {} : { category: line.category }),
      basePrice: line.salePrice,
      addOns: line.addOns,
      addOnAmount,
      plannerFee,
      total: sumAmounts([line.salePrice, addOnAmount, plannerAmountOf(plannerFee)]),
      settlement: {
        feeRateBp: settlement.feeRateBp,
        feeAmount: settlement.feeAmount,
        netAmount: settlement.netAmount,
      },
    };
  });

  const basePrice = lines.reduce((sum, line) => sum + line.basePrice, 0);
  const addOnAmount = sumAmounts(lines.map((line) => line.addOnAmount));

  const selected = lines.filter((line) => line.plannerFee.kind === "selected");
  const plannerFee: OrderPlannerFee =
    selected.length > 0
      ? {
          kind: "selected",
          amount: sumAmounts(selected.map((line) => plannerAmountOf(line.plannerFee))),
          categoryCount: selected.length,
        }
      : lines.length > 0 && lines.every((line) => line.plannerFee.kind === "unavailable")
        ? { kind: "unavailable" }
        : { kind: "not_selected" };

  const feeAmount = lines.reduce((sum, line) => sum + line.settlement.feeAmount, 0);

  return {
    lines,
    itemCount: lines.length,
    basePrice,
    addOns: mergeAddOns(lines.map((line) => line.addOns)),
    addOnAmount,
    plannerFee,
    total: sumAmounts([basePrice, addOnAmount, plannerAmountOf(plannerFee)]),
    settlement: { feeAmount, netAmount: basePrice - feeAmount },
  };
}
