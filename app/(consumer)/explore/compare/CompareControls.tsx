"use client";

import { useRouter, useSearchParams } from "next/navigation";

import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  COMPARE_PLANNER_BASES,
  COMPARE_PLANNER_BASIS_LABEL,
  PLANNER_MISMATCH_NOTICE,
  type ComparePlannerBasis,
} from "@/lib/core/schemas/compare";

/**
 * 비교 조건 (S3-07)
 *
 * 상태는 **URL 이 갖는다.** 링크를 그대로 공유하면 같은 표가 나와야 하고 뒤로 가기가
 * 조건을 되돌려야 한다 — `/explore` 필터와 같은 방식이다.
 *
 * **플래너 기준 전환은 표시만 바꾼다.** 장바구니의 `planner_selected` 는 건드리지 않는다 —
 * 비교하러 들어왔다가 담아 둔 선택이 바뀌면 안 된다.
 */
export type CompareControlsProps = {
  basis: ComparePlannerBasis;
  plannerMixed: boolean;
  items: { itemId: string; label: string }[];
  selected: string[];
};

export function CompareControls({ basis, plannerMixed, items, selected }: CompareControlsProps) {
  const router = useRouter();
  const params = useSearchParams();

  function push(next: URLSearchParams) {
    const query = next.toString();
    router.push(query === "" ? "/explore/compare" : `/explore/compare?${query}`);
  }

  function setBasis(value: ComparePlannerBasis) {
    const next = new URLSearchParams(params);
    if (value === "as_selected") next.delete("basis");
    else next.set("basis", value);

    push(next);
  }

  function toggleItem(itemId: string, on: boolean) {
    const current = new Set(selected.length === 0 ? items.map((item) => item.itemId) : selected);

    if (on) current.add(itemId);
    else current.delete(itemId);

    const next = new URLSearchParams(params);
    next.delete("items");

    // 전부 고른 상태는 '고르지 않음'과 같다. 링크를 짧게 두고 기본값을 하나로 유지한다.
    if (current.size !== items.length) {
      [...current].forEach((id) => next.append("items", id));
    }

    push(next);
  }

  const checkedIds = selected.length === 0 ? items.map((item) => item.itemId) : selected;

  return (
    <section className="space-y-3 rounded-lg border border-border p-4" data-testid="compare-controls">
      {/* 선택이 갈렸을 때만 알린다. 안 갈렸는데 경고하면 소음이다. */}
      {plannerMixed ? (
        <p className="text-caption text-warning" data-testid="planner-mismatch">
          {PLANNER_MISMATCH_NOTICE}
        </p>
      ) : null}

      <div className="space-y-2">
        <p className="text-sm font-medium text-foreground">총액 기준</p>
        <div className="flex flex-col gap-1.5">
          {COMPARE_PLANNER_BASES.map((value) => (
            <label key={value} className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="basis"
                value={value}
                checked={basis === value}
                onChange={() => setBasis(value)}
                className="h-4 w-4 accent-brand-600"
                data-testid={`basis-${value}`}
              />
              <span className="text-foreground">{COMPARE_PLANNER_BASIS_LABEL[value]}</span>
            </label>
          ))}
        </div>
        <p className="text-caption text-muted-foreground">
          기준을 바꿔도 장바구니에 담아 둔 선택은 그대로예요.
        </p>
      </div>

      {items.length > 1 ? (
        <div className="space-y-2">
          <p className="text-sm font-medium text-foreground">비교할 항목</p>
          <div className="space-y-1.5" data-testid="compare-picker">
            {items.map((item) => (
              <div key={item.itemId} className="flex items-center gap-2">
                <Checkbox
                  id={`pick-${item.itemId}`}
                  checked={checkedIds.includes(item.itemId)}
                  onCheckedChange={(checked) => toggleItem(item.itemId, checked === true)}
                />
                <Label htmlFor={`pick-${item.itemId}`} className="font-normal">
                  {item.label}
                </Label>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

export default CompareControls;
