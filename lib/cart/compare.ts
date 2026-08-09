import { formatKrw } from "@/components/domain/PriceDisplay";
import { AMOUNT_UNKNOWN, isUnknownAmount, type Amount } from "@/lib/core/pricing/amount";
import type { OrderTotal } from "@/lib/core/pricing/order";
import {
  COMPARE_AXES,
  groupByCategory,
  lowestTotal,
  plannerSelectionMixed,
  sortByTotal,
  type CompareAxis,
  type CompareCell,
  type ComparePlannerBasis,
} from "@/lib/core/schemas/compare";
import type { CartItemView, CartView } from "@/lib/cart/loader";

/**
 * 비교표 만들기 (S3-07 · F-C-10, §6.2 `/explore/compare`)
 *
 * `loadCart` 가 준 것을 **나란히 놓는 방식만** 다르다. 금액을 다시 계산하지 않는다 —
 * 장바구니와 비교표가 다른 값을 말하면 어느 쪽이 진짜인지 알 수 없게 된다.
 */
export type CompareColumn = {
  itemId: string;
  vendorId: string | null;
  vendorName: string;
  productName: string;
  /** 이 기준에서의 실총액. 정렬과 '가장 낮은 총액' 판정에 쓴다. */
  total: Amount;
  plannerSelected: boolean;
  cells: Record<CompareAxis, CompareCell>;
};

export type CompareGroup = {
  category: string;
  columns: CompareColumn[];
  /** 가장 낮은 실총액. 미정이 섞이면 정하지 않는다. */
  lowest: { itemId: string } | { undecided: "has_unknown" } | null;
  /** 이 묶음 안에서 플래너 선택이 갈렸는가. */
  plannerMixed: boolean;
};

export type CompareView = {
  groups: CompareGroup[];
  basis: ComparePlannerBasis;
  /** 담긴 항목 중 비교 대상으로 고른 id. 빈 배열이면 전체다. */
  selected: string[];
  totalItemCount: number;
  excludedCount: number;
  /** 전체에서 플래너 선택이 갈렸는가. 안내 배너의 조건이다. */
  plannerMixed: boolean;
};

function amountCell(value: Amount): CompareCell {
  return isUnknownAmount(value)
    ? { kind: "missing" }
    : { kind: "value", text: `${formatKrw(value)}원`, amount: value };
}

/** 한 항목의 칸들을 만든다. 값이 없으면 **왜 없는지**를 칸에 담는다. */
function cellsOf(
  item: CartItemView,
  line: OrderTotal["lines"][number] | undefined,
  basis: ComparePlannerBasis,
): Record<CompareAxis, CompareCell> {
  const plannerOn = basis === "as_selected" ? item.plannerSelected : false;

  const addOns: CompareCell =
    item.addOns.kind === "none"
      ? // 0건으로 **확정**한 것이다. 안 적은 것과 다르다(F-V-04).
        { kind: "none", text: "추가금 없음" }
      : item.addOns.kind === "unknown"
        ? { kind: "missing" }
        : item.addOns.kind === "included"
          ? { kind: "value", text: "총액에 포함" }
          : {
              kind: "value",
              text: `최대 ${formatKrw(item.addOns.total ?? 0)}원 · ${item.addOns.count}건`,
              amount: item.addOns.total ?? 0,
            };

  const planner: CompareCell = !plannerOn
    ? { kind: "none", text: "선택 안 함" }
    : item.plannerFeeAmount === null
      ? { kind: "missing" }
      : { kind: "value", text: `${formatKrw(item.plannerFeeAmount)}원`, amount: item.plannerFeeAmount };

  const capacity: CompareCell =
    item.capacityMin === null && item.capacityMax === null
      ? { kind: "missing" }
      : {
          kind: "value",
          text: `${item.capacityMin ?? "-"} ~ ${item.capacityMax ?? "-"}명`,
        };

  const priceChange: CompareCell =
    item.priceChange.kind === "up" || item.priceChange.kind === "down"
      ? {
          kind: "value",
          text: `${item.priceChange.kind === "up" ? "+" : "-"}${formatKrw(item.priceChange.diff)}원`,
        }
      : item.priceChange.kind === "same"
        ? { kind: "none", text: "그대로" }
        : { kind: "missing" };

  return {
    total: line ? amountCell(line.total) : { kind: "unavailable" },
    basePrice: item.basePrice === null ? { kind: "unavailable" } : amountCell(item.basePrice),
    addOns,
    plannerFee: planner,
    tax: { kind: "value", text: item.priceIncludesVat ? "포함" : "별도" },
    includedItems:
      item.basePrice === null
        ? { kind: "unavailable" }
        : item.includedItemCount === 0
          ? // 게시 조건상 포함 항목이 1건 이상이어야 하므로 0건은 사실상 나오지 않는다.
            // 그래도 '없다'고 단정하지 않고 적지 않은 것으로 둔다.
            { kind: "missing" }
          : { kind: "value", text: `${item.includedItemCount}건` },
    capacity,
    region: item.regionCode === null ? { kind: "missing" } : { kind: "value", text: item.regionCode },
    priceChange,
  };
}

/**
 * 비교표를 만든다.
 *
 * **비교 단위는 항목(상품)이다.** 고객이 실제로 고르는 것은 상품이고 계약도 상품 단위다
 * (`bookings.product_id`). 장바구니에서 업체별로 묶은 것은 **편집 단위**이지 비교 단위가
 * 아니다 — 한 업체가 평일·주말 패키지를 함께 올릴 수 있어 업체로 묶으면 견줄 수 없다.
 *
 * **지금 볼 수 없는 항목은 뺀다.** 값을 읽을 수 없어 열을 세우면 모든 칸이 빈칸이 된다.
 * 뺐다는 사실은 화면이 알린다(S3-05 의 처리와 같은 결).
 */
export function buildCompare(
  cart: CartView,
  options: { basis: ComparePlannerBasis; selected: string[] },
): CompareView {
  const { basis, selected } = options;
  const source = basis === "as_selected" ? cart.total : cart.totalWithoutPlanner;

  const visible = cart.items.filter((item) => item.visibility.kind === "visible");
  const picked = selected.length === 0 ? visible : visible.filter((item) => selected.includes(item.itemId));

  const columns: CompareColumn[] = picked.map((item) => {
    const line = source?.lines.find((row) => row.lineId === item.itemId);

    return {
      itemId: item.itemId,
      vendorId: item.vendorId,
      vendorName: item.vendorName ?? "업체",
      productName: item.productName ?? "상품",
      total: line?.total ?? AMOUNT_UNKNOWN,
      plannerSelected: item.plannerSelected,
      cells: cellsOf(item, line, basis),
    };
  });

  const groups: CompareGroup[] = groupByCategory(
    picked.map((item) => ({ category: item.category, itemId: item.itemId })),
  ).map((group) => {
    const groupColumns = sortByTotal(
      group.items
        .map((row) => columns.find((column) => column.itemId === row.itemId))
        .filter((column): column is CompareColumn => column !== undefined),
    );

    return {
      category: group.category,
      columns: groupColumns,
      lowest: lowestTotal(groupColumns),
      plannerMixed: plannerSelectionMixed(groupColumns.map((column) => column.plannerSelected)),
    };
  });

  return {
    groups,
    basis,
    selected,
    totalItemCount: visible.length,
    excludedCount: cart.excludedCount,
    plannerMixed: plannerSelectionMixed(visible.map((item) => item.plannerSelected)),
  };
}

export { COMPARE_AXES };
