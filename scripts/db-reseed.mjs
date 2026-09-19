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
// 그래서 **되돌리는 일을 한 명령으로 묶는다**: reset → storage·kong 재시작(healthy 대기)
// → 시드가 설 때까지 다시 시도. 사람이 순서를 기억할 필요가 없어야 절차가 지켜진다.
//
// ── storage 도 같은 병을 앓는다 (FIX-76 해소 · 2026-09-19) ──────────────────
// `supabase db reset` 은 마이그레이션·`seed.sql` 을 **다 적용한 뒤** 컨테이너를
// 재시작하는데, 거기서 **`supabase_storage_*` 가 DB 보다 먼저 일어나** DB 에
// `ECONNREFUSED` 로 붙지 못하고 `unhealthy` 로 남는다. CLI 는 그것을
// `failed to bootstrap the local database` 로 **exit 1** 이라 적는다 —
// **스키마와 시드는 이미 들어간 상태로.**
//
// 예전에는 그 자리에서 죽었다. 그래서 **DB 가 비워져 스키마만 있고 계정은 없는 상태**로
// 남았고, 그걸 모르고 손으로 `seed:accounts` 를 돌리면 픽스처가 어긋나 **실주행이
// 엉뚱한 이유로 실패**했다 — C-2a 가 그렇게 두 번 잃었고 **제품 결함(FIX-77)을
// 의심하게 만든 원인 중 하나**다. 지금은 **결과로 판정한다.**
//
// ── 왜 전부 동기인가 ────────────────────────────────────────────────────────
// 처음에는 `fetch` 로 auth 가 살아났는지 물어보며 기다렸는데, **`npx supabase db reset`
// 뒤에는 그 `await` 가 영영 안 풀렸다** — 노드가 이벤트 루프를 비우며 아무 말 없이
// 끝났다(처음엔 종료 코드 13, `main()` 으로 감싼 뒤에는 0). 원인을 더 파는 대신
// **비동기를 아예 쓰지 않는다**.
//
// ── 왜 종료 코드를 안 믿는가 ────────────────────────────────────────────────
// `seed:accounts` 가 **0 을 돌려주고도 시드가 안 선** 적이 있다. 그때 이 스크립트는
// "1회째에 섰다" 고 적고 끝났고, **다음 주행이 "업체가 없다" 로 죽어서야** 알았다.
//
// **원인은 시드 쪽이었다**(FIX-70): 게이트웨이가 안 선 상태에서 첫 `fetch` 가 영영 안
// 풀려 노드가 이벤트 루프를 비우며 0 으로 끝났다 — 배너만 찍고. 요청에 기한을 줘서
// 고쳤으니 이제는 `exit 1` 로 닫힌다. (처음엔 윈도우의 `cmd /c npm.cmd` 탓으로 짐작했는데
// **CI(ubuntu)에서도 같은 것이 나서** 짐작이 틀렸다는 것을 알았다.)
//
// **그래도 결과로 판정하는 것은 그대로 둔다.** 이번엔 원인을 찾았지만 "0 을 냈으니
// 됐다" 는 전제 자체가 약하다 — 우리가 알고 싶은 것은 **"시드가 섰는가"** 다
// (운영 규칙 7.0b — 빈 결과로 통과하는 검사를 만들지 않는다).
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

/** `run` 과 같지만 **죽지 않는다.** 성공 여부만 돌려준다(FIX-76). */
function runSoft(command, args, label) {
  process.stdout.write(`\n[${label}] ${command} ${args.join(" ")}\n`);
  const result = spawnSync(command, args, { stdio: "inherit", shell: process.platform === "win32" });
  if (result.status !== 0) console.error(`[${label}] exit ${result.status} — 결과로 판정한다`);
  return result.status === 0;
}

/** 이름 접두어로 컨테이너 하나를 찾는다. 없으면 빈 문자열. */
function containerNamed(prefix) {
  try {
    return (
      execFileSync("docker", ["ps", "-a", "--filter", `name=${prefix}`, "--format", "{{.Names}}"])
        .toString()
        .trim()
        .split(NL)
        .filter(Boolean)[0] ?? ""
    );
  } catch {
    return "";
  }
}

/**
 * 컨테이너를 재시작하고 **healthy 가 될 때까지 기다린다** (FIX-76).
 *
 * 재시작만 하고 넘어가면 다음 단계가 **아직 안 일어난 컨테이너**를 상대하게 된다 —
 * 그것이 `seed:accounts` 가 502 로 죽던 이유이고(FIX-69), `storage` 도 같은 모양이다.
 * healthcheck 가 없는 컨테이너는 기다릴 것이 없으므로 재시작만 하고 넘어간다.
 */
function restartAndWait(prefix, label, timeoutMs = 180_000) {
  const name = containerNamed(prefix);
  if (!name) {
    console.log(`\n[${label}] ${prefix}* 컨테이너가 없다 — 재시작할 것이 없다.`);
    return;
  }

  run("docker", ["restart", name], label);

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let status = "";
    try {
      status = execFileSync("docker", [
        "inspect", "-f", "{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}", name,
      ]).toString().trim();
    } catch {
      status = "unknown";
    }

    if (status === "healthy" || status === "none") {
      console.log(`[${label}] ${name} — ${status === "none" ? "healthcheck 없음(대기 불필요)" : "healthy"}`);
      return;
    }
    if (Date.now() > deadline) {
      console.error(`[${label}] ${name} 이 ${timeoutMs / 1000}초 안에 healthy 가 되지 않았다 (${status}).`);
      return;
    }
    sleepSync(2000);
  }
}

