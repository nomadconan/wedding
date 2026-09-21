import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * 쓰기 결과를 **안 보는 자리**를 센다 (FIX-73 · D-237)
 *
 * ── 왜 검사인가 ─────────────────────────────────────────────────────────────
 * FIX-72 가 증적에서 배운 것이 D-204 에 적혀 있다 — **한 자리씩 고치면 다음 자리가
 * 생기는 날 같은 일이 반복된다.** 자리를 `lib/db/write.ts` 하나로 모았고, 새 자리를
 * 막는 것은 이 검사다.
 *
 * ── 두 가지를 본다 ──────────────────────────────────────────────────────────
 *  1. **이미 닫은 도메인은 0 이어야 한다**(`CLOSED`). 되돌아가면 떨어진다.
 *  2. **아직 안 닫은 곳은 늘면 안 된다**(`BUDGET`). FIX-73 은 표 단위로 나눠 여러
 *     회차에 걸쳐 닫는데, 그 사이에 새 자리가 생기면 끝이 나지 않는다.
 *
 * **예산을 줄이는 것은 자유이고 늘리는 것은 실패다.** 도메인을 닫을 때마다 그 줄을
 * `CLOSED` 로 옮기고 예산을 그만큼 내린다.
 *
 * ── 무엇을 "본다" 로 치는가 ─────────────────────────────────────────────────
 *  · `const { error } = await …` 처럼 **결과를 담았다**
 *  · `return await …` 로 **올려보냈다**
 *  · `mustWrite(…)` 로 **감쌌다**(실패하면 던진다)
 *  · `.then(…)` 을 붙였다
 * `tryWrite(…)` 는 **boolean 을 돌려주므로 담아야** 본 것이다 — 담지 않으면
 * 여기서 잡힌다. 그것이 "삼키는 것이 아니다" 를 코드로 지키는 방법이다.
 */

const ROOT = process.cwd();
const SKIP = new Set([
  "node_modules", ".next", ".git", "tmp", "_local_reports", "supabase", "types", "public",
]);

/** 닫은 도메인 — **0 이어야 한다.** */
const CLOSED = ["lib/payments", "lib/cancellation", "lib/settlements", "lib/escrow"];

/**
 * 아직 안 닫은 곳의 상한. **늘면 실패한다.**
 *
 * 기준값은 `fix/FIX-73a` 회차에 실측한 수다(그때 전체 93 자리 중 `lib/payments`
 * 열아홉을 닫아 일흔넷이 남았다).
 */
const BUDGET = 59;

const WRITE = /\.(insert|update|upsert|delete)\s*\(/;

function sourceFiles() {
  const out = [];
  (function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue;
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(p);
    }
  })(ROOT);
  return out;
}

export function scanUncheckedWrites() {
  const hits = [];

  for (const file of sourceFiles()) {
    const rel = path.relative(ROOT, file).split(path.sep).join("/");
    const lines = readFileSync(file, "utf8").split(/\r?\n/);

    for (let i = 0; i < lines.length; i += 1) {
      const table = lines[i].match(/\bfrom\s*\(\s*["'`]([a-z_]+)["'`]/);
      if (!table) continue;

      // ── 구문 시작을 뒤로 거슬러 찾는다 ────────────────────────────────
      //
      // `.from(` 은 대개 **이어지는 줄**이다. 그 줄만 보면 앞줄의
      // `const { error } = await …` 를 놓치고 전부 미확인으로 센다 — 처음에
      // 그렇게 짜서 270 이 나왔고, 원장이 적은 83 의 세 배였다.
      // **"이어지는 줄의 모양" 을 열거하지 않는다.** 처음엔 `.` 로 시작하는 줄만
      // 이어짐으로 쳤는데, 삼항(`? await admin`)·인자 줄(`admin`)·감싼 호출
      // (`await mustWrite(`)이 전부 빠져나가 **이미 고친 자리까지 미확인으로** 셌다.
      // 대신 **앞줄이 구문을 끝냈는지**를 본다 — 끝내는 모양은 셋뿐이다.
      let start = i;
      while (start > 0) {
        const prev = lines[start - 1].trim();
        // 주석 줄도 경계다 — 안 그러면 `const { data } = await …` 앞에 붙은 설명
        // 줄까지 거슬러 올라가 **이미 결과를 받는 자리를 미확인으로** 센다.
        if (prev === "" || /[;{}]$/.test(prev) || /^(\/\/|\/\*|\*)/.test(prev)) break;
        start -= 1;
      }

      let stmt = "";
      let end = start;
      while (end < lines.length && end - start < 30) {
        stmt += (end === start ? "" : "\n") + lines[end];
        if (/;\s*(\/\/.*)?$/.test(lines[end]) && end >= i) break;
        end += 1;
      }

      if (WRITE.test(stmt)) {
        const head = lines[start];
        const checked =
          /\bmustWrite\s*\(/.test(stmt) ||
          /\b(const|let|var)\b.*=/.test(head) ||
          /^\s*return\b/.test(head) ||
          /=>\s*$/.test(head) ||
          /\.then\s*\(/.test(stmt) ||
          /^\s*\w[\w.]*\s*=\s/.test(head);

        if (!checked) hits.push({ file: rel, line: start + 1, table: table[1] });
      }

      i = Math.max(i, end);
    }
  }

  return hits;
}

const hits = scanUncheckedWrites();

// **목록을 실제로 읽었는지 먼저 본다.** 0 자리로 통과하는 검사를 만들지 않는다
// (§7.0b) — 스캐너가 망가져 아무것도 못 찾아도 "깨끗하다" 로 보이면 안 된다.
const files = sourceFiles();
if (files.length < 200) {
  console.error(`소스 파일을 ${files.length}개밖에 못 찾았다 — 스캐너가 망가졌다.`);
  process.exit(1);
}

const byDir = new Map();
for (const h of hits) {
  const key = h.file.split("/").slice(0, 2).join("/");
  byDir.set(key, (byDir.get(key) ?? 0) + 1);
}

let failed = false;

for (const domain of CLOSED) {
  const inside = hits.filter((h) => h.file.startsWith(`${domain}/`));

  if (inside.length > 0) {
    failed = true;
    console.error(`FAIL  ${domain} 은 닫힌 도메인인데 결과를 안 보는 쓰기가 ${inside.length}자리 있다:`);
    for (const h of inside) console.error(`        ${h.file}:${h.line} [${h.table}]`);
  } else {
    console.log(`ok    ${domain} — 0자리`);
  }
}

const rest = hits.filter((h) => !CLOSED.some((d) => h.file.startsWith(`${d}/`)));

if (rest.length > BUDGET) {
  failed = true;
  console.error(`FAIL  아직 안 닫은 자리가 ${rest.length}개로 상한 ${BUDGET}을 넘었다.`);
  console.error("      FIX-73 은 표 단위로 닫는 중이다. 새 쓰기는 mustWrite/tryWrite 를 쓴다.");
} else {
  console.log(`ok    남은 자리 ${rest.length} / 상한 ${BUDGET}`);
}

if (process.argv.includes("--list")) {
  console.log("\n── 도메인별 ──");
  for (const [d, n] of [...byDir].sort((a, b) => b[1] - a[1])) console.log(String(n).padStart(3), d);
  console.log("\n── 남은 자리 ──");
  for (const h of rest) console.log(`  ${h.file}:${h.line} [${h.table}]`);
}

console.log(`\n파일 ${files.length}개 · 결과를 안 보는 쓰기 ${hits.length}자리`);
process.exit(failed ? 1 : 0);
