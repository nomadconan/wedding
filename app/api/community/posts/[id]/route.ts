import type { NextRequest } from "next/server";

import { recordEvent } from "@/lib/audit/record";
import { fail, failValidation, ok } from "@/lib/api/response";
import { UNVERIFIED_NOTE, canTransition } from "@/lib/core/community/community";
import { PostUpdateSchema } from "@/lib/core/schemas/community";
import { COMMUNITY_FLAG, communityClosedNotice, isFeatureEnabled } from "@/lib/flags";
import { loadPost } from "@/lib/community/loader";
import { createPublicClient } from "@/lib/explore/query";
import { getSessionUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";

/**
 * GET/PUT/DELETE /api/community/posts/[id] — 상세·수정·삭제 (F-C-32, §4.2)
 *
 * **DELETE 는 행을 지우지 않는다.** 삭제는 `status='deleted'` 묘비이며(D-23) DB 는
 * DELETE 권한 자체를 회수했다 — 신고된 글을 지우면 신고 처리의 근거가 사라진다.
 * 그래서 이 메서드는 상태 전이를 수행하고, 전이 가능 여부는 순수 함수가 정한다.
 *
 * **조회수는 `bump_post_view` 로만 오른다**(0038). 여기서 올리는 이유는 상세를 여는
 * 순간이 유일하게 '읽었다' 고 말할 수 있는 시점이기 때문이며, **정확성을 약속하지
 * 않는다**(셀 원본을 만들지 않기로 한 결과다 · §3.7 NOTE).
 */
export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  if (!(await isFeatureEnabled(COMMUNITY_FLAG))) {
    return fail(404, "COMMUNITY_CLOSED", communityClosedNotice());
  }

  const user = await getSessionUser();
  const supabase = await createClient();

  const post = await loadPost(supabase, createPublicClient(), params.id, user?.id ?? null);

  // 남의 비공개 글은 RLS 가 막는다 — 안 보이면 **존재 여부도 알리지 않는다.**
  if (post === null) return fail(404, "COMMUNITY_POST_NOT_FOUND", "글을 찾을 수 없습니다.");

  if (post.status === "published") {
    await supabase.rpc("bump_post_view", { p_post_id: params.id });
  }

  return ok({ post, unverifiedNote: UNVERIFIED_NOTE });
}

export async function PUT(request: NextRequest, { params }: { params: { id: string } }) {
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

  const parsed = PostUpdateSchema.safeParse(body);
  if (!parsed.success) return failValidation(parsed.error.issues);

  const supabase = await createClient();

  const values: Record<string, unknown> = {};
  if (parsed.data.title !== undefined) values.title = parsed.data.title;
  if (parsed.data.body !== undefined) values.body = parsed.data.body;

  if (Object.keys(values).length === 0) {
    return fail(422, "COMMUNITY_NOTHING_TO_UPDATE", "고칠 내용을 적어 주세요.");
  }

  // **작성자만 고친다.** 정책이 행을 고르고 열 단위 GRANT 가 칸을 좁힌다(0038) —
  // 여기서 다시 검사하지 않는 이유는 경계가 하나여야 하기 때문이다.
  const { data: updated } = await supabase
    .from("community_posts")
    .update(values)
    .eq("id", params.id)
    .select("id");

  if ((updated ?? []).length === 0) {
    return fail(403, "COMMUNITY_POST_FORBIDDEN", "이 글을 고칠 권한이 없어요.");
  }

  await recordEvent({
    entityType: "community_post",
    entityId: params.id,
    eventType: "community_post_updated",
    actor: { id: user.id },
    // 본문을 남기지 않는다. 어느 칸을 고쳤는지만 남긴다(§7.3).
    memo: `fields:${Object.keys(values).join(",")}`,
  });

  return ok({ postId: params.id });
}

export async function DELETE(_request: NextRequest, { params }: { params: { id: string } }) {
  if (!(await isFeatureEnabled(COMMUNITY_FLAG))) {
    return fail(404, "COMMUNITY_CLOSED", communityClosedNotice());
  }

  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  const supabase = await createClient();

  const { data: current } = await supabase
    .from("community_posts")
    .select("status, author_id")
    .eq("id", params.id)
    .maybeSingle();

  const row = current as { status: string; author_id: string } | null;
  if (row === null) return fail(404, "COMMUNITY_POST_NOT_FOUND", "글을 찾을 수 없습니다.");

  // 전이 가능 여부는 **순수 함수가 정한다** — 세 면이 같은 표를 본다(S7-14).
  if (
    row.author_id !== user.id ||
    !canTransition({ actor: "author", from: row.status as never, to: "deleted" })
  ) {
    return fail(403, "COMMUNITY_POST_FORBIDDEN", "이 글을 지울 권한이 없어요.");
  }

  const { data: updated } = await supabase
    .from("community_posts")
    .update({ status: "deleted" })
    .eq("id", params.id)
    .select("id");

  if ((updated ?? []).length === 0) {
    return fail(403, "COMMUNITY_POST_FORBIDDEN", "이 글을 지울 권한이 없어요.");
  }

  await recordEvent({
    entityType: "community_post",
    entityId: params.id,
    eventType: "community_post_deleted",
    actor: { id: user.id },
    beforeState: row.status,
    afterState: "deleted",
  });

  // **행은 남는다.** 신고 이력이 그 위에 서 있으며, 대상이 사라져도 신고가 남는 것이
  // 설계다(S7-14 — 왜 지웠는지 설명할 근거가 있어야 한다).
  return ok({ postId: params.id, status: "deleted" });
}
