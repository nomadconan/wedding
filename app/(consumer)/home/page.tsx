import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { MetricTile } from "@/components/domain/MetricTile";
import { PriceDisplay } from "@/components/domain/PriceDisplay";
import { ConsumerShell } from "@/components/layout/ConsumerShell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { LoadingState } from "@/components/ui/LoadingState";
import { loadCart } from "@/lib/cart/loader";
import { isOnboardingComplete, type OnboardingQuestion } from "@/lib/core/schemas/onboarding";
import {
  HOME_ALL_DONE_NOTE,
  HOME_PENDING_SECTIONS,
  dDayState,
  homeTasks,
  pendingMetric,
} from "@/lib/core/schemas/home";
import { measured } from "@/lib/core/stats/metric";
import { findMyCouple } from "@/lib/couple/membership";
import { createPublicClient } from "@/lib/explore/query";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = {
  title: "홈 — 웨딩클리어",
};

/**
 * /home (F-C-04·F-C-05·F-C-25 요약, §6.2)
 *
 * **화면의 순서가 곧 판단이다.**
 *  1) D-day — 준비의 모든 판단이 남은 기간에 달려 있다(리드타임 할인·예약 가능일).
 *     그래서 맥락이 첫 줄이다. **예식일이 미정이면 숫자를 만들지 않고** 그 자리가
 *     그대로 "정해 보세요" 라는 행동이 된다.
 *  2) 지금 할 일 — S2-08 업체 대시보드와 같은 원칙(숫자보다 할 일). 다만 **확인
 *     가능한 사실에서만** 만든다. 항상 떠 있는 권유는 할 일이 아니라 배경이 된다.
 *  3) 담아 둔 것 — 지금 실제로 셀 수 있는 유일한 숫자다.
 *  4) 아직 못 채우는 자리 — 0으로 적지 않고 **어느 태스크에서 채워지는지** 밝힌다.
 *
 * 로그인이 필요하다. 미인증 차단은 미들웨어가 한다(S3-01) — 화면의 `requireUser()` 는
 * 스트리밍이 시작된 뒤라 상태 코드를 바꾸지 못한다.
 *
 * 로딩 상태는 `loading.tsx` 가 아니라 페이지 안쪽 Suspense 다(S3-03).
 */
export default async function HomePage() {
  await requireUser("/home");

  return (
    <ConsumerShell title="홈" activeTab="/home">
      <Suspense fallback={<LoadingState label="홈을 불러오는 중" rows={4} variant="block" />}>
        <HomeSection />
      </Suspense>
    </ConsumerShell>
  );
}

