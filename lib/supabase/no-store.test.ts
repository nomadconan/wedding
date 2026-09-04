import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Supabase 클라이언트는 **기본이 `no-store`** 다 (FIX-22 · S7-15)
 *
 * ── 왜 검사가 필요한가 ──────────────────────────────────────────────────────
 * Next 14 는 `fetch` 를 **기본으로 캐시**하고 supabase-js 는 그 `fetch` 로 PostgREST 를
 * 부른다. 그래서 클라이언트를 하나 새로 만들 때 `no-store` 를 안 적으면 **그 조회는
 * 조용히 1년짜리 캐시에 얹힌다**(`revalidate: 31536000`). 로컬에서 확인했다 —
 * `products.base_price_total` 을 바꿨는데 `/explore` 가 옛 가격을 그렸다.
 *
 * 실수가 **눈에 안 보인다는 것이 이 결함의 핵심**이다. 안 적으면 아무 경고도 없고
 * 화면은 정상으로 보이며, 값이 바뀌는 날에야 드러난다. 그래서 사람의 기억이 아니라
 * 검사가 든다.
 *
 * ── 왜 린트 규칙이 아니라 테스트인가 ────────────────────────────────────────
 * ESLint 로 하려면 **커스텀 규칙 패키지**가 필요하다(새 의존성). 그리고 이 검사가 보는
 * 것은 문법이 아니라 **"이 리포에 클라이언트를 만드는 자리가 몇 개이고 각각 무엇을
 * 정했나"** 라는 목록이라, 규칙보다 목록으로 두는 편이 읽힌다. `npm run verify` 와
 * CI 의 quality 잡이 이 파일을 돌린다.
 *
 * ── 예외는 목록으로 든다 ────────────────────────────────────────────────────
 * 굳는 것이 **목적**인 자리가 하나 있다. 예외를 코드에 흩어 두지 않고 여기 적어,
 * 예외가 늘면 이 목록이 늘어나는 것으로 보이게 한다.
 */

const ROOT = process.cwd();

/**
 * 캐시를 켜 두는 것이 맞는 자리.
 *
 * **파일마다 이유를 적는다.** 이유를 못 적으면 예외가 아니라 빠뜨린 것이다.
 */
const CACHED_ON_PURPOSE: Record<string, string> = {
  "lib/content/loader.ts":
    "SEO 화면(/guides)은 정적으로 굳는 것이 목적이다(§2.1). 신선도는 페이지의 revalidate=300 이 잡고, 공개 데이터라 권한 문제가 아니다.",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * 이 파일이 **서버에서 도는** Supabase 클라이언트를 만드는가.
 *
 * **브라우저 클라이언트(`createBrowserClient`)는 대상이 아니다** — Next 의 Data Cache 는
 * 서버의 `fetch` 를 감싸는 층이라 브라우저에서 도는 요청에는 적용되지 않는다.
 * 타입만 import 하는 파일도 대상이 아니다.
 */
function createsServerClient(text: string): boolean {
  return /\b(createSupabaseClient|createServerClient)\s*\(/.test(text);
}

const files = [...walk(join(ROOT, "app")), ...walk(join(ROOT, "lib"))]
  .map((f) => relative(ROOT, f).split(sep).join("/"))
  .filter((f) => createsServerClient(readFileSync(join(ROOT, f), "utf8")))
  .sort();

describe("Supabase 클라이언트 캐시 정책", () => {
  it("**클라이언트를 만드는 자리를 실제로 찾았다** — 못 찾으면 아래 검사가 빈 목록을 통과시킨다", () => {
    // 빈 목록으로 통과하지 않게 한다. 자리가 줄면 이 수를 함께 내린다.
    expect(files.length).toBeGreaterThanOrEqual(6);
    expect(files).toContain("lib/supabase/admin.ts");
    expect(files).toContain("lib/supabase/server.ts");
  });

  it("**모든 클라이언트가 `no-store` 를 못 박는다** — 안 적으면 조용히 1년 캐시에 얹힌다", () => {
    const missing = files.filter((f) => {
      if (f in CACHED_ON_PURPOSE) return false;
      return !readFileSync(join(ROOT, f), "utf8").includes('cache: "no-store"');
    });

    expect(missing).toEqual([]);
  });

  it("**예외에는 이유가 붙어 있다** — 이유를 못 적으면 예외가 아니라 빠뜨린 것이다", () => {
    for (const [file, reason] of Object.entries(CACHED_ON_PURPOSE)) {
      // 목록에 적어 놓고 파일이 사라지면 예외가 유령으로 남는다.
      expect(files).toContain(file);
      expect(reason.length).toBeGreaterThan(30);
    }
  });

  it("**굳혀도 되는 자리는 익명 클라이언트다** — 서비스롤 응답을 캐시에 얹지 않는다", () => {
    for (const file of Object.keys(CACHED_ON_PURPOSE)) {
      const text = readFileSync(join(ROOT, file), "utf8");
      expect(text).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
    }
  });

  it("**브라우저 클라이언트는 대상이 아니다** — Data Cache 는 서버의 fetch 층이다", () => {
    const browser = readFileSync(join(ROOT, "lib/supabase/client.ts"), "utf8");

    expect(browser).toContain("createBrowserClient");
    // 브라우저 파일이 서버 팩토리를 함께 들면 그때는 대상이 된다.
    expect(createsServerClient(browser)).toBe(false);
  });

  it("**서비스롤 팩토리는 하나뿐이다** — 사본이 생기면 그 사본이 정책을 안 따른다", () => {
    const serviceRole = files.filter((f) =>
      readFileSync(join(ROOT, f), "utf8").includes("SUPABASE_SERVICE_ROLE_KEY"),
    );

    // S7-12 의 공유 링크는 토큰으로만 여는 별도 경계라 자기 클라이언트를 든다.
    expect(serviceRole).toEqual(["lib/share/links.ts", "lib/supabase/admin.ts"]);
  });
});
