import { createServerClient, type SetAllCookies } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * 세션 갱신 + 최소 라우트 가드 (S2-01)
 *
 * 두 가지 일을 한다.
 *  1) **세션 쿠키 갱신** — Supabase 액세스 토큰은 만료되므로 요청마다 갱신 기회를 준다.
 *     이걸 하지 않으면 서버 컴포넌트가 만료된 세션을 보고 사용자를 튕겨낸다.
 *  2) **미인증 차단** — `/vendor/**`·`/admin/**`·`/onboarding` 은 로그인 없이 열리지 않는다.
 *
 * 이 가드는 **UX 보조**다. 권한 판정의 최종 경계는 RLS 이며(§1.4 NOTE, CLAUDE.md §5.5),
 * 여기서 통과했다고 데이터가 열리는 것이 아니다. 역할(운영자 여부) 판정은
 * 미들웨어에서 DB 를 조회하지 않고 각 화면의 서버 컴포넌트에서 한다 —
 * 모든 요청에 프로필 조회를 얹으면 비용만 늘고 경계는 강해지지 않는다.
 *
 * **화면의 `requireUser()` 만으로는 부족하다(S3-01).** `loading.tsx` 가 있는 라우트는
 * 응답이 스트리밍으로 먼저 나가기 때문에, 서버 컴포넌트에서 `redirect()` 를 해도
 * HTTP 상태는 이미 200 으로 확정된 뒤다(클라이언트 스크립트로만 이동한다).
 * 미인증 접근을 상태 코드로 끊으려면 미들웨어에서 막아야 한다.
 */
const PROTECTED_PREFIXES = ["/vendor", "/admin", "/onboarding"];

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: ((list) => {
          list.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          list.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        }) satisfies SetAllCookies,
      },
    },
  );

  // getUser() 를 호출해야 토큰 갱신이 일어난다. 호출 결과를 인가에 쓰지는 않는다.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;
  const needsAuth = PROTECTED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );

  if (needsAuth && !user) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = "/login";
    loginUrl.search = `?next=${encodeURIComponent(pathname)}`;

    return NextResponse.redirect(loginUrl);
  }

  return response;
}

export const config = {
  // 정적 자산·이미지 최적화 경로는 건너뛴다. 세션 갱신이 필요 없고 비용만 든다.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
