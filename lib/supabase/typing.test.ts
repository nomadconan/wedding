import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

import type { UserRole } from "./auth";
import type { createAdminClient } from "./admin";
import type { createClient as createBrowserSideClient } from "./client";
import type { createClient as createServerSideClient } from "./server";

/**
 * **세 클라이언트가 `Database` 를 달고 있는지 지킨다** (FIX-67)
 *
 * 전에는 `types/database.ts` 를 만들어만 두고 아무 클라이언트도 쓰지 않아서,
 * **틀린 컬럼 이름·틀린 표 이름·틀린 반환 모양이 전부 컴파일됐다.** 고쳐 놓아도
 * 다음 사람이 `<Database>` 한 글자를 지우면 조용히 그 상태로 돌아간다 — 그래서
 * 검사로 남긴다(§7.0b · "봤는데 괜찮았다" 는 다음 사람에게 남지 않는다).
 *
 * **망가지는 길이 셋이고 셋 다 본다.**
 *
 * | 어떻게 망가지나 | 무엇이 되나 | 잡는 줄 |
 * |---|---|---|
 * | `@supabase/ssr` 이 supabase-js 와 제네릭 수가 어긋난다 | 행이 `never` | `*_ROW_IS_RESOLVED` |
 * | `<Database>` 를 지운다 | **칸 값이** `any` | `*_COL_IS_NOT_ANY` |
 * | 컬럼·표 이름이 틀린다 | — | `.select()` 자체가 안 넘어간다 |
 *
 * 가운데 줄이 중요하다. `never` 만 보면 **`<Database>` 를 지웠을 때 통과한다** —
 * `any` 는 무엇에나 맞기 때문이다. 실제로 이 파일의 첫 판이 그랬고, 두 번째 판도
 * **행**을 봐서 통과했다(행은 `{ role: any }` 라 `any` 가 아니다). **칸**을 봐야 잡힌다.
 *
 * 판정은 `tsc` 가 한다(`npm run typecheck`). 아래 `declare const` 는 타입만이라
 * 실행되지 않고, 쿼리 함수들도 부르지 않는다 — 여기서 보는 것은 **모양**이다.
 */
type IsAny<T> = 0 extends 1 & T ? true : false;
type IsResolved<T> = [T] extends [never] ? false : true;
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

declare const server: Awaited<ReturnType<typeof createServerSideClient>>;
declare const browser: ReturnType<typeof createBrowserSideClient>;
declare const admin: ReturnType<typeof createAdminClient>;

async function serverRow() {
  const { data } = await server.from("profiles").select("role, user_id");
  return data;
}

async function browserRow() {
  const { data } = await browser.from("vendors").select("id, name, status");
  return data;
}

async function adminRow() {
  const { data } = await admin.from("settlements").select("id, net_amount, fee_basis");
  return data;
}

type RowOf<F extends () => Promise<unknown>> = NonNullable<Awaited<ReturnType<F>>> extends (infer R)[]
  ? R
  : never;

type ServerRow = RowOf<typeof serverRow>;
type BrowserRow = RowOf<typeof browserRow>;
type AdminRow = RowOf<typeof adminRow>;

// ── 1) 행이 풀린다 (ssr 이 어긋나면 `never` 가 된다) ────────────────────────
const SERVER_ROW_IS_RESOLVED: IsResolved<ServerRow> = true;
const BROWSER_ROW_IS_RESOLVED: IsResolved<BrowserRow> = true;
const ADMIN_ROW_IS_RESOLVED: IsResolved<AdminRow> = true;

// ── 2) 칸 값이 `any` 가 아니다 (`<Database>` 를 지우면 여기가 `any` 가 된다) ──
//
// **행이 아니라 칸을 본다.** 처음엔 `IsAny<ServerRow>` 를 봤는데, `<Database>` 를
// 지워도 행은 `{ role: any; user_id: any }` 라 **`any` 가 아니어서 통과했다** —
// 넓어지는 것은 행이 아니라 그 안의 값이다. 일부러 지워 보고서야 알았다(§7.0b).
const SERVER_COL_IS_NOT_ANY: IsAny<ServerRow["role"]> = false;
const BROWSER_COL_IS_NOT_ANY: IsAny<BrowserRow["status"]> = false;
const ADMIN_COL_IS_NOT_ANY: IsAny<AdminRow["net_amount"]> = false;

// ── 3) 값 타입이 DB 그대로다 ────────────────────────────────────────────────
// `profiles.role` 은 enum 이다. `string` 으로 넓어지면 `isOperator` 의 `=== "ops"` 가
// 오타까지 통과하고, 그 값이 `audit_logs.actor_role`(enum) 로 그대로 들어간다.
const ROLE_IS_THE_ENUM: MutuallyAssignable<ServerRow["role"], UserRole> = true;
// 금액은 숫자다. `net_amount` 가 nullable 로 바뀌면 정산 계산이 먼저 멈춰야 한다.
const NET_AMOUNT_IS_NUMBER: MutuallyAssignable<AdminRow["net_amount"], number> = true;

