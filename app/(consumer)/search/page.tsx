import type { Metadata } from "next";
import { Suspense } from "react";

import { ConsumerShell } from "@/components/layout/ConsumerShell";
import { LoadingState } from "@/components/ui/LoadingState";

import { SearchBox } from "./SearchBox";
import { SearchResults } from "./SearchResults";

export const metadata: Metadata = {
  title: "조건 검색 — 웨딩클리어",
  description: "\"3월 14일 강남 300인\"처럼 적으면 조건으로 바꿔 찾아 드려요. 랭킹 기준을 항상 함께 보여줍니다.",
  alternates: { canonical: "/search" },
};

/**
 * /search — 조건 검색 (F-C-30 · 명세서 §6.2 · §5.5)
 *
 * **비로그인도 쓸 수 있다**(§1.4 guest — 조건 검색 체험). 담기부터 로그인이 필요하다.
 *
 * 조건 상태는 **URL 이 갖는다**(`/explore` 와 같은 규칙). 칩을 고치면 명시 파라미터가
 * 박히고, 그 링크를 공유하면 같은 화면이 나온다. 파싱 결과를 서버 세션에 두면 링크가
 * 사람마다 다른 결과를 열게 된다.
 *
 * 하단 탭은 '탐색' 을 켠 상태로 둔다 — `/search` 는 탭이 아니지만 탐색 계열 화면이고,
 * 아무 탭도 안 켜져 있으면 사용자는 자기가 어디 있는지 알 수 없다.
 */
export default function SearchPage({
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

  return (
    <ConsumerShell title="조건 검색" activeTab="/explore">
      <div className="space-y-4">
        <SearchBox defaultQuery={params.get("q") ?? ""} />

        {/* key 를 질의로 두면 조건이 바뀔 때마다 스켈레톤이 다시 뜬다(`/explore` 와 같은 방식). */}
        <Suspense
          key={query}
          fallback={<LoadingState label="조건을 읽고 업체를 찾는 중" rows={4} variant="list" />}
        >
          <SearchResults params={query} />
        </Suspense>
      </div>
    </ConsumerShell>
  );
}
