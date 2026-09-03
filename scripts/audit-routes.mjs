// =============================================================================
// 라우트 정적 전수 대조 (S0-04)
// -----------------------------------------------------------------------------
// 네 가지를 한 번에 본다. 넷 다 "세어 보면 다른 수가 나온다" 는 문제에서 나왔다 —
// 명세 §6 의 경로 수(83)와 커버리지 검증표 D 의 행 수(87)와 실제 `page.tsx`(97)와
// `route.ts`(128)가 서로 달랐고, 어느 것이 전수의 분모인지 아무도 적어 두지 않았다.
//
//  1) **분모 대조** — 명세 §6 · 커버리지 표 D · 실제 라우트의 차집합.
//  2) **내비 링크 대조** — `ADMIN_NAV`·`VENDOR_NAV`·`PLANNER_NAV`·`BottomTabNav` 가
//     가리키는 경로가 실재하는가(죽은 링크 · FIX-23 계열).
//  3) **화면 안의 링크** — 내비 넷 밖의 `href` 도 전수로 본다. 랜딩은 자기 헤더 내비를
//     따로 들고 있고, 실제로 여기서 `/contracts/[id]` 로 가는 죽은 링크가 나왔다.
//  4) **도달 가능성** — 화면이 있는데 **어느 내비도 어느 화면도 가리키지 않는** 것
//     (FIX-25 계열).
//
// 실행:  npm run audit:routes            사람이 읽는 표 + tmp/audit-static.json
//
// **종료 코드는 항상 0 이다.** 이 스크립트는 게이트가 아니라 조사 도구다 —
// 발견은 FIX 번호로 `docs/TASKS.md` 에 등록하고 고치는 것은 담당 태스크가 한다.
// 게이트로 쓰면 "죽은 링크가 하나 생겼다" 는 이유로 무관한 PR 이 막힌다.
// =============================================================================
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { listRoutes, shape, walk } from "./lib/app-routes.mjs";

const ROOT = process.cwd();
const SPEC = "docs/07_개발명세서.md";

// --- 1. 실제 라우트 -----------------------------------------------------------

const { pages, apis } = listRoutes(ROOT);

// --- 2. 명세 §6 의 경로 -------------------------------------------------------

