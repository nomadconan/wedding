// 서버(Route Handler/RSC)용 Supabase 클라이언트
import { createServerClient, type SetAllCookies } from "@supabase/ssr";
import { cookies } from "next/headers";

import type { Database } from "@/types/database";

/**
 * 세션 클라이언트.
 *
 * ── 캐시를 끈다 (FIX-22 · Next 15 에서 뜻이 달라졌다 · FIX-61) ──────────────
 * 쿠키를 읽으므로 라우트는 동적이 되지만 **`fetch` 단위의 Data Cache 는 그것과 다른
 * 층**이라 개별 조회가 여전히 굳을 수 있다. 이 클라이언트로 읽는 것은 **그 사람의
 * 데이터**이며 굳어서 득 볼 것이 없다 — 기본을 안전한 쪽에 둔다.
 *
 * **Next 15 부터 `fetch` 기본값이 `no-store` 가 됐다.** 이 줄은 이제 구멍을 막는 것이
 * 아니라 **의도를 못 박는 것**이다(`lib/supabase/admin.ts` 의 같은 주석 참조).
 */
export async function createClient() {
  const cookieStore = await cookies();
  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      global: {
        fetch: (input: RequestInfo | URL, init?: RequestInit) =>
          fetch(input, { ...init, cache: "no-store" }),
      },
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: ((list) =>
          list.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options)
          )) satisfies SetAllCookies,
      },
    }
  );
}
