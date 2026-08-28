import type { NextRequest } from "next/server";

import { fail, failValidation, ok } from "@/lib/api/response";
import {
  ContentCreateSchema,
  ContentUnpublishSchema,
  ContentUpdateSchema,
} from "@/lib/core/content/cms";
import { createPost, loadCmsPosts, unpublishPost, updatePost } from "@/lib/content/admin";
import { getSessionUser, isOperator } from "@/lib/supabase/auth";

/**
 * CRUD /api/admin/content — 콘텐츠 작성·발행 예약 (S8-08 · F-A-05 · §4.3)
 *
 * **DELETE 가 행을 지우지 않는다.** '내리기' 는 `published_at = null` 이며 행과
 * 리비전은 남는다(0060 §5) — 발행된 글의 URL 은 색인되고 밖에서 링크되므로 행을
 * 지우면 그 링크가 전부 죽고 되돌릴 방법이 없다. 메서드 이름이 DELETE 인 이유는
 * **편집자가 하려는 일**이 그것이기 때문이고, 응답이 무엇을 했는지 그대로 적는다
 * (`unpublished: true`).
 *
 * **발행 상태를 입력으로 받지 않는다.** `publishedAt` 시각 하나가 초안·예약·발행을
 * 정한다 — 상태와 시각을 따로 받으면 둘이 갈리고, 갈렸을 때 공개 여부의 진실이
 * 무엇인지 알 수 없다. 공개 판정은 RLS 하나다.
 *
 * **쓰기는 전부 서비스롤 경유다**(D-62). `content_posts` 에 쓰기 정책을 두지
 * 않았다 — 정책이 생기는 날 아무 로그인 사용자나 우리 이름으로 글을 발행하게 된다.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");
  if (!isOperator(user)) return fail(403, "ADMIN_FORBIDDEN", "권한이 없습니다.");

  try {
    const posts = await loadCmsPosts(new Date());

    return ok({ posts });
  } catch {
    return fail(500, "CMS_LOAD_FAILED", "글 목록을 불러오지 못했습니다.");
  }
}

export async function POST(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");
  if (!isOperator(user)) return fail(403, "ADMIN_FORBIDDEN", "권한이 없습니다.");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "CMS_INVALID_BODY", "요청 본문을 읽지 못했습니다.");
  }

  const parsed = ContentCreateSchema.safeParse(body);
  if (!parsed.success) return failValidation(parsed.error.issues);

  const result = await createPost({
    ...parsed.data,
    operatorId: user.id,
    operatorRole: user.role,
    now: new Date(),
  });

  if (!result.ok) return fail(result.status, result.code, result.message);

  return ok({ postId: result.postId }, { status: 201 });
}

export async function PATCH(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");
  if (!isOperator(user)) return fail(403, "ADMIN_FORBIDDEN", "권한이 없습니다.");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "CMS_INVALID_BODY", "요청 본문을 읽지 못했습니다.");
  }

  const parsed = ContentUpdateSchema.safeParse(body);
  if (!parsed.success) return failValidation(parsed.error.issues);

  const result = await updatePost({
    ...parsed.data,
    operatorId: user.id,
    operatorRole: user.role,
    now: new Date(),
  });

  if (!result.ok) return fail(result.status, result.code, result.message);

  return ok({ postId: result.postId });
}

export async function DELETE(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");
  if (!isOperator(user)) return fail(403, "ADMIN_FORBIDDEN", "권한이 없습니다.");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "CMS_INVALID_BODY", "요청 본문을 읽지 못했습니다.");
  }

  const parsed = ContentUnpublishSchema.safeParse(body);
  if (!parsed.success) return failValidation(parsed.error.issues);

  const result = await unpublishPost({
    ...parsed.data,
    operatorId: user.id,
    operatorRole: user.role,
    now: new Date(),
  });

  if (!result.ok) return fail(result.status, result.code, result.message);

  return ok({ postId: result.postId, unpublished: true, deleted: false });
}
