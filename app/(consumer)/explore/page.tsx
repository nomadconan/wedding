import type { Metadata } from "next";
import { Suspense } from "react";

import { ConsumerShell } from "@/components/layout/ConsumerShell";
import { LoadingState } from "@/components/ui/LoadingState";
import { DEFAULT_EXPLORE_SORT, EXPLORE_SORTS, type ExploreSort } from "@/lib/core/schemas/explore";
import type { StyleTag } from "@/lib/core/schemas/onboarding";

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
export default function ExplorePage({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    if (Array.isArray(value)) value.forEach((item) => params.append(key, item));
    else if (value !== undefined) params.set(key, value);
  }

  const query = params.toString();
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
            styleTags: params.getAll("styleTags") as StyleTag[],
            onlyAvailable: params.get("onlyAvailable") === "true",
            sort: (EXPLORE_SORTS as readonly string[]).includes(sortParam ?? "")
              ? (sortParam as ExploreSort)
              : DEFAULT_EXPLORE_SORT,
          }}
        />

        {/* key 를 질의로 두면 조건이 바뀔 때마다 스켈레톤이 다시 뜬다. */}
        <Suspense key={query} fallback={<LoadingState label="업체를 불러오는 중" rows={4} variant="list" />}>
          <ExploreResults params={query} />
        </Suspense>
      </div>
    </ConsumerShell>
  );
}
