import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * 툴 권한 경계 (S7-20)
 *
 * **소스를 글자로 읽는다.** 모듈을 import 하면 `next/headers` 같은 요청 스코프 API 가
 * 딸려 오고, 그러면 이 검사가 서버 환경 때문에 깨진다 — `lib/core/no-framework-imports`
 * 가 같은 이유로 같은 방식을 쓴다.
 *
 * 지키려는 것은 하나다 — **커플 데이터를 서비스롤로 읽지 않는다.** 서비스롤로 부르면
 * RLS 가 통째로 비켜서고, 인가의 최종 경계가 툴 코드의 `eq("couple_id", …)` 한 줄이
 * 된다. 그 줄을 빠뜨린 날 아무 일도 일어나지 않는다 — 조용히 남의 데이터가 나간다.
 */
const DIR = __dirname;

const read = (file: string) => readFileSync(join(DIR, file), "utf8");

describe("핸들러는 서비스롤을 쥐지 않는다", () => {
  const handlers = read("handlers.ts");

  it("서비스롤 클라이언트를 import 하지 않는다", () => {
    expect(handlers).not.toContain("supabase/admin");
    expect(handlers).not.toContain("createAdminClient");
  });

  it("커플 스코프 조회는 세션 클라이언트(ctx.supabase)로 한다", () => {
    for (const table of ["couples", "couple_members", "onboarding_answers", "coupon_issues"]) {
      const pattern = new RegExp(`ctx\\.supabase[\\s\\S]{0,80}from\\("${table}"\\)`);

      expect(pattern.test(handlers), table).toBe(true);
    }
  });

  it("커플 id 를 인자에서 읽지 않는다 — 스코프는 세션이 정한다", () => {
    expect(handlers).not.toContain("args.coupleId");
    expect(handlers).not.toContain("args.userId");
  });

  it("공개 데이터는 익명 클라이언트로 읽는다", () => {
    for (const table of ["vendors", "products", "inventory_slots"]) {
      const pattern = new RegExp(`ctx\\.publicClient[\\s\\S]{0,80}from\\("${table}"\\)`);

      expect(pattern.test(handlers), table).toBe(true);
    }
  });
});

describe("참조 데이터만 서비스롤로 읽는다", () => {
  const reference = read("reference.ts");

  it("요율·운영 파라미터 밖의 표를 읽지 않는다", () => {
    const tables = [...reference.matchAll(/\.from\("([a-z_]+)"\)/g)].map((match) => match[1]);

    expect(tables).toEqual(["planner_fee_rates"]);
  });

  it("커플 스코프 표를 건드리지 않는다", () => {
    for (const table of ["couples", "carts", "coupon_issues", "ai_conversations"]) {
      expect(reference).not.toContain(`"${table}"`);
    }
  });
});

describe("감사 기록은 결과 본문을 복사하지 않는다", () => {
  const audit = read("audit.ts");
  const registry = read("registry.ts");

  it("`ai_tool_calls` 에 넣는 것은 요약뿐이다", () => {
    expect(audit).toContain("result_summary: call.resultSummary");
    expect(audit).not.toContain("result.data");
  });

  it("요약은 상태·개수만 담는다 (summarizeResult 를 거친다)", () => {
    expect(registry).toContain("summarizeResult");
  });

  it("툴 실행 예외를 대화로 흘리지 않는다", () => {
    // 잡은 예외를 그대로 문자열로 옮기는 코드가 없어야 한다(§5.3).
    expect(registry).not.toMatch(/catch\s*\(\s*error\s*\)/);
  });
});
