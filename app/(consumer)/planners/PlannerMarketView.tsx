"use client";

import Link from "next/link";
import { useState } from "react";

import { EmptyState } from "@/components/ui/EmptyState";
import {
  MARKET_EMPTY_BODY,
  MARKET_EMPTY_TITLE,
  MARKET_SORTS,
  MARKET_SORT_BASIS_NOTICE,
  MARKET_SORT_LABEL,
  NEW_PLANNER_NOTICE,
  SELF_REPORTED_NOTICE,
  type MarketSort,
} from "@/lib/core/planner/profile";
import { PLANNER_CATEGORY_LABEL, type PlannerCategory } from "@/lib/core/planner/scope";
import type { PlannerCard } from "@/lib/planners/loader";
import { cn } from "@/lib/utils";

/**
 * 플래너 마켓 (S6-02 · F-C-18 · §6.2 · D-03 · D-18 · D-25)
 *
 * ── 고르는 화면이지 파는 화면이 아니다 (D-18) ──────────────────────────────
 * 플래너는 **선택적 보조자**다. 그래서 "추천"·"프리미엄" 배지가 없고, 순서는 실적과
 * 사실로만 정한다. **정렬 기준 배지를 항상 노출**해 "유료 노출 없음" 을 화면으로
 * 증명한다(§2.2 가 업체 목록에 세운 것과 같은 규칙).
 *
 * ── 못 세는 지표를 0으로 적지 않는다 ────────────────────────────────────────
 * 리뷰는 "아직 세지 않는다" 로 적는다 — 0으로 적으면 **평가가 나쁜 것처럼** 읽히고
 * 그것은 사실이 아니다(S2-08·S3-11·S6-01 이 세운 같은 규칙).
 */
export type MarketData = {
  planners: PlannerCard[];
  sort: MarketSort;
  filter: { category: string | null; region: string | null };
};

export function PlannerMarketView({ data }: { data: MarketData }) {
  const [sort, setSort] = useState<MarketSort>(data.sort);
  const [category, setCategory] = useState<string | null>(data.filter.category);

  function apply(next: { sort?: MarketSort; category?: string | null }) {
    const params = new URLSearchParams();
    const nextSort = next.sort ?? sort;
    const nextCategory = next.category === undefined ? category : next.category;

    params.set("sort", nextSort);
    if (nextCategory) params.set("category", nextCategory);

    setSort(nextSort);
    setCategory(nextCategory);
    window.location.search = params.toString();
  }

  return (
    <div className="space-y-5">
      {/* §2.2 — 정렬 기준을 화면이 항상 말한다. 이것이 "광고 반영 없음" 의 증명이다. */}
      <div className="rounded-lg border border-border bg-neutral-50 px-3 py-2">
        <p className="text-xs font-medium text-neutral-700">
          정렬 기준 · {MARKET_SORT_LABEL[sort]}
        </p>
        <p className="mt-0.5 text-xs text-neutral-600">{MARKET_SORT_BASIS_NOTICE}</p>
      </div>

      {/* S6-04. **이미 위임한 사람이 돌아오는 자리다.** 목록만 있고 관리 화면으로
          가는 길이 없으면, 위임을 거두려는 사람은 자기가 어느 플래너에게 맡겼는지
          기억해 프로필을 다시 찾아 들어가야 한다. */}
      <Link
        href="/planners/delegations"
        className="block rounded-lg border border-border px-3 py-2 text-xs font-medium text-brand-600"
      >
        내 위임 관리 — 지금 무엇이 열려 있는지 보고 거둘 수 있어요
      </Link>

      <section>
        <p className="text-xs font-medium text-neutral-500">정렬</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {MARKET_SORTS.map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => apply({ sort: value })}
              className={cn(
                "rounded-lg border px-3 py-1.5 text-xs",
                sort === value
                  ? "border-brand-500 bg-brand-50 text-brand-700"
                  : "border-border text-neutral-700",
              )}
            >
              {MARKET_SORT_LABEL[value]}
            </button>
          ))}
        </div>
      </section>

      <section>
        <p className="text-xs font-medium text-neutral-500">카테고리</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => apply({ category: null })}
            className={cn(
              "rounded-lg border px-3 py-1.5 text-xs",
              category === null
                ? "border-brand-500 bg-brand-50 text-brand-700"
                : "border-border text-neutral-700",
            )}
          >
            전체
          </button>
          {(Object.keys(PLANNER_CATEGORY_LABEL) as PlannerCategory[]).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => apply({ category: value })}
              className={cn(
                "rounded-lg border px-3 py-1.5 text-xs",
                category === value
                  ? "border-brand-500 bg-brand-50 text-brand-700"
                  : "border-border text-neutral-700",
              )}
            >
              {PLANNER_CATEGORY_LABEL[value]}
            </button>
          ))}
        </div>
      </section>

      {data.planners.length === 0 ? (
        <EmptyState title={MARKET_EMPTY_TITLE} description={MARKET_EMPTY_BODY} />
      ) : (
        <ul className="space-y-3">
          {data.planners.map((planner) => (
            <li key={planner.id}>
              <PlannerRow planner={planner} />
            </li>
          ))}
        </ul>
      )}

      <p className="text-xs text-neutral-500">{SELF_REPORTED_NOTICE}</p>
    </div>
  );
}

function PlannerRow({ planner }: { planner: PlannerCard }) {
  const isNew = planner.contractCount === 0;

  return (
    <Link
      href={`/planners/${planner.id}`}
      className="block rounded-xl border border-border p-4 transition-colors hover:bg-neutral-50"
    >
      <p className="text-sm font-semibold text-foreground">{planner.headline}</p>

      <p className="mt-1 text-xs text-neutral-600">
        경력 {planner.careerYears}년 · {planner.regions.join(", ")}
      </p>

      <div className="mt-2 flex flex-wrap gap-1.5">
        {planner.categories.map((category) => (
          <span
            key={category}
            className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-600"
          >
            {PLANNER_CATEGORY_LABEL[category] ?? category}
          </span>
        ))}
      </div>

      <dl className="mt-3 flex flex-wrap gap-x-4 gap-y-1 border-t border-border pt-2 text-xs">
        <Metric label="계약 성사" metric={planner.metrics.contracts} />
        <Metric label="후기" metric={planner.metrics.reviews} />
      </dl>

      {isNew ? <p className="mt-2 text-xs text-neutral-500">{NEW_PLANNER_NOTICE}</p> : null}
    </Link>
  );
}

/** 못 세는 지표는 **0이 아니라 "아직 세지 않는다"** 로 적는다. */
function Metric({
  label,
  metric,
}: {
  label: string;
  metric: PlannerCard["metrics"]["contracts"];
}) {
  return (
    <div className="flex items-baseline gap-1">
      <dt className="text-neutral-500">{label}</dt>
      <dd className={cn(metric.kind === "value" ? "font-medium text-neutral-800" : "text-neutral-500")}>
        {metric.kind === "value" ? `${metric.value}건` : "아직 세지 않아요"}
      </dd>
    </div>
  );
}
