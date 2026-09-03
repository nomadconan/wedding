// =============================================================================
// 점검 결과를 마크다운 표로 (S0-04)
// -----------------------------------------------------------------------------
// `audit-routes.mjs`(정적)와 `audit-runtime.mjs`(실동작)가 남긴 JSON 을 읽어
// `docs/ROUTES.md` 에 붙일 표를 만든다. **손으로 표를 옮겨 적지 않는다** — 이 리포에서
// 손으로 옮긴 표는 네 번 연속 낡았다(커버리지 요약표 · T-00f~T-00k).
//
// 실행:  npm run audit:report            표를 화면에 찍는다
//        npm run audit:report -- --out=tmp/audit-tables.md
//
// 콘솔이 아니라 파일에 담을 때는 `--out` 을 쓴다. 표 자체는 한글이다(문서용).
// =============================================================================
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const ARGS = process.argv.slice(2);
const opt = (n, d) => {
  const hit = ARGS.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};

const statik = JSON.parse(readFileSync(join(ROOT, opt("static", "tmp/audit-static.json")), "utf8"));

/**
 * 화면과 API 를 따로 돌릴 수 있으므로 결과 파일이 여럿이다. 있는 것을 다 읽어 **합친다** —
 * 한 파일만 읽으면 나중에 돈 쪽이 앞의 결과를 지운 것처럼 보인다.
 */
const RUNTIME_FILES = (opt("runtime", "tmp/audit-runtime.json,tmp/audit-screens.json,tmp/audit-api.json"))
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const runtime = { screens: [], apis: [], fixturesMissing: [], sources: [] };
for (const file of RUNTIME_FILES) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(join(ROOT, file), "utf8"));
  } catch {
    continue;
  }
  if (parsed.screens?.length) {
    runtime.screens = parsed.screens;
    runtime.sources.push(`${file}(화면 ${parsed.screens.length})`);
  }
  if (parsed.apis?.length) {
    runtime.apis = parsed.apis;
    runtime.sources.push(`${file}(API ${parsed.apis.length})`);
  }
  if (parsed.fixturesMissing?.length) runtime.fixturesMissing = parsed.fixturesMissing;
}
if (!runtime.screens.length && !runtime.apis.length) {
  console.error(`실동작 결과가 없다. 먼저 npm run audit:screens / audit:api 를 돌린다.`);
  process.exit(1);
}

const ACCOUNT_ORDER = [
  ["guest", "비로그인"],
  ["couple-a", "커플A"],
  ["couple-b", "커플B"],
  ["couple-linked-a", "연동A"],
  ["couple-linked-b", "연동B"],
  ["planner", "플래너"],
  ["vendor", "업체"],
  ["staff", "스태프"],
  ["ops", "ops"],
  ["admin", "admin"],
];

/** 표 칸에 들어갈 짧은 코드. 뜻은 문서의 범례가 든다. */
function code(verdict) {
  if (!verdict) return "·";
  if (verdict.startsWith("정상")) return "정상";
  if (verdict === "빈 상태") return "빈";
  if (verdict === "로그인 요구") return "로그인";
  if (verdict === "권한 거부") return "거부";
  if (verdict === "404") return "404";
  if (verdict.startsWith("리다이렉트")) return verdict.replace("리다이렉트(→", "→").replace(")", "");
  // `오류 상태(CODE)` 는 **화면이 제 일을 한 경우**가 섞여 있다(선행 조건 미충족).
  // 굵게 칠하면 표가 정상을 결함으로 보이게 하므로 낱말을 갈아 끼운다 — 뜻은 §3 범례가 든다.
  if (verdict.startsWith("오류 상태(")) return "전제 필요(" + verdict.slice("오류 상태(".length);
  if (verdict === "로딩 고착") return "**로딩고착**";
  if (verdict.startsWith("오류")) return "**" + verdict + "**";
  return verdict;
}

