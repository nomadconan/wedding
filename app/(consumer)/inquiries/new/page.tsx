import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { ConsumerShell } from "@/components/layout/ConsumerShell";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/EmptyState";
import { LoadingState } from "@/components/ui/LoadingState";
import { MAX_TARGETS_UNSET_NOTE, effectiveMaxTargets } from "@/lib/core/inquiry/inquiry";
import {
  INQUIRY_NEW_DESCRIPTION,
  INQUIRY_NO_CANDIDATE_NOTE,
} from "@/lib/core/inquiry/request-form";
import { findMyCouple } from "@/lib/couple/membership";
import { loadInquiryCandidates } from "@/lib/inquiry/candidates";
import { loadMaxTargets } from "@/lib/inquiry/loader";
import { requireUser } from "@/lib/supabase/auth";

import { InquiryForm } from "./InquiryForm";

export const metadata: Metadata = {
  title: "견적 요청 — 웨딩클리어",
};

/**
 * /inquiries/new — 표준 요청 폼 (FIX-66 · F-C-13 · §6.2 반영 제안)
 *
 * ── 사슬의 첫 칸이었다 ─────────────────────────────────────────────────────
 * `POST /api/inquiries` 의 `action:"create"` 를 부르는 자리가 리포에 **없었다.**
 * 그래서 `chain:walk`·`vendor:walk` 둘 다 이 칸을 **세션 fetch 로 우회**했고,
 * **실주행이 우회하는 단계는 실주행이 지키지 못한다.**
 *
 * ── 왜 별도 화면인가 ───────────────────────────────────────────────────────
 * 업체 상세에 1:1 '문의 보내기' 를 두면 **채팅과 구분이 사라진다**(S4-01 ·
 * `CONTACT_PATHS`). 문의는 "여러 업체에서 **같은 조건으로** 견적을 받아 비교" 하는
 * 경로이고 남는 것은 **업체별 표준 견적서**다. 업체 상세에서 오는 길은
 * `?vendor=<id>` 로 **그 업체가 미리 골라진 1:N 폼**에 닿는다.
 *
 * ── 하단 탭에 넣지 않았다 ──────────────────────────────────────────────────
 * 탭은 다섯이 상한이고 이미 찼다. 이 화면은 **문의함의 아래 화면**이며 진입은
 * 문의함(빈 상태 포함) · 업체 상세 · 비교 화면이다.
 *
 * **캐시하지 않는다** — 후보가 찜·장바구니에서 오므로 방금 담은 것이 보여야 한다.
 */
export const dynamic = "force-dynamic";

export default async function NewInquiryPage(props: {
  searchParams: Promise<{ vendor?: string }>;
}) {
  await requireUser("/inquiries/new");
  const searchParams = await props.searchParams;

  return (
    <ConsumerShell title="견적 요청" activeTab="/home">
      <Suspense fallback={<LoadingState label="후보 업체를 불러오는 중" rows={4} variant="block" />}>
        <NewInquirySection viewingVendorId={searchParams.vendor ?? null} />
      </Suspense>
    </ConsumerShell>
  );
}

async function NewInquirySection({ viewingVendorId }: { viewingVendorId: string | null }) {
  const user = await requireUser("/inquiries/new");
  const membership = await findMyCouple(user.id);

  // **온보딩이 전제다.** 서버도 같은 이유로 403 을 낸다(`INQUIRY_COUPLE_REQUIRED`) —
  // 화면이 먼저 말해 주지 않으면 다 적고 나서 거절당한다.
  if (!membership) {
    return (
      // `/estimates` 와 같은 자리다 — 오류가 아니라 **전제 미충족**이므로 빈 상태로
      // 그리고 **갈 곳을 준다**(`ErrorState` 에는 행동 버튼 자리가 없다).
      <EmptyState
        assetId="explore.empty"
        title="온보딩을 먼저 마쳐 주세요"
        description="예식일과 지역을 정해야 업체에 같은 조건으로 견적을 요청할 수 있어요."
        action={
          <Button size="touch" asChild>
            <Link href="/onboarding">온보딩 하러 가기</Link>
          </Button>
        }
      />
    );
  }

  const configured = await loadMaxTargets();
  const candidates = await loadInquiryCandidates({
    coupleId: membership.coupleId,
    viewingVendorId,
  });

  if (candidates.length === 0) {
    return (
      <EmptyState
        assetId="explore.empty"
        title="아직 후보로 담은 업체가 없어요"
        description={INQUIRY_NO_CANDIDATE_NOTE}
        action={
          <Button size="touch" asChild>
            <Link href="/explore">업체 둘러보기</Link>
          </Button>
        }
      />
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-caption text-muted-foreground">{INQUIRY_NEW_DESCRIPTION}</p>

      {/* **상한이 없으면 그 사실을 적는다.** `effectiveMaxTargets` 가 1 로 좁히는데
          이유를 안 적으면 "왜 한 곳만 되지" 가 된다(MAX_TARGETS_UNSET_NOTE 는 S4-12 가
          만들어 두고 아무 화면도 쓰지 않던 문장이다 · FIX-66 회차에 붙였다). */}
      {configured === null ? (
        <p
          className="rounded-lg border border-warning bg-warning-surface p-3 text-caption text-warning-foreground"
          data-testid="max-targets-unset"
        >
          {MAX_TARGETS_UNSET_NOTE}
        </p>
      ) : null}

      <InquiryForm
        candidates={candidates}
        maxTargets={effectiveMaxTargets(configured)}
        preselectedVendorId={viewingVendorId}
        // **오늘을 서버가 정해 넘긴다.** 브라우저 시계로 판정하면 시간대가 다른
        // 사용자에게 "지난 날짜" 가 달라진다(`isPastDate` 가 인자를 받는 이유).
        today={new Date().toISOString().slice(0, 10)}
      />
    </div>
  );
}
