import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/response";
import { COMMUNITY_FLAG, communityClosedNotice, isFeatureEnabled } from "@/lib/flags";
import { getSessionUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";

/**
 * POST/DELETE /api/community/posts/[id]/like — 좋아요 (F-C-32, §4.2)
 *
 * **행이 권위 있는 값이고 `like_count` 는 캐시다**(§3.7 NOTE). 이 라우트는 행만
 * 만들고 지우며, 캐시는 같은 트랜잭션의 트리거가 맞춘다 — 여기서 카운터를 올리려
 * 하면 열 단위 GRANT 가 막는다(0038).
 *
 * **증적을 남기지 않는다.** 좋아요는 상태 전이가 아니라 취향이고, 누가 무엇을
 * 좋아했는지 이벤트로 쌓으면 그것은 증적이 아니라 기호 수집이다(§7.3 최소화).
 *
 * 응답에 갱신된 수를 실어 화면이 다시 조회하지 않게 한다.
 */
async function likeCount(postId: string): Promise<number | null> {
  const supabase = await createClient();

  const { data } = await supabase
    .from("community_posts")
    .select("like_count")
    .eq("id", postId)
    .maybeSingle();

  return (data as { like_count: number } | null)?.like_count ?? null;
}

export async function POST(_request: NextRequest, { params }: { params: { id: string } }) {
  if (!(await isFeatureEnabled(COMMUNITY_FLAG))) {
    return fail(404, "COMMUNITY_CLOSED", communityClosedNotice());
  }

  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  const supabase = await createClient();

  // 사용자 id 는 DB 기본값(`auth.uid()`)이 채우고 정책이 확인한다(0038).
  const { error } = await supabase.from("community_likes").insert({ post_id: params.id });

  // 이미 눌렀으면 유니크가 막는다. **그것을 실패로 보이지 않는다** — 누른 상태가 목표다.
  if (error && !String(error.code).startsWith("23")) {
    return fail(403, "COMMUNITY_LIKE_FORBIDDEN", "좋아요를 누를 수 없어요.");
  }

  return ok({ liked: true, likeCount: await likeCount(params.id) });
}

export async function DELETE(_request: NextRequest, { params }: { params: { id: string } }) {
  if (!(await isFeatureEnabled(COMMUNITY_FLAG))) {
    return fail(404, "COMMUNITY_CLOSED", communityClosedNotice());
  }

  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  const supabase = await createClient();

  // 본인 행만 지워진다(정책). 남의 좋아요를 지우려 해도 0행으로 끝난다.
  await supabase.from("community_likes").delete().eq("post_id", params.id);

  return ok({ liked: false, likeCount: await likeCount(params.id) });
}
