import { NextResponse, type NextRequest } from "next/server";

import { createClient } from "@/lib/supabase/server";

/**
 * GET /auth/callback — 소셜 로그인 콜백 (F-C-01, §2.1)
 *
 * Supabase Auth 가 provider 인증을 마치면 `?code=` 를 달고 여기로 돌아온다.
 * 그 코드를 세션으로 바꾸고 원래 가려던 곳으로 보낸다.
 *
 * **provider 키 발급·등록은 이번 범위가 아니다**(S3-01b).
 * 카카오·네이버·구글·애플은 각각 개발자 계정 등록과 리다이렉트 URI 승인이 필요하고,
 * 그건 코드가 아니라 계정 작업이다. 이 라우트와 버튼은 **만들어 두고 켜지 않는다**
 * (CLAUDE.md §2.1) — `NEXT_PUBLIC_SOCIAL_AUTH_ENABLED` 로 화면 노출을 제어한다.
 *
 * 로컬에서 켜려면 `supabase/config.toml` 에 provider 를 추가하고 키를 넣은 뒤
 * `npm run db:start` 로 다시 띄운다.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/onboarding";

  if (!code) {
    return NextResponse.redirect(`${origin}/login?error=missing_code`);
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    // 실패 사유를 그대로 노출하지 않는다(CLAUDE.md §5.3).
    return NextResponse.redirect(`${origin}/login?error=oauth_failed`);
  }

  return NextResponse.redirect(`${origin}${next.startsWith("/") ? next : "/onboarding"}`);
}
