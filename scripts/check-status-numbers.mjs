import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * `docs/PROJECT_STATUS.md` 의 수치 칸을 **기계로 대조한다** (D-238)
 *
 * ── 왜 ──────────────────────────────────────────────────────────────────────
 * 이 표가 **반복해서 낡는다.** C-4e 회차에 「기록된 의사결정」이 **181** 에 멈춰
 * 있었고(실제 207), 바로 다음 회차에 「마이그레이션」이 **75** 에 멈춰 있었다
 * (실제 84). 손으로 적는 수가 있는 한 계속 낡는다 — 고치는 사람이 자기가 건드린
 * 칸만 고치기 때문이다.
 *
 * `check:coverage-table` 과 같은 방식으로 **셀 수 있는 칸은 세어서 대조**한다.
 *
 * ── 셀 수 있는 것과 없는 것을 가른다 ────────────────────────────────────────
 * `verify` 는 **DB 도 브라우저도 없이** 돈다. 그래서:
 *
 *  · **소스에서 유도되는 칸**(화면·라우트·표·마이그레이션·태스크·결정·FIX)은
 *    **정확히 대조**한다. 틀리면 떨어진다.
 *  · **돌려 봐야 아는 칸**(단위 테스트 수·권한 격리 점검 수·실주행 수·골든셋)은
 *    셀 수 없다. 대신 **`(측정 YYYY-MM-DD)` 표시를 요구**한다 — 수를 강제할 수는
 *    없어도 **언제 잰 수인지는 적게** 할 수 있고, 그것만으로 "낡았는지" 가 보인다.
 *
 * **못 세는 칸을 0 으로 통과시키지 않는다**(§공통) — 측정 표시가 없으면 떨어진다.
 */

const ROOT = process.cwd();
const DOC = "docs/PROJECT_STATUS.md";
const text = readFileSync(path.join(ROOT, DOC), "utf8");

// ── 세는 쪽 ────────────────────────────────────────────────────────────────

function walk(dir, test, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", ".next", ".git"].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, test, out);
    else if (test(e.name, p)) out.push(p);
  }
  return out;
}

const migrations = readdirSync(path.join(ROOT, "supabase/migrations")).filter((f) =>
  f.endsWith(".sql"),
);

const migrationSql = migrations
  .map((f) => readFileSync(path.join(ROOT, "supabase/migrations", f), "utf8"))
  .join("\n");

const tables = new Set(
  [...migrationSql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?public\.([a-z_]+)/gi)].map(
    (m) => m[1].toLowerCase(),
  ),
);

const tasksDoc = readFileSync(path.join(ROOT, "docs/TASKS.md"), "utf8");
const decisionsDoc = readFileSync(path.join(ROOT, "docs/DECISIONS.md"), "utf8");

/** 태스크 행 — ID 칸 + 상태 칸을 가진 행만 센다. */
function taskRows() {
  const seen = new Map();
  for (const line of tasksDoc.split(/\r?\n/)) {
    const m = line.match(
      /^\|\s*\*{0,2}((?:[A-Z]|S\d|T-0)[0-9A-Za-z-]*)\*{0,2}\s*\|\s*[^|]*\|\s*(\*\*\[x\]\*\*|\[x\]|\[ \]|\*\*\[ \]\*\*|\[~\])\s*\|/,
    );
    if (m && !seen.has(m[1])) seen.set(m[1], /\[x\]/.test(m[2]));
  }
  return seen;
}

/** FIX 표 — 등급과 상태를 함께 본다. **"미해소" 안에 "해소" 가 있다.** */
function fixRows() {
  const lines = tasksDoc.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === "| ID | 등급 | 내용 | 상태 | 발견/해소 |");
  if (start < 0) throw new Error(`${DOC} 대조 불가: FIX 표 머리를 못 찾았다`);

  const rows = [];
  for (let i = start + 2; i < lines.length; i += 1) {
    if (!lines[i].startsWith("|")) break;
    const cells = lines[i].replaceAll("\\|", "\u0001").split("|").slice(1, -1);
    if (cells.length !== 5) continue;
    const clean = (s) => s.replace(/\*\*/g, "").replace(/~~/g, "").replace(/\u0001/g, "|").trim();
    rows.push({ id: clean(cells[0]), grade: clean(cells[1]), state: clean(cells[3]) });
  }
  // **"미해소" 안에 "해소" 가 있고, "부분 해소" 도 해소가 아니다.**
  // 앞을 낱말 경계로만 가르면 "부분 해소" 가 해소로 세어 FIX-73 처럼 74자리가
  // 남은 항목이 집계에서 사라진다 — **맨 앞이 `해소` 인 것만** 해소로 친다.
  const done = (r) => /^해소/.test(r.state) || /^해소/.test(r.grade);

  return {
    must: rows.filter((r) => !done(r) && /실서비스 전 필수/.test(r.grade)).length,
    noted: rows.filter((r) => !done(r) && /^기록$/.test(r.grade)).length,
    done: rows.filter(done).length,
  };
}

