import Link from "next/link";

import { formatKrw } from "@/components/domain/PriceDisplay";
import { Badge } from "@/components/ui/badge";
import type { CartCompareView } from "@/lib/cart/compare";
import {
  BUDGET_LINE_LABEL,
  CART_COMPARE_COLLAPSED_LABEL,
  LOWEST_CART_UNDECIDED_NOTICE,
} from "@/lib/core/cart/multi-cart";
import { COMPARE_SCROLL_HINT, cellText, type CompareCell } from "@/lib/core/schemas/compare";
import { VENDOR_CATEGORY_LABEL, type VendorCategory } from "@/lib/core/schemas/vendor";

/**
 * 장바구니끼리 비교 (IDEA-01 · F-C-10, §6.2 `/explore/compare`)
 *
 * **375px 에서 열 셋 이상은 한 화면에 들어가지 않는다.** 그래서 표를 가로로 스크롤하고
 * **축 이름 열을 고정**한다(`sticky left-0`) — 항목 비교표(S3-07)와 같은 방식이다.
 *
 * **총액만 보고 "이게 싸다" 고 오인하게 두지 않는다.** 담은 카테고리가 서로 다르면
 * '가장 낮은 총액' 배지를 아예 달지 않고 그 이유를 적는다(`different_coverage`). 덜 담은
 * 장바구니가 싼 것은 당연한 일이고, 그것을 우승으로 표시하면 표가 거짓말을 한다.
 *
 * **모든 장바구니에서 같은 줄은 접는다.** 차이를 보러 온 화면에서 같은 줄이 자리를
 * 먹으면 정작 다른 줄이 밀린다. 감추지 않고 `<details>` 로 접는다 — 새 의존성도
 * 클라이언트 상태도 필요 없다.
 */
function Cell({ cell }: { cell: CompareCell }) {
  if (cell.kind === "value") {
    return (
      <span data-amount={cell.amount === undefined ? undefined : ""} className="text-unit text-foreground">
        {cell.text}
      </span>
    );
  }

  return (
    <span className="text-caption text-muted-foreground" data-state={cell.kind}>
      {cell.kind === "none" && cell.text ? cell.text : cellText(cell)}
    </span>
  );
}

function rowLabel(row: { key: string; label: string }): string {
  if (!row.key.startsWith("category:")) return row.label;

  return VENDOR_CATEGORY_LABEL[row.label as VendorCategory] ?? row.label;
}

