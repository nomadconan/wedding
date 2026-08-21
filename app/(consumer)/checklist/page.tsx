import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { ConsumerShell } from "@/components/layout/ConsumerShell";
import { EmptyState } from "@/components/ui/EmptyState";
import { LoadingState } from "@/components/ui/LoadingState";
import { enabledViews } from "@/lib/core/schedule/view";
import { findMyCouple } from "@/lib/couple/membership";
import { SCHEDULE_VIEWS_FLAG, featureRollout } from "@/lib/flags";
import { loadChecklist } from "@/lib/tasks/loader";
import { requireUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";

import { ChecklistView } from "./ChecklistView";

export const metadata: Metadata = {
  title: "일정·준비 순서 — 웨딩클리어",
};

/**
 * /checklist — 일정·체크리스트·준비 순서 (F-C-04 · **F-C-37** · 명세서 §6.2)
 *
 * **표현 넷이 여기 붙었다**(S7-19) — 역산 타임라인(기본) · 진행 게이지 · 다음 할 일
 * 카드 · 의존 관계 뷰. **넷이 같은 조회를 쓴다**(§4.2): `loadChecklist` 한 번이
 * 태스크·간선·순서·타임라인·게이지·다음 할 일을 전부 싣고 화면이 나눠 그린다.
 * 뷰마다 조회를 따로 두면 같은 질문에 다른 답이 나온다.
 *
 * **세션 클라이언트로 읽는다** — `tasks`·`task_dependencies` 는 커플 스코프이고
 * 플래너 위임까지 RLS 가 판정한다(0005 [11] · 0042). 쿠키를 읽으므로 이 페이지는
 * 동적이며 FIX-22 의 캐시 문제가 붙지 않는다. **표현 스위치만 서비스롤**이고
 * (`feature_flags` 는 anon·authenticated 에게 권한이 없다) 그쪽은 `lib/flags.ts` 가
 * `no-store` 를 못 박아 둔다 — 스위치가 캐시되면 스위치 노릇을 못 한다.
 *
 * 하단 탭은 '홈' 을 켠다 — 다섯 칸이 이미 찼고(D-55) 진입은 홈의 '다음 할 일' 이다.
 */
export default async function ChecklistPage() {
  await requireUser("/checklist");

  return (
    <ConsumerShell title="일정·준비 순서" activeTab="/home">
      <Suspense fallback={<LoadingState label="일정을 불러오는 중" rows={4} variant="list" />}>
        <ChecklistSection />
      </Suspense>
    </ConsumerShell>
  );
}

async function ChecklistSection() {
  const user = await requireUser("/checklist");
  const membership = await findMyCouple(user.id);

  if (!membership) {
    return (
      <EmptyState
        title="먼저 온보딩을 마쳐 주세요"
        description="예식일을 알아야 준비 일정을 역산해 만들 수 있어요."
        action={
          <Link href="/onboarding" className="text-sm font-medium text-brand-600">
            온보딩 하러 가기
          </Link>
        }
      />
    );
  }

  const supabase = await createClient();

  const { data: couple } = await supabase
    .from("couples")
    .select("wedding_date")
    .eq("id", membership.coupleId)
    .maybeSingle();

  const view = await loadChecklist(supabase, {
    coupleId: membership.coupleId,
    today: new Date().toISOString().slice(0, 10),
  });

  // O-16 이 못 주는 표현을 끄기로 하면 **행 하나로** 꺼진다(§7.5 · 0043).
  // 지금은 넷 다 켜져 있고, 판정은 지표가 붙는 S8-01 이후다.
  const views = enabledViews(await featureRollout(SCHEDULE_VIEWS_FLAG));

  return (
    <div className="space-y-4">
      {/* 순환이 남아 있으면 숨기지 않는다 — 조용히 임의 순서를 그리면 그것이 순서로 믿긴다. */}
      {view.cycle.length > 0 ? (
        <p className="rounded-lg border border-warning/40 p-3 text-caption text-warning">
          선행 관계가 돌고 도는 항목이 {view.cycle.length}건 있어요. 순서 표시가 정확하지 않을 수 있습니다.
        </p>
      ) : null}

      <ChecklistView
        initialTasks={view.tasks}
        edges={view.edges}
        timeline={view.timeline}
        progress={view.progress}
        enabledViews={views}
        hasWeddingDate={(couple as { wedding_date: string | null } | null)?.wedding_date != null}
        generated={view.generatedCodes.length > 0}
      />
    </div>
  );
}
