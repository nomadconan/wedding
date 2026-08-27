import type { Metadata } from "next";
import Link from "next/link";

import { ConsumerShell } from "@/components/layout/ConsumerShell";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/EmptyState";
import { REVIEW_BLOCK_MESSAGE } from "@/lib/core/review/write";
import { loadReviewFormContext } from "@/lib/reviews/read";
import { requireUser } from "@/lib/supabase/auth";

import { ReviewForm } from "./ReviewForm";

export const metadata: Metadata = {
  title: "후기 쓰기 — 웨딩클리어",
};

/**
 * /reviews/new/[bookingId] — 검증 후기 작성 (F-C-17, §6.2 — 8단계 · S8-11)
 *
 * **자격은 화면이 판정하지 않는다.** 여기서 읽는 조건은 `reviews_insert` 정책이
 * 검사하는 것과 같은 조건이고, 둘이 갈리면 **RLS 가 이긴다**(CLAUDE.md §5.5).
 * 이 조회의 목적은 "저장 버튼을 눌러야 거절당하는" 경험을 없애는 것뿐이다.
 *
 * **막힌 이유를 그대로 적는다.** "쓸 수 없습니다" 만 적으면 사용자는 무엇이 잘못됐는지
 * 모른 채 떠난다 — 이미 썼다면 기존 후기로 보낸다.
 */
export const dynamic = "force-dynamic";

export default async function NewReviewPage({ params }: { params: { bookingId: string } }) {
  const user = await requireUser(`/reviews/new/${params.bookingId}`);
  const context = await loadReviewFormContext(user.id, params.bookingId);

  if (!context.ok) {
    return (
      <ConsumerShell title="후기 쓰기" activeTab="/home">
        <Card className="mx-gutter my-6">
          <CardContent className="pt-6">
            <EmptyState
              title="지금은 후기를 쓸 수 없어요"
              description={REVIEW_BLOCK_MESSAGE[context.reason]}
              action={
                <Button size="touch" asChild>
                  <Link href="/me">마이페이지로</Link>
                </Button>
              }
            />
          </CardContent>
        </Card>
      </ConsumerShell>
    );
  }

  return (
    <ConsumerShell title="후기 쓰기" activeTab="/home">
      <ReviewForm
        bookingId={context.bookingId}
        vendorName={context.vendorName}
        totalAmount={context.totalAmount}
      />
    </ConsumerShell>
  );
}
