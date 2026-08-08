// Fills .env.local with the local Supabase values reported by `supabase status`.
//
//   node scripts/sync-env.mjs           sync  - create .env.local when missing, warn on drift
//   npm run env:check                   check - verify only, never write, exit 1 on drift
//
// Why this exists: the local keys used to be copied by hand and a single I/l or O/0
// mix-up leaves the whole app authenticating against nothing (S2-01 lost an hour to it).
// The values now come straight from the CLI output.
//
// Rules:
//   * An existing .env.local is NEVER overwritten. Hand-entered secrets
//     (ANTHROPIC_API_KEY, TOSS_*) must survive - we only report mismatches.
//   * When .env.local is missing we copy .env.example and fill the Supabase keys only.
//   * Console output is ASCII-only for Windows CMD (docs/06 section 3).
//   * Key values are printed masked. The full secret never reaches the console.

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV_LOCAL = path.join(ROOT, ".env.local");
const ENV_EXAMPLE = path.join(ROOT, ".env.example");

const MODE = process.argv.includes("--check") ? "check" : "sync";

/** Keys this script owns. Everything else in .env.local is left alone. */
const SUPABASE_KEYS = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
];

/**
 * CLI errors arrive with ANSI colour codes and follow-up hints. Both render as
 * garbage in a CP949 console, so keep the first line and drop the escapes.
 */
function firstCleanLine(text) {
  return String(text ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/\[[0-9;]*m/g, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)[0] ?? "";
}

function mask(value) {
  if (!value) return "(empty)";
  if (value.length <= 12) return `${value.slice(0, 3)}...`;

  return `${value.slice(0, 8)}...${value.slice(-4)} (len ${value.length})`;
}

/**
 * Runs `supabase status -o json`. The CLI may print extra lines before the JSON
 * (stopped services, upgrade notices), so we pull out the first {...} block.
 */
function readSupabaseStatus() {
  let raw;
  try {
    raw = execFileSync("npx", ["supabase", "status", "-o", "json"], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
    });
  } catch (error) {
    return {
      running: false,
      reason: firstCleanLine(error.stderr) || "supabase status failed",
    };
  }

  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1) {
    return { running: false, reason: "no JSON in supabase status output" };
  }

  let status;
  try {
    status = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return { running: false, reason: "could not parse supabase status output" };
  }

  const url = status.API_URL;
  // Newer CLIs report PUBLISHABLE_KEY/SECRET_KEY; older ones only the legacy JWTs.
  const anonKey = status.PUBLISHABLE_KEY || status.ANON_KEY;
  const serviceKey = status.SECRET_KEY || status.SERVICE_ROLE_KEY;

  if (!url || !anonKey || !serviceKey) {
    return { running: false, reason: "supabase status did not report API_URL and keys" };
  }

  return {
    running: true,
    values: {
      NEXT_PUBLIC_SUPABASE_URL: url,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: anonKey,
      SUPABASE_SERVICE_ROLE_KEY: serviceKey,
    },
  };
}

/** Parses KEY=VALUE lines. Trailing "# comment" is not part of the value. */
function parseEnv(text) {
  const values = {};

  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=(.*)$/.exec(line);
    if (!match) continue;

    values[match[1]] = match[2].split("#")[0].trim();
  }

  return values;
}

/** Rewrites one KEY= line, keeping any trailing comment that was already there. */
function setEnvLine(text, key, value) {
  const pattern = new RegExp(`^(\\s*${key}\\s*=)([^\\r\\n]*)$`, "m");

  if (!pattern.test(text)) {
    return `${text.replace(/\s*$/, "")}\n${key}=${value}\n`;
  }

  return text.replace(pattern, (_full, head, rest) => {
    const commentAt = rest.indexOf("#");
    const comment = commentAt === -1 ? "" : `        ${rest.slice(commentAt)}`;

    return `${head}${value}${comment}`;
  });
}

function notRunningNotice(reason) {
  console.log("");
  console.log("  Supabase is not running, so the local keys cannot be read.");
  console.log(`  reason: ${reason}`);
  console.log("");
  console.log("  Start it first:");
  console.log("    npm run db:start        (Docker Desktop must be running)");
  console.log("");
}

function main() {
  const status = readSupabaseStatus();

  if (!status.running) {
    notRunningNotice(status.reason);

    // sync mode is part of dev-setup: report and stop without failing the setup.
    // check mode must fail - a verification that cannot verify is not a pass.
    process.exit(MODE === "check" ? 1 : 0);
  }

  const wanted = status.values;

  if (!existsSync(ENV_LOCAL)) {
    if (MODE === "check") {
      console.error("FAIL  .env.local is missing. Run: node scripts/sync-env.mjs");
      process.exit(1);
    }

    if (!existsSync(ENV_EXAMPLE)) {
      console.error("FAIL  .env.example is missing - cannot create .env.local");
      process.exit(1);
    }

    copyFileSync(ENV_EXAMPLE, ENV_LOCAL);

    let text = readFileSync(ENV_LOCAL, "utf8");
    for (const key of SUPABASE_KEYS) text = setEnvLine(text, key, wanted[key]);
    writeFileSync(ENV_LOCAL, text, "utf8");

    console.log("  created .env.local from .env.example");
    for (const key of SUPABASE_KEYS) console.log(`    ${key} = ${mask(wanted[key])}`);
    console.log("  other keys are left empty on purpose:");
    console.log("    ANTHROPIC_API_KEY / AI_MODEL / TOSS_CLIENT_KEY / TOSS_SECRET_KEY");

    return;
  }

  // .env.local exists: compare only. Never touch a file that holds real secrets.
  const current = parseEnv(readFileSync(ENV_LOCAL, "utf8"));
  const drift = SUPABASE_KEYS.filter((key) => current[key] !== wanted[key]);

  if (drift.length === 0) {
    console.log("  .env.local matches the running Supabase instance");

    return;
  }

  const label = MODE === "check" ? "FAIL " : "WARN ";
  console.log("");
  console.log(`${label} .env.local does not match the running Supabase instance:`);
  for (const key of drift) {
    console.log(`    ${key}`);
    console.log(`      in file : ${mask(current[key])}`);
    console.log(`      expected: ${mask(wanted[key])}`);
  }
  console.log("");
  console.log("  .env.local was NOT modified - it may hold keys you entered by hand.");
  console.log("  Copy the expected values from: npx supabase status");
  console.log("");

  process.exit(MODE === "check" ? 1 : 0);
}

main();