export function CartCompareTable({ view }: { view: CartCompareView }) {
  const shown = view.rows.filter((row) => !row.identical);
  const collapsed = view.rows.filter((row) => row.identical);

  return (
    <section className="space-y-2" data-testid="cart-compare">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-foreground">장바구니 총액</h2>
        <span className="text-caption text-muted-foreground">{view.columns.length}개</span>
      </div>

      {view.lowest !== null && "undecided" in view.lowest ? (
        <p className="text-caption text-warning" data-testid="cart-lowest-undecided" data-reason={view.lowest.undecided}>
          {LOWEST_CART_UNDECIDED_NOTICE[view.lowest.undecided]}
        </p>
      ) : null}

      {view.coverageJudged ? null : (
        <p className="text-caption text-muted-foreground" data-testid="coverage-unjudged">
          채움 기준이 설정되지 않아 어느 장바구니가 미완성인지 판단하지 않았어요.
        </p>
      )}

      {view.columns.length > 2 ? (
        <p className="text-caption text-muted-foreground">{COMPARE_SCROLL_HINT}</p>
      ) : null}

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full border-collapse text-left">
          <caption className="sr-only">
            장바구니끼리 비교. 총액과 예산 대비, 카테고리별로 담긴 것을 견줍니다.
          </caption>

          <thead>
            <tr>
              <th
                scope="col"
                className="sticky left-0 z-10 min-w-[6rem] border-b border-border bg-background p-2 text-caption font-medium text-muted-foreground"
              >
                항목
              </th>
              {view.columns.map((column) => {
                const isLowest =
                  view.lowest !== null && "cartId" in view.lowest && view.lowest.cartId === column.cartId;

                return (
                  <th
                    key={column.cartId}
                    scope="col"
                    className="min-w-[9rem] border-b border-l border-border p-2 align-top"
                    data-testid="cart-compare-column"
                    data-cart-id={column.cartId}
                  >
                    <Link
                      href={`/cart?cart=${column.seq}`}
                      className="block truncate text-sm font-semibold text-foreground"
                    >
                      {column.seq}. {column.label}
                    </Link>
                    <span className="block text-caption text-muted-foreground">
                      담은 것 {column.itemCount}개
                    </span>

                    {/* 미완성은 배지로 말하고 **어느 카테고리가 비었는지 이름으로 적는다.** */}
                    {column.missing.length > 0 ? (
                      <span
                        className="mt-1 block text-caption text-warning"
                        data-testid="cart-incomplete"
                      >
                        미완성 ·{" "}
                        {column.missing
                          .map((category) => VENDOR_CATEGORY_LABEL[category as VendorCategory] ?? category)
                          .join("·")}{" "}
                        없음
                      </span>
                    ) : null}

                    {isLowest ? (
                      <Badge className="mt-1" data-testid="cart-lowest-badge">
                        가장 낮은 총액
                      </Badge>
                    ) : null}
                  </th>
                );
              })}
            </tr>
          </thead>

          <tbody>
            {/* 예산 대비 — **예산이 미정이면 줄을 만들지 않는다**(0으로 견주지 않는다). */}
            {view.budgetTotal === null ? null : (
              <tr data-testid="cart-compare-row" data-axis="budget">
                <th
                  scope="row"
                  className="sticky left-0 z-10 border-b border-border bg-background p-2 align-top text-caption font-medium text-muted-foreground"
                >
                  예산 대비
                </th>
                {view.columns.map((column) => (
                  <td
                    key={column.cartId}
                    className="border-b border-l border-border p-2 align-top"
                    data-state={column.budget.kind}
                  >
                    {column.budget.kind === "under" ? (
                      <span className="text-caption text-success">
                        여유 <span data-amount="">{formatKrw(column.budget.remaining)}</span>원
                      </span>
                    ) : column.budget.kind === "over" ? (
                      <span className="text-caption text-warning">
                        초과 <span data-amount="">{formatKrw(column.budget.excess)}</span>원
                      </span>
                    ) : (
                      <span className="text-caption text-muted-foreground">
                        {BUDGET_LINE_LABEL[column.budget.kind]}
                      </span>
                    )}
                  </td>
                ))}
              </tr>
            )}

            {shown.map((row) => (
              <tr key={row.key} data-testid="cart-compare-row" data-axis={row.key}>
                <th
                  scope="row"
                  className="sticky left-0 z-10 border-b border-border bg-background p-2 align-top text-caption font-medium text-muted-foreground"
                >
                  {rowLabel(row)}
                </th>
                {row.cells.map((cell, index) => (
                  <td
                    key={view.columns[index]?.cartId ?? index}
                    className={`border-b border-l border-border p-2 align-top ${
                      // 총액이 이 표의 주인공이다(D-18).
                      row.key === "total" ? "text-amount-sm" : ""
                    }`}
                  >
                    <Cell cell={cell} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {collapsed.length > 0 ? (
        <details className="rounded-lg border border-border p-3" data-testid="cart-compare-collapsed">
          <summary className="cursor-pointer text-caption font-medium text-foreground">
            {CART_COMPARE_COLLAPSED_LABEL} {collapsed.length}개 — 펼쳐 보기
          </summary>
          <ul className="space-y-1 pt-2">
            {collapsed.map((row) => (
              <li key={row.key} className="flex items-start justify-between gap-2">
                <span className="text-caption text-muted-foreground">{rowLabel(row)}</span>
                <span className="min-w-0 text-right">
                  <Cell cell={row.cells[0]} />
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

export default CartCompareTable;
