/**
 * `(dev)` 라우트 그룹 차단 (S8-05 · TASKS.md "지연 항목" — `(dev)` 라우트 그룹 차단)
 *
 * `app/(dev)/design-system` 은 **개발 확인용 카탈로그**다. 더미 금액·더미 업체명이
 * 가득하고 제품 내비게이션에서 연결하지 않는다. 그런데 라우트 그룹은 URL 에 나타나지
 * 않으므로 배포하면 **`/design-system` 이 그냥 열린다** — 아무 가드도 없었다.
 *
 * **왜 삭제가 아니라 차단인가.** 카탈로그는 계속 필요하다(새 컴포넌트를 만들면 여기
 * 추가하는 것이 규칙이다). 없애면 토큰·컴포넌트를 한 화면에서 대조할 자리가 사라진다.
 * "만들어 두고 켜지 않는다"(CLAUDE.md §2.1)와 같은 결이다.
 *
 * **왜 기본값이 '개발에서는 열림' 인가.** 반대로 두면(기본 차단 + 켜야 열림) 로컬에서
 * 카탈로그를 보려면 매번 환경변수를 세워야 하고, 그러면 아무도 안 본다. 막아야 하는
 * 것은 **배포된 것**이지 개발자의 브라우저가 아니다.
 *
 * 판단을 순수 함수로 꺼내 둔다 — 미들웨어 안에 있으면 시험할 수 없고, 시험할 수 없는
 * 가드는 조용히 뚫린다.
 */

/** `(dev)` 그룹이 소유한 경로. 그룹이 URL 에 안 나타나므로 직접 적는다. */
export const DEV_ROUTE_PREFIXES = ["/design-system"] as const;

export type DevRouteEnv = {
  /** `NODE_ENV === "production"`. 빌드된 앱이 도는 중인가. */
  isProduction: boolean;
  /** `ENABLE_DEV_ROUTES` 값. 프로덕션에서도 일부러 열어야 할 때만 쓴다. */
  enableFlag: string | undefined;
};

/** 이 경로가 `(dev)` 그룹의 것인가. */
export function isDevRoute(pathname: string): boolean {
  return DEV_ROUTE_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/**
 * 지금 이 요청을 막아야 하는가.
 *
 * 막는 조건은 **프로덕션이고 명시적으로 켜지 않았을 때**뿐이다.
 * 플래그는 `"true"` 정확히 일치해야 켜진다 — `"1"`·`"yes"`·`"false"` 를 참으로 읽으면
 * 오타 하나가 카탈로그를 배포에 노출시킨다.
 */
export function shouldBlockDevRoute(pathname: string, env: DevRouteEnv): boolean {
  if (!isDevRoute(pathname)) return false;
  if (!env.isProduction) return false;

  return env.enableFlag !== "true";
}
