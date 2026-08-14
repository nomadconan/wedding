import type { Metadata } from "next";
import { Suspense } from "react";

import { ConsumerShell } from "@/components/layout/ConsumerShell";
import { ErrorState } from "@/components/ui/ErrorState";
import { LoadingState } from "@/components/ui/LoadingState";
import { MARKET_TITLE } from "@/lib/core/planner/profile";
import { loadMarket } from "@/lib/planners/loader";
import { createClient } from "@/lib/supabase/server";

import { PlannerMarketView } from "./PlannerMarketView";

export const metadata: Metadata = {
  title: "플래너 찾기 — 웨딩클리어",
};

/**
 * /planners (F-C-18, §6.2)
 *
 * **비로그인도 본다.** `planners_select_public`(0005)이 `active` 를 anon 에게도 연다 —
 * 마켓은 고르기 전에 둘러보는 화면이라 로그인을 요구하면 비교 자체를 막는다
 * (`/explore` 가 같은 판단을 했다).
 *
 * **`/planner`(단수)와 다른 화면이다.** 그쪽은 §6.2 가 **AI 플래너 채팅**(F-C-03,
 * 7단계)에 배정한 경로다. 사람 플래너 콘솔은 `/pro` 를 쓴다 — AdminShell 주석 참조.
 */
export default async function PlannerMarketPage({
  searchParams,
}: {
  searchParams: { sort?: string; category?: string; region?: string };
}) {
  return (
    <ConsumerShell title={MARKET_TITLE}>
      <Suspense fallback={<LoadingState label="플래너를 불러오는 중" rows={3} variant="block" />}>
        <MarketSection searchParams={searchParams} />
      </Suspense>
    </ConsumerShell>
  );
}

async function MarketSection({
  searchParams,
}: {
  searchParams: { sort?: string; category?: string; region?: string };
}) {
  try {
    const payload = await loadMarket(await createClient(), {
      sort: searchParams.sort ?? null,
      category: searchParams.category ?? null,
      region: searchParams.region ?? null,
    });

    return (
      <PlannerMarketView
        data={{ planners: payload.planners, sort: payload.sort, filter: payload.filter }}
      />
    );
  } catch {
    return (
      <ErrorState
        code="PLANNER_MARKET_FAILED"
        title="플래너를 불러오지 못했어요"
        description="잠시 후 다시 시도해 주세요."
      />
    );
  }
}
