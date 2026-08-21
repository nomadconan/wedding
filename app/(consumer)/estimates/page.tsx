import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { ConsumerShell } from "@/components/layout/ConsumerShell";
import { EmptyState } from "@/components/ui/EmptyState";
import { LoadingState } from "@/components/ui/LoadingState";
import { NO_UPLOAD_NOTE } from "@/lib/core/estimate/normalize";
import { findMyCouple } from "@/lib/couple/membership";
import { listEstimateCandidates } from "@/lib/estimates/loader";
import { requireUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";

import { EstimatesView } from "./EstimatesView";

export const metadata: Metadata = {
  title: "견적 비교 — 웨딩클리어",
};

/**
 * /estimates — 견적 비교 (F-C-06 · 명세서 §6.2 · §5.4)
 *
 * **세션 클라이언트로 읽는다** — `quotes` 는 상위 `inquiry_targets`·`inquiries` 스코프이고
 * 커플 구성원만 본다. 업체 이름·카테고리만 `estimate_quote_sources()`(SECURITY DEFINER ·
 * 0047)를 지난다: `vendors` 를 임베드로 읽으면 **행이 안 보일 때 조용히 `null` 이 오고**
 * 그 값이 분류의 근거라 견적이 통째로 `unmapped` 가 된다(S7-07 이 겪은 것과 같은 계열).
 * 쿠키를 읽으므로 이 페이지는 동적이며 FIX-22 의 캐시 문제가 붙지 않는다.
 *
 * 하단 탭은 '홈' 을 켠다 — 다섯 칸이 이미 찼고(D-55) 진입은 **문의함(`/inquiries`)** 이다.
 * 견적을 받는 곳이 거기이기 때문이다.
 */
export default async function EstimatesPage() {
  await requireUser("/estimates");

  return (
    <ConsumerShell title="견적 비교" activeTab="/home">
      <Suspense fallback={<LoadingState label="견적을 불러오는 중" rows={3} variant="list" />}>
        <EstimatesSection />
      </Suspense>
    </ConsumerShell>
  );
}

async function EstimatesSection() {
  const user = await requireUser("/estimates");
  const membership = await findMyCouple(user.id);

  if (!membership) {
    return (
      <EmptyState
        title="먼저 온보딩을 마쳐 주세요"
        description="문의를 보내야 업체에게서 견적을 받을 수 있어요."
        action={
          <Link href="/onboarding" className="text-sm font-medium text-brand-600">
            온보딩 하러 가기
          </Link>
        }
      />
    );
  }

  const supabase = await createClient();
  const candidates = await listEstimateCandidates(supabase, { coupleId: membership.coupleId });

  return (
    <EstimatesView
      initial={{
        candidates,
        estimates: [],
        comparison: null,
        noUploadNote: NO_UPLOAD_NOTE,
      }}
    />
  );
}
