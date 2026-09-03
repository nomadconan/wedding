// =============================================================================
// 마크다운 표 칸 수 검사 (S0-04)
// -----------------------------------------------------------------------------
// **왜 필요한가.** `docs/TASKS.md` 의 FIX 원장에서 `FIX-38` 행이 **상태·발견 칸을
// 통째로 잃은 채** 여러 회차 동안 서 있었다. 원인은 내용 안의 파이프 하나다 —
// `` `started_at: string | null` `` 의 `|` 가 이스케이프되지 않아 마크다운이 그것을
// **칸 구분자로 읽었고**, 뒤의 칸들이 밀려 사라졌다. 코드 스팬 안이라고 안전하지 않다.
//
// 표는 사람이 읽는 원장이다. 칸이 밀리면 **상태가 없는 행**이 생기고, 그 행은
// "고쳤는지 아닌지 아무도 모르는 결함" 이 된다. 손으로 보면 다시 놓친다 — 그래서 센다.
//
// 실행:  npm run check:tables      (verify 에 포함)
// 종료 코드: 어긋난 행이 있으면 1.
//
// 콘솔 출력은 ASCII 전용이다(docs/06 §3).
// =============================================================================
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const TARGETS = [
  ...readdirSync(join(ROOT, "docs"))
    .filter((f) => f.endsWith(".md"))
    .map((f) => `docs/${f}`),
  "CLAUDE.md",
  "AGENTS.md",
  "README.md",
];

/**
 * 표 한 줄을 칸으로 자른다.
 *
 * **역슬래시로 이스케이프한 파이프(`\|`)는 구분자가 아니다.** 그것이 이 검사의
 * 요점이므로 정규식 split 을 쓰지 않고 한 글자씩 읽는다.
 */
function cells(line) {
  let s = line.trim();
  s = s.endsWith("|") ? s.slice(1, -1) : s.slice(1);
  const out = [];
  let cur = "";
  for (let i = 0; i < s.length; i += 1) {
    if (s[i] === "\\" && i + 1 < s.length) {
      cur += s.slice(i, i + 2);
      i += 1;
      continue;
    }
    if (s[i] === "|") {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += s[i];
  }
  out.push(cur);
  return out;
}

const isSeparator = (line) => /^\|[\s:|-]+\|?\s*$/.test(line.trim());

const problems = [];

for (const file of TARGETS) {
  let text;
  try {
    text = readFileSync(join(ROOT, file), "utf8");
  } catch {
    continue; // 없는 파일은 건너뛴다 (04 의사결정로그는 이 리포에 없다)
  }
  const lines = text.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const isRow = lines[i].trim().startsWith("|");
    if (isRow && i + 1 < lines.length && isSeparator(lines[i + 1])) {
      const header = cells(lines[i]).length;
      let j = i;
      while (j < lines.length && lines[j].trim().startsWith("|")) {
        const n = cells(lines[j]).length;
        if (n !== header) {
          problems.push({
            file,
            line: j + 1,
            got: n,
            want: header,
            text: lines[j].trim().slice(0, 60),
          });
        }
        j += 1;
      }
      i = j;
    } else {
      i += 1;
    }
  }
}

if (problems.length === 0) {
  console.log("doc tables OK - every row matches its header column count");
  process.exit(0);
}

console.error(`broken table rows: ${problems.length}`);
for (const p of problems) {
  console.error(`  ${p.file}:${p.line}  cells=${p.got} header=${p.want}`);
  console.error(`    ${p.text}`);
}
console.error("");
console.error("fix: escape pipes inside cells as \\| (code spans are NOT safe),");
console.error("     or add the missing cells so the row matches its header.");
process.exit(1);