/**
 * **우리가 친 URL 의 응답 코드**를 고른다.
 *
 * 화면이 뜬 뒤 Next 가 링크를 미리 당겨오고 그중 보호 경로는 307 로 되돌아온다.
 * 기록된 문서 응답 중 마지막을 쓰면 그 307 이 화면의 상태로 둔갑한다 — 정상으로
 * 200 이 뜬 화면이 307 로 적히는 것이다. 오래된 결과 파일에도 같은 보정을 건다.
 */
function statusOf(r) {
  const want = (r.url ?? "").split("?")[0];
  for (const entry of r.chain ?? []) {
    const at = entry.indexOf(" ");
    if (at < 0) continue;
    const code = Number(entry.slice(0, at));
    const path = entry.slice(at + 1).split("?")[0];
    if (path === want) return code;
  }
  return r.status;
}

/** 마크다운 표 칸 안의 파이프는 반드시 이스케이프한다(FIX-38 이 그 사고다). */
const cell = (s) => String(s).split("|").join("\\|");

const out = [];
const say = (s = "") => out.push(s);

// --- 1. 분모 ------------------------------------------------------------------

const c = statik.counts;
say("### 분모 (실측)");
say();
say("| 목록 | 수 | 무엇을 세는가 |");
say("|---|---|---|");
say(`| 실제 \`app/**/page.tsx\` | **${c.pages}** | **이 점검의 분모.** 사용자가 URL 로 열 수 있는 화면 |`);
say(`| 실제 \`app/**/route.ts\` | **${c.apis}** | **API 점검의 분모** |`);
say(`| 명세 \`docs/07\` §6 경로 | ${c.spec} | 문서가 약속한 화면 |`);
say(`| 커버리지 검증표 D(\`docs/TASKS.md\`) | ${c.coverageTableRows} | 태스크 대응을 적은 세 번째 목록 |`);
say();

// --- 2. 차집합 셋 --------------------------------------------------------------

say("### 차집합 셋 (명세 §6 ↔ 실제 화면)");
say();
say(`**둘 다 있음 ${c.both} · 명세에만 ${c.specOnly} · 실제에만 ${c.codeOnly}**`);
say();
say("| 구분 | 경로 | 비고 |");
say("|---|---|---|");
for (const s of statik.specOnly) say(`| 명세에만 | \`${s.route}\` | ${cell(s.screen)} (${s.section}) — 화면 파일이 없다 |`);
for (const p of statik.codeOnly) say(`| 실제에만 | \`${p.route}\` | \`${p.file}\` |`);
say();

// --- 3. 화면 × 계정 -----------------------------------------------------------

const byRoute = new Map();
for (const r of runtime.screens) {
  if (!byRoute.has(r.route)) byRoute.set(r.route, {});
  byRoute.get(r.route)[r.account] = r;
}

say("### 화면 × 계정");
say();
say(`| 경로 | ${ACCOUNT_ORDER.map(([, l]) => l).join(" | ")} |`);
say(`|---|${ACCOUNT_ORDER.map(() => "---").join("|")}|`);
for (const [route, row] of [...byRoute.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  const cells = ACCOUNT_ORDER.map(([k]) => code(row[k]?.verdict));
  const missing = ACCOUNT_ORDER.some(([k]) => row[k]?.fixtureMissing);
  say(`| \`${route}\`${missing ? " ※" : ""} | ${cells.join(" | ")} |`);
}
say();
say("※ = 시드에 해당 행이 없어 **없는 id** 로 열었다. 그 칸의 `404` 는 결함이 아니라 '못 찾음 경로가 깨끗이 끝났다' 는 뜻이다.");
say();

// --- 4. 화면 요약 --------------------------------------------------------------

const tally = {};
for (const r of runtime.screens) {
  const k = code(r.verdict);
  tally[k] = (tally[k] ?? 0) + 1;
}
say("### 화면 점검 요약");
say();
say("| 판정 | 건수 |");
say("|---|---|");
for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) say(`| ${k} | ${v} |`);
say(`| **합계** | **${runtime.screens.length}** |`);
say();

