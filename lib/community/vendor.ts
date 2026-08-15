import type { SupabaseClient } from "@supabase/supabase-js";

import { recordEvent } from "@/lib/audit/record";
import { visibleBody, type PostStatus } from "@/lib/core/community/community";
import {
  taggedPostState,
  vendorReplyProblem,
  type TaggedPostState,
} from "@/lib/core/community/vendor-reply";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * 업체의 커뮤니티 대응 (S7-16 · 명세서 §2.2 F-V-18 · §4.3)
 *
 * **세션 클라이언트로 읽는다.** 0038 이 `community_post_tags_select_vendor` 와
 * `community_comments_insert`(태그된 업체 허용)를 만들었고 그것이 경계다 — 서비스롤로
 * 읽으면 "자사 태그" 판정이 이 파일의 조건문이 된다.
 *
 * **글이 비공개로 내려가도 태그는 보인다**(0038 주석). 답변할 글을 찾는 경로이기
 * 때문이며, 그래서 목록에는 뜨되 답변은 막힌다(아무도 읽지 않는 말을 남기지 않는다).
 */

export type TaggedPost = {
  postId: string;
  title: string;
  body: string;
  status: PostStatus;
  createdAt: string;
  taggedAt: string;
  /** 이 업체가 이미 남긴 공식 답변. 있으면 고칠 수 있다. */
  reply: { id: string; body: string; createdAt: string } | null;
  state: TaggedPostState;
  /** 이 업체가 이 글을 이미 신고했는가. 두 번 신고할 수 없다(0038 유니크). */
  reported: boolean;
};

type TagRow = { post_id: string; created_at: string };
type PostRow = { id: string; title: string; body: string; status: string; created_at: string };
type CommentRow = { id: string; post_id: string; author_id: string; body: string; created_at: string };

/**
 * 자사가 태그된 글.
 *
 * `memberIds` 는 **이 업체의 구성원 전체**다. 답변은 개인이 남기지만 **업체의 말**이라
 * 담당자가 바뀌어도 "이미 답변함" 이 유지돼야 한다 — 그래서 작성자 한 명이 아니라
 * 조직으로 센다.
 */
export async function loadTaggedPosts(
  client: SupabaseClient,
  input: { vendorId: string; memberIds: readonly string[]; viewerId: string },
): Promise<TaggedPost[]> {
  const { data: tagRows } = await client
    .from("community_post_tags")
    .select("post_id, created_at")
    .eq("vendor_id", input.vendorId)
    .order("created_at", { ascending: false })
    .limit(50);

  const tags = (tagRows ?? []) as TagRow[];
  if (tags.length === 0) return [];

  const postIds = tags.map((tag) => tag.post_id);

  const [{ data: postRows }, { data: commentRows }, { data: reportRows }] = await Promise.all([
    client.from("community_posts").select("id, title, body, status, created_at").in("id", postIds),
    client
      .from("community_comments")
      .select("id, post_id, author_id, body, created_at")
      .in("post_id", postIds)
      .eq("status", "published"),
    client.from("community_reports").select("target_id").in("target_id", postIds),
  ]);

  const posts = new Map(((postRows ?? []) as PostRow[]).map((row) => [row.id, row]));
  const comments = (commentRows ?? []) as CommentRow[];
  const reported = new Set(((reportRows ?? []) as { target_id: string }[]).map((row) => row.target_id));

  const members = new Set(input.memberIds);

  return tags
    .filter((tag) => posts.has(tag.post_id))
    .map((tag) => {
      const post = posts.get(tag.post_id) as PostRow;
      const status = post.status as PostStatus;

      // **조직으로 센다** — 담당자가 바뀌어도 "이미 답변함" 이 유지돼야 한다.
      const ours = comments
        .filter((comment) => comment.post_id === post.id && members.has(comment.author_id))
        .sort((a, b) => a.created_at.localeCompare(b.created_at));

      const mine = ours.find((comment) => comment.author_id === input.viewerId) ?? ours[0] ?? null;

      return {
        postId: post.id,
        title: post.title,
        // 가려진 글의 본문은 화면에서도 가린다(D-23 · 소비자 화면과 같은 규칙).
        body: visibleBody({ status, body: post.body }),
        status,
        createdAt: post.created_at,
        taggedAt: tag.created_at,
        reply:
          mine === undefined || mine === null
            ? null
            : { id: mine.id, body: mine.body, createdAt: mine.created_at },
        state: taggedPostState({ existingReplies: ours.length, targetStatus: status }),
        reported: reported.has(post.id),
      };
    });
}

