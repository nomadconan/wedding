// 커버리지 검증표 자동 집계 (S8-05 · T-00k 가 tmp/ 에 두고 커밋하지 않은 스크립트를 옮겼다)
//
//   node scripts/check-coverage-table.mjs           요약과 본문 행이 맞는지 검사한다 (CI)
//   node scripts/check-coverage-table.mjs --print   센 값만 출력한다 (표를 고칠 때)
//
// ── 왜 필요한가 ─────────────────────────────────────────────────────────────
// `docs/TASKS.md` 의 커버리지 요약표가 **네 번 연속 같은 이유로 낡았다**(T-00f · T-00g ·
// T-00h · T-00k). 태스크가 끝나면 자기 행은 고치지만 **요약은 사람 기억에 맡겨져 있었고**,
// 다른 태스크가 대신 만들어 준 행은 아무도 안 고쳤다. T-00h 는 열세 행이 **실제보다 나쁘게**
// 적혀 있는 것을 찾아냈고, T-00k 는 그것을 **손으로 다시 세어** 둘을 더 찾았다.
//
// 손으로 세는 한 다섯 번째가 온다. 그래서 센다.
//
// ── 세는 규칙 (T-00f 가 정하고 T-00h·T-00k 가 따랐다) ───────────────────────
// **상태 칸이 `완료` 로 시작하는 행만** 센다. `부분`·`화면·API 완료`·`로직·엔드포인트 완료`
// 는 세지 않는다. 굵게(`**완료**`)와 맨 `완료` 는 같게 본다 — 표기는 강조일 뿐 상태가 아니다.
// 취소선(`~~...~~`)으로 시작하는 행은 **폐기된 항목**이라 총계에서도 뺀다.
//
// 콘솔 출력은 ASCII 전용이다(docs/06 §3).

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TASKS = path.join(ROOT, "docs", "TASKS.md");
const PRINT_ONLY = process.argv.includes("--print");

/**
 * 네 축. `heading` 은 본문 표를 여는 제목이고 `summaryLabel` 은 요약표의 행 이름이다.
 * `statusColumn` 은 상태 칸의 위치(0-based, 파이프로 자른 뒤).
 */
