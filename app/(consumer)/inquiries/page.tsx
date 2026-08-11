import type { Metadata } from "next";
import { Suspense } from "react";

import { ConsumerShell } from "@/components/layout/ConsumerShell";
import { ErrorState } from "@/components/ui/ErrorState";
import { LoadingState } from "@/components/ui/LoadingState";
import { effectiveMaxTargets } from "@/lib/core/inquiry/inquiry";
import { loadMaxTargets, loadMyInquiries, loadSlaThreshold } from "@/lib/inquiry/loader";
import { requireUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";

import { InquiriesView } from "./InquiriesView";

export const metadata: Metadata = {
  title: "문의함 — 웨딩클리어",
};

/**
 * /inquiries (F-C-13, §6.2)
 *
 * 로그인이 필요하다. 미인증 차단은 미들웨어가 한다(S3-01).
 * 로딩 상태는 `loading.tsx` 가 아니라 페이지 안쪽 Suspense 다(S3-03).
 *
 * 하단 탭에 넣지 않았다 — 탭은 다섯이 상한이고 이미 찼다(BottomTabNav 주석).
 * 진입은 홈·탐색 비교 화면과 업체 상세다.
 */
export default async function InquiriesPage() {
  await requireUser("/inquiries");

  return (
    <ConsumerShell title="문의함">
      <Suspense fallback={<LoadingState label="문의를 불러오는 중" rows={4} variant="block" />}>
        <InquiriesSection />
      </Suspense>
    </ConsumerShell>
  );
}

async function InquiriesSection() {
  await requireUser("/inquiries");
  const supabase = await createClient();

  try {
    // RLS 가 자기 커플의 문의만 보여준다 — 여기서 couple_id 로 다시 거르지 않는다.
    const inquiries = await loadMyInquiries(supabase, {
      threshold: await loadSlaThreshold(),
      now: new Date(),
    });

    return (
      <InquiriesView
        initialInquiries={inquiries}
        maxTargets={effectiveMaxTargets(await loadMaxTargets())}
      />
    );
  } catch {
    return (
      <ErrorState
        code="INQUIRY_LOAD_FAILED"
        title="문의를 불러오지 못했어요"
        description="잠시 후 다시 시도해 주세요."
      />
    );
  }
}
