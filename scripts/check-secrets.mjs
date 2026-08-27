// 시크릿 스캔 + 클라이언트 번들 유입 검사 (S8-05 · 명세서 §7.2)
//
//   node scripts/check-secrets.mjs            소스만 검사한다 (.next 가 없어도 된다)
//   node scripts/check-secrets.mjs --bundle   빌드 산출물까지 검사한다 (npm run build 뒤)
//
// §7.2 는 두 가지를 요구한다.
//   1. **시크릿 스캔** — 키가 소스에 박혀 커밋되는 것을 막는다.
//   2. **서비스롤 키의 클라이언트 번들 유입 여부를 CI 에서 검사한다.**
//
// 둘은 다른 사고다. (1)은 리포에 키가 남는 것이고, (2)는 키가 **브라우저로 나가는** 것이다.
// (2)가 더 나쁘다 — 리포는 되돌릴 수 있지만 배포된 번들은 이미 읽힌 뒤다.
//
// **왜 grep 한 줄이 아닌가.** 서버 전용 키는 `process.env.SUPABASE_SERVICE_ROLE_KEY` 처럼
// **이름으로** 참조된다. 값이 소스에 없어도 `"use client"` 파일이 그 이름을 읽으면
// Next 가 번들에 인라인한다(`NEXT_PUBLIC_` 이 아니면 `undefined` 가 되지만, 그 코드는
// 서버에서 돌 것을 전제로 쓰였다는 뜻이라 그 자체가 결함이다). 그래서 **이름 참조**와
// **값 유출**을 따로 본다.
//
// 콘솔 출력은 ASCII 전용이다(docs/06 §3 — Windows CMD 인코딩).

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WITH_BUNDLE = process.argv.includes("--bundle");

/** 서버에서만 읽어야 하는 환경변수 (CLAUDE.md §5.4). */
const SERVER_ONLY_ENV = [
  "SUPABASE_SERVICE_ROLE_KEY",
  "ANTHROPIC_API_KEY",
  "TOSS_SECRET_KEY",
  "SUPABASE_DB_URL",
];

/**
 * 소스에 박힌 값을 찾는 패턴.
 *
 * **로컬 Supabase 의 데모 키는 제외한다** — `supabase status` 가 누구에게나 같은 값을
 * 출력하는 공개된 개발용 키라 비밀이 아니고, 문서·주석에 적혀 있어도 사고가 아니다.
 * 진짜 키만 남겨야 경보가 신뢰를 얻는다(늘 빨간 경보는 아무도 안 본다).
 */
const VALUE_PATTERNS = [
  {
    id: "SUPABASE_SECRET_KEY",
    // 새 형식 시크릿 키. publishable 은 공개용이라 제외한다.
    re: /\bsb_secret_[A-Za-z0-9_-]{16,}/g,
    note: "Supabase secret key",
  },
  {
    id: "ANTHROPIC_API_KEY",
    re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g,
    note: "Anthropic API key",
  },
  {
    id: "TOSS_SECRET_KEY",
    re: /\btest_sk_[A-Za-z0-9]{20,}|\blive_sk_[A-Za-z0-9]{20,}/g,
    note: "Toss secret key",
  },
  {
    id: "PRIVATE_KEY_BLOCK",
    re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
    note: "private key block",
  },
  {
    id: "SERVICE_ROLE_JWT",
    // role=service_role 이 든 JWT 페이로드. base64 이므로 원문으로는 안 잡힌다.
    re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g,
    note: "JWT",
    /** JWT 는 anon 키도 같은 모양이라 페이로드를 열어 service_role 만 잡는다. */
    confirm(match) {
      try {
        const payload = JSON.parse(
          Buffer.from(match.split(".")[1], "base64url").toString("utf8"),
        );

        return payload?.role === "service_role";
      } catch {
        return false;
      }
    },
  },
];

/** 검사에서 뺄 경로. 빌드 산출물·의존성·로컬 전용 자료. */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  "out",
  "coverage",
  "tmp",
  "_local_reports",
  "이미지캡춰",
]);

/** 검사할 확장자. 바이너리를 열지 않는다. */
const TEXT_EXT = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".json", ".sql", ".md", ".yml", ".yaml", ".css", ".bat", ".sh", ".example",
]);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;

    const full = path.join(dir, entry);
    const stat = statSync(full);

    if (stat.isDirectory()) walk(full, out);
    else if (TEXT_EXT.has(path.extname(entry))) out.push(full);
  }

  return out;
}

const problems = [];
const rel = (file) => path.relative(ROOT, file).replace(/\\/g, "/");

// ── 1) 추적되는 파일에 .env.local 이 섞이지 않았는가 ────────────────────────
// .gitignore 를 믿지 않고 git 에 직접 묻는다 — 한 번 추적되기 시작한 파일은
// .gitignore 를 고쳐도 계속 추적된다.
try {
  const tracked = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" })
    .split(/\r?\n/)
    .filter(Boolean);

  for (const file of tracked) {
    if (/(^|\/)\.env(\.|$)/.test(file) && !file.endsWith(".env.example")) {
      problems.push({ file, id: "ENV_TRACKED", detail: "env file is tracked by git" });
    }
  }
} catch {
  console.log("WARN  git ls-files failed - skipping tracked-env check");
}

