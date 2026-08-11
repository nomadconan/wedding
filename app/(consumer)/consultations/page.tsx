import type { Metadata } from "next";
import { Suspense } from "react";

import { ConsumerShell } from "@/components/layout/ConsumerShell";
import { ErrorState } from "@/components/ui/ErrorState";
import { LoadingState } from "@/components/ui/LoadingState";
import { loadConsultationSettings, loadMyConsultations } from "@/lib/consultation/loader";
import { requireUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";

import { ConsultationsView } from "./ConsultationsView";

export const metadata: Metadata = {
  title: "상담·탐방 — 웨딩클리어",
};

/**
 * /consultations (F-C-29, §6.2)
 *
 * 로그인이 필요하다. 미인증 차단은 미들웨어가 한다(S3-01).
 * 로딩 상태는 `loading.tsx` 가 아니라 페이지 안쪽 Suspense 다(S3-03).
 *
 * 하단 탭에 넣지 않았다 — 탭은 다섯이 상한이고 이미 찼다. 진입은 업체 상세와
 * 채팅의 상담 제안 카드다.
 */
export default async function ConsultationsPage() {
  await requireUser("/consultations");

  return (
    <ConsumerShell title="상담·탐방">
      <Suspense fallback={<LoadingState label="예약을 불러오는 중" rows={3} variant="block" />}>
        <ConsultationsSection />
      </Suspense>
    </ConsumerShell>
  );
}

async function ConsultationsSection() {
  await requireUser("/consultations");
  const supabase = await createClient();

  try {
    // RLS 가 커플·업체·위임 플래너를 가른다 — 여기서 couple_id 로 다시 거르지 않는다.
    return (
      <ConsultationsView
        initialConsultations={await loadMyConsultations(supabase)}
        settings={await loadConsultationSettings()}
      />
    );
  } catch {
    return (
      <ErrorState
        code="CONSULTATION_LOAD_FAILED"
        title="예약을 불러오지 못했어요"
        description="잠시 후 다시 시도해 주세요."
      />
    );
  }
}
