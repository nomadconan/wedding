import type { NextRequest } from "next/server";

/**
 * 배치 실행 인증 (S8-13 · §4.5)
 *
 * ── 전용 비밀키를 여기서 정한다 ─────────────────────────────────────────────
 * 배치 라우트들이 지금까지 `SUPABASE_SERVICE_ROLE_KEY` 를 그대로 헤더로 받았고,
 * 주석마다 "전용 비밀키는 S8-13 이 실행 인프라를 정할 때 함께 정한다" 고 적혀 있었다.
 * 그 시점이다.
 *
 * **`CRON_SECRET` 을 먼저 본다.** Vercel Cron 이 그 이름으로 보내며, 서비스롤 키를
 * 스케줄러 설정에 복사하지 않아도 된다 — 그 키는 **RLS 를 통째로 우회**하므로
 * 배포 설정·로그·대시보드 어디에도 늘어나면 안 된다(CLAUDE.md §5.4).
 *
 * **서비스롤 키도 계속 받는다.** 로컬에서 손으로 부르는 경로가 그것이고, 그것까지
 * 끊으면 `db:reset` 뒤 배치를 확인할 방법이 없어진다.
 *
 * ── 설정이 없으면 조용히 401 이 된다 ────────────────────────────────────────
 * **`CRON_SECRET` 이 없으면 Vercel 은 Authorization 헤더를 아예 안 보낸다.** 그러면
 * 스케줄은 매시간 도는데 라우트가 매번 401 을 돌려주고, `job_runs` 에는 아무것도
 * 안 남아 화면은 "한 번도 안 돌았다" 로 보인다 — **틀린 화면은 아니지만 원인을
 * 가리키지 못한다.** 그래서 `cronSecretConfigured()` 를 콘솔이 함께 보여준다.
 */
export type JobAuth = { ok: true } | { ok: false; reason: "no_secret" | "mismatch" };

export function authorizeJob(request: NextRequest): JobAuth {
  const cronSecret = process.env.CRON_SECRET;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const provided = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");

  if (!cronSecret && !serviceKey) return { ok: false, reason: "no_secret" };
  if (!provided) return { ok: false, reason: "mismatch" };

  // **둘 다 받는다.** 스케줄러는 `CRON_SECRET`, 손으로 부를 때는 서비스롤 키.
  if (cronSecret && provided === cronSecret) return { ok: true };
  if (serviceKey && provided === serviceKey) return { ok: true };

  return { ok: false, reason: "mismatch" };
}

/**
 * 스케줄러 전용 키가 설정돼 있는가.
 *
 * **값을 돌려주지 않는다** — 불리언만 낸다. 콘솔이 "설정됨/안 됨" 을 보이는 데는
 * 그것으로 충분하고, 값이 화면 경로에 실리면 그 자체가 사고다(§5.4).
 */
export function cronSecretConfigured(): boolean {
  return (process.env.CRON_SECRET ?? "") !== "";
}
