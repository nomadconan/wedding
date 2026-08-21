import type { NextRequest } from "next/server";

import { fail, failValidation, ok } from "@/lib/api/response";
import { INVITE_SHARE_NOTICE } from "@/lib/core/guest/guest";
import { InviteActionSchema } from "@/lib/core/schemas/guest";
import { findMyCouple } from "@/lib/couple/membership";
import { issueInvite, revokeInvite } from "@/lib/guest/loader";
import { getSessionUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";

/**
 * POST /api/guests/invites — 초대(청첩) 링크 발급·회수 (F-C-22 · §4.2 신설)
 *
 * **명단 경로와 나눈 이유.** 링크 발급은 **되돌리기 어렵다** — 한 번 보내면 회수해도
 * 이미 열어 본 사람이 있다. 명단 편집과 같은 문에 두면 실수로 발급되는 경로가 생긴다.
 *
 * ── 토큰은 여기서 한 번만 나간다 ────────────────────────────────────────────
 * `GET /api/guests` 는 토큰을 싣지 않는다(있는지 여부만). 링크는 **발급 응답에서만**
 * 돌려주며, 다시 필요하면 같은 하객에 대해 다시 부르면 **같은 토큰**이 온다 —
 * 새로 만들면 **이미 보낸 링크가 죽는다.**
 *
 * ── 만료가 예식일이다 ───────────────────────────────────────────────────────
 * S7-12(공유 링크)를 그대로 쓰지 않았다. 그쪽은 설정이 없으면 발급하지 않지만
 * (만료 없는 공유 = 영구 공개) **청첩장은 예식일까지 살아 있어야** 한다. 그래서 만료를
 * 시간 상수가 아니라 `couples.wedding_date` 로 두고, **예식일이 없으면 발급하지
 * 않는다**(D-49 계열).
 */
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  const membership = await findMyCouple(user.id);
  if (!membership) return fail(404, "GUEST_COUPLE_NOT_FOUND", "먼저 온보딩을 마쳐 주세요.");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "GUEST_INVALID_BODY", "요청 본문을 읽지 못했습니다.");
  }

  const parsed = InviteActionSchema.safeParse(body);
  if (!parsed.success) return failValidation(parsed.error.issues);

  const supabase = await createClient();

  if (parsed.data.action === "revoke") {
    const result = await revokeInvite(supabase, {
      coupleId: membership.coupleId,
      userId: user.id,
      guestId: parsed.data.guestId,
    });

    if ("status" in result) return fail(result.status, result.code, result.message);

    return ok(result);
  }

  const { data: couple } = await supabase
    .from("couples")
    .select("wedding_date")
    .eq("id", membership.coupleId)
    .maybeSingle();

  const result = await issueInvite(supabase, {
    coupleId: membership.coupleId,
    userId: user.id,
    guestId: parsed.data.guestId,
    weddingDate: (couple as { wedding_date: string | null } | null)?.wedding_date ?? null,
  });

  if ("status" in result) return fail(result.status, result.code, result.message);

  return ok({ ...result, notice: INVITE_SHARE_NOTICE }, { status: 201 });
}
