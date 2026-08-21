import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { BudgetDonut } from "@/components/domain/BudgetDonut";
import { ConsumerShell } from "@/components/layout/ConsumerShell";
import { EmptyState } from "@/components/ui/EmptyState";
import { LoadingState } from "@/components/ui/LoadingState";
import { loadBudget } from "@/lib/budget/loader";
import { findMyCouple } from "@/lib/couple/membership";
import { createPublicClient } from "@/lib/explore/query";
import { requireUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";

import { BudgetView } from "./BudgetView";

export const metadata: Metadata = {
  title: "예산 — 웨딩클리어",
};

/**
 * /budget — 예산 배분·추적 (F-C-05 · 명세서 §6.2)
 *
 * **세션 클라이언트로 읽는다** — `budgets`·`budget_items`·`expenses`·`bookings`·
 * `payments` 는 전부 커플 스코프이고 플래너 위임까지 RLS 가 판정한다(0005 [12][13][14]).
 * 쿠키를 읽으므로 이 페이지는 동적이며 **FIX-22 의 캐시 문제가 붙지 않는다.**
 * 참가격 지수만 익명 클라이언트로 읽는다 — 공개 데이터다(§3.9).
 *
 * **하단 탭은 '홈' 을 켠다** — 다섯 칸이 이미 찼고(D-55) 진입은 홈의 **예산 게이지**다.
 * §6.2 가 그 게이지를 홈의 요소로 적어 두었으므로 새로 만드는 진입점이 아니다.
 */
export default async function BudgetPage() {
  await requireUser("/budget");

  return (
    <ConsumerShell title="예산" activeTab="/home">
      <Suspense fallback={<LoadingState label="예산을 불러오는 중" rows={4} variant="list" />}>
        <BudgetSection />
      </Suspense>
    </ConsumerShell>
  );
}

async function BudgetSection() {
  const user = await requireUser("/budget");
  const membership = await findMyCouple(user.id);

  if (!membership) {
    return (
      <EmptyState
        title="먼저 온보딩을 마쳐 주세요"
        description="지역과 총예산을 알아야 참가격 기준으로 배분을 권해 드릴 수 있어요."
        action={
          <Link href="/onboarding" className="text-sm font-medium text-brand-600">
            온보딩 하러 가기
          </Link>
        }
      />
    );
  }

  const supabase = await createClient();
  const view = await loadBudget(supabase, createPublicClient(), {
    coupleId: membership.coupleId,
  });

  return (
    <div className="space-y-5">
      {/* **도넛은 큰 그림이고 아래 목록이 사실이다**(BudgetDonut 주석 참조). */}
      <BudgetDonut
        segments={view.donut}
        emptyLabel={
          view.totalBudget === null
            ? "총예산을 정하면 배분을 그려드려요."
            : "아직 카테고리에 배정한 금액이 없어요."
        }
      />

      <BudgetView
        totalBudget={view.totalBudget}
        lines={view.lines}
        totals={view.totals}
        warnings={view.warnings}
        recommendations={view.recommendations}
        recommendation={view.recommendation}
        expenses={view.expenses}
        regionCode={view.regionCode}
      />
    </div>
  );
}