// ── 2) 소스에 박힌 키 값 ────────────────────────────────────────────────────
const sourceFiles = walk(ROOT);

for (const file of sourceFiles) {
  const text = readFileSync(file, "utf8");

  for (const pattern of VALUE_PATTERNS) {
    pattern.re.lastIndex = 0;
    const matches = text.match(pattern.re) ?? [];

    for (const match of matches) {
      if (pattern.confirm && !pattern.confirm(match)) continue;

      problems.push({
        file: rel(file),
        id: pattern.id,
        // **값을 출력하지 않는다.** 로그에 실으면 스캐너가 유출 경로가 된다(§5.3).
        detail: `${pattern.note} literal in source`,
      });
    }
  }
}

// ── 3) 클라이언트 컴포넌트가 서버 전용 환경변수를 읽는가 ────────────────────
// `"use client"` 파일과 `lib/supabase/client.ts` 는 브라우저로 나간다.
const CLIENT_PATH_HINTS = [/^lib\/supabase\/client\.ts$/];

for (const file of sourceFiles) {
  const relative = rel(file);
  if (!/^(app|components|lib|hooks)\//.test(relative)) continue;
  if (!/\.(ts|tsx|js|jsx)$/.test(relative)) continue;
  if (/\.test\.(ts|tsx)$/.test(relative)) continue;

  const text = readFileSync(file, "utf8");
  const isClient =
    /^\s*["']use client["']/m.test(text.slice(0, 500)) ||
    CLIENT_PATH_HINTS.some((re) => re.test(relative));

  if (!isClient) continue;

  for (const name of SERVER_ONLY_ENV) {
    if (text.includes(name)) {
      problems.push({
        file: relative,
        id: "SERVER_ENV_IN_CLIENT",
        detail: `client file references ${name}`,
      });
    }
  }

  // 서비스롤 클라이언트를 클라이언트 파일에서 import 하면 키 없이도 사고다.
  if (/from\s+["']@\/lib\/supabase\/admin["']/.test(text)) {
    problems.push({
      file: relative,
      id: "ADMIN_CLIENT_IN_CLIENT",
      detail: "client file imports lib/supabase/admin (service role)",
    });
  }
}

// ── 4) 빌드 산출물에 값이 실렸는가 (--bundle) ───────────────────────────────
// **이것이 §7.2 가 말하는 검사다.** 위 3)은 소스 규칙이고, 여기는 실제로 나가는 파일이다.
let bundleFilesScanned = 0;

if (WITH_BUNDLE) {
  const staticDir = path.join(ROOT, ".next", "static");

  if (!existsSync(staticDir)) {
    console.error("FAIL  .next/static not found. Run `npm run build` first.");
    process.exit(1);
  }

  const bundleFiles = walk(staticDir).concat(
    // 서버 청크는 브라우저로 안 가지만, 프리렌더된 HTML 은 나간다.
    existsSync(path.join(ROOT, ".next", "server", "app"))
      ? walk(path.join(ROOT, ".next", "server", "app")).filter((f) => f.endsWith(".html"))
      : [],
  );

  // walk() 는 TEXT_EXT 만 모은다. .js 청크가 그 안에 있다.
  for (const file of bundleFiles) {
    bundleFilesScanned += 1;
    const text = readFileSync(file, "utf8");

    for (const pattern of VALUE_PATTERNS) {
      pattern.re.lastIndex = 0;
      for (const match of text.match(pattern.re) ?? []) {
        if (pattern.confirm && !pattern.confirm(match)) continue;

        problems.push({ file: rel(file), id: pattern.id, detail: `${pattern.note} in client bundle` });
      }
    }

    // 값이 실리지 않았더라도 **이름이 인라인됐으면** 그 코드는 브라우저에서 서버 코드를
    // 실행하려 한 것이다. Next 는 `NEXT_PUBLIC_` 이 아닌 변수를 `undefined` 로 바꾸므로
    // 보통은 이름조차 남지 않는다 — 남았다면 그 경로를 봐야 한다.
    for (const name of SERVER_ONLY_ENV) {
      if (text.includes(name)) {
        problems.push({
          file: rel(file),
          id: "SERVER_ENV_NAME_IN_BUNDLE",
          detail: `${name} appears in client bundle`,
        });
      }
    }
  }
}

// ── 결과 ────────────────────────────────────────────────────────────────────
console.log("");
console.log(`  scanned : ${sourceFiles.length} source files${WITH_BUNDLE ? ` + ${bundleFilesScanned} bundle files` : ""}`);
console.log(`  mode    : ${WITH_BUNDLE ? "source + bundle" : "source only"}`);
console.log("");

if (problems.length === 0) {
  console.log("PASS  no secrets in source" + (WITH_BUNDLE ? " or client bundle" : ""));
  console.log("");
  process.exit(0);
}

for (const problem of problems) {
  console.error(`FAIL  [${problem.id}] ${problem.file} :: ${problem.detail}`);
}

console.error("");
console.error(`  ${problems.length} problem(s).`);
console.error("  Secret values are never printed here - open the file to see it.");
console.error("");
process.exit(1);