const AXES = [
  { key: "features", heading: /^### A\. §2 기능/, summaryLabel: "§2 기능", statusColumn: 4 },
  { key: "tables", heading: /^### B\. §3 테이블/, summaryLabel: "§3 테이블", statusColumn: 3 },
  { key: "apis", heading: /^### C\. §4 API · 배치/, summaryLabel: "§4 API·배치", statusColumn: 3 },
  { key: "screens", heading: /^### D\. §6 화면/, summaryLabel: "§6 화면", statusColumn: 3 },
];

const lines = readFileSync(TASKS, "utf8").split(/\r?\n/);

/** 마크다운 강조·취소선·공백을 걷어낸 상태 문자열. */
function normalizeStatus(cell) {
  return cell
    .replace(/\*\*/g, "")
    .replace(/`/g, "")
    .trim();
}

/** 표 행을 칸 배열로 자른다. 바깥쪽 파이프를 버린다. */
function cells(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) return null;

  return trimmed.slice(1, trimmed.endsWith("|") ? -1 : undefined).split("|");
}

function countAxis(axis) {
  const start = lines.findIndex((line) => axis.heading.test(line));
  if (start === -1) throw new Error(`본문 표를 찾지 못했다: ${axis.summaryLabel}`);

  let total = 0;
  let done = 0;
  let unassigned = 0;
  let retired = 0;
  let seenHeader = false;

  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];

    // 다음 `###` 제목을 만나면 이 표는 끝났다.
    if (/^###\s/.test(line)) break;

    const parts = cells(line);
    if (!parts) continue;

    // 구분선(`|---|---|`)과 헤더 행을 건너뛴다. 헤더는 표마다 한 번뿐이다.
    if (parts.every((cell) => /^[\s:-]+$/.test(cell))) continue;
    if (!seenHeader) {
      seenHeader = true;
      continue;
    }

    const first = parts[0].trim();
    // 폐기된 항목. 총계에서 뺀다.
    if (first.startsWith("~~")) {
      retired += 1;
      continue;
    }

    total += 1;

    const status = normalizeStatus(parts[axis.statusColumn] ?? "");
    if (status.startsWith("완료")) done += 1;

    const owner = normalizeStatus(parts[axis.statusColumn - 1] ?? "");
    if (owner === "" || owner === "-" || /미배정/.test(owner)) unassigned += 1;
  }

  return { total, done, unassigned, retired };
}

/** 요약표에서 한 축의 숫자를 읽는다. 요약표는 문서에 두 벌 있어 **둘 다** 본다. */
function readSummaries(label) {
  const found = [];

  for (let i = 0; i < lines.length; i += 1) {
    const parts = cells(lines[i]);
    if (!parts) continue;
    if (normalizeStatus(parts[0]) !== label) continue;
    // 요약표는 6칸이다: 축 | 총계 | 배정 | 미배정 | 완료 | 실동작
    if (parts.length < 5) continue;

    const numeric = parts.slice(1, 5).map((cell) => Number(normalizeStatus(cell)));
    if (numeric.slice(0, 2).some((value) => !Number.isFinite(value))) continue;

    found.push({ line: i + 1, total: numeric[0], assigned: numeric[1], unassigned: numeric[2], done: numeric[3] });
  }

  return found;
}

// ── 실행 ────────────────────────────────────────────────────────────────────
const counted = {};
for (const axis of AXES) counted[axis.key] = countAxis(axis);

console.log("");
console.log("  counted from the body tables of docs/TASKS.md");
console.log("  rule: a row counts as done only when its status cell STARTS WITH `완료`");
console.log("");
console.log("  axis          total   done   unassigned   retired");
for (const axis of AXES) {
  const c = counted[axis.key];
  console.log(
    `  ${axis.summaryLabel.padEnd(12)}  ${String(c.total).padStart(5)}  ${String(c.done).padStart(5)}  ` +
      `${String(c.unassigned).padStart(10)}  ${String(c.retired).padStart(8)}`,
  );
}
console.log("");

if (PRINT_ONLY) process.exit(0);

// ── 요약과 대조 ─────────────────────────────────────────────────────────────
const problems = [];

for (const axis of AXES) {
  const c = counted[axis.key];
  const summaries = readSummaries(axis.summaryLabel);

  if (summaries.length === 0) {
    problems.push(`${axis.summaryLabel}: 요약표 행을 찾지 못했다`);
    continue;
  }

  for (const summary of summaries) {
    if (summary.total !== c.total) {
      problems.push(
        `${axis.summaryLabel} (TASKS.md:${summary.line}): 총계 ${summary.total} vs 본문 ${c.total}`,
      );
    }
    if (summary.done !== c.done) {
      problems.push(
        `${axis.summaryLabel} (TASKS.md:${summary.line}): 완료 ${summary.done} vs 본문 ${c.done}`,
      );
    }
    if (summary.unassigned !== c.unassigned) {
      problems.push(
        `${axis.summaryLabel} (TASKS.md:${summary.line}): 미배정 ${summary.unassigned} vs 본문 ${c.unassigned}`,
      );
    }
  }

  // 본문 표의 제목에 박힌 수(`### A. §2 기능 (75)`)도 같은 값이어야 한다.
  const headingLine = lines.findIndex((line) => axis.heading.test(line));
  const headingCount = Number(lines[headingLine].match(/\((\d+)\)/)?.[1]);
  if (Number.isFinite(headingCount) && headingCount !== c.total) {
    problems.push(
      `${axis.summaryLabel} (TASKS.md:${headingLine + 1}): 표 제목의 수 ${headingCount} vs 본문 ${c.total}`,
    );
  }
}

if (problems.length === 0) {
  console.log("PASS  summary rows and body tables agree");
  console.log("");
  process.exit(0);
}

for (const problem of problems) console.error(`FAIL  ${problem}`);
console.error("");
console.error(`  ${problems.length} mismatch(es).`);
console.error("  Fix the summary table (and the heading counts) to match the body rows,");
console.error("  or fix the body row that is wrong. Run with --print to see the counts.");
console.error("");
process.exit(1);
