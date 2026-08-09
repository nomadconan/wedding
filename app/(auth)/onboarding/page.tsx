import type { Metadata } from "next";

import { ConsumerShell } from "@/components/layout/ConsumerShell";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ErrorState } from "@/components/ui/ErrorState";
import { isOnboardingComplete, type OnboardingQuestion } from "@/lib/core/schemas/onboarding";
import { findMyCouple } from "@/lib/couple/membership";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";

import { OnboardingStepper, type SavedAnswer } from "./OnboardingStepper";
import { PartnerInvite } from "./PartnerInvite";

export const metadata: Metadata = {
  title: "시작하기 — 웨딩클리어",
};

/**
 * /onboarding (F-C-01·F-C-02, §6.1)
 *
 * 소비자 화면이라 `ConsumerShell` 을 쓰고, 집중이 필요한 단계라 탭을 감춘다
 * (docs/DESIGN.md §2 — 온보딩처럼 집중이 필요한 단계는 `hideTabBar`).
 *
 * 답변은 세션 클라이언트로 읽는다 — RLS 가 내 커플 것만 보여준다.
 */
export default async function OnboardingPage() {
  const user = await requireUser("/onboarding");
  const supabase = await createClient();
  const membership = await findMyCouple(user.id);

  let answers: SavedAnswer[] = [];
  let paired = false;

  if (membership) {
    const { data: rows, error } = await supabase
      .from("onboarding_answers")
      .select("question_key, answer_json")
      .eq("couple_id", membership.coupleId);

    if (error) {
      return (
        <ConsumerShell title="시작하기" hideTabBar>
          <ErrorState
            code="ONBOARDING_LOAD_FAILED"
            title="정보를 불러오지 못했어요"
            description="잠시 후 다시 시도해 주세요."
          />
        </ConsumerShell>
      );
    }

    answers = (rows ?? []).map((row) => ({
      question: row.question_key as OnboardingQuestion,
      ...(row.answer_json as Record<string, unknown>),
    }));

    const { data: members } = await supabase
      .from("couple_members")
      .select("member_role")
      .eq("couple_id", membership.coupleId);

    paired = (members ?? []).filter((m) => m.member_role !== "planner").length >= 2;
  }

  const complete = isOnboardingComplete(answers.map((answer) => answer.question));

  // 활동 기록 — 누가 무엇을 했는지 표기한다(§2.1). 증적은 entity_events 가 갖는다.
  const admin = createAdminClient();
  const { data: activity } = membership
    ? await admin
        .from("entity_events")
        .select("id, event_type, actor_id, occurred_at")
        .eq("entity_type", "couple")
        .eq("entity_id", membership.coupleId)
        .order("occurred_at", { ascending: false })
        .limit(5)
    : { data: [] };

  return (
    <ConsumerShell title="시작하기" hideTabBar>
      <div className="space-y-6">
        <Card>
          <CardContent className="pt-6">
            <OnboardingStepper answers={answers} complete={complete} />
          </CardContent>
        </Card>

        {complete ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">배우자와 함께 준비하기</CardTitle>
              <CardDescription>
                연결하면 두 분이 같은 정보를 보고 함께 고를 수 있어요.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <PartnerInvite
                role={(membership?.role as "owner" | "partner") ?? null}
                paired={paired}
                appUrl={process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"}
              />
            </CardContent>
          </Card>
        ) : null}

        {activity && activity.length > 0 ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">최근 활동</CardTitle>
              <CardDescription>누가 무엇을 했는지 기록으로 남습니다.</CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="space-y-1" data-testid="couple-activity">
                {activity.map((event) => (
                  <li key={event.id} className="text-caption text-muted-foreground">
                    {event.occurred_at.slice(0, 16).replace("T", " ")} · {event.event_type}
                    {event.actor_id === user.id ? " · 나" : " · 배우자"}
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        ) : null}
      </div>
    </ConsumerShell>
  );
}
