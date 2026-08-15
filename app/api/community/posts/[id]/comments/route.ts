import type { NextRequest } from "next/server";

import { recordEvent } from "@/lib/audit/record";
import { fail, failValidation, ok } from "@/lib/api/response";
import { VENDOR_REPLY_ONLY_NOTE, commentProblem } from "@/lib/core/community/community";
import { CommentCreateSchema } from "@/lib/core/schemas/community";
import { COMMUNITY_FLAG, communityClosedNotice, isFeatureEnabled } from "@/lib/flags";
import { loadPost } from "@/lib/community/loader";
import { createPublicClient } from "@/lib/explore/query";
import { getSessionUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";

/**
 * GET/POST /api/community/posts/[id]/comments — 댓글 (F-C-32, §4.2)
 *
 * **업체는 답변만 한다**(F-V-18). 자사가 태그된 글에 댓글을 달 수 있고 본문은 고칠 수
 * 없다 — 그 경계는 RLS 가 지키며(0038: 업체에게 posts UPDATE 정책이 없다) 여기서
 * 다시 판정하지 않는다. 경계가 둘이면 한쪽이 느슨해지는 날이 온다.
 *
 * **답글의 답글은 DB 트리거가 막는다**(2단 제한). 화면이 그 깊이를 자르면 데이터에는
 * 있는데 보이지 않는 댓글이 생긴다.
 */
export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  if (!(await isFeatureEnabled(COMMUNITY_FLAG))) {
    return fail(404, "COMMUNITY_CLOSED", communityClosedNotice());
  }

  const user = await getSessionUser();
  const supabase = await createClient();

  const post = await loadPost(supabase, createPublicClient(), params.id, user?.id ?? null);
  if (post === null) return fail(404, "COMMUNITY_POST_NOT_FOUND", "글을 찾을 수 없습니다.");

  return ok({ comments: post.comments, vendorReplyNote: VENDOR_REPLY_ONLY_NOTE });
}

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  if (!(await isFeatureEnabled(COMMUNITY_FLAG))) {
    return fail(404, "COMMUNITY_CLOSED", communityClosedNotice());
  }

  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "COMMUNITY_INVALID_BODY", "요청 본문을 읽지 못했습니다.");
  }

  const parsed = CommentCreateSchema.safeParse(body);
  if (!parsed.success) return failValidation(parsed.error.issues);

  const problem = commentProblem(parsed.data.body);
  if (problem !== null) return fail(422, "COMMUNITY_COMMENT_INVALID", problem);

  const supabase = await createClient();

  const { data: created, error } = await supabase
    .from("community_comments")
    .insert({
      post_id: params.id,
      body: parsed.data.body,
      parent_id: parsed.data.parentId ?? null,
    })
    .select("id")
    .maybeSingle();

  const commentId = (created as { id: string } | null)?.id ?? null;

  if (error || commentId === null) {
    // 트리거·정책이 거절한 경우다. **DB 메시지를 그대로 흘리지 않는다**(§5.3).
    return fail(403, "COMMUNITY_COMMENT_FORBIDDEN", "이 글에는 댓글을 달 수 없어요.");
  }

  await recordEvent({
    entityType: "community_comment",
    entityId: commentId,
    eventType: "community_comment_created",
    actor: { id: user.id },
    afterState: "published",
    // 본문을 넣지 않는다. 남길 사실은 답글 여부다(§7.3).
    memo: parsed.data.parentId === undefined ? "top" : "reply",
  });

  return ok({ commentId }, { status: 201 });
}
