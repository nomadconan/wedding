// =============================================================================
// db:reseed — 로컬 DB 를 되돌린다 (FIX-69 해소)
// -----------------------------------------------------------------------------
// **`db:reset` 바로 뒤의 `seed:accounts` 가 502 로 죽는다.**
//
// `supabase db reset` 은 컨테이너 몇을 재시작하는데 **`supabase_kong_*` 은 그대로
// 남아** 예전 주소를 물고 있다. `supabase_auth_*` 는 healthy 인데 게이트웨이를 지나는
// `GET /auth/v1/health` 는 **502** 이고, 그 상태가 한동안 간다.
//
// CLAUDE.md §4.4 가 정한 절차가 `db:reset` → `db:types` → `seed:accounts` → `db:rls`
// 인데 **그 순서를 그대로 따르면 두 번째 칸에서 멈춘다.** C-1b 가 세 번, C-3 가 여러 번
// 같은 자리에서 멈췄고 그때마다 "시드가 깨졌나" 를 먼저 의심했다 — 앱 결함이 아니다.
//
// 그래서 **되돌리는 일을 한 명령으로 묶는다**: reset → kong 재시작 → 시드가 설 때까지
// 다시 시도. 사람이 순서를 기억할 필요가 없어야 절차가 지켜진다.
//
// ── 왜 전부 동기인가 ────────────────────────────────────────────────────────
// 처음에는 `fetch` 로 auth 가 살아났는지 물어보며 기다렸는데, **`npx supabase db reset`
// 뒤에는 그 `await` 가 영영 안 풀렸다** — 노드가 이벤트 루프를 비우며 아무 말 없이
// 끝났다(처음엔 종료 코드 13, `main()` 으로 감싼 뒤에는 0). 원인을 더 파는 대신
// **비동기를 아예 쓰지 않는다**.
//
// ── 왜 종료 코드를 안 믿는가 ────────────────────────────────────────────────
// `spawnSync("npm", …, { shell: true })` 가 **0 을 돌려주고도 시드가 안 선** 적이 있다
// (윈도우에서 `cmd /c npm.cmd` 를 거치며 안쪽 종료 코드가 묻혔다). 그때 이 스크립트는
// "1회째에 섰다" 고 적고 끝났고, **다음 주행이 "업체가 없다" 로 죽어서야** 알았다.
// 우리가 알고 싶은 것은 "명령이 0 을 냈는가" 가 아니라 **"시드가 섰는가"** 이므로
// 표를 직접 센다(운영 규칙 7.0b — 빈 결과로 통과하는 검사를 만들지 않는다).
//
// 실행:  npm run db:reseed
// `audit:*` · `check:escrow` · `check:settlement` · `chain:walk` · `vendor:walk`
// 뒤에 쓴다(그것들은 DB 를 더럽힌다).
// =============================================================================
import { execFileSync, spawnSync } from "node:child_process";

const ATTEMPTS = 12;
const WAIT_MS = 3000;
const NL = /\r?\n/;

/** 동기 대기. 비동기를 안 쓰기로 했으므로 타이머 대신 이것을 쓴다. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function run(command, args, label) {
  process.stdout.write(`\n[${label}] ${command} ${args.join(" ")}\n`);
  const result = spawnSync(command, args, { stdio: "inherit", shell: process.platform === "win32" });

  if (result.status !== 0) {
    console.error(`[${label}] 실패 (exit ${result.status})`);
    process.exit(result.status ?? 1);
  }
}

function dbContainer() {
  try {
    return execFileSync("docker", [
      "ps", "--filter", "name=supabase_db_", "--format", "{{.Names}}",
    ]).toString().trim().split(NL).filter(Boolean)[0] ?? "";
  } catch {
    return "";
  }
}

/** **시드가 섰는가.** 못 세면 -1 — 0 과 구분한다(재 보지 못한 것을 0 으로 적지 않는다). */
function seededUserCount() {
  const container = dbContainer();
  if (!container) return -1;

  try {
    const out = execFileSync(
      "docker",
      ["exec", "-i", container, "psql", "-U", "postgres", "-d", "postgres",
        "-X", "-q", "-A", "-t", "-c", "select count(*) from auth.users;"],
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
    ).trim().split(NL).pop().trim();

    const value = Number(out);

    return Number.isFinite(value) ? value : -1;
  } catch {
    return -1;
  }
}

run("npx", ["supabase", "db", "reset"], "reset");

/**
 * **kong 을 재시작한다.** 이름은 프로젝트마다 다르므로 `docker ps` 로 찾는다.
 * 컨테이너가 없으면 조용히 넘어간다 — 그럴 때는 재시작할 것도 없다.
 */
let kong = "";
try {
  kong = execFileSync("docker", [
    "ps", "--filter", "name=supabase_kong_", "--format", "{{.Names}}",
  ]).toString().trim().split(NL).filter(Boolean)[0] ?? "";
} catch {
  kong = "";
}

if (kong) {
  run("docker", ["restart", kong], "kong");
} else {
  console.log("\n[kong] supabase_kong_* 컨테이너가 없다 — 재시작할 것이 없다.");
}

console.log(`\n[seed] npm run seed:accounts (최대 ${ATTEMPTS}회 · 결과로 판정한다)`);

let seeded = false;
for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
  const last = attempt === ATTEMPTS;
  const result = spawnSync("npm", ["run", "seed:accounts"], {
    // 마지막 시도는 그대로 보여준다 — 끝내 안 서면 **왜** 안 섰는지가 남아야 한다.
    stdio: last ? "inherit" : ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });

  const users = seededUserCount();
  if (users > 0) {
    console.log(`[seed] ${attempt}회째에 섰다 — 계정 ${users}개.`);
    seeded = true;
    break;
  }

  if (!last) {
    const why = result.status === 0 ? `종료 코드는 0 인데 계정 ${users}개` : `exit ${result.status}`;
    process.stdout.write(`[seed] ${attempt}회째 실패(${why}) — ${WAIT_MS / 1000}초 뒤 다시 시도한다\n`);

    // 원인을 아예 감추지 않는다 — 첫 줄만 보여준다.
    const err = String(result.stderr ?? "").split(NL).find((line) => line.trim() !== "");
    if (err) process.stdout.write(`        ${err.slice(0, 120)}\n`);

    sleepSync(WAIT_MS);
  }
}

if (!seeded) {
  console.error("\n[seed] 끝내 서지 않았다. `npx supabase status` 로 스택을 확인한다.");
  process.exit(1);
}

console.log("\n되돌렸다 — db:reset + kong 재시작 + seed:accounts");
