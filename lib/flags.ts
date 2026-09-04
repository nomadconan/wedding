import { createAdminClient } from "@/lib/supabase/admin";

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
 * 그때는 **자기 클라이언트를 만들어** `no-store` 를 못 박았다. 공용 팩토리를 건드리면
 * 전 호출부의 캐시 동작이 함께 바뀌기 때문이었고, 같은 위험이 다른 곳에도 있다는 사실은
 * FIX-22 로 기록했다. **FIX-22 가 그것을 해소하면서 기본이 `no-store` 가 됐으므로**
 * 사본을 지우고 공용 팩토리로 돌아온다 — 사본이 남아 있으면 다음 사람이 "여기는 특별해서
 * 따로 만들었구나" 로 읽고 **자기 것도 하나 더 만든다.**
 */

export async function isFeatureEnabled(key: string): Promise<boolean> {
  try {
    const { data } = await createAdminClient()
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
 * 플래그의 `rollout_json` (S7-19).
 *
 * **켬/끔이 아니라 '어느 부분을 켜는가' 를 담는 자리다**(§3.8). 준비 순서 뷰는 표현이
 * 넷이고 O-16 이 그 중 일부를 끌 수 있으므로(§7.5 — "못 주는 표현은 삭제가 아니라
 * `feature_flags` 로 끈다") 키 하나에 넷을 담는다. 키를 넷으로 쪼개면 **한 기능의
 * 개폐가 네 행에 흩어지고** 그 중 하나만 고치는 날이 온다(D-67 이 개방 조건을
 * `rollout_json` 에 적어 둔 것과 같은 자리다).
 *
 * `isFeatureEnabled` 와 같은 클라이언트를 쓴다 — 공용 팩토리가 **캐시를 끈다**(FIX-22).
 * **행이 없으면 `null`** 이며, 읽는 쪽이 그것을 '판정 전' 으로 볼지 '꺼짐' 으로 볼지
 * 정한다. 커뮤니티는 꺼짐이었고 이쪽은 판정 전이다 — 두 상황이 다르므로 이 함수가
 * 대신 정하지 않는다.
 */
export async function featureRollout(key: string): Promise<Record<string, unknown> | null> {
  try {
    const { data } = await createAdminClient()
      .from("feature_flags")
      .select("rollout_json")
      .eq("key", key)
      .maybeSingle();

    return (data as { rollout_json: Record<string, unknown> } | null)?.rollout_json ?? null;
  } catch {
    return null;
  }
}

/**
 * 준비 순서 뷰의 표현 스위치 (F-C-37 · O-16).
 *
 * **지금은 넷 다 켜져 있다.** 판정은 지표가 붙는 S8-01 이후이며(O-16) 그때 못 주는
 * 표현을 **행 하나로** 끈다 — 코드를 고치지 않는다.
 */
export const SCHEDULE_VIEWS_FLAG = "schedule.views";

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
