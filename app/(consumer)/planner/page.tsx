import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { ConsumerShell } from "@/components/layout/ConsumerShell";
import { EmptyState } from "@/components/ui/EmptyState";
import { LoadingState } from "@/components/ui/LoadingState";
import { conversationGate } from "@/lib/core/ai/limits";
import {
  listConversations,
  loadMessages,
  ownsConversation,
  sessionTokens,
  toMessageViews,
  turnsUsedToday,
} from "@/lib/ai/planner/conversation";
import { plannerMode } from "@/lib/ai/planner/run";
import { aiLimitSettings } from "@/lib/ai/tools/reference";
import { findMyCouple } from "@/lib/couple/membership";
import { requireUser } from "@/lib/supabase/auth";

import { PlannerView } from "./PlannerView";

export const metadata: Metadata = {
  title: "클리어 — 웨딩클리어",
};

/**
 * /planner — AI 플래너 '클리어' (F-C-03 · 명세서 §6.2)
 *
 * **대화 목록을 URL 이 갖는다**(`?c=<id>`). 서버 세션에 두면 같은 링크가 사람마다 다른
 * 대화를 열고, 새로고침이 대화를 바꾼다(`/cart` 의 `?cart=` 와 같은 규칙).
 *
 * **상한을 화면에서 먼저 판정한다.** 막혀 있으면 입력창을 아예 그리지 않는다 — 보내고
 * 나서 429 를 받는 것보다, 왜 못 보내는지 먼저 말하는 편이 낫다. 판정 자체는 라우트가
 * 다시 한다(화면은 UX 보조이지 경계가 아니다 · CLAUDE.md §5.5).
 *
 * 하단 탭은 '홈' 을 켠 상태로 둔다 — `/planner` 는 탭이 아니고(다섯 칸이 이미 찼다),
 * 진입은 홈의 클리어 카드다.
 */
export default async function PlannerPage({
  searchParams,
}: {
  searchParams: { c?: string };
}) {
  await requireUser("/planner");

  return (
    <ConsumerShell title="클리어" activeTab="/home">
      <Suspense fallback={<LoadingState label="대화를 불러오는 중" rows={3} variant="block" />}>
        <PlannerSection conversationId={searchParams.c ?? null} />
      </Suspense>
    </ConsumerShell>
  );
}

async function PlannerSection({ conversationId }: { conversationId: string | null }) {
  const user = await requireUser("/planner");
  const membership = await findMyCouple(user.id);

  // 커플이 없으면 맥락 주입이 성립하지 않는다. **빈 대화를 열어 두지 않는다** —
  // 예식일도 예산도 모르는 채로 답하면 그 답은 우리 데이터에 근거하지 않는다.
  if (!membership) {
    return (
      <EmptyState
        title="먼저 온보딩을 마쳐 주세요"
        description="예식일·예산·지역을 알아야 클리어가 우리 데이터로 답할 수 있어요."
        action={
          <Link href="/onboarding" className="text-sm font-medium text-brand-600">
            온보딩 하러 가기
          </Link>
        }
      />
    );
  }

  const selected =
    conversationId !== null && (await ownsConversation(membership.coupleId, conversationId))
      ? conversationId
      : null;

  const [conversations, stored, limits] = await Promise.all([
    listConversations(membership.coupleId),
    selected === null ? Promise.resolve([]) : loadMessages(selected),
    aiLimitSettings(),
  ]);

  const asOf = new Date().toISOString().slice(0, 10);

  const gate = conversationGate({
    usedToday: await turnsUsedToday(membership.coupleId, asOf),
    sessionTokens: await sessionTokens(selected),
    freeDailyTurns: limits.freeDailyTurns,
    sessionTokenCap: limits.sessionTokenCap,
    // 멤버십은 S7-11 이 붙인다. 그 전까지 모두 무료다 — 등급을 지어내지 않는다.
    membership: "free",
  });

  return (
    <div className="space-y-4">
      {conversations.length > 0 ? (
        <nav aria-label="지난 대화" className="flex gap-2 overflow-x-auto pb-1">
          <Link
            href="/planner"
            aria-current={selected === null ? "page" : undefined}
            className={`shrink-0 rounded-full border px-3 py-1 text-caption ${
              selected === null
                ? "border-brand-500 text-brand-600"
                : "border-border text-muted-foreground"
            }`}
          >
            새 대화
          </Link>

          {conversations.map((conversation) => (
            <Link
              key={conversation.id}
              href={`/planner?c=${conversation.id}`}
              aria-current={selected === conversation.id ? "page" : undefined}
              data-testid="planner-conversation"
              className={`shrink-0 rounded-full border px-3 py-1 text-caption ${
                selected === conversation.id
                  ? "border-brand-500 text-brand-600"
                  : "border-border text-muted-foreground"
              }`}
            >
              {conversation.title ?? "새 대화"}
            </Link>
          ))}
        </nav>
      ) : null}

      <PlannerView
        initialConversationId={selected}
        initialMessages={toMessageViews(stored)}
        mode={plannerMode()}
        blockedNotice={gate.ok ? null : gate.notice}
      />
    </div>
  );
}
