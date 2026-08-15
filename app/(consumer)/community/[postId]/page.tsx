import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { ConsumerShell } from "@/components/layout/ConsumerShell";
import { LoadingState } from "@/components/ui/LoadingState";
import { COMMUNITY_FLAG, isFeatureEnabled } from "@/lib/flags";
import { loadPost } from "@/lib/community/loader";
import { createPublicClient } from "@/lib/explore/query";
import { getSessionUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";

import { PostDetailView } from "./PostDetailView";

export const metadata: Metadata = {
  title: "커뮤니티 — 웨딩클리어",
};

/**
 * /community/[postId] — 글 상세 (F-C-32·33·34 · 명세서 §6.2)
 *
 * **비로그인도 읽는다**(published 만 anon SELECT). 좋아요·댓글·신고부터 로그인이며,
 * 그 판정은 RLS 가 한다 — 화면은 버튼을 그리고 서버가 401 로 답한다.
 *
 * 조회수는 상세 API 가 올린다(`bump_post_view`). 서버 컴포넌트에서 올리지 않는 이유는
 * 프리페치·재렌더로 여러 번 불릴 수 있기 때문이며, **정확성을 약속하지 않는 값**이라도
 * 예측 가능한 자리에서 오르는 편이 낫다.
 */
export default async function CommunityPostPage({ params }: { params: { postId: string } }) {
  if (!(await isFeatureEnabled(COMMUNITY_FLAG))) notFound();

  return (
    <ConsumerShell title="커뮤니티" activeTab="/home">
      <Suspense fallback={<LoadingState label="글을 불러오는 중" rows={4} variant="block" />}>
        <DetailSection postId={params.postId} />
      </Suspense>
    </ConsumerShell>
  );
}

async function DetailSection({ postId }: { postId: string }) {
  const user = await getSessionUser();
  const supabase = await createClient();

  const post = await loadPost(supabase, createPublicClient(), postId, user?.id ?? null);

  // 남의 비공개 글은 RLS 가 막는다 — **존재 여부도 알리지 않는다.**
  if (post === null) notFound();

  return <PostDetailView initial={post} />;
}