const tasks = taskRows();
const fixes = fixRows();

const DERIVED = [
  { label: "화면", value: walk(path.join(ROOT, "app"), (n) => n === "page.tsx").length },
  { label: "API·배치", value: walk(path.join(ROOT, "app"), (n) => n === "route.ts").length },
  { label: "DB 표", value: tables.size },
  { label: "마이그레이션", value: migrations.length },
  { label: "태스크", value: tasks.size },
  {
    label: "기록된 의사결정",
    value: (decisionsDoc.match(/^### D-\d+ /gm) ?? []).length,
  },
  { label: "오픈을 막는 것", value: fixes.must },
  { label: "기록", value: fixes.noted },
  { label: "해소됨", value: fixes.done },
];

/** 돌려 봐야 아는 칸. 수는 못 세고 **측정 날짜**를 요구한다. */
const MEASURED = ["단위 테스트", "권한 격리 점검", "화면 실주행", "API 실주행", "AI 회귀 골든셋"];

// ── 대조 ───────────────────────────────────────────────────────────────────

/** `| 라벨 | **1,234** …` 에서 수를 읽는다. 천 단위 쉼표를 지운다. */
function cellValue(label) {
  const row = text
    .split(/\r?\n/)
    .find((l) => new RegExp(`^\\|\\s*${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\|`).test(l));
  if (row === undefined) return { row: null, value: null };

  const m = row.match(/\|\s*\*\*([0-9,]+)\*\*/);

  return { row, value: m === null ? null : Number(m[1].replace(/,/g, "")) };
}

let failed = false;

// **표를 실제로 읽었는지 먼저 본다** — 0 칸으로 통과하지 않는다(§7.0b).
const found = DERIVED.filter((d) => cellValue(d.label).row !== null).length;
if (found < DERIVED.length) {
  console.error(`FAIL  ${DOC} 에서 대조할 칸 ${DERIVED.length} 중 ${found} 개만 찾았다.`);
  failed = true;
}
if (tasks.size < 50 || fixes.done < 10) {
  console.error(`FAIL  세는 쪽이 망가졌다 (태스크 ${tasks.size} · 해소 ${fixes.done}).`);
  failed = true;
}

for (const { label, value } of DERIVED) {
  const { row, value: written } = cellValue(label);

  if (row === null) continue;

  if (written === null) {
    console.error(`FAIL  「${label}」 칸에서 수를 못 읽었다 — \`**숫자**\` 모양이어야 한다.`);
    failed = true;
  } else if (written !== value) {
    console.error(`FAIL  「${label}」 ${written} → 실제 ${value}`);
    failed = true;
  } else {
    console.log(`ok    「${label}」 ${value}`);
  }
}

for (const label of MEASURED) {
  const { row } = cellValue(label);

  if (row === null) {
    console.error(`FAIL  「${label}」 행이 없다.`);
    failed = true;
  } else if (!/측정 20\d\d-\d\d-\d\d/.test(row)) {
    console.error(
      `FAIL  「${label}」 은 돌려 봐야 아는 수다 — \`(측정 YYYY-MM-DD)\` 를 함께 적는다.`,
    );
    failed = true;
  } else {
    console.log(`ok    「${label}」 측정 표시 있음`);
  }
}

console.log(
  failed
    ? "\nPROJECT_STATUS 수치가 실제와 다르다. 표를 고친다 — 세는 쪽이 아니라."
    : `\nPROJECT_STATUS OK — 유도 ${DERIVED.length}칸 대조 · 측정 ${MEASURED.length}칸 날짜 확인`,
);

process.exit(failed ? 1 : 0);