// --- 5. API × 계정 ------------------------------------------------------------

if (runtime.apis.length) {
  const apiByRoute = new Map();
  for (const r of runtime.apis) {
    const key = `${r.method} ${r.route}`;
    if (!apiByRoute.has(key)) apiByRoute.set(key, {});
    apiByRoute.get(key)[r.account] = r;
  }
  say("### API × 계정 (HTTP 상태)");
  say();
  say(`| 메서드·경로 | ${ACCOUNT_ORDER.map(([, l]) => l).join(" | ")} |`);
  say(`|---|${ACCOUNT_ORDER.map(() => "---").join("|")}|`);
  for (const [key, row] of [...apiByRoute.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const cells = ACCOUNT_ORDER.map(([k]) => {
      const s = row[k] ? statusOf(row[k]) : null;
      if (s === undefined || s === null) return "·";
      return s >= 500 ? `**${s}**` : String(s);
    });
    say(`| \`${key}\` | ${cells.join(" | ")} |`);
  }
  say();

  const apiTally = {};
  for (const r of runtime.apis) {
    apiTally[r.verdict] = (apiTally[r.verdict] ?? 0) + 1;
  }
  say("### API 점검 요약");
  say();
  say("| 판정 | 건수 |");
  say("|---|---|");
  for (const [k, v] of Object.entries(apiTally).sort((a, b) => b[1] - a[1])) say(`| ${k} | ${v} |`);
  say(`| **합계** | **${runtime.apis.length}** |`);
  say();
}

// --- 6. 내비게이션 -------------------------------------------------------------

say("### 내비게이션 링크 대조");
say();
say("| 내비 | 링크 | 실제 라우트 | 판정 |");
say("|---|---|---|---|");
for (const nav of statik.navResults) {
  for (const l of nav.links) {
    say(`| \`${nav.nav}\` | \`${l.href}\` | ${l.ok ? "있음" : "**없음**"} | ${l.ok ? "정상" : "**죽은 링크**"} |`);
  }
}
say();
say("### 화면 안의 죽은 링크 (내비 넷 밖의 `href`)");
say();
if (!statik.deadHrefs?.length) {
  say("없다.");
} else {
  say("| 링크 | 어디서 | 왜 죽었나 |");
  say("|---|---|---|");
  for (const d of statik.deadHrefs) {
    say(`| \`${d.href}\` | ${d.from.map((f) => "`" + f + "`").join(" · ")} | 실재하는 화면 라우트가 없다 |`);
  }
}
say();

const unreachableReal = statik.unreachable.filter((u) => !u.standaloneReason);
const standalone = statik.unreachable.filter((u) => u.standaloneReason);

say("### 도달 불가 화면 (어느 내비도 어느 화면도 가리키지 않는다)");
say();
if (unreachableReal.length === 0) {
  say("없다.");
} else {
  say("| 경로 | 파일 |");
  say("|---|---|");
  for (const u of unreachableReal) say(`| \`${u.route}\` | \`${u.file}\` |`);
}
say();
say("#### 가리키는 자리가 없어도 정상인 화면");
say();
say("| 경로 | 왜 |");
say("|---|---|");
for (const u of standalone) say(`| \`${u.route}\` | ${cell(u.standaloneReason)} |`);
say();

// --- 7. 시드 픽스처 공백 -------------------------------------------------------

say("### 시드에 없어 실제 id 로 열지 못한 것");
say();
if (!runtime.fixturesMissing?.length) {
  say("없다.");
} else {
  say("`" + runtime.fixturesMissing.join("` · `") + "`");
}
say();

const text = out.join("\n");
const target = opt("out", null);
if (target) {
  writeFileSync(join(ROOT, target), text);
  console.log(`${target} 에 저장했다.`);
} else {
  console.log(text);
}
