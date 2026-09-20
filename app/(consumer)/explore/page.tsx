import type { Metadata } from "next";
import { Suspense } from "react";

import { ConsumerShell } from "@/components/layout/ConsumerShell";
import { LoadingState } from "@/components/ui/LoadingState";
import {
  TASTE_DEFAULT_CLEAR_LABEL,
  TASTE_DEFAULT_NOTE,
  TASTE_OFF,
  tasteDefault,
} from "@/lib/core/product/concept";
import { DEFAULT_EXPLORE_SORT, EXPLORE_SORTS, type ExploreSort } from "@/lib/core/schemas/explore";
import { myStyleTags } from "@/lib/explore/taste";
import type { StyleTag } from "@/lib/core/schemas/onboarding";

import Link from "next/link";

import { ExploreFilters } from "./ExploreFilters";
import { ExploreResults } from "./ExploreResults";

export const metadata: Metadata = {
  title: "업체 탐색 — 웨딩클리어",
};

/**
 * /explore (F-C-10, §6.2)
 *
 * **비로그인도 볼 수 있다**(§1.4 guest). 로그인은 담기부터 필요하다.
 *
 * 조회는 API 와 **같은 함수**(`searchVendors`)를 쓴다. 화면이 자기 쿼리를 따로 쓰면
 * `GET /api/vendors` 로 확인한 결과와 화면이 갈린다.
 *
 * 로딩 상태(§6 3종)는 `loading.tsx` 가 아니라 **여기 Suspense** 다. 라우트 파일로 두면
 * 그 경계가 자식 라우트까지 감싸서 상세 화면이 404 를 못 낸다(ExploreResults 주석 참조).
 */
export default async function ExplorePage(
  props: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
  }
) {
  const searchParams = await props.searchParams;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    if (Array.isArray(value)) value.forEach((item) => params.append(key, item));
    else if (value !== undefined) params.set(key, value);
  }

  /**
   * 온보딩 취향을 **기본 필터**로 넣는다(C-2d · 완료 조건 ②).
   *
   * **조용히 걸러 두지 않는다** — 말 없이 걸러 두면 사용자는 결과가 원래 그것뿐이라고
   * 믿는다. 아래에서 **어디서 온 값인지 적고 지우는 링크**를 함께 준다.
   * 규칙(사용자가 고른 값 > 끈 상태 > 취향 기본값)은 순수 함수가 갖는다.
   */
  const taste = tasteDefault({
    requestedTags: params.getAll("styleTags"),
    tasteParam: params.get("taste"),
    coupleTags: await myStyleTags(),
  });

  const effective = new URLSearchParams(params);
  if (taste.kind === "applied") {
    for (const tag of taste.tags) effective.append("styleTags", tag);
  }

  /** 취향 필터를 끄는 주소. 다른 조건은 그대로 두고 `taste=off` 만 더한다. */
  const clearTasteHref = (() => {
    const next = new URLSearchParams(params);
    next.delete("styleTags");
    next.set("taste", TASTE_OFF);

    return `/explore?${next.toString()}`;
  })();

  const query = effective.toString();
  const raw = (key: string) => params.get(key) ?? "";
  const sortParam = params.get("sort");

  return (
    <ConsumerShell title="탐색">
      <div className="space-y-4">
        <ExploreFilters
          defaults={{
            region: raw("region"),
            category: raw("category"),
            budgetMin: raw("budgetMin"),
            budgetMax: raw("budgetMax"),
            guestCount: raw("guestCount"),
            date: raw("date"),
            styleTags: (taste.kind === "applied"
              ? taste.tags
              : params.getAll("styleTags")) as StyleTag[],
            onlyAvailable: params.get("onlyAvailable") === "true",
            sort: (EXPLORE_SORTS as readonly string[]).includes(sortParam ?? "")
              ? (sortParam as ExploreSort)
              : DEFAULT_EXPLORE_SORT,
          }}
        />

        {/* 기본값으로 걸렀다는 사실과 **지우는 수단**을 함께 보인다(C-2d).
            둘 중 하나라도 없으면 그건 걸러 주는 것이 아니라 가리는 것이다. */}
        {taste.kind === "applied" ? (
          <p
            data-testid="taste-default-notice"
            className="flex flex-wrap items-center gap-2 rounded-lg border border-brand-200 bg-brand-50 p-3 text-sm text-brand-700"
          >
            <span>{TASTE_DEFAULT_NOTE}</span>
            <Link href={clearTasteHref} className="font-medium underline" data-testid="taste-clear">
              {TASTE_DEFAULT_CLEAR_LABEL}
            </Link>
          </p>
        ) : null}

        {/* key 를 질의로 두면 조건이 바뀔 때마다 스켈레톤이 다시 뜬다. */}
        <Suspense key={query} fallback={<LoadingState label="업체를 불러오는 중" rows={4} variant="list" />}>
          <ExploreResults params={query} />
        </Suspense>
      </div>
    </ConsumerShell>
  );
}
