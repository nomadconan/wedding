import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, failValidation, ok } from "@/lib/api/response";
import { COMMENT_BODY_MAX_LENGTH } from "@/lib/core/community/community";
import {
  VENDOR_REPLY_LIMIT_NOTE,
  VENDOR_REPLY_MODERATED_NOTE,
  VENDOR_REPLY_SCOPE_NOTE,
} from "@/lib/core/community/vendor-reply";
import { COMMUNITY_FLAG, communityClosedNotice, isFeatureEnabled } from "@/lib/flags";
import { editReply, loadTaggedPosts, replyToTaggedPost, vendorMemberIds } from "@/lib/community/vendor";
import { getSessionUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";
import { findMemberVendor } from "@/lib/vendor/products";

/**
 * GET/PATCH /api/vendor/community-tags — 자사 태그 글과 답변 (F-V-18, §4.3)
 *
 * ── 업체가 할 수 있는 일과 없는 일 ──────────────────────────────────────────
 *  · **답변 작성·수정** — 글당 공식 답변은 **한 번**이고 쓴 답변은 고칠 수 있다.
 *  · **본문 수정은 못 한다** — RLS 가 지킨다(업체에게 `community_posts` UPDATE 정책이
 *    없다). 이 라우트에 본문 필드를 두지 않은 것은 그 사실을 API 표면에서도 보이게
 *    하기 위해서다.
 *  · **글을 내리지 못한다** — 부당하다고 판단하면 `POST /api/community/reports` 로
 *    신고한다. 내리는 것은 운영자의 일이다(F-A-18 · D-24 조율자).
 *
 * `vendorId` 를 입력으로 받지 않는다 — 세션에서 찾는다(다른 업체 라우트와 같다).
 */
const PatchSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("reply"),
    postId: z.string().uuid(),
    body: z.string().trim().min(1, "답변을 적어 주세요.").max(COMMENT_BODY_MAX_LENGTH),
  }),
  z.object({
    action: z.literal("edit_reply"),
    commentId: z.string().uuid(),
    body: z.string().trim().min(1, "답변을 적어 주세요.").max(COMMENT_BODY_MAX_LENGTH),
  }),
]);

async function context() {
  if (!(await isFeatureEnabled(COMMUNITY_FLAG))) {
    return { error: fail(404, "COMMUNITY_CLOSED", communityClosedNotice()) } as const;
  }

  const user = await getSessionUser();
  if (!user) return { error: fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.") } as const;

  const vendor = await findMemberVendor(user.id);
  if (!vendor) return { error: fail(403, "VENDOR_NOT_FOUND", "등록된 업체가 없습니다.") } as const;

  return { user, vendor } as const;
}

export async function GET() {
  const ctx = await context();
  if ("error" in ctx) return ctx.error;

  const supabase = await createClient();

  const posts = await loadTaggedPosts(supabase, {
    vendorId: ctx.vendor.id,
    memberIds: await vendorMemberIds(ctx.vendor.id),
    viewerId: ctx.user.id,
  });

  return ok({
    posts,
    // 경계를 응답에도 싣는다 — 화면이 문구를 따로 쓰면 두 벌이 갈린다.
    scopeNote: VENDOR_REPLY_SCOPE_NOTE,
    limitNote: VENDOR_REPLY_LIMIT_NOTE,
    moderatedNote: VENDOR_REPLY_MODERATED_NOTE,
  });
}

export async function PATCH(request: NextRequest) {
  const ctx = await context();
  if ("error" in ctx) return ctx.error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "VENDOR_INVALID_BODY", "요청 본문을 읽지 못했습니다.");
  }

  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) return failValidation(parsed.error.issues);

  const supabase = await createClient();

  const result =
    parsed.data.action === "reply"
      ? await replyToTaggedPost(supabase, {
          postId: parsed.data.postId,
          vendorId: ctx.vendor.id,
          memberIds: await vendorMemberIds(ctx.vendor.id),
          viewerId: ctx.user.id,
          body: parsed.data.body,
        })
      : await editReply(supabase, {
          commentId: parsed.data.commentId,
          body: parsed.data.body,
          viewerId: ctx.user.id,
        });

  if (!result.ok) return fail(result.status, result.code, result.message);

  return ok({ commentId: result.commentId });
}
