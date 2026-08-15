import type { Metadata } from "next";
import Link from "next/link";

import { AdminShell } from "@/components/layout/AdminShell";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { COMMUNITY_FLAG, isFeatureEnabled } from "@/lib/flags";
import { loadTaggedPosts, vendorMemberIds } from "@/lib/community/vendor";
import { requireUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";
import { findMemberVendor } from "@/lib/vendor/products";

import { VendorCommunityView } from "./VendorCommunityView";

export const metadata: Metadata = {
  title: "커뮤니티 태그 — 웨딩클리어",
};

/**
 * /vendor/community (F-V-18, §6.3)
 *
 * **자사가 태그된 글만 본다.** 목록을 만드는 조건은 `community_post_tags` 이고 그
 * 판정은 RLS 가 한다(0038 `community_post_tags_select_vendor`) — 서비스롤로 읽으면
 * "자사" 판정이 앱 코드가 된다.
 *
 * **커뮤니티가 닫혀 있으면 그 사실을 적는다.** 화면을 막지는 않는다 — 이미 태그된
 * 글이 있다면 업체는 그것을 볼 수 있어야 하고, 닫힌 것은 소비자 입구다.
 *
 * 서비스롤로 읽는 것은 `vendorMemberIds` 하나이며(§3.9 상 남의 조직 구성은 세션으로
 * 안 보인다) 그 결과는 화면에 나가지 않는다 — "이미 답변함" 을 조직 단위로 세는 데만
 * 쓴다. `createClient()` 가 쿠키를 읽어 이 페이지는 동적이라 FIX-22 의 캐시 문제가
 * 붙지 않는다.
 */
export default async function VendorCommunityPage() {
  const user = await requireUser("/vendor/community");
  const vendor = await findMemberVendor(user.id);

  if (!vendor) {
    return (
      <AdminShell role="vendor" title="커뮤니티 태그">
        <Card>
          <CardContent className="pt-6">
            <EmptyState
              title="아직 등록된 업체가 없어요"
              description="입점 신청을 마치면 회원이 태그한 글을 보고 답변할 수 있습니다."
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

  try {
    const supabase = await createClient();

    const [posts, communityOpen] = await Promise.all([
      loadTaggedPosts(supabase, {
        vendorId: vendor.id,
        memberIds: await vendorMemberIds(vendor.id),
        viewerId: user.id,
      }),
      isFeatureEnabled(COMMUNITY_FLAG),
    ]);

    const pending = posts.filter((post) => post.state === "needs_reply").length;

    return (
      <AdminShell
        role="vendor"
        title="커뮤니티 태그"
        description={
          posts.length === 0
            ? "회원이 우리 업체를 태그한 글이 여기에 모입니다."
            : `태그된 글 ${posts.length}건 · 답변 전 ${pending}건`
        }
      >
        <div className="space-y-4">
          {communityOpen ? null : (
            <p
              className="rounded-lg border border-border bg-muted p-3 text-caption text-muted-foreground"
              data-testid="vendor-community-closed"
            >
              커뮤니티는 아직 열지 않았어요. 이미 태그된 글은 여기에서 보고 답변할 수 있습니다.
            </p>
          )}

          <VendorCommunityView posts={posts} />
        </div>
      </AdminShell>
    );
  } catch {
    return (
      <AdminShell role="vendor" title="커뮤니티 태그">
        <ErrorState
          code="VENDOR_COMMUNITY_FAILED"
          title="태그된 글을 불러오지 못했어요"
          description="잠시 후 다시 시도해 주세요."
        />
      </AdminShell>
    );
  }
}
