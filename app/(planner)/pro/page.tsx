import type { Metadata } from "next";
import Link from "next/link";

import { AdminShell } from "@/components/layout/AdminShell";
import { ErrorState } from "@/components/ui/ErrorState";
import { PROFILE_TITLE } from "@/lib/core/planner/profile";
import { loadMyPlanner } from "@/lib/planners/loader";
import { requireUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";

import { ProfileForm } from "./ProfileForm";

export const metadata: Metadata = {
  title: "플래너 콘솔 — 웨딩클리어",
};

/**
 * /pro (F-C-18, §6.2 보완 제안)
 *
 * ── 왜 `/pro` 인가 ──────────────────────────────────────────────────────────
 * `/planner`(단수)는 §6.2 가 **AI 플래너 채팅**(F-C-03, 7단계)에 배정한 경로다 —
 * 같은 접두어를 쓰면 "AI 플래너" 와 "사람 플래너" 가 한 자리에서 뒤섞인다.
 * `/planners`(복수)는 **소비자용 마켓**이라 셸도 RLS 전제도 다르다. 그래서 업체
 * (`/vendor`)·운영자(`/admin`)와 같은 모양의 접두어를 새로 쓴다. 명세 §6 반영 제안(§7.5).
 *
 * ── AdminShell 을 쓴다 ──────────────────────────────────────────────────────
 * 플래너는 **공급자 측 업무 콘솔**이고 화면 구조가 업체 어드민과 같다. ConsumerShell
 * (375px·하단 탭 5개)에는 맞지 않고, 별도 셸을 만들면 같은 레이아웃이 두 벌이 되어
 * 한쪽만 고치는 날이 온다 — role 하나로 갈랐다(AdminShell 주석 참조).
 *
 * **아직 등록하지 않은 사람도 들어온다.** 이 화면이 곧 등록 화면이므로 `planners`
 * 행이 없어도 404 로 막지 않는다.
 */
export default async function PlannerConsolePage() {
  const user = await requireUser("/pro");

  try {
    const planner = await loadMyPlanner(await createClient(), user.id);

    return (
      <AdminShell
        role="planner"
        title={PROFILE_TITLE}
        description={
          planner === null
            ? "프로필을 등록하면 마켓 공개를 신청할 수 있어요."
            : "프로필과 공개 상태를 관리합니다. 요금은 요율 설정에서 다뤄요."
        }
      >
        {/* S6-06. **플래너가 가장 먼저 묻는 것**이 "나는 무엇으로 평가되는가" 다.
            기준을 감추면 그 자리를 추측과 소문이 채운다(D-25). */}
        <p className="mb-4 rounded-lg border border-border bg-muted px-3 py-2 text-xs text-neutral-700">
          마켓의 순서는 실적 지표와 사실 정보로만 정해요.{" "}
          <Link href="/planners/ranking" className="font-medium text-brand-600">
            무엇을 세고 무엇을 안 세는지 보기
          </Link>
        </p>

        <ProfileForm
          data={{
            planner:
              planner === null
                ? null
                : {
                    id: planner.id,
                    headline: planner.headline,
                    bio: planner.bio,
                    careerYears: planner.careerYears,
                    categories: planner.categories,
                    regions: planner.regions,
                    status: planner.status,
                    contractCount: planner.contractCount,
                  },
          }}
        />
      </AdminShell>
    );
  } catch {
    return (
      <AdminShell role="planner" title={PROFILE_TITLE}>
        <ErrorState
          code="PLANNER_PROFILE_FAILED"
          title="프로필을 불러오지 못했어요"
          description="잠시 후 다시 시도해 주세요."
        />
      </AdminShell>
    );
  }
}