async function HomeSection() {
  const user = await requireUser("/home");
  const membership = await findMyCouple(user.id);

  const supabase = await createClient();
  const admin = createAdminClient();

  // 커플이 없으면 온보딩 전이다. 그 상태에서도 화면은 깨지지 않고 **할 일 하나**를 보여준다.
  const couple = membership
    ? (
        await supabase
          .from("couples")
          .select("id, wedding_date, region_code, total_budget, guest_count")
          .eq("id", membership.coupleId)
          .maybeSingle()
      ).data
    : null;

  const answers = membership
    ? ((
        await supabase
          .from("onboarding_answers")
          .select("question_key")
          .eq("couple_id", membership.coupleId)
      ).data ?? [])
    : [];

  const onboardingComplete = isOnboardingComplete(
    answers.map((row) => (row as { question_key: string }).question_key as OnboardingQuestion),
  );

  const { data: members } = membership
    ? await admin
        .from("couple_members")
        .select("user_id")
        .eq("couple_id", membership.coupleId)
        .in("member_role", ["owner", "partner"])
    : { data: [] };

  const memberIds = (members ?? []).map((row) => (row as { user_id: string }).user_id);
  const partnerLinked = memberIds.length >= 2;

  const cart = membership
    ? await loadCart(supabase, createPublicClient(), {
        coupleId: membership.coupleId,
        viewerId: user.id,
        memberIds,
      })
    : null;

  const visibleItems = (cart?.items ?? []).filter((item) => item.visibility.kind === "visible");

  const { count: wishCount } = membership
    ? await admin
        .from("wishlists")
        .select("id", { count: "exact", head: true })
        .eq("couple_id", membership.coupleId)
    : { count: 0 };

  // 기준일은 여기서 한 번만 만들고 화면 전체가 같은 값을 쓴다.
  const today = new Date().toISOString().slice(0, 10);
  const dday = dDayState(today, couple?.wedding_date ?? null);

  const tasks = homeTasks({
    onboardingComplete,
    weddingDateDecided: couple?.wedding_date !== null && couple?.wedding_date !== undefined,
    partnerLinked,
    cartItemCount: visibleItems.length,
    comparableCount: visibleItems.length,
  });

  return (
    <div className="space-y-5" data-testid="home">
      {/* ── 1) D-day ─────────────────────────────────────────────────────── */}
      <Card data-testid="dday" data-state={dday.kind}>
        <CardContent className="pt-5">
          {dday.kind === "undecided" ? (
            <div className="space-y-1">
              <p className="text-unit text-muted-foreground">예식일</p>
              <p className="text-lg font-semibold text-foreground">아직 정하지 않았어요</p>
              <p className="text-caption text-muted-foreground">
                날짜를 정하면 남은 날짜와 그날 기준 가격을 보여드려요.
              </p>
              <Link href="/onboarding" className="text-sm font-medium text-brand-600">
                예식일 정하기
              </Link>
            </div>
          ) : (
            <div className="space-y-1">
              <p className="text-unit text-muted-foreground">
                {couple?.wedding_date}
                {couple?.region_code ? ` · ${couple.region_code}` : ""}
              </p>
              <p className="flex items-baseline gap-1">
                <span data-amount="" className="text-amount text-foreground">
                  {dday.kind === "today" ? "D-DAY" : dday.days}
                </span>
                {dday.kind === "today" ? null : (
                  <span className="text-base text-muted-foreground">
                    {dday.kind === "upcoming" ? "일 남았어요" : "일 지났어요"}
                  </span>
                )}
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── 2) 지금 할 일 (최대 3건) ─────────────────────────────────────── */}
      <section className="space-y-2" data-testid="home-tasks">
        <h2 className="text-base font-semibold text-foreground">지금 할 일</h2>

        {tasks.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="home-tasks-empty">
            {HOME_ALL_DONE_NOTE}
          </p>
        ) : (
          <ul className="space-y-2">
            {tasks.map((task) => (
              <li key={task.code}>
                <Link
                  href={task.href}
                  className="block rounded-lg border border-border p-4"
                  data-testid="home-task"
                  data-code={task.code}
                >
                  <p className="text-sm font-medium text-foreground">{task.title}</p>
                  <p className="text-caption text-muted-foreground">{task.description}</p>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ── 3) 담아 둔 것 — 지금 실제로 셀 수 있는 숫자 ───────────────────── */}
      <section className="space-y-2" data-testid="home-cart">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-base font-semibold text-foreground">담아 둔 것</h2>
          {partnerLinked ? (
            <Badge variant="secondary" data-testid="partner-linked">
              배우자와 공유 중
            </Badge>
          ) : null}
        </div>

        {cart?.total && visibleItems.length > 0 ? (
          <Card>
            <CardContent className="space-y-3 pt-5">
              <PriceDisplay
                amount={cart.total.total}
                basePrice={cart.total.basePrice}
                taxIncluded
                addOns={cart.total.addOns}
                plannerFee={cart.total.plannerFee}
                variant="sum"
                itemCount={cart.total.itemCount}
                size="md"
              />
              <div className="flex gap-2">
                <Link
                  href="/cart"
                  className="flex-1 rounded-md border border-border px-3 py-2 text-center text-sm font-medium text-foreground"
                >
                  장바구니
                </Link>
                <Link
                  href="/explore/compare"
                  className="flex-1 rounded-md border border-border px-3 py-2 text-center text-sm font-medium text-foreground"
                >
                  비교하기
                </Link>
              </div>
            </CardContent>
          </Card>
        ) : (
          <p className="text-sm text-muted-foreground">
            아직 담은 것이 없어요.{" "}
            <Link href="/explore" className="font-medium text-brand-600">
              업체 둘러보기
            </Link>
          </p>
        )}

        <div className="grid grid-cols-2 gap-2">
          <MetricTile label="담은 상품" metric={measured(visibleItems.length)} unit="개" />
          <MetricTile label="찜" metric={measured(wishCount ?? 0)} unit="곳" />
        </div>
      </section>

      {/* ── 4) 아직 채울 수 없는 자리 ────────────────────────────────────── */}
      <section className="space-y-2">
        <h2 className="text-base font-semibold text-foreground">준비 중인 기능</h2>
        <p className="text-caption text-muted-foreground">
          아래는 아직 만들지 않아 셀 수 없는 값이에요. 0이 아니라 &lsquo;아직&rsquo;입니다.
        </p>

        <div className="space-y-2" data-testid="home-pending">
          {HOME_PENDING_SECTIONS.map((section) => (
            <MetricTile
              key={section.key}
              label={section.label}
              metric={pendingMetric(section.key)}
            />
          ))}
        </div>
      </section>

      {/* 참가격은 로그인 없이도 보는 화면이라 링크만 둔다. */}
      {couple?.region_code ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{couple.region_code} 참가격</CardTitle>
            <CardDescription>
              지역·카테고리별 가격 분포를 표본수·출처와 함께 볼 수 있어요.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Link
              href={`/prices/${encodeURIComponent(couple.region_code)}/hall`}
              className="text-sm font-medium text-brand-600"
              data-testid="price-index-link"
            >
              웨딩홀 가격 분포 보기
            </Link>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
