// 의존성 취약점 게이트 (S8-05 · 명세서 §7.2 · §7.5 "PR 파이프라인 차단 조건")
//
//   node scripts/check-audit.mjs          알려진 것 외에 새 취약점이 있으면 실패한다
//   node scripts/check-audit.mjs --list   지금 보이는 권고를 그대로 출력한다
//
// ── 왜 `npm audit --audit-level=high` 한 줄이 아닌가 ────────────────────────
// 지금 리포에는 **고칠 수 없는 high 3건**이 있다. 전부 `postcss` 이고 `next` 가 끌고 오며,
// `npm audit fix --force` 는 **next@16 으로 올린다**(메이저 업그레이드 = 파괴적 변경).
// 그 상태에서 `--audit-level=high` 를 게이트로 걸면 **CI 가 첫날부터 영구히 빨간불**이 된다.
//
// 늘 빨간 게이트는 게이트가 아니다. 사람은 그것을 읽지 않게 되고, 그러면 **정말 새로운
// 취약점이 왔을 때도 안 읽는다.** 그것이 이 게이트가 막으려던 바로 그 사고다.
//
// 그래서 **알려진 것을 목록으로 못 박고, 목록에 없는 것이 나오면 막는다.** 목록은 파일에
// 있고 커밋되므로 `왜 이것을 감수했는가` 가 리뷰를 거친다 — `--audit-level` 을 낮추는 것과
// 다른 점이 여기다(그쪽은 등급 전체를 조용히 끈다).
//
// 콘솔 출력은 ASCII 전용이다(docs/06 §3).

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ALLOWLIST = path.join(ROOT, "security", "audit-allowlist.json");
const LIST_ONLY = process.argv.includes("--list");

/** 이 등급부터 막는다. moderate 이하는 보고만 한다. */
const BLOCKING_SEVERITIES = new Set(["high", "critical"]);

function runAudit() {
  let raw;
  try {
    raw = execFileSync("npm", ["audit", "--json"], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      shell: process.platform === "win32",
    });
  } catch (error) {
    // **`npm audit` 은 취약점이 있으면 종료 코드가 0이 아니다.** 그래도 stdout 에 JSON 은
    // 그대로 실려 온다 — 여기서 던지면 취약점이 있을 때마다 스크립트가 죽는다.
    raw = error.stdout;
  }

  if (!raw) {
    console.error("FAIL  npm audit produced no output.");
    process.exit(1);
  }

  try {
    return JSON.parse(raw);
  } catch {
    console.error("FAIL  npm audit output was not JSON.");
    process.exit(1);
  }
}

const report = runAudit();
const vulnerabilities = report.vulnerabilities ?? {};

/**
 * 권고 하나를 안정된 키로 만든다.
 *
 * **패키지 이름만으로는 부족하다** — 같은 패키지에 새 CVE 가 붙으면 조용히 통과한다.
 * GHSA id 까지 넣어야 "이미 아는 그 취약점" 과 "새로 온 것" 이 갈린다.
 */
function advisoriesOf(node) {
  const out = [];

  for (const via of node.via ?? []) {
    if (typeof via === "string") continue; // 다른 패키지를 통해 전이된 경우
    out.push({
      key: `${via.name ?? node.name}:${via.url?.split("/").pop() ?? via.source ?? "unknown"}`,
      name: via.name ?? node.name,
      severity: via.severity ?? node.severity,
      title: via.title ?? "(no title)",
      url: via.url ?? "",
    });
  }

  return out;
}

const found = new Map();
for (const node of Object.values(vulnerabilities)) {
  for (const advisory of advisoriesOf(node)) {
    if (!found.has(advisory.key)) found.set(advisory.key, advisory);
  }
}

if (LIST_ONLY) {
  console.log("");
  console.log(JSON.stringify([...found.values()], null, 2));
  console.log("");
  process.exit(0);
}

let allow = { accepted: [] };
try {
  allow = JSON.parse(readFileSync(ALLOWLIST, "utf8"));
} catch {
  console.log("WARN  no security/audit-allowlist.json - every advisory is treated as new");
}

const acceptedKeys = new Set((allow.accepted ?? []).map((entry) => entry.key));

const blocking = [...found.values()].filter(
  (advisory) => BLOCKING_SEVERITIES.has(advisory.severity) && !acceptedKeys.has(advisory.key),
);
const acceptedSeen = [...found.values()].filter((advisory) => acceptedKeys.has(advisory.key));
const lowerSeverity = [...found.values()].filter(
  (advisory) => !BLOCKING_SEVERITIES.has(advisory.severity),
);

// 목록에 적혀 있는데 더는 보이지 않는 항목 — 고쳐졌다는 뜻이다. 목록을 청소해야 한다.
const stale = [...acceptedKeys].filter((key) => !found.has(key));

console.log("");
console.log(`  advisories found : ${found.size}`);
console.log(`  accepted (known) : ${acceptedSeen.length}`);
console.log(`  below threshold  : ${lowerSeverity.length} (moderate/low - reported, not blocking)`);
console.log(`  NEW and blocking : ${blocking.length}`);
console.log("");

for (const advisory of acceptedSeen) {
  const entry = (allow.accepted ?? []).find((row) => row.key === advisory.key);
  console.log(`  KNOWN  [${advisory.severity}] ${advisory.key}`);
  console.log(`         ${entry?.reason ?? "(no reason recorded)"}`);
}

if (stale.length > 0) {
  console.log("");
  for (const key of stale) {
    console.log(`  STALE  ${key} is in the allowlist but no longer reported - remove it`);
  }
}

if (blocking.length === 0) {
  console.log("");
  console.log("PASS  no new high/critical advisories");
  console.log("");
  process.exit(0);
}

console.error("");
for (const advisory of blocking) {
  console.error(`FAIL  [${advisory.severity}] ${advisory.key}`);
  console.error(`      ${advisory.title}`);
  if (advisory.url) console.error(`      ${advisory.url}`);
}

console.error("");
console.error("  A new high/critical advisory appeared.");
console.error("  Fix it, or - if it genuinely cannot be fixed - add it to");
console.error("  security/audit-allowlist.json WITH A REASON so the choice is reviewed.");
console.error("");
process.exit(1);
