import type { SupabaseClient } from "@supabase/supabase-js";

import {
  sortPosts,
  visibleBody,
  type BoardType,
  type CommunitySort,
  type PostStatus,
} from "@/lib/core/community/community";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * 커뮤니티 조회 (S7-15 · 명세서 §6.2)
 *
 * **세션 클라이언트로 읽는다.** `community_posts` 는 `published` 만 anon 에게 열리고
 * 작성자·운영자는 자기 몫을 더 본다(0038). 그 판정이 인가의 최종 경계이므로 여기서
 * 서비스롤을 쓰지 않는다 — 쓰면 경계가 이 파일의 `eq("status", …)` 한 줄이 된다.
 *
 * **작성자 이름을 조회하지 않는다.** `profiles.display_name` 을 붙이면 글마다 사람이
 * 특정되고, 커뮤니티에서 그것은 필요보다 큰 노출이다. 화면은 "내 글" 여부만 안다 —
 * 그 판정에는 `author_id` 비교로 충분하다.
 */

export type CommunityPostRow = {
  id: string;
  boardType: BoardType;
  title: string;
  body: string;
  status: PostStatus;
  isMine: boolean;
  isPinned: boolean;
  likeCount: number;
  viewCount: number;
  commentCount: number;
  lastCommentAt: string | null;
  createdAt: string;
  tags: { vendorId: string; vendorName: string; verifiedPurchase: boolean }[];
};

export type CommunityComment = {
  id: string;
  parentId: string | null;
  body: string;
  status: PostStatus;
  isMine: boolean;
  createdAt: string;
  /** 태그된 업체의 멤버가 단 답변인가(F-V-18). 화면이 '업체 답변' 으로 구분한다. */
  isVendorReply: boolean;
};

export type CommunityPostDetail = CommunityPostRow & {
  comments: CommunityComment[];
  liked: boolean;
  scrapped: boolean;
};

type PostRecord = {
  id: string;
  author_id: string;
  board_type: string;
  title: string;
  body: string;
  status: string;
  is_pinned: boolean;
  like_count: number;
  view_count: number;
  created_at: string;
};

const POST_COLUMNS =
  "id, author_id, board_type, title, body, status, is_pinned, like_count, view_count, created_at";

/** 업체명은 공개 데이터라 익명 클라이언트로 읽는다(승인 업체만 보인다). */
async function vendorNames(
  publicClient: SupabaseClient,
  ids: readonly string[],
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();

  const { data } = await publicClient.from("vendors").select("id, name").in("id", [...ids]);

  return new Map(((data ?? []) as { id: string; name: string }[]).map((row) => [row.id, row.name]));
}

async function decorate(
  client: SupabaseClient,
  publicClient: SupabaseClient,
  posts: readonly PostRecord[],
  viewerId: string | null,
): Promise<CommunityPostRow[]> {
  if (posts.length === 0) return [];

  const ids = posts.map((post) => post.id);

  const [{ data: tagRows }, { data: commentRows }] = await Promise.all([
    client.from("community_post_tags").select("post_id, vendor_id, verified_purchase").in("post_id", ids),
    client
      .from("community_comments")
      .select("post_id, created_at")
      .in("post_id", ids)
      .eq("status", "published"),
  ]);

  const tags = (tagRows ?? []) as { post_id: string; vendor_id: string; verified_purchase: boolean }[];
  const names = await vendorNames(publicClient, [...new Set(tags.map((tag) => tag.vendor_id))]);

  const comments = (commentRows ?? []) as { post_id: string; created_at: string }[];

  return posts.map((post) => {
    const own = comments.filter((comment) => comment.post_id === post.id);

    return {
      id: post.id,
      boardType: post.board_type as BoardType,
      title: post.title,
      // 가려진·지워진 글의 본문은 화면에서 가린다. **행은 남는다**(D-23).
      body: visibleBody({ status: post.status as PostStatus, body: post.body }),
      status: post.status as PostStatus,
      isMine: viewerId !== null && post.author_id === viewerId,
      isPinned: post.is_pinned,
      likeCount: post.like_count,
      viewCount: post.view_count,
      commentCount: own.length,
      lastCommentAt: own.map((comment) => comment.created_at).sort().at(-1) ?? null,
      createdAt: post.created_at,
      tags: tags
        .filter((tag) => tag.post_id === post.id)
        .map((tag) => ({
          vendorId: tag.vendor_id,
          vendorName: names.get(tag.vendor_id) ?? "등록 업체",
          verifiedPurchase: tag.verified_purchase,
        })),
    };
  });
}

