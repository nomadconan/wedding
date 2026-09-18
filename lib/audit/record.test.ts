import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * **증적 쓰기는 한 자리에서만 한다** (FIX-72)
 *
 * ── 왜 검사가 필요한가 ──────────────────────────────────────────────────────
 * 전에는 `audit_logs` 에 넣는 **25자리가 손으로 적혀 있었고 결과를 보는 자리가 하나도
 * 없었다.** `await admin.from("audit_logs").insert({...})` 로 끝나므로 **DB 가 거절해도
 * 부르는 쪽은 성공으로 읽는다.** FIX-71 이 정확히 그렇게 났다 — 배치가 지어낸 uuid 를
 * 넣어 FK 에 걸렸는데 배치는 `{"ok":true}` 를 돌려줬고 증적만 사라졌다.
 *
 * **한 자리씩 고치면 26번째가 생기는 날 같은 일이 반복된다.** 그래서 자리를 하나로
 * 모았고, 손으로 적는 길이 다시 열리지 않는지 여기서 본다.
 *
 * ── 왜 린트 규칙이 아니라 테스트인가 ────────────────────────────────────────
 * 커스텀 린트 규칙에는 **새 패키지**가 필요하고, 이 검사가 보는 것은 문법이 아니라
 * **"증적을 쓰는 자리가 몇 개인가" 라는 목록**이다 — `no-store.test.ts` ·
 * `lib/supabase/typing.test.ts` 와 같은 판단이다.
 */

const ROOT = process.cwd();

/** 래퍼 자신. 여기서만 표에 직접 쓴다. */
const WRAPPER = "lib/audit/record.ts";

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    // **테스트 파일은 뺀다** — 이 파일이 아래에서 금지된 모양을 *문자열로* 들고 있다.
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

const sources = [...walk(join(ROOT, "app")), ...walk(join(ROOT, "lib"))].map((f) => ({
  file: relative(ROOT, f).split(sep).join("/"),
  text: readFileSync(f, "utf8"),
}));

/** 표에 직접 쓰는 모양. 래퍼 밖에서는 금지다. */
const DIRECT_AUDIT_WRITE = /\.from\(\s*["'`]audit_logs["'`]\s*\)\s*\n?\s*\.(insert|update|upsert)\s*\(/;

/**
 * 행위자 자리에 지어낸 uuid.
 *
 * `actor_id` 는 `auth.users` 를 참조하므로 **없는 사람을 적으면 FK 가 거절하고 증적이
 * 통째로 사라진다**(FIX-71 · FIX-72). 사람이 없으면 `null` 이고, 실행자는 `source` 가
 * 말한다(D-173).
 */
const INVENTED_ACTOR =
  /(actor|actorId|operatorId|actor_id)\s*[:=][^;\n]{0,60}["'`]0{8}-0{4}-0{4}-0{4}-0{12}["'`]/;

describe("증적 쓰기 자리", () => {
  it("**훑을 파일을 실제로 찾았다** — 못 찾으면 아래 검사가 빈 목록을 통과시킨다", () => {
    // 빈 목록으로 조용히 통과하지 않게 한다(§7.0b).
    expect(sources.length).toBeGreaterThanOrEqual(200);
    expect(sources.map((s) => s.file)).toContain(WRAPPER);
  });

  it("**`audit_logs` 에 직접 쓰는 자리는 래퍼뿐이다** — 손으로 적으면 결과를 안 보게 된다", () => {
    const direct = sources
      .filter((s) => s.file !== WRAPPER && DIRECT_AUDIT_WRITE.test(s.text))
      .map((s) => s.file)
      .sort();

    expect(direct).toEqual([]);
  });

  it("**래퍼를 실제로 쓰고 있다** — 호출이 사라지면 위 검사는 빈 리포도 통과시킨다", () => {
    const calls = sources
      .filter((s) => s.file !== WRAPPER)
      .reduce((sum, s) => sum + (s.text.match(/\brecordAudit\s*\(/g) ?? []).length, 0);

    // FIX-72 회차에 25자리를 옮겼다. 줄어들면 이 수를 함께 내린다.
    expect(calls).toBeGreaterThanOrEqual(25);
  });

  it("**행위자를 지어내지 않는다** — 0 uuid 는 `auth.users` FK 가 거절한다", () => {
    const invented = sources
      .filter((s) => INVENTED_ACTOR.test(s.text))
      .map((s) => s.file)
      .sort();

    expect(invented).toEqual([]);
  });

  /**
   * **검사가 헛돌지 않는지 본다**(§7.0b). 정규식이 아무것도 안 맞으면 위의 검사들은
   * 늘 빈 배열을 보고 통과한다 — 맞아야 할 것에 실제로 맞는지 여기서 확인한다.
   * FIX-67 에서 부분 문자열 때문에 검사가 세 번 헛돌았다.
   */
  it("검사가 헛돌지 않는다 — 금지된 모양을 실제로 잡아낸다", () => {
    expect(DIRECT_AUDIT_WRITE.test('await admin.from("audit_logs").insert({ a: 1 });')).toBe(true);
    expect(DIRECT_AUDIT_WRITE.test('await admin\n  .from("audit_logs")\n  .insert({});')).toBe(true);
    expect(DIRECT_AUDIT_WRITE.test("await recordAudit({ action: 'x' });")).toBe(false);
    // 읽기는 막지 않는다 — 운영자 화면이 이 표를 읽는다.
    expect(DIRECT_AUDIT_WRITE.test('await admin.from("audit_logs").select("id");')).toBe(false);

    expect(INVENTED_ACTOR.test('actorId: "00000000-0000-0000-0000-000000000000",')).toBe(true);
    expect(INVENTED_ACTOR.test('actor: { id: x ?? "00000000-0000-0000-0000-000000000000" },')).toBe(
      true,
    );
    expect(INVENTED_ACTOR.test("actorId: null,")).toBe(false);
    // 행위자가 아닌 자리의 같은 uuid 는 막지 않는다(`.in()` 의 빈 목록 자리 등).
    expect(INVENTED_ACTOR.test('.in("review_id", ["00000000-0000-0000-0000-000000000000"])')).toBe(
      false,
    );
  });
});