export type ReplyResult =
  | { ok: true; commentId: string }
  | { ok: false; status: number; code: string; message: string };

/**
 * 공식 답변을 남긴다.
 *
 * **삽입은 세션 클라이언트로 한다** — 0038 의 `community_comments_insert` 가
 * "태그된 업체" 를 허용하고 그 판정이 경계다. 여기서 서비스롤을 쓰면 태그되지 않은
 * 글에도 답변이 들어간다.
 */
export async function replyToTaggedPost(
  client: SupabaseClient,
  input: { postId: string; vendorId: string; memberIds: readonly string[]; viewerId: string; body: string },
): Promise<ReplyResult> {
  const posts = await loadTaggedPosts(client, {
    vendorId: input.vendorId,
    memberIds: input.memberIds,
    viewerId: input.viewerId,
  });

  const target = posts.find((post) => post.postId === input.postId);

  // 태그되지 않은 글이면 목록에 없다. **존재 여부도 알리지 않는다.**
  if (target === undefined) {
    return { ok: false, status: 404, code: "VENDOR_TAG_NOT_FOUND", message: "태그된 글을 찾을 수 없어요." };
  }

  const problem = vendorReplyProblem({
    body: input.body,
    existingReplies: target.reply === null ? 0 : 1,
    targetStatus: target.status,
  });

  if (problem !== null) {
    return {
      ok: false,
      status: problem.field === "limit" ? 409 : 422,
      code: `VENDOR_REPLY_${problem.field.toUpperCase()}`,
      message: problem.message,
    };
  }

  const { data: created, error } = await client
    .from("community_comments")
    .insert({ post_id: input.postId, body: input.body.trim() })
    .select("id")
    .maybeSingle();

  const commentId = (created as { id: string } | null)?.id ?? null;

  if (error || commentId === null) {
    return { ok: false, status: 403, code: "VENDOR_REPLY_FORBIDDEN", message: "답변을 남기지 못했어요." };
  }

  await recordEvent({
    entityType: "community_comment",
    entityId: commentId,
    eventType: "community_vendor_replied",
    actor: { id: input.viewerId, role: "vendor" },
    afterState: "published",
    // **본문을 넣지 않는다**(§7.3). 남길 사실은 업체 답변이라는 것뿐이다.
    memo: `vendor:${input.vendorId}`,
  });

  return { ok: true, commentId };
}

/**
 * 답변을 고친다.
 *
 * **새 답변을 다는 것과 다르다**(글당 한 번 규칙은 추가에 대한 것이다). 정책이
 * 작성자 본인만 허용하므로(0038) 남의 답변은 0행으로 끝난다.
 */
export async function editReply(
  client: SupabaseClient,
  input: { commentId: string; body: string; viewerId: string },
): Promise<ReplyResult> {
  const { data: updated } = await client
    .from("community_comments")
    .update({ body: input.body.trim() })
    .eq("id", input.commentId)
    .select("id");

  if ((updated ?? []).length === 0) {
    return { ok: false, status: 403, code: "VENDOR_REPLY_FORBIDDEN", message: "이 답변을 고칠 권한이 없어요." };
  }

  await recordEvent({
    entityType: "community_comment",
    entityId: input.commentId,
    eventType: "community_vendor_reply_updated",
    actor: { id: input.viewerId, role: "vendor" },
  });

  return { ok: true, commentId: input.commentId };
}

/** 업체 구성원 id. 답변을 조직으로 세기 위해 필요하다(§3.9 상 세션으로는 안 보인다). */
export async function vendorMemberIds(vendorId: string): Promise<string[]> {
  const { data } = await createAdminClient()
    .from("vendor_members")
    .select("user_id")
    .eq("vendor_id", vendorId);

  return ((data ?? []) as { user_id: string }[]).map((row) => row.user_id);
}
