import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/response";
import { COMMUNITY_FLAG, communityClosedNotice, isFeatureEnabled } from "@/lib/flags";
import { getSessionUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";

/**
 * POST/DELETE /api/community/posts/[id]/scrap — 스크랩 (F-C-32, §4.2)
 *
 * **본인만 안다.** 스크랩에는 집계 컬럼이 없고 목록에도 수가 뜨지 않는다 — 누가
 * 무엇을 모아 두는지는 남에게 보일 정보가 아니다(§3.7). 좋아요와 달리 공개된 총합조차
 * 만들지 않은 이유가 그것이다.
 */
export async function POST(_request: NextRequest, { params }: { params: { id: string } }) {
  if (!(await isFeatureEnabled(COMMUNITY_FLAG))) {
    return fail(404, "COMMUNITY_CLOSED", communityClosedNotice());
  }

  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  const supabase = await createClient();
  const { error } = await supabase.from("community_scraps").insert({ post_id: params.id });

  if (error && !String(error.code).startsWith("23")) {
    return fail(403, "COMMUNITY_SCRAP_FORBIDDEN", "스크랩할 수 없어요.");
  }

  return ok({ scrapped: true });
}

export async function DELETE(_request: NextRequest, { params }: { params: { id: string } }) {
  if (!(await isFeatureEnabled(COMMUNITY_FLAG))) {
    return fail(404, "COMMUNITY_CLOSED", communityClosedNotice());
  }

  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  const supabase = await createClient();
  await supabase.from("community_scraps").delete().eq("post_id", params.id);

  return ok({ scrapped: false });
}
