import { existsSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { DEFAULT_LANDING, allLandingPaths, landingForRole } from "./landing";

describe("landingForRole", () => {
  it.each([
    ["admin", "/admin"],
    ["ops", "/admin"],
    ["vendor_owner", "/vendor"],
    ["vendor_staff", "/vendor"],
    ["planner", "/pro"],
    ["consumer", "/home"],
  ])("%s 는 %s 로 간다", (role, expected) => {
    expect(landingForRole(role)).toBe(expected);
  });

  it("프로필 행이 없으면 소비자로 본다", () => {
    expect(landingForRole(null)).toBe(DEFAULT_LANDING);
    expect(landingForRole(undefined)).toBe(DEFAULT_LANDING);
  });

  it("모르는 역할도 소비자로 떨어진다 — 착지 실패로 흰 화면을 만들지 않는다", () => {
    expect(landingForRole("something_new")).toBe(DEFAULT_LANDING);
    expect(landingForRole("")).toBe(DEFAULT_LANDING);
  });

  /**
   * FIX-24 의 실제 비용은 "로그인이 됐는데 없는 화면에 떨어지는" 경우까지 포함한다.
   * 착지 경로가 실재하는 라우트인지 **파일로** 확인한다 — 로그인이 막혀 있는 동안에도
   * 이 검사는 돈다.
   */
  it("모든 착지 경로에 실제 page.tsx 가 있다", () => {
    const root = path.resolve(__dirname, "../../..");
    const GROUPS = ["(admin)", "(vendor)", "(consumer)", "(planner)", "(auth)", "(marketing)", ""];

    for (const route of allLandingPaths()) {
      const found = GROUPS.some((group) =>
        existsSync(path.join(root, "app", group, route.slice(1), "page.tsx")),
      );

      expect(found, `착지 경로 ${route} 에 page.tsx 가 없다`).toBe(true);
    }
  });
});
