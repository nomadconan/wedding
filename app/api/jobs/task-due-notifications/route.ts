import type { NextRequest } from "next/server";

import { recordAudit } from "@/lib/audit/record";
import { fail, ok } from "@/lib/api/response";
import { skipSummary } from "@/lib/core/notify/task-due";
import { authorizeJob } from "@/lib/ops/job-auth";
import { closeJobRun, openJobRun } from "@/lib/ops/job-run";
import { runTaskDueNotifications } from "@/lib/notify/task-due";

/**
 * POST /api/jobs/task-due-notifications — 기한 알림 배치 (C-4d · §4.5)
 *
 * ── 왜 `dday-notifications` 와 나눴나 ───────────────────────────────────────
 * `job_runs` 는 **배치 단위**로 남는다. 한 라우트에 묶으면 무엇이 실패했는지 못
 * 가르고, 한쪽 장애가 다른 쪽 발송을 막는다. 성격도 다르다 — 저쪽은 **예식일 하나**
 * 에 대한 여덟 번이고 이쪽은 **항목마다** 자기 기한에서 역산한다.
 *
 * ── 파라미터가 없으면 `skipped` 로 끝낸다 ───────────────────────────────────
 * **`succeeded` 로 적지 않는다.** 성공으로 적으면 모니터링 화면이 "잘 돌았고 0건
 * 보냈다" 로 읽고, 그것은 *"보낼 게 없었다"* 와 구분되지 않는다. `job_runs.status`
 * 에 `skipped` 가 있는 이유가 여기다(§7.4 · D-49 계열).
 *
 * ── 증적의 쓰기 결과를 본다 (FIX-72) ────────────────────────────────────────
 * `recordAudit` 는 boolean 을 돌려준다. 넣는 쪽이 결과를 안 보면 **증적만 조용히
 * 사라진다** — 참가격 배치가 실제로 그랬다. 실패하면 응답과 `job_runs` 에 적는다.
 *
 * ── 배치에는 사람이 없다 (D-173) ────────────────────────────────────────────
 * `actor_id` 에 uuid 를 지어내지 않는다. `actor_id`·`actor_role` 은 `null` 이고
 * 시스템 실행임은 `source` 가 말한다.
 *
 * `today` 를 인자로 받는다 — 배치가 '오늘' 을 스스로 정하면 같은 입력으로 같은
 * 결과가 나오지 않아 재현할 수 없다(`dday` 와 같은 규칙).
 */
export async function POST(request: NextRequest) {
  if (!authorizeJob(request).ok) {
    return fail(401, "JOB_UNAUTHORIZED", "실행 권한이 없습니다.");
  }

  const raw = request.nextUrl.searchParams.get("today");
  const today =
    raw && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : new Date().toISOString().slice(0, 10);

  const run = await openJobRun("task-due-notifications");

  try {
    const result = await runTaskDueNotifications(today);

    /**
     * **증적을 남기고 그 결과를 본다**(FIX-72).
     *
     * `entity_events` 가 아니라 `audit_logs` 다 — 이 기록의 대상은 **실행 한 번**
     * 이지 어느 한 태스크·알림이 아니고, `EntityType` 에 억지로 끼워 맞추면 그 어휘가
     * 뜻하는 바가 흐려진다. 알림 한 건씩의 증적은 `notifications` 행이 이미 갖는다
     * (발송·도달·열람 · D-23).
     *
     * **행위자가 없다**(D-173) — `actor_id` 에 uuid 를 지어 넣으면 `auth.users` FK 가
     * 거절해 증적이 통째로 사라진다(FIX-71 이 실제로 겪었다).
     */
    const recorded = await recordAudit({
      actorId: null,
      actorRole: null,
      action: result.blocked === null ? "task_due_batch_ran" : "task_due_batch_blocked",
      targetType: "job_run",
      targetId: run.id,
      // **셀 수 있는 값만.** 태스크 제목·상품명은 넣지 않는다(§7.3).
      after: {
        sent: result.sent,
        duplicate: result.duplicate,
        scanned: result.scanned,
        blocked: result.blocked,
      },
    });

    const summary = [
      result.blocked === null ? null : `blocked:${result.blocked}`,
      skipSummary(result),
      // **증적이 사라진 사실을 감추지 않는다.** 배치는 계속 돌되 밖으로 낸다.
      recorded ? null : "audit_lost:1",
    ]
      .filter(Boolean)
      .join(" ");

    const runClosed = await closeJobRun(run, {
      // 파라미터가 없어 아무것도 못 보낸 것은 **성공이 아니다.**
      status: result.blocked === null ? "succeeded" : "skipped",
      processedCount: result.scanned,
      errorSummary: summary === "" ? null : summary,
    });

    return ok({
      today,
      ...result,
      auditRecorded: recorded,
      // 마감을 못 적었으면 밖으로 낸다 — 모니터가 `running` 으로 남은 행을 볼 때
      // 그 이유가 여기 있다(FIX-73f · `price-anomaly-scan` 과 같은 모양).
      runClosed,
    });
  } catch {
    await closeJobRun(run, { status: "failed", errorSummary: "task_due_failed:1" });

    // 실패 원인을 응답에 싣지 않는다(CLAUDE.md §5.3).
    return fail(500, "JOB_FAILED", "배치를 끝내지 못했습니다.");
  }
}

/** **Vercel Cron 은 GET 으로 부른다**(`dday` 가 같은 이유로 둘 다 낸다). */
export const GET = POST;
