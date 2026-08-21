import type { Metadata } from "next";
import { Suspense } from "react";

import { ConsumerShell } from "@/components/layout/ConsumerShell";
import { LoadingState } from "@/components/ui/LoadingState";
import { daysLeft } from "@/lib/core/membership/membership";
import { loadMembership, loadMembershipPrice } from "@/lib/membership/actions";
import { requireUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";

import { MembershipView } from "./MembershipView";

export const metadata: Metadata = {
  title: "멤버십 — 웨딩클리어",
};

/**
 * /membership — 멤버십 구독 (F-C-19 · 명세서 §6.2)
 *
 * **세션 클라이언트로 읽는다** — `memberships` 는 본인 것만 보이며(0005 [06]) 그
 * 경계가 RLS 다. 쿠키를 읽으므로 이 페이지는 동적이고 FIX-22 의 캐시 문제가 붙지 않는다.
 *
 * **하단 탭을 늘리지 않는다** — 다섯 칸이 이미 찼다(D-55). 진입은 `/me` 의 '멤버십'
 * 줄이다. 결제·구독은 **자주 오는 화면이 아니라 계정 설정에서 찾는 화면**이다.
 */
export default async function MembershipPage() {
  await requireUser("/membership");

  return (
    <ConsumerShell title="멤버십" activeTab="/me">
      <Suspense fallback={<LoadingState label="멤버십을 불러오는 중" rows={3} variant="list" />}>
        <MembershipSection />
      </Suspense>
    </ConsumerShell>
  );
}

async function MembershipSection() {
  await requireUser("/membership");

  const supabase = await createClient();
  const now = new Date();
  const { state } = await loadMembership(supabase, { now });
  const price = await loadMembershipPrice();

  return (
    <MembershipView
      state={state}
      daysLeft={daysLeft(state.expiresAt, now.toISOString())}
      price={price}
    />
  );
}