describe("Supabase 클라이언트가 Database 를 달고 있다", () => {
  it("세 클라이언트 모두 행 타입이 풀린다 — never 가 아니다", () => {
    expect([SERVER_ROW_IS_RESOLVED, BROWSER_ROW_IS_RESOLVED, ADMIN_ROW_IS_RESOLVED]).toEqual([
      true,
      true,
      true,
    ]);
  });

  it("세 클라이언트 모두 칸 값이 any 가 아니다", () => {
    expect([SERVER_COL_IS_NOT_ANY, BROWSER_COL_IS_NOT_ANY, ADMIN_COL_IS_NOT_ANY]).toEqual([
      false,
      false,
      false,
    ]);
  });

  it("값 타입이 DB 그대로다 — role 은 enum, net_amount 는 number", () => {
    expect([ROLE_IS_THE_ENUM, NET_AMOUNT_IS_NUMBER]).toEqual([true, true]);
  });

  /**
   * **검사가 헛돌지 않는지 본다**(§7.0b). 위의 단언들이 늘 통과하는 모양이면
   * 아무것도 지키지 않는다 — 틀린 짝을 넣어 반대 답이 나오는지 확인한다.
   */
  it("검사가 헛돌지 않는다 — never 와 any 를 실제로 가려낸다", () => {
    const neverIsNotResolved: IsResolved<never> = false;
    const anyIsAny: IsAny<any> = true;
    const stringIsNotAny: IsAny<string> = false;
    const roleIsNotString: MutuallyAssignable<ServerRow["role"], string> = false;

    expect([neverIsNotResolved, anyIsAny, stringIsNotAny, roleIsNotString]).toEqual([
      false,
      true,
      false,
      false,
    ]);
  });
});

// =============================================================================
// 자리를 새로 만들 때도 지켜진다 — 원본 훑기
// =============================================================================
//
// 위의 타입 단언은 **세 팩토리**만 본다. 그런데 이 리포에서 타입이 실제로 버려지던
// 자리는 팩토리가 아니라 **경계**였다 — 로더들이 인자를 `client: SupabaseClient` 로
// 받았고, 그 기본값이 `Database = any` 라 **팩토리를 아무리 좁혀도 그 안에서 전부
// 풀렸다**(FIX-67 회차에 63자리). 그런 자리는 새로 만들기도 쉽다.
//
// 그래서 **문법이 아니라 목록으로** 본다 — `no-store.test.ts` 와 같은 방식이다.

const ROOT = process.cwd();

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    // **테스트 파일은 뺀다.** 이 파일 자신이 아래에서 맨몸 표기를 *문자열로* 들고
    // 있어서, 안 빼면 검사가 자기를 잡는다(실제로 그랬다).
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

const sources = [...walk(join(ROOT, "app")), ...walk(join(ROOT, "lib"))].map((f) => ({
  file: relative(ROOT, f).split(sep).join("/"),
  text: readFileSync(f, "utf8"),
}));

/** 타입 인자가 없는 `SupabaseClient` 주석. 그 기본값은 `any` 다. */
const BARE_ANNOTATION = /:\s*SupabaseClient(?![<\w])/;

/** 타입 인자가 없는 클라이언트 생성. */
const BARE_FACTORY = /(createSupabaseClient|createServerClient|createBrowserClient)\s*\(/;

describe("클라이언트 타입이 경계에서 버려지지 않는다", () => {
  it("**훑을 파일을 실제로 찾았다** — 못 찾으면 아래 검사가 빈 목록을 통과시킨다", () => {
    // 빈 목록으로 통과하지 않게 한다(§7.0b).
    expect(sources.length).toBeGreaterThanOrEqual(200);
    expect(sources.map((s) => s.file)).toContain("lib/supabase/server.ts");
  });

  it("**`SupabaseClient` 를 맨몸으로 쓰지 않는다** — 맨몸이면 `Database` 가 `any` 다", () => {
    const bare = sources.filter((s) => BARE_ANNOTATION.test(s.text)).map((s) => s.file);

    expect(bare).toEqual([]);
  });

  it("**클라이언트를 만들 때 `<Database>` 를 붙인다**", () => {
    const bare = sources
      .filter((s) => BARE_FACTORY.test(s.text))
      .map((s) => s.file)
      .sort();

    expect(bare).toEqual([]);
  });

  /**
   * **검사가 헛돌지 않는지 본다**(§7.0b). 정규식이 아무것도 안 맞으면 위의 두 검사는
   * 늘 빈 배열을 보고 통과한다 — 맞아야 할 것에 실제로 맞는지 여기서 확인한다.
   */
  it("검사가 헛돌지 않는다 — 맨몸 표기를 실제로 잡아낸다", () => {
    expect(BARE_ANNOTATION.test("  client: SupabaseClient,")).toBe(true);
    expect(BARE_ANNOTATION.test("  client: SupabaseClient<Database>,")).toBe(false);
    expect(BARE_FACTORY.test('createServerClient(url, key, {})')).toBe(true);
    expect(BARE_FACTORY.test('createServerClient<Database>(url, key, {})')).toBe(false);
  });
});
