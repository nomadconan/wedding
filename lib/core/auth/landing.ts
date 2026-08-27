/**
 * 로그인 뒤 착지 경로 (FIX-24)
 *
 * 이 판단이 화면 안에 있는 동안에는 **아무도 검증하지 못했다.** 로그인 자체가 막혀 있어
 * 육안 확인이 불가능했고(§운영 규칙 4), 규칙이 컴포넌트 안에 있어 테스트도 붙지 않았다.
 * 그래서 순수 함수로 꺼낸다 — 로그인을 못 하는 동안에도 착지 규칙은 고정된다.
 *
 * **이것은 인가가 아니다.** 여기서 어디로 보내든 각 화면의 가드와 RLS 가 다시 판정한다
 * (§1.4 NOTE · CLAUDE.md §5.5). 잘못 보내면 사용자가 한 번 튕길 뿐 데이터는 열리지 않는다.
 */

/** `profiles.role` 이 가질 수 있는 값과 그 착지 경로. */
const LANDING_BY_ROLE: Record<string, string> = {
  admin: "/admin",
  ops: "/admin",
  vendor_owner: "/vendor",
  vendor_staff: "/vendor",
  // 플래너 콘솔은 `/pro` 다. `/planner`(단수)는 AI 플래너 채팅이고 `/planners`(복수)는
  // 소비자용 마켓이라 셋 다 다른 화면이다(S6-02 주석).
  planner: "/pro",
  consumer: "/home",
};

/**
 * 프로필 행이 아직 없으면(가입 직후 upsert 전이거나 실패) 소비자로 본다 —
 * `profiles.role` 기본값이 consumer 이기 때문이다.
 */
export const DEFAULT_LANDING = "/home";

export function landingForRole(role: string | null | undefined): string {
  if (!role) return DEFAULT_LANDING;

  return LANDING_BY_ROLE[role] ?? DEFAULT_LANDING;
}

/** 착지 경로 목록. 라우트가 실재하는지 검사하는 테스트가 쓴다. */
export function allLandingPaths(): string[] {
  return [...new Set([...Object.values(LANDING_BY_ROLE), DEFAULT_LANDING])];
}
