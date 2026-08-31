import type { Metadata } from "next";

import { AdminShell } from "@/components/layout/AdminShell";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import {
  PLANNER_ACCEPT_NOTICE,
  PLANNER_INBOX_EMPTY_BODY,
  PLANNER_INBOX_EMPTY_TITLE,
  PLANNER_INBOX_TITLE,
} from "@/lib/core/planner/delegation";
import { loadPlannerInbox, plannerIdOf } from "@/lib/planners/delegation";
import { requireUser } from "@/lib/supabase/auth";

import { InboxList } from "./InboxList";

export const metadata: Metadata = {
  title: "받은 위임 — 웨딩클리어",
};

/**
 * /pro/engagements — 받은 위임 제안 (F-C-18 · §6.2 보완 제안 · S6-04)
 *
 * ── 이 화면이 지키는 규칙 ───────────────────────────────────────────────────
 * 1. **수락 전에는 고객이 누구인지도 보이지 않는다.** `couples` 는 활성 위임에만
 *    열리므로(0005 `has_planner_scope`) 여기에는 **거래 조건**(범위·기간·제안 시각)만
 *    실린다. 이름을 보여 주려면 위임 제안 자체가 개인정보 열람 경로가 되어야 하는데,
 *    그것은 "수락해야 열린다" 는 규칙과 정면으로 어긋난다. 화면이 그 사실을 적는다.
 * 2. **범위를 넓힐 수 없다는 사실을 적는다.** 스스로 넓히면 자기 수수료를 늘리는
 *    행위이므로 정책·컬럼 권한이 막는다(0069) — 화면도 같은 말을 한다.
 * 3. **거절도 기록이다.** 거절한 제안을 목록에서 지우지 않는다(D-23).
 * 4. **캐시하지 않는다** — 기간이 시계로 판정되고 쿠키를 읽는다(함정 4).
 */
export const dynamic = "force-dynamic";

export default async function PlannerEngagementsPage() {
  const user = await requireUser("/pro/engagements");
  const plannerId = await plannerIdOf(user.id);

  if (plannerId === null) {
    return (
      <AdminShell role="planner" title={PLANNER_INBOX_TITLE}>
        <ErrorState
          code="PLANNER_NOT_REGISTERED"
          title="아직 플래너 프로필이 없어요"
          description="내 프로필에서 등록을 마치면 고객이 위임을 제안할 수 있어요."
        />
      </AdminShell>
    );
  }

  try {
    const payload = await loadPlannerInbox({ plannerId, now: new Date() });

    return (
      <AdminShell
        role="planner"
        title={PLANNER_INBOX_TITLE}
        description="고객이 제안한 열람 범위와 기간입니다. 수락해야 열려요."
      >
        <div className="space-y-4">
          <p className="rounded-lg border border-border bg-muted px-3 py-2 text-xs text-neutral-700">
            {PLANNER_ACCEPT_NOTICE}
          </p>

          {/* 못 보는 것을 감추지 않는다 — "왜 고객 이름이 없나" 에 먼저 답한다. */}
          <p className="text-xs text-neutral-500">
            수락하기 전에는 고객이 누구인지 열리지 않아요. 제안에 적힌 범위와 기간만 보고 판단합니다.
          </p>

          {payload.rows.length === 0 ? (
            <EmptyState
              title={PLANNER_INBOX_EMPTY_TITLE}
              description={PLANNER_INBOX_EMPTY_BODY}
            />
          ) : (
            <InboxList rows={payload.rows} />
          )}
        </div>
      </AdminShell>
    );
  } catch {
    return (
      <AdminShell role="planner" title={PLANNER_INBOX_TITLE}>
        <ErrorState
          code="DELEGATION_INBOX_FAILED"
          title="받은 위임을 불러오지 못했어요"
          description="잠시 후 다시 시도해 주세요."
        />
      </AdminShell>
    );
  }
}
