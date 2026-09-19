// =============================================================================
// stack:slim — 실주행에 필요 없는 Supabase 컨테이너를 내린다 (FIX-77)
// -----------------------------------------------------------------------------
// ── 왜 필요한가 ─────────────────────────────────────────────────────────────
// 이 개발 PC 는 **물리 메모리가 7.8GB** 다. 거기에 Supabase 스택(컨테이너 아홉) ·
// Next 개발 서버 · Chrome(주행이 면 넷을 띄운다) · 편집기가 함께 올라간다.
// 실측에서 **커밋 메모리가 26GB / 여유 0.6GB** 였고, 그 상태에서는
//   · 개발 서버가 라우트 하나를 컴파일하는 데 20~30초가 걸리고
//   · storage 컨테이너 마이그레이션이 **26분**이 걸렸으며(실측)
//   · 주행 중 Chrome 이 죽는다(`CDP 응답 없음`)
// 그리고 그 실패는 **제품 결함처럼 보인다**(FIX-77 이 그렇게 시작됐다).
//
// ── 무엇을 내리는가 ────────────────────────────────────────────────────────
// **주행이 쓰지 않는 것만** 내린다. 내리는 것이 무엇인지 아래 표에 적는다 —
// "뭔지 모르고 껐다" 가 되면 다음 사람이 되살릴 수 없다.
//
// | 컨테이너 | 무엇 | 주행이 쓰나 |
// |---|---|---|
// | `studio`  | 웹 관리 UI(localhost:54323) | **안 쓴다** — 사람이 보는 화면이다 |
// | `pg_meta` | studio 가 DB 를 들여다보는 뒷단 | **안 쓴다** — studio 전용이다 |
// | `inbucket`| 메일 확인함(localhost:54324)  | **안 쓴다** — 주행은 메일을 열지 않는다 |
//
// **DB·auth·kong·rest·storage·realtime 은 건드리지 않는다.** 앱이 쓴다.
//
// 되살리기:  npm run db:start   (supabase start 가 전부 다시 올린다)
//
// 실행:  npm run stack:slim
// 콘솔 출력은 ASCII 전용이 아니다(사람이 읽는 안내다).
// =============================================================================
import { execFileSync, spawnSync } from "node:child_process";

const NL = /\r?\n/;

/** 주행이 쓰지 않는 컨테이너. 이름은 프로젝트마다 접미사가 붙는다. */
const UNUSED = ["supabase_studio_", "supabase_pg_meta_", "supabase_inbucket_"];

function names(prefix) {
  try {
    return execFileSync("docker", ["ps", "--filter", `name=${prefix}`, "--format", "{{.Names}}"])
      .toString().trim().split(NL).filter(Boolean);
  } catch {
    return [];
  }
}

function memUsage(name) {
  try {
    return execFileSync("docker", ["stats", "--no-stream", "--format", "{{.MemUsage}}", name])
      .toString().trim().split("/")[0].trim();
  } catch {
    return "?";
  }
}

let stopped = 0;
const freed = [];

for (const prefix of UNUSED) {
  for (const name of names(prefix)) {
    const before = memUsage(name);
    const result = spawnSync("docker", ["stop", name], { stdio: "ignore" });
    if (result.status === 0) {
      stopped += 1;
      freed.push(`${name} (${before})`);
    } else {
      console.error(`  ${name} 을 내리지 못했다 (exit ${result.status})`);
    }
  }
}

if (stopped === 0) {
  console.log("\n내릴 것이 없다 — 이미 내려가 있거나 스택이 안 떠 있다.");
} else {
  console.log(`\n내렸다 (${stopped}개):`);
  for (const line of freed) console.log(`  · ${line}`);
  console.log("\n되살리려면: npm run db:start");
}

// **남은 것을 적는다.** 무엇이 도는지 보이지 않으면 다음 사람이 또 추측한다.
try {
  const rows = execFileSync("docker", [
    "stats", "--no-stream", "--format", "{{.Name}}\t{{.MemUsage}}",
  ]).toString().trim().split(NL).filter((l) => l.includes("supabase_"));
  if (rows.length > 0) {
    console.log("\n지금 도는 스택:");
    for (const row of rows) console.log(`  ${row}`);
  }
} catch {
  /* docker 가 없으면 넘어간다 */
}
