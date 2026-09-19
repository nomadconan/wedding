// 지금 도는 Node 가 `.nvmrc` 와 같은지 본다 (C-2a · T-00n 후속)
//
//   node scripts/check-node.mjs
//
// ── 왜 필요한가 ─────────────────────────────────────────────────────────────
// 리포는 Node 20 LTS 를 **세 곳에 못박아 두었는데**(`.nvmrc` · `package.json` 의
// `engines.node` · CI 의 `node-version-file`) **그 선언을 지키는 것이 없었다.**
// 개발 PC 가 Node 24 로 도는 동안 `npm ci` 도 `npm run verify` 도 전부 초록불이었고
// 아무도 몰랐다 — npm 은 `engines` 를 **경고도 없이 통과**시키기 때문이다.
//
// ── 왜 `.npmrc` 의 `engine-strict=true` 가 아닌가 (C-2a 가 실측으로 판단했다) ─
// 처음에는 그것을 넣었다. 그런데 **`engine-strict` 는 루트뿐 아니라 의존성 전부의
// `engines` 를 강제한다.** 이 리포에는 **`@supabase/auth-js@2.112.0` 이 `node >=22.0.0`
// 을 선언**하고 있어서, 켜는 순간 **Node 20 에서 `npm ci` 자체가 EBADENGINE 으로 죽는다** —
// 그리고 **CI 가 `.nvmrc`(20) 로 돌므로 CI 가 즉시 깨진다.** 실측으로 확인했다.
// 그래서 강제하는 자리를 **설치가 아니라 검증**으로 옮겼다. 이 검사는
// **우리가 정한 것(`.nvmrc`)과 지금 도는 것**만 비교하고 의존성 트리를 건드리지 않는다.
// (`@supabase/auth-js` 의 Node 22 요구는 **FIX-74** 로 따로 적었다 — 지금 Node 20 에서
//  돌고는 있으나 **선언되지 않은 위험**이다.)
//
// 콘솔 출력은 ASCII 전용이다(docs/06 §3).

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 줄바꿈을 먼저 정규화한다 — 이 리포의 작업트리는 CRLF 다(TASKS 운영 규칙 11). */
function readText(file) {
  return readFileSync(path.join(ROOT, file), "utf8").split(/\r?\n/);
}

const problems = [];

// ── 1. `.nvmrc` 를 실제로 읽었는지 먼저 본다 ────────────────────────────────
// 빈 값으로 통과하면 이 검사는 아무것도 지키지 않는다(TASKS 운영 규칙 7·8).
let pinned = "";
try {
  pinned = (readText(".nvmrc")[0] ?? "").trim();
} catch {
  problems.push("`.nvmrc` 를 읽지 못했다. 버전 선언의 단일 진실이 없으면 이 검사는 무의미하다.");
}
if (!problems.length && !/^\d+\.\d+\.\d+$/.test(pinned)) {
  problems.push(`.nvmrc 값이 'x.y.z' 형식이 아니다: ${JSON.stringify(pinned)}`);
}

// ── 2. `engines.node` 도 실제로 읽는다 ──────────────────────────────────────
let engines = "";
try {
  engines = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).engines?.node ?? "";
} catch {
  problems.push("`package.json` 을 읽지 못했다.");
}
if (!problems.length && !engines) {
  problems.push("`package.json` 에 `engines.node` 가 없다. 세 자리 중 하나가 비었다.");
}

const running = process.versions.node;

// ── 3. 실행 중인 Node 가 `.nvmrc` 와 같은가 ────────────────────────────────
if (!problems.length && running !== pinned) {
  problems.push(
    `Node 가 .nvmrc 와 다르다 — pinned ${pinned} / running ${running}\n` +
      "         nvm use " + pinned + "   (없으면 먼저: nvm install " + pinned + ")",
  );
}

// ── 4. `.nvmrc` 가 `engines.node` 범위 안에 있는가 ─────────────────────────
// 선언 셋이 서로 어긋나면 어느 것이 진실인지 답할 수 없다.
if (!problems.length) {
  const major = Number(pinned.split(".")[0]);
  const bounds = [...engines.matchAll(/(>=|<=|<|>|\^|~)?\s*(\d+)/g)].map((m) => ({
    op: m[1] ?? "=",
    major: Number(m[2]),
  }));
  if (bounds.length === 0) {
    problems.push(`engines.node 를 해석하지 못했다: ${JSON.stringify(engines)}`);
  } else {
    const okRange = bounds.every((b) => {
      if (b.op === ">=") return major >= b.major;
      if (b.op === ">") return major > b.major;
      if (b.op === "<=") return major <= b.major;
      if (b.op === "<") return major < b.major;
      return major === b.major;
    });
    if (!okRange) {
      problems.push(`.nvmrc(${pinned}) 가 engines.node(${engines}) 범위 밖이다.`);
    }
  }
}

console.log("");
console.log("  node version gate");
console.log(`    .nvmrc         : ${pinned || "(read failed)"}`);
console.log(`    engines.node   : ${engines || "(read failed)"}`);
console.log(`    running node   : ${running}`);
console.log("");

if (problems.length === 0) {
  console.log("PASS  running node matches .nvmrc and satisfies engines.node");
  console.log("");
  process.exit(0);
}

for (const p of problems) console.error(`FAIL  ${p}`);
console.error("");
console.error("  npm does NOT enforce `engines` on its own - that is why this check exists.");
console.error("  See docs/06 section 2 for how this repo pins Node.");
console.error("");
process.exit(1);
