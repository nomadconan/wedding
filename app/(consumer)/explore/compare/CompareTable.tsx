import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { COMPARE_AXES, type CompareGroup } from "@/lib/cart/compare";
import {
  COMPARE_AXIS_LABEL,
  COMPARE_SCROLL_HINT,
  LOWEST_UNDECIDED_NOTICE,
  SINGLE_ITEM_NOTICE,
  cellText,
  type CompareCell,
} from "@/lib/core/schemas/compare";
import { VENDOR_CATEGORY_LABEL, type VendorCategory } from "@/lib/core/schemas/vendor";

/**
 * 병렬 비교표 (F-C-10, §6.2 `/explore/compare`)
 *
 * **375px 에서 열 셋 이상은 한 화면에 들어가지 않는다.** 그래서 표를 가로로 스크롤하고
 * **축 이름 열을 고정**한다(`sticky left-0`) — 옆으로 밀어도 지금 보는 줄이 무엇인지
 * 알 수 있어야 한다. CSS 만으로 되므로 새 의존성이 없다.
 *
 * 빈칸을 만들지 않는다. 값이 없으면 **왜 없는지**를 적는다(`CompareCell`).
 * 금액은 `tabular-nums`(`data-amount`)로 자릿수를 맞춘다(docs/DESIGN.md §금액).
 */
function Cell({ cell }: { cell: CompareCell }) {
  if (cell.kind === "value") {
    return (
      <span
        data-amount={cell.amount === undefined ? undefined : ""}
        className="text-unit text-foreground"
      >
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

export function CompareTable({ group }: { group: CompareGroup }) {
  const categoryLabel =
    VENDOR_CATEGORY_LABEL[group.category as VendorCategory] ?? group.category;

  return (
    <section className="space-y-2" data-testid="compare-group" data-category={group.category}>
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-foreground">{categoryLabel}</h2>
        <span className="text-caption text-muted-foreground">{group.columns.length}개</span>
      </div>

      {group.columns.length === 1 ? (
        <p className="text-caption text-muted-foreground" data-testid="single-item-notice">
          {SINGLE_ITEM_NOTICE}{" "}
          <Link
            href={`/explore?category=${encodeURIComponent(group.category)}`}
            className="font-medium text-brand-600"
          >
            같은 카테고리 더 보기
          </Link>
        </p>
      ) : null}

      {group.lowest && "undecided" in group.lowest ? (
        <p className="text-caption text-warning" data-testid="lowest-undecided">
          {LOWEST_UNDECIDED_NOTICE}
        </p>
      ) : null}

      {group.columns.length > 2 ? (
        <p className="text-caption text-muted-foreground">{COMPARE_SCROLL_HINT}</p>
      ) : null}

      {/* 가로 스크롤은 이 컨테이너 안에서만 일어난다. 본문이 좌우로 밀리면 안 된다. */}
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full border-collapse text-left">
          <caption className="sr-only">
            {categoryLabel} 담은 항목 비교. 실총액 낮은 순으로 정렬했습니다.
          </caption>

          <thead>
            <tr>
              <th
                scope="col"
                className="sticky left-0 z-10 min-w-[6rem] border-b border-border bg-background p-2 text-caption font-medium text-muted-foreground"
              >
                항목
              </th>
              {group.columns.map((column) => {
                const isLowest =
                  group.lowest !== null &&
                  "itemId" in group.lowest &&
                  group.lowest.itemId === column.itemId;

                return (
                  <th
                    key={column.itemId}
                    scope="col"
                    className="min-w-[9rem] border-b border-l border-border p-2 align-top"
                    data-testid="compare-column"
                  >
                    <Link
                      href={`/explore/${column.vendorId}`}
                      className="block truncate text-sm font-semibold text-foreground"
                    >
                      {column.vendorName}
                    </Link>
                    <span className="block truncate text-caption text-muted-foreground">
                      {column.productName}
                    </span>
                    {isLowest ? (
                      <Badge className="mt-1" data-testid="lowest-badge">
                        가장 낮은 총액
                      </Badge>
                    ) : null}
                  </th>
                );
              })}
            </tr>
          </thead>

          <tbody>
            {COMPARE_AXES.map((axis) => (
              <tr key={axis} data-testid="compare-row" data-axis={axis}>
                <th
                  scope="row"
                  className="sticky left-0 z-10 border-b border-border bg-background p-2 align-top text-caption font-medium text-muted-foreground"
                >
                  {COMPARE_AXIS_LABEL[axis]}
                </th>
                {group.columns.map((column) => (
                  <td
                    key={column.itemId}
                    className={`border-b border-l border-border p-2 align-top ${
                      // 총액이 이 표의 주인공이다(D-18).
                      axis === "total" ? "text-amount-sm" : ""
                    }`}
                  >
                    <Cell cell={column.cells[axis]} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default CompareTable;
