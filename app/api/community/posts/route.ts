import type { NextRequest } from "next/server";

import { recordEvent } from "@/lib/audit/record";
import { fail, failValidation, ok } from "@/lib/api/response";
import {
  COMMUNITY_SORT_BASIS_NOTICE,
  UNVERIFIED_NOTE,
  VENDOR_FILTER_LIMIT_NOTE,
  postProblem,
} from "@/lib/core/community/community";
import { PostCreateSchema, PostListQuerySchema } from "@/lib/core/schemas/community";
import { COMMUNITY_FLAG, communityClosedNotice, isFeatureEnabled } from "@/lib/flags";
import { listPosts } from "@/lib/community/loader";
import { createPublicClient } from "@/lib/explore/query";
import { getSessionUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";

/**
 * GET/POST /api/community/posts — 목록·작성 (F-C-32·33, 명세서 §4.2)
 *
 * **플래그가 꺼져 있으면 열리지 않는다.** T-00f 가 "모더레이션 없이 커뮤니티를 열 수
 * 없다" 고 정했고, 처리 큐는 S7-17 이 만든다. 기능을 미루는 대신(그것은 범위 축소다)
 * **만들어 두고 켜지 않는다**(CLAUDE.md §2.1).
 *
 * **정렬 기준을 응답에 싣는다**(§2.2). 조회수·좋아요가 순서에 끼어들지 않는다는 사실을
 * 화면이 말할 수 있어야 한다 — 업체 목록의 랭킹 배지와 같은 이유다.
 *
 * **본문의 업체명은 서버가 고치지 않는다**(D-60). 작성 화면이 제안하고 사용자가 정한다.
 */
export async function GET(request: NextRequest) {
  if (!(await isFeatureEnabled(COMMUNITY_FLAG))) {
    return fail(404, "COMMUNITY_CLOSED", communityClosedNotice());
  }

  const params = request.nextUrl.searchParams;

  const parsed = PostListQuerySchema.safeParse({
    board: params.get("board"),
    sort: params.get("sort") ?? "recent",
  });

  if (!parsed.success) return failValidation(parsed.error.issues);

  const user = await getSessionUser();
  const supabase = await createClient();

  const posts = await listPosts(supabase, createPublicClient(), {
    board: parsed.data.board,
    sort: parsed.data.sort,
    viewerId: user?.id ?? null,
  });

  return ok({
    posts,
    sort: parsed.data.sort,
    // 배지가 증거이려면 기준이 응답에 있어야 한다(D-03 · §2.2).
    sortBasis: parsed.data.sort,
    sortBasisNotice: COMMUNITY_SORT_BASIS_NOTICE,
    unverifiedNote: UNVERIFIED_NOTE,
  });
}

export async function POST(request: NextRequest) {
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

  const parsed = PostCreateSchema.safeParse(body);
  if (!parsed.success) return failValidation(parsed.error.issues);

  const problem = postProblem({
    title: parsed.data.title,
    body: parsed.data.body,
    tagCount: parsed.data.vendorIds.length,
  });

  if (problem !== null) {
    return fail(422, `COMMUNITY_${problem.field.toUpperCase()}`, problem.message);
  }

  const supabase = await createClient();

  // **작성자는 정책이 정한다.** `author_id` 를 본문에서 받지 않으며 DB 기본값이
  // `auth.uid()` 다 — 남의 이름으로 쓰려 하면 정책이 거절한다(0038).
  const { data: created, error } = await supabase
    .from("community_posts")
    .insert({
      board_type: parsed.data.boardType,
      title: parsed.data.title,
      body: parsed.data.body,
    })
    .select("id")
    .maybeSingle();

  const postId = (created as { id: string } | null)?.id ?? null;
  if (error || postId === null) {
    return fail(500, "COMMUNITY_CREATE_FAILED", "글을 올리지 못했어요.");
  }

  // 태그는 **승인된 업체만** 붙는다(트리거). 실패한 태그는 조용히 버리지 않고 세어 알린다.
  let taggedCount = 0;

  for (const vendorId of parsed.data.vendorIds) {
    const { error: tagError } = await supabase
      .from("community_post_tags")
      .insert({ post_id: postId, vendor_id: vendorId });

    if (!tagError) taggedCount += 1;
  }

  await recordEvent({
    entityType: "community_post",
    entityId: postId,
    eventType: "community_post_created",
    actor: { id: user.id },
    afterState: "published",
    // **본문·제목을 넣지 않는다**(§7.3). 남길 사실은 게시판과 태그 수다.
    memo: `board:${parsed.data.boardType} tags:${taggedCount}`,
  });

  return ok(
    {
      postId,
      taggedCount,
      skippedTags: parsed.data.vendorIds.length - taggedCount,
      // 필터가 첫 층일 뿐이라는 사실을 응답에도 싣는다(D-60).
      filterNote: VENDOR_FILTER_LIMIT_NOTE,
    },
    { status: 201 },
  );
}
