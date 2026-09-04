import { createClient as createSupabaseClient } from "@supabase/supabase-js";

/**
 * 서비스롤 클라이언트 (S2-01)
 *
 * **서버 전용이다.** `SUPABASE_SERVICE_ROLE_KEY` 는 RLS 를 우회하므로
 * 클라이언트 번들에 들어가면 전 데이터가 열린다(CLAUDE.md §5.4).
 * 이 모듈은 **Route Handler 에서만** import 한다. 클라이언트 컴포넌트(`"use client"`)에서
 * 절대 참조하지 않는다 — `server-only` 패키지로 강제하고 싶지만 새 의존성이라 추가하지 않았다
 * (S8-05 CI 의 번들 유입 검사가 최종 방어선이다).
 *
 * 쓰는 곳은 §3.9 가 "서비스롤 경유" 로 규정한 경로뿐이다.
 *  - 입점 신청 생성(`vendors` 는 INSERT 정책이 없다 — 심사 도메인이라 서버가 만든다)
 *  - 심사 승인·반려(운영자)
 *  - `entity_events`·`audit_logs` 기록(INSERT 정책을 두지 않는 증적 테이블)
 *
 * **호출자는 반드시 세션에서 확인한 사용자 id 로 대상을 좁혀야 한다.**
 * 클라이언트가 보낸 id 를 그대로 쓰면 RLS 우회가 그대로 취약점이 된다.
 *
 * ── 캐시를 끈다 (FIX-22) ────────────────────────────────────────────────────
 * Next 14 는 `fetch` 를 **기본으로 캐시**하고 supabase-js 는 그 `fetch` 로 PostgREST 를
 * 부른다. 그래서 서비스롤 조회가 **`revalidate: 31536000`(1년)** 으로 디스크 캐시에
 * 얹힌다 — 로컬에서 확인했다: `products.base_price_total` 을 바꿨는데 `/explore` 가
 * **옛 가격을 그대로 그렸다.**
 *
 * **여기는 기본이 `no-store` 다.** 이유가 둘이다 —
 *  1. **이 클라이언트는 RLS 를 우회한다.** 그 응답이 URL 을 열쇠로 공유 캐시에 얹히면
 *     값이 굳는 것에 더해 **누가 봐도 되는 응답인지를 캐시가 판단하게 된다.**
 *  2. 서비스롤 조회는 대부분 사용자·업체별 필터라 **적중률이 낮다** — 캐시로 얻는 것이
 *     적고 잃는 것(금액·재고·권한이 굳는다)이 크다.
 *
 * **굳혀도 되는 자리는 호출부가 명시한다.** `.abortSignal()` 처럼 감출 수 없는 자리에
 * 두지 않고, 그 조회가 왜 굳어도 되는지를 그 자리에 적는다
 * (지금 그런 자리는 `lib/content/loader.ts` 하나이며 **익명 클라이언트**를 따로 쓴다).
 */
export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error("Supabase 서버 환경변수가 설정되지 않았습니다.");
  }

  return createSupabaseClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: {
      // **금액·재고·권한은 캐시되면 안 된다**(FIX-22). 기본을 안전한 쪽에 둔다.
      fetch: (input, init) => fetch(input as RequestInfo, { ...init, cache: "no-store" }),
    },
  });
}