/**
 * 시드가 실제로 들어왔는지 **결과로** 본다 — `task_templates` 는 `seed.sql` 이 넣는
 * 19행짜리 표라 "마이그레이션과 시드가 둘 다 지나갔다" 의 증거가 된다.
 * 못 세면 0 이 아니라 **-1** 을 돌려준다(빈 결과로 통과하지 않는다).
 */
function countTaskTemplates() {
  const db = containerNamed("supabase_db_");
  if (!db) return -1;
  try {
    const out = execFileSync("docker", [
      "exec", "-i", db, "psql", "-U", "postgres", "-d", "postgres",
      "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1",
      "-c", "select count(*) from public.task_templates;",
    ]).toString().trim();
    const value = Number(out);
    return Number.isInteger(value) && value >= 0 ? value : -1;
  } catch {
    return -1;
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

    // **`Number("")` 는 0 이다.** 빈 출력을 0 행으로 읽으면 "못 셌다" 가 "없다" 가 되고
    // 실패 메시지가 거짓을 말한다 — CI 가 "계정 0개" 라 적었는데 실제로는 **못 센**
    // 것이었다(컨테이너가 아직 재시작 중). 빈 문자열은 **-1** 이다.
    if (out === "") return -1;

    const value = Number(out);

    return Number.isInteger(value) && value >= 0 ? value : -1;
  } catch {
    return -1;
  }
}

/**
 * **`db:reset` 도 종료 코드로 판정하지 않는다 (FIX-76).**
 *
 * `supabase db reset` 은 마이그레이션과 `seed.sql` 을 적용한 **뒤에** 컨테이너를
 * 재시작하는데, 거기서 **`supabase_storage_*` 가 DB 보다 먼저 일어나** DB 에
 * `ECONNREFUSED` 로 붙지 못하고 `unhealthy` 로 남는다. 그러면 CLI 가
 * `failed to bootstrap the local database` 로 **exit 1** 을 낸다 —
 * **스키마와 시드는 이미 다 들어간 상태로.**
 *
 * 예전에는 그 자리에서 `process.exit` 했다. 그 바람에 **DB 는 비워져 스키마만 있고
 * 계정은 없는 상태**로 남았고, 그걸 모르고 손으로 시드하면 픽스처가 어긋나
 * **실주행이 엉뚱한 이유로 실패**했다(C-2a 가 두 번 잃었다 · FIX-77 을 의심하게 만든
 * 원인 중 하나다).
 *
 * 그래서 여기서도 **결과로 판정한다** — 종료 코드가 아니라 `task_templates` 가
 * 실제로 들어왔는지를 본다(위 `seed:accounts` 와 같은 철학).
 */
const resetOk = runSoft("npx", ["supabase", "db", "reset"], "reset");

restartAndWait("supabase_storage_", "storage");
restartAndWait("supabase_kong_", "kong");

if (!resetOk) {
  const templates = countTaskTemplates();
  if (templates > 0) {
    console.log(
      `\n[reset] CLI 는 실패로 끝났지만 **스키마와 시드는 들어와 있다**(task_templates ${templates}건).\n` +
        "        컨테이너 재시작 단계의 실패이며(FIX-76) 위에서 되살렸다 — 계속 간다.",
    );
  } else {
    console.error(
      "\n[reset] 실패했고 **시드도 안 들어왔다**(task_templates 0건).\n" +
        "        DB 가 빈 채로 남았다 — 손으로 시드하지 말고 다시 돌린다:\n" +
        "          npm run db:reseed\n",
    );
    process.exit(1);
  }
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
    const counted = users < 0 ? "계정 수를 못 셌다" : `계정 ${users}개`;
    const why = result.status === 0 ? `종료 코드는 0 인데 ${counted}` : `exit ${result.status}`;
    process.stdout.write(`[seed] ${attempt}회째 실패(${why}) — ${WAIT_MS / 1000}초 뒤 다시 시도한다\n`);

    /**
     * **원인을 감추지 않는다.** 처음에는 stderr 첫 줄만 보여줬는데, 시드는 실패를
     * **stdout 에도** 적어서(`FAIL  auth … -> 502`) 화면에 아무것도 안 남을 때가 있었다 —
     * 그 탓에 CI 로그만 보고는 왜 실패했는지 알 수 없었다. 둘 다 본다.
     */
    for (const [label, raw] of [["out", result.stdout], ["err", result.stderr]]) {
      const line = String(raw ?? "").split(NL).find((l) => /FAIL|Error|error|STOP/.test(l));
      if (line) process.stdout.write(`        [${label}] ${line.trim().slice(0, 140)}\n`);
    }

    sleepSync(WAIT_MS);
  }
}

if (!seeded) {
  console.error("\n[seed] 끝내 서지 않았다. `npx supabase status` 로 스택을 확인한다.");
  process.exit(1);
}

console.log("\n되돌렸다 — db:reset + storage·kong 재시작(healthy 대기) + seed:accounts");
