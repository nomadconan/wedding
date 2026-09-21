import {
  DOCUMENT_BUCKET,
  PURGE_JOB_NAME,
  documentObjectKey,
  type PurgeCandidate,
  type PurgeOutcome,
  type PurgeSummary,
  selectDuePurges,
  summarizePurgeRun,
} from "@/lib/core/privacy/purge";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * 문서 파기 배치 (S8-04 · F-A-08 · 명세서 §4.3 배치 · §5.1)
 *
 * ── 왜 Edge Function 이 아닌가 ──────────────────────────────────────────────
 * §4.3 배치표는 이 일을 `purge-documents` **Edge Function** 으로 적어 두었다.
 * 그런데 이 리포의 배치 셋(`dday-notifications`·`sla-escalation`·
 * `consultation-confirm-request`)은 전부 **`app/api/jobs/*` Route Handler** 이고,
 * §3 기술표도 배치 수단을 "Supabase Edge Functions **+ Vercel Cron**" 둘로 적는다.
 *
 * Route Handler 를 고른 이유는 셋이다.
 *   1. **한 벌의 코드.** Deno 로 쓰면 `lib/core/privacy` 를 못 쓰고(경로 별칭·zod)
 *      파기 판정 로직이 **두 벌**이 된다. 파기는 되돌릴 수 없는 일이라 두 벌이 갈리면
 *      어느 쪽이 진짜 규칙인지 답할 수 없다.
 *   2. **한 벌의 시험.** vitest 가 그대로 돈다. Deno 함수는 지금 CI 가 실행하지 않는다.
 *   3. **선례.** 앞선 배치 셋과 같은 자리에 두면 S8-13 이 스케줄을 붙일 때 한 곳만 본다.
 * **명세 §4.3 의 수단 표기를 Route Handler 로 고칠 것을 제안한다**(§7.5 · D-118).
 *
 * ── 순서가 규칙이다 (D-58) ─────────────────────────────────────────────────
 * **Storage 삭제 → `purged_at`** 이다. 뒤집으면 파기 실패한 문서가 '파기됨' 으로 적혀
 * **감사(F-A-08)가 찾아내야 할 것을 못 찾는다.**
 *
 * ── 버킷을 경로에서 읽지 않는다 (FIX-87) ───────────────────────────────────
 * 여기 `splitStoragePath(path)` 가 있어서 `documents.storage_path` 의 **첫 조각을
 * 버킷으로 읽었다.** 그런데 그 값을 적는 쪽(`lib/reports/storage.ts` 의
 * `documentPath()`)은 `<커플id>/<문서id>` 를 적는다 — **버킷 접두어가 없다.**
 * 그래서 배치는 `<커플id>` 라는 **없는 버킷**에서 지우려 했고,
 * `storage.remove()` 는 없는 버킷에도 **오류를 안 낸다**(실측: `error:null data:[]`).
 * 결과가 이랬다:
 *
 *     {"processed":2,"purged":2,"failed":0,"status":"succeeded"}   ← 원문은 그대로 있다
 *
 * 게다가 `purged_at` 이 찍히는 순간 아래 조회의 `is('purged_at', null)` 에서
 * **영영 빠진다.** 24시간 파기(§5.1)가 아니라 **영구 보존**이 되고, 감사 화면은
 * "파기됨" 이라고 말한다. `purged_at` 의 뜻이 통째로 뒤집혀 있었다.
 *
 * **경로는 `contracts-raw` 안의 키다.** 버킷은 상수이며 추측하지 않는다.
 * 그리고 `remove()` 가 **오류를 안 내므로 지워진 개수를 본다** — 0 은 성공이 아니다.
 */
export type PurgeRunResult = PurgeSummary & { jobRunId: string | null; ranAt: string };

