import type { Metadata } from "next";
import Link from "next/link";

import { AdminShell } from "@/components/layout/AdminShell";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { loadVendorQna } from "@/lib/qna/loader";
import { requireUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";
import { findMemberVendor } from "@/lib/vendor/products";

import { VendorQnaView } from "./VendorQnaView";

export const metadata: Metadata = {
  title: "문의게시판 — 웨딩클리어",
};

/**
 * /vendor/qna (F-V-16, §6.3)
 *
 * **미답변 큐가 먼저다.** 0021 이 그 경로에 부분 인덱스를 깔아 두었다.
 * staff 도 답한다 — 가격·정산이 아니므로 S2-07 의 제한 대상이 아니다.
 */
export default async function VendorQnaPage() {
  const user = await requireUser("/vendor/qna");
  const vendor = await findMemberVendor(user.id);

  if (!vendor) {
    return (
      <AdminShell role="vendor" title="문의게시판">
        <Card>
          <CardContent className="pt-6">
            <EmptyState
              assetId="vendor.dashboard.empty"
              title="아직 등록된 업체가 없어요"
              description="입점 신청을 마치면 고객 질문을 받을 수 있습니다."
              action={
                <Button size="touch" asChild>
                  <Link href="/vendor/apply">입점 신청하러 가기</Link>
                </Button>
              }
            />
          </CardContent>
        </Card>
      </AdminShell>
    );
  }

  const supabase = await createClient();

  try {
    const { posts, unansweredCount } = await loadVendorQna(supabase, vendor.id);

    return (
      <AdminShell
        role="vendor"
        title="문의게시판"
        description={
          unansweredCount > 0
            ? `답변 대기 ${unansweredCount}건. 공개 질문의 답변은 다음 고객도 봅니다.`
            : "답변 대기 중인 질문이 없어요."
        }
      >
        <VendorQnaView initialPosts={posts} viewerId={user.id} />
      </AdminShell>
    );
  } catch {
    return (
      <AdminShell role="vendor" title="문의게시판">
        <ErrorState
          code="QNA_LOAD_FAILED"
          title="질문을 불러오지 못했어요"
          description="잠시 후 다시 시도해 주세요."
        />
      </AdminShell>
    );
  }
}
