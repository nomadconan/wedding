import type { NextRequest } from "next/server";

import { fail, failValidation, ok } from "@/lib/api/response";
import { AcceptInviteSchema } from "@/lib/core/schemas/vendor-settings";
import { getSessionUser } from "@/lib/supabase/auth";
import { acceptInvite, previewInvite } from "@/lib/vendor/invites";

/**
 * GET/POST /api/vendor/invites/accept — 초대 확인·수락 (S2-09)
 *
 * ── 왜 별도 라우트인가 ──────────────────────────────────────────────────────
 * `/api/vendor/invites` 는 **업체 멤버**용이다(`findMemberVendor` 로 시작한다).
 * 초대받은 사람은 아직 멤버가 아니라 그 라우트를 지날 수 없다.
 *
 * `GET` 은 **로그인 없이도** 된다 — 링크를 열었을 때 "어느 업체가 불렀는가" 를 먼저
 * 보여주고 로그인으로 보내는 흐름이 자연스럽다. 대신 **이메일을 마스킹**해 내보낸다:
 * 토큰만 있으면 남의 이메일을 알 수 있게 되면 안 된다.
 *
 * `POST` 는 로그인이 필요하고, **초대받은 이메일과 계정이 같아야** 한다 — 토큰이
 * 유출되면 아무나 업체 멤버가 되는데 그건 가격·정산 접근이다(§3.9).
 */
export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get("token");
  if (!token) return fail(400, "VENDOR_INVITE_TOKEN_REQUIRED", "초대 링크가 올바르지 않아요.");

  const preview = await previewInvite(token, new Date());
  if (!preview) return fail(404, "VENDOR_INVITE_NOT_FOUND", "초대를 찾을 수 없어요.");

  return ok({ invite: preview });
}

export async function POST(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "VENDOR_INVALID_BODY", "요청 본문을 읽을 수 없습니다.");
  }

  const parsed = AcceptInviteSchema.safeParse(body);
  if (!parsed.success) return failValidation(parsed.error.issues);

  const result = await acceptInvite({
    token: parsed.data.token,
    userId: user.id,
    userEmail: user.email,
    now: new Date(),
  });

  return "status" in result ? fail(result.status, result.code, result.message) : ok(result);
}
