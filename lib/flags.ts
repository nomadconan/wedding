import { createClient as createSupabaseClient } from "@supabase/supabase-js";

/**
 * 피처 플래그 (CLAUDE.md §2.1 · 명세서 §3.8)
 *
 * **공개 시점 제어의 유일한 수단이다.** 원칙은 "나중에 만든다" 가 아니라
 * **"만들어 두고 켜지 않는다"** 이며, 기능 범위 축소로 대체하지 않는다.
 *
 * `feature_flags` 는 anon·authenticated 에게 **권한 자체가 없다**(0005 — 미공개 기능의
 * 존재를 노출하지 않기 위해서다). 그래서 서비스롤로 읽고, 판정 결과(불리언)만 화면에
 * 넘긴다 — 키 목록이 클라이언트로 나가지 않는다.
 *
 * **행이 없으면 꺼진 것이다.** 없는 키를 켜진 것으로 읽으면 플래그가 방어가 아니라
 * 장식이 된다(상한 파라미터가 없을 때 대화를 열지 않는 것과 같은 판단 · D-49).
 *
 * ── 캐시를 끈 이유 (S7-15 에서 실제로 물렸다) ────────────────────────────────
 * Next 14 는 서버 컴포넌트의 `fetch` 를 **기본으로 캐시**한다. supabase-js 는 그
 * `fetch` 로 PostgREST 를 부르므로, **쿠키를 읽기 전에** 도는 조회는 정적 렌더로
 * 취급돼 캐시에 얹힌다. 그 결과 플래그를 켜도 **꺼진 값이 계속 돌아왔다** — 스위치가
 * 스위치 노릇을 못 하는 상태이며, 흐름 점검이 그것을 잡았다.
 *
 * 그래서 이 모듈은 **자기 클라이언트를 만들고 `no-store` 를 못 박는다.**
 * `createAdminClient()` 를 쓰지 않는 이유는 그쪽을 건드리면 전 호출부의 캐시 동작이
 * 함께 바뀌기 때문이다 — 플래그만 고친다(같은 위험이 다른 곳에도 있다는 사실은
 * FIX-22 로 기록했다).
 */
function createFlagClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error("Supabase 서버 환경변수가 설정되지 않았습니다.");
  }

  return createSupabaseClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: {
      // **스위치는 캐시되면 안 된다.** 켠 순간 켜져야 한다.
      fetch: (input, init) => fetch(input as RequestInfo, { ...init, cache: "no-store" }),
    },
  });
}

export async function isFeatureEnabled(key: string): Promise<boolean> {
  try {
    const { data } = await createFlagClient()
      .from("feature_flags")
      .select("enabled")
      .eq("key", key)
      .maybeSingle();

    return (data as { enabled: boolean } | null)?.enabled === true;
  } catch {
    // 읽지 못하면 **꺼진 것으로 본다.** 조회 실패로 미공개 기능이 열리면 안 된다.
    return false;
  }
}

/**
 * 커뮤니티 공개 플래그.
 *
 * **T-00f 가 "모더레이션 없이 커뮤니티를 열 수 없다" 고 정했다.** 신고 버튼은
 * S7-15(이 태스크)가 만들고 처리 큐는 S7-17 이 만든다 — 그 사이에는 **신고를 받고도
 * 처리 경로가 없는 상태**가 존재한다. 기능을 나중으로 미루는 대신(그것은 범위 축소다)
 * **만들어 두고 켜지 않는다.** S7-17 이 끝나면 이 플래그를 켠다.
 */
export const COMMUNITY_FLAG = "community.enabled";

export function communityClosedNotice(): string {
  return "커뮤니티는 준비 중이에요. 신고 처리 체계가 갖춰지면 열립니다.";
}
