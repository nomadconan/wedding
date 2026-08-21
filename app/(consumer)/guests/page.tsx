import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { ConsumerShell } from "@/components/layout/ConsumerShell";
import { EmptyState } from "@/components/ui/EmptyState";
import { LoadingState } from "@/components/ui/LoadingState";
import { canIssueInvite } from "@/lib/core/guest/guest";
import { findMyCouple } from "@/lib/couple/membership";
import { loadGuests } from "@/lib/guest/loader";
import { requireUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";

import { GuestsView } from "./GuestsView";

export const metadata: Metadata = {
  title: "하객 관리 — 웨딩클리어",
};

/**
 * /guests — 하객·좌석 (F-C-22 · 명세서 §6.2)
 *
 * **세션 클라이언트로 읽는다** — `guests`·`seating_plans` 는 커플 스코프이고
 * RLS(0005 [15][16])가 커플 구성원 + 위임 플래너(읽기만)를 판정한다. 쿠키를 읽으므로
 * 이 페이지는 동적이며 FIX-22 의 캐시 문제가 붙지 않는다.
 *
 * **하단 탭은 '홈' 을 켠다** — 다섯 칸이 이미 찼고(D-55) 진입은 홈의 '준비 상황' 줄이다.
 */
export default async function GuestsPage() {
  await requireUser("/guests");

  return (
    <ConsumerShell title="하객 관리" activeTab="/home">
      <Suspense fallback={<LoadingState label="명단을 불러오는 중" rows={4} variant="list" />}>
        <GuestsSection />
      </Suspense>
    </ConsumerShell>
  );
}

async function GuestsSection() {
  const user = await requireUser("/guests");
  const membership = await findMyCouple(user.id);

  if (!membership) {
    return (
      <EmptyState
        title="먼저 온보딩을 마쳐 주세요"
        description="예식일을 알아야 초대 링크를 언제까지 열어 둘지 정할 수 있어요."
        action={
          <Link href="/onboarding" className="text-sm font-medium text-brand-600">
            온보딩 하러 가기
          </Link>
        }
      />
    );
  }

  const supabase = await createClient();
  const view = await loadGuests(supabase, {
    coupleId: membership.coupleId,
    today: new Date().toISOString().slice(0, 10),
  });

  return (
    <GuestsView
      guests={view.guests}
      counts={view.counts}
      favorNote={view.favorNote}
      gap={view.gap}
      invite={view.invite}
      canIssueInvite={canIssueInvite(view.weddingDate)}
      layout={view.layout}
      issues={view.issues}
      unseated={view.unseated}
    />
  );
}
