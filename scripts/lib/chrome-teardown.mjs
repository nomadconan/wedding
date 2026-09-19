// =============================================================================
// Chrome 을 **자식까지** 끝낸다 (FIX-77)
// -----------------------------------------------------------------------------
// ── 무엇이 문제였나 ─────────────────────────────────────────────────────────
// 실주행 셋(`chain:walk` · `vendor:walk` · `audit:*`)은 끝날 때 `proc.kill()` 로
// Chrome 을 닫았다. **그런데 Windows 에서 그것은 부모 하나만 죽인다** —
// Chrome 은 렌더러·GPU·유틸리티로 **프로세스를 여럿 띄우고**, 부모가 죽어도
// 자식들은 **고아로 살아남는다.**
//
// 한 번 돌 때마다 **열두어 개가 남고** 각각 100~300MB 를 쥔다. 몇 번 돌리면
// 수 GB 가 사라진다. 이 개발 PC 는 **물리 메모리가 7.8GB** 라 그 상태에서
// 다음 주행을 걸면:
//   · 개발 서버가 라우트 하나를 컴파일하는 데 20~30초가 걸리고
//   · 페이지가 덜 그려진 채로 CDP 조회가 값을 돌려주고
//   · Chrome 이 주행 도중 죽는다(`CDP 응답 없음: Page.navigate`)
//
// 그래서 증상이 **제품 결함처럼 보였다** — `chain:walk` 이 4단계에서
// "업체가 후보에 없음" 으로 죽었고, 그것은 화면이 그리지 못한 것이지
// 후보 계산이 틀린 것이 아니었다. **환경이 못 도는 것과 제품이 안 도는 것은
// 다른 사실이고, 섞이면 원장이 거짓말을 한다.**
//
// ── 무엇을 하는가 ──────────────────────────────────────────────────────────
//  1. `killTree(proc)`    — 프로세스 **트리째** 끝낸다(Windows 는 `taskkill /T /F`).
//  2. `removeProfile(dir)`— 임시 프로필 디렉터리를 지운다(디스크도 새고 있었다).
//  3. `sweepOrphans()`    — **지난 주행이 남긴 고아**를 찾아 정리한다.
//  4. `memoryNote()`      — 지금 메모리 여유를 한 줄로 적는다(주행 로그에 남긴다).
//
// 콘솔 출력은 ASCII 전용이 아니어도 된다(이 스크립트는 사람이 읽는 주행 로그에 쓴다).
// =============================================================================
import { execFileSync, spawnSync } from "node:child_process";
import { rmSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freemem, totalmem } from "node:os";

const IS_WIN = process.platform === "win32";

/** 프로필 디렉터리 접두어 셋 — 주행마다 다르다. */
export const PROFILE_PREFIXES = ["wc-chain-", "wc-vendor-", "wc-audit-"];

/**
 * 프로세스를 **트리째** 끝낸다.
 *
 * `proc.kill()` 은 Windows 에서 **부모만** 죽인다 — 그것이 FIX-77 의 뿌리다.
 * 죽이지 못해도 던지지 않는다: 정리 단계에서 던지면 **주행 결과가 정리 실패로
 * 덮인다**(우리가 알고 싶은 것은 주행 결과다).
 */
export function killTree(proc) {
  if (!proc || proc.killed || typeof proc.pid !== "number") return;

  if (IS_WIN) {
    // `/T` 자식까지 · `/F` 강제. 이미 죽었으면 비영 종료 코드지만 그것도 정상이다.
    spawnSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }

  try {
    // POSIX: 프로세스 그룹째. 그룹이 없으면 당사자만.
    process.kill(-proc.pid, "SIGKILL");
  } catch {
    try { proc.kill("SIGKILL"); } catch { /* 이미 죽었다 */ }
  }
}

/** 임시 프로필을 지운다. 실패해도 던지지 않는다(다음 청소가 가져간다). */
export function removeProfile(dir) {
  if (!dir) return;
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* 파일이 잠겨 있으면 다음 주행의 sweepOrphans 가 가져간다 */
  }
}

/**
 * **지난 주행이 남긴 고아를 정리한다.**
 *
 * 지금까지 새던 것이라 이미 쌓여 있을 수 있다. 주행을 시작하기 전에 한 번 쓸어
 * 담는다 — 안 그러면 **이번 주행이 남의 쓰레기 때문에 실패한다.**
 *
 * **우리 것만 지운다.** 사람이 열어 둔 Chrome 창을 닫으면 안 되므로
 * **`--user-data-dir` 가 우리 임시 프로필인 프로세스만** 고른다.
 */
export function sweepOrphans({ quiet = false } = {}) {
  let killed = 0;
  let dirs = 0;

  if (IS_WIN) {
    try {
      const out = execFileSync("powershell", [
        "-NoProfile", "-Command",
        "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | " +
          "Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress",
      ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

      if (out) {
        const parsed = JSON.parse(out);
        const rows = Array.isArray(parsed) ? parsed : [parsed];
        for (const row of rows) {
          const cmd = String(row?.CommandLine ?? "");
          if (!PROFILE_PREFIXES.some((p) => cmd.includes(p))) continue;
          spawnSync("taskkill", ["/PID", String(row.ProcessId), "/T", "/F"], { stdio: "ignore" });
          killed += 1;
        }
      }
    } catch {
      /* 못 세면 그냥 넘어간다 — 청소는 최선 노력이다 */
    }
  } else {
    try {
      execFileSync("pkill", ["-f", "wc-chain-|wc-vendor-|wc-audit-"], { stdio: "ignore" });
    } catch {
      /* 맞는 것이 없으면 pkill 은 1 을 낸다 */
    }
  }

  // 임시 프로필 디렉터리도 쓸어 담는다. **오래된 것만** — 지금 도는 주행 것을 지우면 안 된다.
  const cutoff = Date.now() - 60_000;
  try {
    for (const name of readdirSync(tmpdir())) {
      if (!PROFILE_PREFIXES.some((p) => name.startsWith(p))) continue;
      const full = join(tmpdir(), name);
      try {
        if (statSync(full).mtimeMs > cutoff) continue;
        rmSync(full, { recursive: true, force: true, maxRetries: 2 });
        dirs += 1;
      } catch {
        /* 잠겨 있으면 다음에 */
      }
    }
  } catch {
    /* tmpdir 을 못 읽으면 넘어간다 */
  }

  if (!quiet && (killed > 0 || dirs > 0)) {
    console.log(`[청소] 지난 주행이 남긴 Chrome ${killed}개 · 프로필 ${dirs}개를 정리했다 (FIX-77)`);
  }
  return { killed, dirs };
}

/**
 * 메모리 여유를 한 줄로 적는다.
 *
 * **막지는 않는다.** 여유가 없다고 주행을 거부하면 "환경이 모자라다" 가
 * "검사가 안 돈다" 가 되고, 그러면 아무도 돌리지 않는다. 대신 **주행 로그에
 * 사실을 남겨** 뒤에 결과를 읽는 사람이 판단할 수 있게 한다.
 */
export function memoryNote() {
  const freeGb = freemem() / 1024 ** 3;
  const totalGb = totalmem() / 1024 ** 3;
  const line = `[메모리] 여유 ${freeGb.toFixed(1)}GB / 전체 ${totalGb.toFixed(1)}GB`;
  if (freeGb < 1.0) {
    return `${line} — ⚠ **여유가 1GB 미만이다.** 개발 서버 컴파일이 느려지고 ` +
      `Chrome 이 주행 도중 죽을 수 있다. 그렇게 죽으면 **제품 결함처럼 보인다**(FIX-77).`;
  }
  return line;
}
