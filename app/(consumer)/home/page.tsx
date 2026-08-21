import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { MetricTile } from "@/components/domain/MetricTile";
import { NextTaskList } from "@/components/domain/NextTaskList";
import { formatKrw } from "@/components/domain/PriceDisplay";
import { isUnknownAmount } from "@/lib/core/pricing/amount";
import { ConsumerShell } from "@/components/layout/ConsumerShell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { LoadingState } from "@/components/ui/LoadingState";
import { Progress } from "@/components/ui/progress";
import { loadCarts } from "@/lib/cart/loader";
import { loadRooms } from "@/lib/chat/loader";
import { unreadBadge } from "@/lib/core/chat/chat";
import { isOnboardingComplete, type OnboardingQuestion } from "@/lib/core/schemas/onboarding";
import {
  HOME_ALL_DONE_NOTE,
  HOME_PENDING_SECTIONS,
  dDayState,
  homeTasks,
  pendingMetric,
} from "@/lib/core/schemas/home";
import { ANALYSIS_STATUS_LABEL } from "@/lib/core/report/pipeline";
import { measured } from "@/lib/core/stats/metric";
import { latestReport } from "@/lib/reports/loader";
import { loadBudgetGauge } from "@/lib/budget/loader";
import { loadNextTasks } from "@/lib/tasks/loader";
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

  const cartsView = membership
    ? await loadCarts(supabase, createPublicClient(), {
        coupleId: membership.coupleId,
        viewerId: user.id,
        memberIds,
      })
    : null;

  // 홈은 **장바구니 전부**를 요약한다(IDEA-01). 하나만 골라 보이면 "왜 이것만 보이나" 가
  // 되고, 예산에 맞춰 좁혀 가는 일이 홈에서 보이지 않는다.
  const carts = cartsView?.carts ?? [];
  const visibleItems = carts.flatMap((cart) =>
    cart.items.filter((item) => item.visibility.kind === "visible"),
  );

  const { count: wishCount } = membership
    ? await admin
        .from("wishlists")
        .select("id", { count: "exact", head: true })
        .eq("couple_id", membership.coupleId)
    : { count: 0 };

  // 최근 대화(F-C-27). 커플이 없으면 방도 없다 — 조회 자체를 건너뛴다.
  // RLS 가 자기 커플의 방만 보여주므로 여기서 couple_id 로 다시 거르지 않는다.
  // SLA 눈금은 넘기지 않는다(null) — 홈은 업체용 타이머를 그리는 자리가 아니다.
  const recentRooms = membership
    ? (
        await loadRooms(supabase, {
          viewerId: user.id,
          side: "couple",
          threshold: null,
          now: new Date(),
        }).catch(() => [])
      ).slice(0, 3)
    : [];

  // 다음 할 일(F-C-04 · S7-08). **`/checklist` 와 같은 함수를 부른다** — §6.2 가 요구한
  // "홈과 같은 컴포넌트" 는 고르는 규칙이 하나일 때만 성립한다(두 화면이 다른 3건을
  // 보여주면 사용자는 어느 쪽이 맞는지 묻게 된다).
  const nextTaskList = membership
    ? await loadNextTasks(supabase, {
        coupleId: membership.coupleId,
        today: new Date().toISOString().slice(0, 10),
      }).catch(() => [])
    : [];

  // 예산 게이지(F-C-05 · S7-07). **`/budget` 과 같은 함수를 부른다** — 두 화면이 다른
  // 총액을 말하면 사용자는 어느 쪽이 맞는지 묻게 된다('다음 할 일' 과 같은 규칙 · §6.2).
  // 총예산은 `couples.total_budget` 하나이며 장바구니 기준선(D-77)도 그 값을 쓴다.
  const budgetGauge = membership
    ? await loadBudgetGauge(supabase, createPublicClient(), {
        coupleId: membership.coupleId,
      }).catch(() => null)
    : null;

  // 최근 검토 리포트(F-C-07 · S7-03). 커플이 없으면 문서도 없다 — 조회를 건너뛴다.
  // RLS 가 자기 커플의 문서만 보여주므로 여기서 couple_id 로 다시 거르지 않는다.
  const recentReport = membership ? await latestReport(supabase).catch(() => null) : null;

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

      {/* ── 2-b) 예산 게이지 (S7-07 — F-C-05) ────────────────────────────── */}
      {/* §6.2 가 홈의 요소로 적어 둔 자리다. **하단 탭을 늘리지 않고**(D-55) 여기가
          `/budget` 의 1차 진입이 된다. 총예산이 미정이면 **게이지를 그리지 않는다** —
          0을 기준으로 삼으면 담는 즉시 '초과' 가 뜨는데 그건 사실이 아니다. */}
      <section className="space-y-2" data-testid="home-budget">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-base font-semibold text-foreground">예산</h2>
          <Link href="/budget" className="text-caption font-medium text-brand-600">
            자세히
          </Link>
        </div>

        {budgetGauge === null || budgetGauge.totalBudget === null ? (
          <p className="text-sm text-muted-foreground" data-testid="home-budget-none">
            총예산을 정하면 얼마나 남았는지 알려드려요.{" "}
            <Link href="/budget" className="font-medium text-brand-600">
              예산 정하기
            </Link>
          </p>
        ) : (
          <Link
            href="/budget"
            className="block space-y-2 rounded-lg border border-border p-4"
            data-testid="home-budget-gauge"
            data-state={(budgetGauge.overBy ?? 0) > 0 ? "over" : "under"}
          >
            <Progress
              value={Math.min(100, (budgetGauge.usedBp ?? 0) / 100)}
              aria-label="예산 소진율"
            />
            <p className="text-sm text-foreground">
              {formatKrw(budgetGauge.committed)}원 / {formatKrw(budgetGauge.totalBudget)}원
            </p>
            <p
              className={`text-caption ${(budgetGauge.overBy ?? 0) > 0 ? "text-warning" : "text-success"}`}
            >
              {(budgetGauge.overBy ?? 0) > 0
                ? `예산 초과 ${formatKrw(budgetGauge.overBy as number)}원`
                : `남은 예산 ${formatKrw(budgetGauge.remaining as number)}원`}
            </p>
          </Link>
        )}
      </section>

      {/* ── 2-c) 하객 (S7-09 — F-C-22) ──────────────────────────────────── */}
      {/* **하단 탭을 늘리지 않는다**(D-55). `/guests` 는 자주 오는 화면이 아니라
          예식이 가까워질 때 오는 화면이라 홈에서 잇는다. **숫자를 여기서 세지
          않는다** — 명단 집계는 `/guests` 가 한 번에 읽어 계산하고, 홈이 따로 세면
          두 화면이 다른 숫자를 말한다(D-84 와 같은 판단). */}
      <section className="space-y-2" data-testid="home-guests">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-base font-semibold text-foreground">하객</h2>
          <Link href="/guests" className="text-caption font-medium text-brand-600">
            자세히
          </Link>
        </div>
        <p className="text-sm text-muted-foreground">
          명단을 적어 두면 참석 응답을 링크로 받고 답례품 수량까지 세어 드려요.{" "}
          <Link href="/guests" className="font-medium text-brand-600">
            하객 관리
          </Link>
        </p>
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

        {visibleItems.length > 0 ? (
          <Card>
            <CardContent className="space-y-3 pt-5">
              {/* 장바구니마다 총액과 예산 대비를 한 줄로 적는다. **하나로 합치지 않는다** —
                  서로 다른 조합의 총액을 더한 값은 아무 뜻도 없는 숫자다. */}
              <ul className="space-y-2" data-testid="home-cart-list">
                {carts.map((cart) => (
                  <li key={cart.cartId} data-testid="home-cart-row" data-cart-id={cart.cartId}>
                    <Link href={`/cart?cart=${cart.seq}`} className="block space-y-1">
                      <span className="flex items-baseline justify-between gap-2">
                        <span className="min-w-0 truncate text-sm font-medium text-foreground">
                          {cart.seq}. {cart.label}
                        </span>
                        <span className="shrink-0 text-unit text-foreground">
                          {cart.total === null || isUnknownAmount(cart.total.total) ? (
                            "담은 것 없음"
                          ) : (
                            <>
                              <span data-amount="">{formatKrw(cart.total.total)}</span>원
                            </>
                          )}
                        </span>
                      </span>

                      {/* 예산이 미정이면 기준선을 그리지 않는다(0으로 견주지 않는다). */}
                      {cart.budget.kind === "under" || cart.budget.kind === "over" ? (
                        <span
                          className={`block text-caption ${cart.budget.kind === "over" ? "text-warning" : "text-success"}`}
                          data-testid="home-cart-budget"
                          data-state={cart.budget.kind}
                        >
                          {cart.budget.kind === "over"
                            ? `예산 초과 ${formatKrw(cart.budget.excess)}원`
                            : `예산 여유 ${formatKrw(cart.budget.remaining)}원`}
                          {cart.fill && !cart.fill.complete ? " · 미완성 총액" : ""}
                        </span>
                      ) : cart.fill && !cart.fill.complete ? (
                        <span className="block text-caption text-muted-foreground">
                          미완성 총액
                        </span>
                      ) : null}
                    </Link>
                  </li>
                ))}
              </ul>

              <div className="flex gap-2">
                <Link
                  href="/cart"
                  className="flex-1 rounded-md border border-border px-3 py-2 text-center text-sm font-medium text-foreground"
                >
                  장바구니
                </Link>
                <Link
                  href={carts.length >= 2 ? "/explore/compare?mode=carts" : "/explore/compare"}
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

      {/* ── 4) 최근 대화 (S4-04 — F-C-27) ────────────────────────────────── */}
      <section className="space-y-2" data-testid="home-chat">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-base font-semibold text-foreground">최근 대화</h2>
          {recentRooms.length > 0 ? (
            <Link href="/chat" className="text-caption font-medium text-brand-600">
              전체 보기
            </Link>
          ) : null}
        </div>

        {recentRooms.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            아직 진행 중인 대화가 없어요.{" "}
            <Link href="/explore" className="font-medium text-brand-600">
              업체에 문의하기
            </Link>
          </p>
        ) : (
          <ul className="space-y-2" data-testid="home-chat-rooms">
            {recentRooms.map((room) => {
              const badge = unreadBadge(room.unread);

              return (
                <li key={room.id}>
                  <Link
                    href={`/chat/${room.id}`}
                    className="flex items-start gap-3 rounded-lg border border-border p-4"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-foreground">
                        {room.vendorName}
                      </p>
                      <p className="truncate text-caption text-muted-foreground">{room.preview}</p>
                    </div>
                    {badge ? (
                      <span className="inline-flex min-w-5 shrink-0 items-center justify-center rounded-full bg-brand-500 px-1.5 py-0.5 text-caption font-semibold text-primary-foreground">
                        {badge}
                      </span>
                    ) : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* ── 5) 다음 할 일 (S7-08 — F-C-04 · 표현 C 는 S7-19) ─────────────── */}
      {/* **`/checklist` 와 같은 규칙으로 고른 3건**이다(§6.2). `waiting` 은 넣지 않는다 —
          먼저 할 일이 있는 태스크를 '다음 할 일' 로 올리면 그 카드가 순서를 뒤집는다.
          **마크업도 `/checklist` 표현 C 와 한 벌이다**(S7-19 · `NextTaskList`) — S7-08 은
          고르는 함수만 공유했고 그리는 쪽은 여기에만 있었다. 두 벌이면 한쪽만 고치는 날이 온다. */}
      <section className="space-y-2" data-testid="home-next-tasks">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-base font-semibold text-foreground">다음 할 일</h2>
          <Link href="/checklist" className="text-caption font-medium text-brand-600">
            전체 보기
          </Link>
        </div>

        <NextTaskList
          tasks={nextTaskList}
          testId="home-next-task-list"
          emptyHint={
            <>
              아직 만든 일정이 없어요.{" "}
              <Link href="/checklist" className="font-medium text-brand-600">
                예식일 기준으로 만들기
              </Link>
            </>
          }
        />
      </section>

      {/* ── 6) 최근 검토 리포트 (S7-03 — F-C-07) ─────────────────────────── */}
      <section className="space-y-2" data-testid="home-reports">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-base font-semibold text-foreground">계약서 검토</h2>
          {recentReport ? (
            <Link href="/reports" className="text-caption font-medium text-brand-600">
              전체 보기
            </Link>
          ) : null}
        </div>

        {recentReport === null ? (
          <p className="text-sm text-muted-foreground">
            아직 검토한 계약서가 없어요.{" "}
            <Link href="/reports/upload" className="font-medium text-brand-600">
              계약서 올리기
            </Link>
          </p>
        ) : (
          <Link
            href={
              recentReport.analysisId === null ? "/reports" : `/reports/${recentReport.analysisId}`
            }
            className="block rounded-lg border border-border p-4"
            data-testid="home-report-link"
          >
            <p className="text-sm font-medium text-foreground">
              {new Date(recentReport.createdAt).toLocaleDateString("ko-KR")} 올린 계약서
            </p>
            <p className="text-caption text-muted-foreground">
              {recentReport.status === null
                ? "분석을 시작하지 않았어요"
                : ANALYSIS_STATUS_LABEL[recentReport.status]}
              {recentReport.riskScore === null ? "" : ` · 위험 ${recentReport.riskScore}`}
            </p>
          </Link>
        )}
      </section>

      {/* ── 7) 클리어 진입 (S7-06 — F-C-03) ──────────────────────────────── */}
      {/* **하단 탭을 늘리지 않았다.** 다섯 칸이 이미 찼고 여섯 번째부터는 375px 에서
          터치 타깃이 44px 아래로 내려간다(§7.5). 그래서 클리어의 1차 진입은 여기다. */}
      <section className="space-y-2" data-testid="home-planner">
        <h2 className="text-base font-semibold text-foreground">클리어에게 물어보기</h2>

        <Link
          href="/planner"
          className="block rounded-lg border border-border p-4"
          data-testid="home-planner-link"
        >
          <p className="text-sm font-medium text-foreground">
            준비 중 궁금한 것을 물어보세요
          </p>
          <p className="text-caption text-muted-foreground">
            조회한 값으로만 답해요. 없는 숫자는 말하지 않습니다.
          </p>
        </Link>
      </section>

      {/* ── 8) 아직 채울 수 없는 자리 ────────────────────────────────────── */}
      {/* **목록이 비면 절을 그리지 않는다**(S7-11). 담당 태스크가 끝날 때마다 항목이
          빠지고 지금은 하나도 남지 않았다 — 빈 제목만 남기면 화면이 "준비 중인 것이
          있는데 못 세고 있다" 고 읽힌다. */}
      {HOME_PENDING_SECTIONS.length > 0 ? (
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
      ) : null}

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