export async function runDocumentPurge(now: Date): Promise<PurgeRunResult> {
  const admin = createAdminClient();
  const ranAt = now.toISOString();

  // 실행 이력을 **먼저** 연다. 도중에 프로세스가 죽어도 "돌다 말았다" 가 남는다 —
  // 끝나고 나서야 기록하면 죽은 실행은 아무 흔적이 없고, 감사 화면은 '한 번도 안 돌았다'
  // 와 '돌다 죽었다' 를 구분하지 못한다.
  const { data: opened } = await admin
    .from("job_runs")
    .insert({ job_name: PURGE_JOB_NAME, started_at: ranAt, status: "running" })
    .select("id")
    .maybeSingle();

  const jobRunId = (opened as { id: string } | null)?.id ?? null;

  // **서비스롤로 읽는다.** `documents` 의 SELECT 정책은 커플 소유라 배치에는 세션이
  // 없다. 여기서 읽은 `storage_path` 는 이 함수 밖으로 **나가지 않는다**(§5.3).
  const { data: rows, error } = await admin
    .from("documents")
    .select("id, storage_path, purge_scheduled_at, purged_at")
    .is("purged_at", null)
    .lte("purge_scheduled_at", ranAt)
    .limit(500);

  if (error) {
    const summary = summarizePurgeRun([]);
    await closeRun(admin, jobRunId, { ...summary, status: "failed", errorSummary: "query_failed:1" });

    throw new Error("PURGE_QUERY_FAILED");
  }

  const candidates: PurgeCandidate[] = (
    (rows ?? []) as { id: string; storage_path: string; purge_scheduled_at: string; purged_at: string | null }[]
  ).map((row) => ({
    id: row.id,
    storagePath: row.storage_path,
    purgeScheduledAt: row.purge_scheduled_at,
    purgedAt: row.purged_at,
  }));

  const due = selectDuePurges(candidates, now);
  const outcomes: PurgeOutcome[] = [];

  /**
   * **버킷이 있는지 먼저 본다** (FIX-87 · §7.0b "0 으로 통과하는 검사를 만들지 않는다").
   *
   * 아래에서 "지워진 개수 0" 을 `already_gone` 으로 읽는데, **버킷 자체가 없어도
   * 0 이 나온다.** 그 둘을 못 가르면 버킷 이름을 잘못 적은 날 배치가 **전건을
   * '이미 없다' 로 찍고** 원문을 통째로 남긴다 — 바로 그 일이 있었다.
   * 확인은 실행당 한 번이고, 실패하면 **아무것도 찍지 않고** 통째로 실패로 닫는다.
   */
  if (due.length > 0) {
    const { error: bucketError } = await admin.storage.getBucket(DOCUMENT_BUCKET);

    if (bucketError) {
      const summary = summarizePurgeRun(
        due.map((candidate) => ({
          id: candidate.id,
          result: "failed" as const,
          reason: "bucket_missing",
        })),
      );
      await closeRun(admin, jobRunId, summary);

      return { ...summary, jobRunId, ranAt };
    }
  }

  for (const candidate of due) {
    const key = documentObjectKey(candidate.storagePath);

    if (key === null) {
      // 경로가 망가졌으면 지울 수 없다. **`purged_at` 을 찍지 않는다** — 원문이
      // 어딘가 남아 있을 수 있는데 '파기됨' 으로 적으면 감사가 눈을 감는다.
      outcomes.push({ id: candidate.id, result: "failed", reason: "bad_path" });
      continue;
    }

    const removed = await admin.storage.from(DOCUMENT_BUCKET).remove([key]);

    if (removed.error) {
      outcomes.push({ id: candidate.id, result: "failed", reason: "storage_error" });
      continue;
    }

    // **개수를 본다.** 버킷이 살아 있는데 0 건이 지워졌다면 객체가 이미 없다는 뜻이고
    // (`already_gone`), 그건 파기 목적이 달성된 상태다 — 안 찍으면 매시간 다시 집는다.
    // 버킷 자체가 없는 경우는 위의 사전 확인이 이미 걸렀다.
    const deleted = (removed.data ?? []).length;

    // Storage 를 지운 **뒤에** 표시한다(D-58).
    const { error: markError } = await admin
      .from("documents")
      .update({ purged_at: new Date().toISOString() })
      .eq("id", candidate.id);

    outcomes.push(
      markError
        ? { id: candidate.id, result: "failed", reason: "mark_failed" }
        : deleted > 0
          ? { id: candidate.id, result: "purged" }
          : { id: candidate.id, result: "already_gone" },
    );
  }

  const summary = summarizePurgeRun(outcomes);
  await closeRun(admin, jobRunId, summary);

  return { ...summary, jobRunId, ranAt };
}

async function closeRun(
  admin: ReturnType<typeof createAdminClient>,
  jobRunId: string | null,
  summary: PurgeSummary,
): Promise<void> {
  if (!jobRunId) return;

  await admin
    .from("job_runs")
    .update({
      finished_at: new Date().toISOString(),
      status: summary.status,
      processed_count: summary.processed,
      // 사유별 개수만 담는다. 경로·id 는 담지 않는다(§5.3 · `summarizePurgeRun` 주석).
      error_summary: summary.errorSummary,
    })
    .eq("id", jobRunId);
}