export async function listPosts(
  client: SupabaseClient,
  publicClient: SupabaseClient,
  options: { board: BoardType | null; sort: CommunitySort; viewerId: string | null },
): Promise<CommunityPostRow[]> {
  let query = client.from("community_posts").select(POST_COLUMNS).eq("status", "published");

  if (options.board !== null) query = query.eq("board_type", options.board);

  const { data } = await query.order("created_at", { ascending: false }).limit(50);

  const rows = await decorate(client, publicClient, (data ?? []) as unknown as PostRecord[], options.viewerId);

  // **정렬은 순수 함수가 한다** — 조회수·좋아요가 순서에 끼어들 자리를 만들지 않는다(D-03).
  return sortPosts(rows, options.sort);
}

export async function loadPost(
  client: SupabaseClient,
  publicClient: SupabaseClient,
  postId: string,
  viewerId: string | null,
): Promise<CommunityPostDetail | null> {
  const { data } = await client
    .from("community_posts")
    .select(POST_COLUMNS)
    .eq("id", postId)
    .maybeSingle();

  const post = data as unknown as PostRecord | null;
  if (post === null) return null;

  const [decorated] = await decorate(client, publicClient, [post], viewerId);

  const { data: commentRows } = await client
    .from("community_comments")
    .select("id, author_id, parent_id, body, status, created_at")
    .eq("post_id", postId)
    .order("created_at", { ascending: true });

  const comments = (commentRows ?? []) as {
    id: string;
    author_id: string;
    parent_id: string | null;
    body: string;
    status: string;
    created_at: string;
  }[];

  // 태그된 업체의 멤버가 단 댓글인가. **서비스롤로 확인한다** — `vendor_members` 는
  // 남의 조직 구성을 열지 않으므로 세션으로는 보이지 않는다(§3.9). 화면에 나가는 것은
  // "업체 답변인가" 라는 불리언뿐이고 누구인지는 나가지 않는다.
  const vendorReplyIds = await vendorReplyAuthors(
    postId,
    comments.map((comment) => comment.author_id),
  );

  const liked =
    viewerId === null
      ? false
      : ((await client.from("community_likes").select("id").eq("post_id", postId)).data ?? []).length > 0;

  const scrapped =
    viewerId === null
      ? false
      : ((await client.from("community_scraps").select("id").eq("post_id", postId)).data ?? []).length > 0;

  return {
    ...decorated,
    liked,
    scrapped,
    comments: comments.map((comment) => ({
      id: comment.id,
      parentId: comment.parent_id,
      body: visibleBody({ status: comment.status as PostStatus, body: comment.body }),
      status: comment.status as PostStatus,
      isMine: viewerId !== null && comment.author_id === viewerId,
      createdAt: comment.created_at,
      isVendorReply: vendorReplyIds.has(comment.author_id),
    })),
  };
}

async function vendorReplyAuthors(
  postId: string,
  authorIds: readonly string[],
): Promise<Set<string>> {
  if (authorIds.length === 0) return new Set();

  const admin = createAdminClient();

  const { data: tagRows } = await admin
    .from("community_post_tags")
    .select("vendor_id")
    .eq("post_id", postId);

  const vendorIds = ((tagRows ?? []) as { vendor_id: string }[]).map((row) => row.vendor_id);
  if (vendorIds.length === 0) return new Set();

  const { data: memberRows } = await admin
    .from("vendor_members")
    .select("user_id")
    .in("vendor_id", vendorIds)
    .in("user_id", [...new Set(authorIds)]);

  return new Set(((memberRows ?? []) as { user_id: string }[]).map((row) => row.user_id));
}

/**
 * 업체 상세의 '커뮤니티 언급' (§6.2 · F-C-33).
 *
 * **검증 후기와 시각적으로 분리**하고 '미검증 경험담' 라벨을 붙이는 것은 화면의 일이며,
 * 여기서는 그 재료만 만든다. 공개된 글만 나간다.
 */
export type VendorMention = {
  postId: string;
  title: string;
  createdAt: string;
  verifiedPurchase: boolean;
};

export async function vendorMentions(
  client: SupabaseClient,
  vendorId: string,
  limit = 5,
): Promise<VendorMention[]> {
  const { data: tagRows } = await client
    .from("community_post_tags")
    .select("post_id, verified_purchase")
    .eq("vendor_id", vendorId)
    .order("created_at", { ascending: false })
    .limit(limit * 3);

  const tags = (tagRows ?? []) as { post_id: string; verified_purchase: boolean }[];
  if (tags.length === 0) return [];

  const { data: postRows } = await client
    .from("community_posts")
    .select("id, title, created_at")
    .in(
      "id",
      tags.map((tag) => tag.post_id),
    )
    .eq("status", "published")
    .order("created_at", { ascending: false })
    .limit(limit);

  return ((postRows ?? []) as { id: string; title: string; created_at: string }[]).map((post) => ({
    postId: post.id,
    title: post.title,
    createdAt: post.created_at,
    verifiedPurchase: tags.find((tag) => tag.post_id === post.id)?.verified_purchase === true,
  }));
}