function parseSpec() {
  const text = readFileSync(join(ROOT, SPEC), "utf8");
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^## 6\. /.test(l));
  const end = lines.findIndex((l, i) => i > start && /^## 7\. /.test(l));
  const rows = [];
  let section = "";
  for (const line of lines.slice(start, end)) {
    const h = line.match(/^### (6\.\d)\s+(.*)$/);
    if (h) {
      section = "§6." + h[1].split(".")[1] + " " + h[2];
      continue;
    }
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.length < 2) continue;
    const raw = cells[0].replace(/\*\*/g, "").replace(/`/g, "").trim();
    if (!raw.startsWith("/")) continue; // 헤더행·구분선은 여기서 걸린다
    const screen = cells[1].replace(/\*\*/g, "").replace(/`/g, "").trim();
    rows.push({ route: raw, screen, section });
  }
  return rows;
}

const spec = parseSpec();

const pageShapes = new Map(pages.map((p) => [shape(p.route), p]));
const specShapes = new Map(spec.map((s) => [shape(s.route), s]));

const specOnly = spec.filter((s) => !pageShapes.has(shape(s.route)));
const codeOnly = pages.filter((p) => !specShapes.has(shape(p.route)));
const both = pages.filter((p) => specShapes.has(shape(p.route)));

// 이름만 다른 동적 세그먼트는 따로 적는다 — 라우팅은 같지만 문서는 어긋나 있다.
const segmentMismatch = both
  .filter((p) => specShapes.get(shape(p.route)).route !== p.route)
  .map((p) => ({ code: p.route, spec: specShapes.get(shape(p.route)).route }));

// --- 3. 내비게이션 ------------------------------------------------------------

function navItems(file, constName) {
  const text = readFileSync(join(ROOT, file), "utf8");
  const at = text.indexOf(constName);
  if (at < 0) return [];
  // `const ADMIN_NAV: NavItem[] = [` — 타입 표기의 `[]` 를 배열 시작으로 착각하면
  // 링크가 0개로 세어진다. `=` 뒤의 첫 `[` 를 잡는다.
  const eq = text.indexOf("=", at);
  const open = text.indexOf("[", eq);
  let depth = 0;
  let close = open;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === "[") depth += 1;
    if (text[i] === "]") {
      depth -= 1;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  const block = text.slice(open, close + 1);
  return [...block.matchAll(/href:\s*"([^"]+)"/g)].map((m) => m[1]);
}

const NAVS = [
  { name: "VENDOR_NAV", file: "components/layout/AdminShell.tsx" },
  { name: "ADMIN_NAV", file: "components/layout/AdminShell.tsx" },
  { name: "PLANNER_NAV", file: "components/layout/AdminShell.tsx" },
  { name: "TABS", file: "components/layout/BottomTabNav.tsx", label: "BottomTabNav" },
];

/**
 * 링크 하나가 실재하는 라우트를 가리키는가.
 *
 * **세그먼트 단위로 견준다.** 모양 문자열끼리 비교하면 `/prices/[*]/hall` 이
 * `/prices/[region]/[category]` 와 다른 것으로 나온다 — 카테고리 자리에 **구체적인
 * 값**을 넣은 정상 링크인데 죽은 링크로 잡힌다. 라우팅은 그렇게 판정하지 않는다.
 */
function routeExists(target) {
  const t = target.split("?")[0].split("/").filter(Boolean);
  return pages.some((p) => {
    const r = p.route.split("/").filter(Boolean);
    if (r.length !== t.length) return false;
    return r.every((seg, i) => seg.startsWith("[") || t[i] === "[*]" || seg === t[i]);
  });
}

const navResults = NAVS.map((n) => ({
  nav: n.label ?? n.name,
  links: navItems(n.file, "const " + n.name).map((href) => ({
    href,
    ok: routeExists(href),
  })),
}));

// --- 4. 링크 수집 -------------------------------------------------------------

const SOURCE_DIRS = ["app", "components", "lib", "hooks"];

/**
 * 주석을 걷어낸다.
 *
 * **없으면 도달 가능성이 거짓으로 나온다.** `/admin/settlements` 는 어느 내비도
 * 가리키지 않는데 다른 파일의 JSDoc 에 경로가 적혀 있어 '도달 가능' 으로 세어졌다.
 * 주석은 링크가 아니다.
 *
 * `//` 는 앞이 `:` 이면 자르지 않는다 — `https://` 를 주석으로 오인하면 문자열이
 * 통째로 날아간다(그 안의 내부 경로까지).
 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");
}

/**
 * **두 질문에 서로 다른 엄격함이 필요하다.**
 *
 *  · *도달 가능성* — "여기로 가는 길이 하나라도 있는가". 놓치면 정상 화면을 결함으로
 *    적게 되므로 **넉넉하게** 센다(URL 조립 표현까지 포함).
 *  · *죽은 링크* — "이 링크가 없는 곳을 가리키는가". 넉넉하면 `"/rsvp/"` 를 인자로 받는
 *    문자열 치환까지 링크로 잡히므로 **좁게** 센다(진짜 `href` 와 라우터 이동만).
 *
 * 그래서 목록을 둘 만든다. 하나로 합치면 한쪽이 반드시 거짓말한다.
 */
const LOOSE_PATTERNS = [
  /href=\{?["'`](\/[^"'`\s{}]*)["'`]/g,
  /href=\{`([^`]*)`\}/g,
  /href:\s*["'`](\/[^"'`]*)["'`]/g,
  /(?:router\.push|router\.replace|redirect|permanentRedirect)\(\s*[`"']([^`"']*)[`"']/g,
  // URL 조립 — `${base}/share/${token}` 처럼 앞이 변수라 `/` 로 시작하지 않는다.
  /(\/[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)*)\/\$\{/g,
];
const STRICT_COUNT = 4;

/** `${...}` 를 `[*]` 로 바꾸고, 글자와 섞인 세그먼트부터는 잘라 버린다. */
function normalizeTarget(path) {
  const clean = path.split("?")[0].split("#")[0];
  const replaced = clean.replace(/\$\{[^}]*\}/g, "[*]");
  const segs = replaced.split("/");
  const out = [];
  for (const seg of segs) {
    // `audit[*]` 처럼 글자와 자리표시가 섞이면 그 아래는 경로가 아니라 쿼리·접미사다.
    if (seg.includes("[*]") && seg !== "[*]") break;
    // 표현식이 중간에서 끊긴 조각(`audit${next.toString()`)도 마찬가지다 —
    // 정규식이 백틱에서 잘라 온 것이라 `${...}` 가 닫히지 않아 위 치환이 못 걷는다.
    if (seg.includes("$")) break;
    out.push(seg);
  }
  const joined = out.join("/").replace(/\/$/, "") || "/";
  return joined.startsWith("/") ? joined : null;
}

const linkTargets = new Map(); // 넉넉한 목록: 경로 -> Set<파일>
const strictLinks = new Map(); // 좁은 목록:   경로 -> Set<파일>

function collect(map, path, file) {
  const t = normalizeTarget(path);
  if (!t) return;
  if (!map.has(t)) map.set(t, new Set());
  map.get(t).add(file);
}

for (const dir of SOURCE_DIRS) {
  let all;
  try {
    all = walk(join(ROOT, dir));
  } catch {
    continue;
  }
  for (const full of all) {
    if (!/\.(tsx?|mjs)$/.test(full)) continue;
    if (/\.test\.tsx?$/.test(full)) continue;
    const rel = full.slice(ROOT.length + 1).split("\\").join("/");
    const text = stripComments(readFileSync(full, "utf8"));
    LOOSE_PATTERNS.forEach((re, idx) => {
      re.lastIndex = 0;
      const isBuilder = idx === LOOSE_PATTERNS.length - 1;
      for (const m of text.matchAll(re)) {
        if (!m[1] || !m[1].startsWith("/")) continue;
        collect(linkTargets, isBuilder ? `${m[1]}/[*]` : m[1], rel);
        if (idx < STRICT_COUNT) collect(strictLinks, m[1], rel);
      }
    });
  }
}

// --- 4a. 화면 안의 죽은 링크 --------------------------------------------------

const apiShapes = new Set(apis.map((a) => shape(a.route)));
const SKIP_PREFIX = ["/api", "/_next", "/storage", "/images", "/icons"];
const deadHrefs = [];
for (const [target, files] of strictLinks) {
  if (routeExists(target)) continue;
  if (apiShapes.has(shape(target))) continue;
  if (SKIP_PREFIX.some((x) => target === x || target.startsWith(`${x}/`))) continue;
  if (/\.[a-z0-9]{2,4}$/i.test(target)) continue; // robots.txt · sitemap.xml · 이미지
  deadHrefs.push({ href: target, from: [...files].sort() });
}
deadHrefs.sort((a, b) => a.href.localeCompare(b.href));

// --- 4b. 도달 가능성 ----------------------------------------------------------

/**
 * **가리키는 자리가 없어도 정상인 화면.** 이유를 적지 않으면 다음 사람이 "링크를
 * 붙여야 하나" 를 매번 다시 묻는다. 목록에 넣는 조건은 **앱 밖에서 들어오는 화면**
 * 이거나 **제품 내비게이션에 올리지 않기로 이미 결정된 화면**이다.
 */
const STANDALONE = {
  "/": "랜딩 — 진입점 그 자체다",
  "/login": "로그인 — 미들웨어가 보내는 자리이며 내비에 올리지 않는다",
  "/design-system":
    "컴포넌트 카탈로그(dev) — 제품 내비에 연결하지 않기로 했다(S8-05 · 프로덕션에서는 404)",
  "/admin/consultation-disputes":
    "명세 §6.4 경로를 살려 두는 리다이렉트다 — `/admin/disputes?source=consultation` 으로 보낸다." +
    " 내비가 따로 가리키면 **같은 큐가 목록에 두 벌** 서고(D-121) 그 둘이 갈리는 날 어느" +
    " 쪽이 맞는지 답할 수 없다. 실제 입구는 `/admin/disputes` 의 출처 필터 칩이며 그 화면은" +
    " `ADMIN_NAV` 에 있다.",
  "/share/[token]": "공유 링크 — 앱 밖(메신저·메일)에서 열린다",
  "/rsvp/[token]": "하객 응답 — 초대 링크로 앱 밖에서 열린다",
  "/vendor/invite/[token]": "업체 초대 수락 — 초대 메일 링크로 들어온다",
};

/** 이 화면을 가리키는 링크가 자기 파일 밖에 있는가. */
function linkedFromElsewhere(page) {
  const target = shape(page.route).split("/").filter(Boolean);
  for (const [key, files] of linkTargets) {
    const a = key.split("/").filter(Boolean);
    if (a.length !== target.length) continue;
    const same = a.every((seg, i) => seg === "[*]" || target[i] === "[*]" || seg === target[i]);
    if (!same) continue;
    if ([...files].some((f) => f !== page.file)) return true;
  }
  return false;
}

const unreachable = pages
  .filter((p) => !linkedFromElsewhere(p))
  .map((p) => ({
    route: p.route,
    file: p.file,
    standaloneReason: STANDALONE[shape(p.route)] ?? null,
  }));

/** 실제로 문제인 것 — 앱 안에서 들어갈 자리가 없어야 할 이유가 없는 화면. */
const unreachableReal = unreachable.filter((u) => !u.standaloneReason);

// --- 5. 커버리지 검증표 D (docs/TASKS.md) -------------------------------------
// 네 번째 축이다. 명세 §6 도 아니고 실제 라우트도 아닌 **세 번째 목록**이 있고,
// 그 수가 명세와도 실제와도 달랐다 — S0-04 가 분모를 물은 이유다.

function coverageTableD() {
  const lines = readFileSync(join(ROOT, "docs", "TASKS.md"), "utf8").split(/\r?\n/);
  const start = lines.findIndex((l) => /^### D\. §6 화면/.test(l));
  if (start < 0) return [];
  const rows = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^###\s/.test(lines[i])) break;
    const l = lines[i].trim();
    if (!l.startsWith("|")) continue;
    const cells = l.slice(1).split("|").map((c) => c.trim());
    const raw = cells[0].replace(/\*\*/g, "").replace(/`/g, "").trim();
    if (!raw.startsWith("/")) continue;
    rows.push({ route: raw, status: (cells[3] ?? "").replace(/\*\*/g, "").trim() });
  }
  return rows;
}

const coverage = coverageTableD();
const coverShapes = new Set(coverage.map((c) => shape(c.route)));
const coverageDiff = {
  rows: coverage.length,
  inTableNoPage: coverage.filter((c) => !pageShapes.has(shape(c.route))).map((c) => c.route),
  pageNotInTable: pages.filter((p) => !coverShapes.has(shape(p.route))).map((p) => p.route),
  inTableNotInSpec: coverage.filter((c) => !specShapes.has(shape(c.route))).map((c) => c.route),
  inSpecNotInTable: spec.filter((s) => !coverShapes.has(shape(s.route))).map((s) => s.route),
};

// --- 출력 ---------------------------------------------------------------------

const report = {
  generatedAt: new Date().toISOString(),
  counts: {
    pages: pages.length,
    apis: apis.length,
    spec: spec.length,
    both: both.length,
    specOnly: specOnly.length,
    codeOnly: codeOnly.length,
    segmentMismatch: segmentMismatch.length,
    deadNavLinks: navResults.reduce((n, r) => n + r.links.filter((l) => !l.ok).length, 0),
    deadHrefs: deadHrefs.length,
    unreachable: unreachable.length,
    unreachableReal: unreachableReal.length,
    coverageTableRows: coverage.length,
  },
  pages,
  apis,
  spec,
  specOnly,
  codeOnly,
  both,
  segmentMismatch,
  navResults,
  deadHrefs,
  unreachable,
  unreachableReal,
  coverageDiff,
};

mkdirSync(join(ROOT, "tmp"), { recursive: true });
writeFileSync(join(ROOT, "tmp", "audit-static.json"), JSON.stringify(report, null, 2));

const line = (s = "") => console.log(s);
line("=== 분모 ===");
line("  명세 §6 경로        : " + spec.length);
line("  커버리지 검증표 D   : " + coverage.length);
line("  실제 page.tsx       : " + pages.length);
line("  실제 route.ts (API) : " + apis.length);
line("  명세·실제 둘 다     : " + both.length);
line("  명세에만            : " + specOnly.length);
line("  실제에만            : " + codeOnly.length);
line();
line("=== 명세에만 있음 (화면이 없다) ===");
for (const s of specOnly) line("  " + s.route + "  — " + s.screen + " (" + s.section + ")");
line();
line("=== 실제에만 있음 (명세에 없다) ===");
for (const p of codeOnly) line("  " + p.route + "  — " + p.file);
line();
line("=== 동적 세그먼트 이름 불일치 (라우팅은 같다) ===");
for (const m of segmentMismatch) line("  코드 " + m.code + "  <->  명세 " + m.spec);
line();
line("=== 내비게이션 죽은 링크 ===");
for (const r of navResults) {
  const dead = r.links.filter((l) => !l.ok);
  line("  " + r.nav + ": 링크 " + r.links.length + " 중 죽은 링크 " + dead.length);
  for (const d of dead) line("    x " + d.href);
}
line();
line("=== 화면 안의 죽은 링크 (" + deadHrefs.length + ") ===");
for (const d of deadHrefs) line("  " + d.href + "  <- " + d.from.join(", "));
line();
line("=== 도달 불가 화면 (" + unreachableReal.length + ") ===");
for (const u of unreachableReal) line("  " + u.route + "  — " + u.file);
line();
line("=== 가리키는 자리가 없어도 정상 (" + (unreachable.length - unreachableReal.length) + ") ===");
for (const u of unreachable.filter((x) => x.standaloneReason)) {
  line("  " + u.route + "  — " + u.standaloneReason);
}
line();
line("=== 커버리지 검증표 D (docs/TASKS.md) 대조 ===");
line("  표의 행 수 : " + coverageDiff.rows);
line("  표에 있는데 화면 없음 : " + (coverageDiff.inTableNoPage.join(", ") || "없음"));
line("  화면인데 표에 없음   : " + (coverageDiff.pageNotInTable.join(", ") || "없음"));
line("  표에 있는데 명세 없음 : " + (coverageDiff.inTableNotInSpec.join(", ") || "없음"));
line("  명세인데 표에 없음   : " + (coverageDiff.inSpecNotInTable.join(", ") || "없음"));
line();
line("tmp/audit-static.json 에 저장했다.");
