import { readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { BATCH_SPECS } from "@/lib/core/ops/monitor";

import { JOB_ROUTE_NAMES, SCHEDULED_JOB_CRONS, SCHEDULED_JOB_NAMES } from "./registry";

/**
 * **선언과 실물을 대조한다.** 이 세 곳이 갈리면 모니터링 화면이 거짓말을 한다 —
 * 그리고 거짓말하는 모니터링은 모니터링이 없는 것보다 나쁘다.
 */
describe("배치 실행 인프라 선언", () => {
  const onDisk = readdirSync(join(process.cwd(), "app", "api", "jobs"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  it("**선언한 라우트 목록이 디스크와 같다**", () => {
    expect([...JOB_ROUTE_NAMES]).toEqual(onDisk);
  });

  it("**등록된 스케줄에는 전부 라우트가 있다** — 없으면 매번 404 를 부른다", () => {
    for (const name of SCHEDULED_JOB_NAMES) {
      expect(onDisk).toContain(name);
    }
  });

  it("**라우트가 있는 배치는 전부 등록돼 있다** — 만들어 두고 안 부르면 없는 것과 같다", () => {
    expect([...SCHEDULED_JOB_NAMES].sort()).toEqual(onDisk);
  });

  it("**`vercel.json` 의 주기와 코드가 선언한 주기가 같다**", () => {
    for (const spec of BATCH_SPECS) {
      expect(SCHEDULED_JOB_CRONS[spec.name] ?? null).toBe(spec.cron);
    }
  });

  it("모든 라우트 이름이 §4.5 배치 목록 안에 있다", () => {
    const known = new Set(BATCH_SPECS.map((spec) => spec.name));
    for (const name of onDisk) expect(known.has(name)).toBe(true);
  });
});
