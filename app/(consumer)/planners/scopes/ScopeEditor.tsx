"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  RELEASE_CONFIRM_TITLE,
  SCOPE_RATE_UNKNOWN_NOTICE,
  isUnknownAmount,
  releaseImpact,
  type Amount,
} from "@/lib/core/planner/scope";
import { formatKrw } from "@/components/domain/PriceDisplay";
import type { DelegatedPlanner, ScopeCategoryView } from "@/lib/planners/scopes";

/**
 * 카테고리별 이용 선택 (S6-03 · F-C-31)
 *
 * ── 이 편집기가 지키는 규칙 ─────────────────────────────────────────────────
 * 1. **누르기 전에 얼마가 붙는지 보인다.** 담긴 항목의 판매가와 그 위에 붙는 금액을
 *    카테고리마다 적는다 — "9%" 만 보고 정하면 고액 계약에서 얼마인지 모른다.
 * 2. **미정을 0원이라고 적지 않는다**(함정 2). 요율이 없으면 금액 자리에 '기준 미설정'
 *    이라 쓰고 이유를 붙인다.
 * 3. **빼기 전에 무엇이 바뀌는지 말한다** — 특히 "이미 확정된 계약은 그대로" 와
 *    "열람 권한은 따로" 를(D-43).
 * 4. **서버가 다시 계산한 값을 받는다.** 화면이 자기 계산으로 그리면 요율을 모르는
 *    클라이언트가 금액을 지어내게 된다.
 */
function AmountText({ value }: { value: Amount }) {
  if (isUnknownAmount(value)) {
    return <span className="text-warning">기준 미설정</span>;
  }

  return <span>{formatKrw(value)}원</span>;
}

export function ScopeEditor({
  categories,
  delegated,
  feeTotal,
}: {
  categories: ScopeCategoryView[];
  delegated: DelegatedPlanner[];
  feeTotal: Amount;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [confirmCategory, setConfirmCategory] = useState<string | null>(null);

  const impact = releaseImpact();
  const rateMissing = categories.some((row) => row.selected && row.rateBp === null);

  /** 지금 선택을 그대로 두고 한 카테고리만 바꾼다. */
  async function apply(next: { category: string; plannerId: string | null }) {
    setPending(true);
    setErrors([]);

    const selections = categories
      .filter((row) => (row.category === next.category ? next.plannerId !== null : row.selected))
      .map((row) => ({
        category: row.category,
        plannerId:
          row.category === next.category ? (next.plannerId as string) : (row.plannerId as string),
      }));

    try {
      const response = await fetch("/api/planner-scopes", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selections }),
      });
      const payload = (await response.json()) as {
        ok: boolean;
        error?: { message?: string; details?: { reasons?: { message: string }[] } };
      };

      if (!response.ok || !payload.ok) {
        const reasons = payload.error?.details?.reasons ?? [];
        setErrors(
          reasons.length > 0
            ? reasons.map((reason) => reason.message)
            : [payload.error?.message ?? "저장하지 못했어요."],
        );

        return;
      }

      setConfirmCategory(null);
      router.refresh();
    } catch {
      setErrors(["네트워크 문제로 처리하지 못했어요. 잠시 후 다시 시도해 주세요."]);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-4" data-testid="scope-editor">
      <section className="rounded-xl border border-border p-4">
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold text-foreground">지금 붙는 플래너 수수료</h2>
          <p className="text-base font-semibold text-foreground" data-testid="scope-fee-total">
            <AmountText value={feeTotal} />
          </p>
        </div>
        <p className="mt-1 text-xs text-neutral-600">
          장바구니에 담긴 항목의 판매가를 기준으로 계산한 값이에요. 담은 것이 바뀌면 함께 바뀝니다.
        </p>
        {rateMissing ? (
          <p className="mt-2 rounded-lg bg-warning-surface px-2 py-1.5 text-xs text-warning-foreground">
            {SCOPE_RATE_UNKNOWN_NOTICE}
          </p>
        ) : null}
      </section>

      <ul className="space-y-3">
        {categories.map((row) => (
          <li key={row.category} className="rounded-xl border border-border p-4">
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="text-sm font-semibold text-foreground">{row.label}</h3>
              <span
                className="shrink-0 rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-700"
                data-testid="scope-state"
              >
                {row.selected ? "플래너 이용" : "직접 진행"}
              </span>
            </div>

            <dl className="mt-2 space-y-1 text-xs">
              <div className="flex gap-2">
                <dt className="shrink-0 text-neutral-500">담긴 항목</dt>
                <dd className="text-neutral-800">
                  {row.itemCount}개 · 판매가 {formatKrw(row.salePriceTotal)}원
                </dd>
              </div>
              <div className="flex gap-2">
                <dt className="shrink-0 text-neutral-500">붙는 수수료</dt>
                <dd className="text-neutral-800">
                  <AmountText value={row.fee} />
                </dd>
              </div>
              {row.selected ? (
                <div className="flex gap-2">
                  <dt className="shrink-0 text-neutral-500">맡긴 플래너</dt>
                  <dd className="text-neutral-800">
                    {/* 이름을 못 읽었으면 지어내지 않는다. */}
                    {row.plannerHeadline ?? "이름을 불러오지 못했어요"}
                  </dd>
                </div>
              ) : null}
            </dl>

            {row.selected ? (
              confirmCategory === row.category ? (
                <div className="mt-3 rounded-lg border border-border bg-muted p-3">
                  <p className="text-sm font-medium text-foreground">{RELEASE_CONFIRM_TITLE}</p>
                  <ul className="mt-2 list-disc space-y-1 pl-4 text-xs text-neutral-700">
                    {impact.notes.map((note) => (
                      <li key={note}>{note}</li>
                    ))}
                  </ul>
                  <div className="mt-3 flex gap-2">
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={pending}
                      onClick={() => apply({ category: row.category, plannerId: null })}
                    >
                      직접 진행하기
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setConfirmCategory(null)}>
                      그대로 두기
                    </Button>
                  </div>
                </div>
              ) : (
                <Button
                  className="mt-3"
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() => setConfirmCategory(row.category)}
                >
                  플래너 빼기
                </Button>
              )
            ) : (
              <div className="mt-3 flex flex-wrap gap-2">
                {delegated.map((planner) => (
                  <Button
                    key={planner.plannerId}
                    size="sm"
                    variant="outline"
                    disabled={pending}
                    onClick={() =>
                      apply({ category: row.category, plannerId: planner.plannerId })
                    }
                  >
                    {planner.headline ?? "이름 없는 플래너"}에게 맡기기
                  </Button>
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>

      {errors.length > 0 ? (
        <ul className="rounded-lg border border-danger bg-danger-surface px-3 py-2 text-xs text-danger-foreground">
          {errors.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
