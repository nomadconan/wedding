import { describe, expect, it } from "vitest";

import { DEV_ROUTE_PREFIXES, isDevRoute, shouldBlockDevRoute } from "./dev-routes";

const dev = { isProduction: false, enableFlag: undefined };
const prod = { isProduction: true, enableFlag: undefined };

describe("isDevRoute", () => {
  it.each(DEV_ROUTE_PREFIXES)("%s 는 (dev) 그룹이다", (prefix) => {
    expect(isDevRoute(prefix)).toBe(true);
    expect(isDevRoute(`${prefix}/buttons`)).toBe(true);
  });

  it("제품 경로는 아니다", () => {
    for (const path of ["/", "/home", "/admin", "/explore", "/vendor"]) {
      expect(isDevRoute(path)).toBe(false);
    }
  });

  it("접두어가 이름의 일부로 걸리지 않는다", () => {
    // `/design-systems-guide` 는 다른 화면이다. `startsWith` 만 쓰면 같이 막힌다.
    expect(isDevRoute("/design-systemsomething")).toBe(false);
    expect(isDevRoute("/design-systems")).toBe(false);
  });
});

describe("shouldBlockDevRoute", () => {
  it("개발 중에는 열린다 — 막아야 하는 것은 배포된 것이다", () => {
    expect(shouldBlockDevRoute("/design-system", dev)).toBe(false);
  });

  it("**프로덕션에서는 막는다** — 이 가드가 없어 지금까지 그냥 열려 있었다", () => {
    expect(shouldBlockDevRoute("/design-system", prod)).toBe(true);
    expect(shouldBlockDevRoute("/design-system/buttons", prod)).toBe(true);
  });

  it("프로덕션에서도 명시적으로 켜면 열린다", () => {
    expect(shouldBlockDevRoute("/design-system", { isProduction: true, enableFlag: "true" })).toBe(
      false,
    );
  });

  it('플래그는 정확히 "true" 여야 한다 — 오타 하나가 카탈로그를 노출시킨다', () => {
    for (const flag of ["1", "yes", "TRUE", "True", "on", "false", "", " true"]) {
      expect(shouldBlockDevRoute("/design-system", { isProduction: true, enableFlag: flag })).toBe(
        true,
      );
    }
  });

  it("제품 경로는 프로덕션에서도 막지 않는다", () => {
    for (const path of ["/", "/home", "/admin", "/explore"]) {
      expect(shouldBlockDevRoute(path, prod)).toBe(false);
    }
  });
});
