import type { SupabaseClient } from "@supabase/supabase-js";

import { recordEvent } from "@/lib/audit/record";
import {
  REPORT_REASON_LABEL,
  REPORT_STATUS_LABEL,
  isReportClosed,
  reportSla,
  type PostStatus,
  type ReportReason,
  type ReportStatus,
  type SlaVerdict,
} from "@/lib/core/community/community";
import {
  buildResolution,
  moderationMemo,
  moderationOutcome,
  moderationProblem,
  sortQueue,
  type AbuseSignals,
  type ModerationAction,
} from "@/lib/core/community/moderation";
import { readIntSetting } from "@/lib/app-settings";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * 모더레이션 실행 (S7-17 · 명세서 §2.3 F-A-18 · §3.9 · D-62)
 *
 * **조회는 세션(RLS)으로, 변경은 서비스롤로.** 두 방향이 다른 이유가 있다 —
 *  · 큐 조회는 `is_operator()` 정책이 이미 판정한다(0038). 서비스롤로 읽으면 경계가
 *    RLS 가 아니라 이 파일의 조건문이 된다.
 *  · 변경은 **정책이 없다.** 운영자에게 UPDATE 정책을 주면 되돌릴 수 없는 권한이
 *    클라이언트 번들이 닿는 자리에 놓인다(D-62). 그래서 서버가 지나고, **서버는
 *    지나기 전에 세션으로 운영자임을 확인한다.**
 */

export type QueueItem = {
  reportId: string;
  targetType: "post" | "comment";
  targetId: string;
  reasonCode: ReportReason;
  reasonLabel: string;
  status: ReportStatus;
  statusLabel: string;
  createdAt: string;
  sla: SlaVerdict;
  /** 대상 글. 이미 지워졌으면 `deleted` 이고 그때도 신고는 닫을 수 있다. */
  target: {
    exists: boolean;
    status: PostStatus | null;
    title: string | null;
    /** 본문 일부. **운영자가 판단하려면 무엇이 문제인지 봐야 한다.** */
    excerpt: string | null;
    authorId: string | null;
  };
  signals: AbuseSignals;
  /** 이미 처리된 신고의 기록. 처리 이력 탭이 읽는다. */
  resolution: string | null;
  resolvedAt: string | null;
};

type ReportRecord = {
  id: string;
  target_type: string;
  target_id: string;
  reporter_id: string;
  reason_code: string;
  status: string;
  resolution: string | null;
  resolved_at: string | null;
  created_at: string;
};

const REPORT_COLUMNS =
  "id, target_type, target_id, reporter_id, reason_code, status, resolution, resolved_at, created_at";

/** 본문은 통째로 내보내지 않는다. 판단에 필요한 만큼만 자른다(§7.3 최소화). */
const EXCERPT_LENGTH = 200;

/**
 * 신고 큐.
 *
 * **세션 클라이언트로 읽는다** — `is_operator()` 가 경계다. 대상 글은 운영자 정책이
 * 열어 두므로(0038 `community_posts_select_operator`) 같은 클라이언트로 읽는다.
 */
export async function loadQueue(
  client: SupabaseClient,
  options: { closed: boolean; now: number },
): Promise<QueueItem[]> {
  const { data } = await client
    .from("community_reports")
    .select(REPORT_COLUMNS)
    .in("status", options.closed ? ["resolved", "rejected"] : ["open", "reviewing"])
    .order("created_at", { ascending: true })
    .limit(100);

  const reports = (data ?? []) as unknown as ReportRecord[];
  if (reports.length === 0) return [];

  const postIds = reports.filter((row) => row.target_type === "post").map((row) => row.target_id);
  const commentIds = reports.filter((row) => row.target_type === "comment").map((row) => row.target_id);

  const [{ data: postRows }, { data: commentRows }] = await Promise.all([
    postIds.length
      ? client.from("community_posts").select("id, title, body, status, author_id").in("id", postIds)
      : Promise.resolve({ data: [] as never[] }),
    // **댓글도 신고 대상이다**(0038 `target_type`). 업체 공식 답변(F-V-18)도 댓글이므로
    // 여기서 다루지 않으면 **신고할 수 없는 글이 하나 생긴다** — 그 예외는 곧
    // "업체는 무엇이든 쓸 수 있다" 가 된다(S7-16).
    commentIds.length
      ? client.from("community_comments").select("id, body, status, author_id").in("id", commentIds)
      : Promise.resolve({ data: [] as never[] }),
  ]);

  const posts = new Map(
    ((postRows ?? []) as { id: string; title: string; body: string; status: string; author_id: string }[]).map(
      (row) => [row.id, row],
    ),
  );

  const comments = new Map(
    ((commentRows ?? []) as { id: string; body: string; status: string; author_id: string }[]).map((row) => [
      row.id,
      row,
    ]),
  );

  // **SLA 기준은 O-14 대기다.** 값이 없으면 판정하지 않는다 — 지어낸 기한으로
  // 운영자를 재촉하지 않는다.
  const slaHours = await readIntSetting("community.report_sla_hours", "value");

  const signals = await abuseSignals(client, reports, [...posts.values()]);

  const items: QueueItem[] = reports.map((report) => {
    const post = posts.get(report.target_id) ?? null;
    const comment = comments.get(report.target_id) ?? null;
    // 글이든 댓글이든 운영자가 볼 것은 같다 — 무엇이 문제인지 읽을 본문과 상태다.
    const target = post ?? comment ?? null;

    return {
      reportId: report.id,
      targetType: report.target_type as "post" | "comment",
      targetId: report.target_id,
      reasonCode: report.reason_code as ReportReason,
      reasonLabel: REPORT_REASON_LABEL[report.reason_code as ReportReason] ?? report.reason_code,
      status: report.status as ReportStatus,
      statusLabel: REPORT_STATUS_LABEL[report.status as ReportStatus] ?? report.status,
      createdAt: report.created_at,
      sla: reportSla({ createdAt: report.created_at, now: options.now, slaHours }),
      target: {
        // **대상이 사라져도 신고는 남는다**(S7-14). 없으면 없다고 말한다.
        exists: target !== null,
        status: (target?.status ?? null) as PostStatus | null,
        title: post?.title ?? (comment === null ? null : "댓글"),
        excerpt: target === null ? null : target.body.slice(0, EXCERPT_LENGTH),
        authorId: target?.author_id ?? null,
      },
      signals: signals.get(report.id) ?? {
        reportsOnTarget: 0,
        reportsByReporter: 0,
        hiddenPostsByAuthor: 0,
      },
      resolution: report.resolution,
      resolvedAt: report.resolved_at,
    };
  });

  return sortQueue(items);
}

/**
 * 어뷰징 신호.
 *
 * **이미 있는 행에서만 센다**(§7.3 — 새로 수집하는 값이 없다). 그리고 **판정하지
 * 않는다**: 무엇이 어뷰징인지는 O-14 다.
 */
async function abuseSignals(
  client: SupabaseClient,
  reports: readonly ReportRecord[],
  posts: readonly { id: string; author_id: string }[],
): Promise<Map<string, AbuseSignals>> {
  const targetIds = [...new Set(reports.map((row) => row.target_id))];
  const reporterIds = [...new Set(reports.map((row) => row.reporter_id))];
  const authorIds = [...new Set(posts.map((row) => row.author_id))];

  const [{ data: onTarget }, { data: byReporter }, { data: hidden }] = await Promise.all([
    client.from("community_reports").select("target_id").in("target_id", targetIds),
    client.from("community_reports").select("reporter_id").in("reporter_id", reporterIds),
    authorIds.length
      ? client.from("community_posts").select("author_id").in("author_id", authorIds).eq("status", "hidden")
      : Promise.resolve({ data: [] as { author_id: string }[] }),
  ]);

  const count = <T extends string>(rows: readonly Record<string, unknown>[], key: string) => {
    const map = new Map<T, number>();

    for (const row of rows) {
      const value = row[key] as T;
      map.set(value, (map.get(value) ?? 0) + 1);
    }

    return map;
  };

  const targetCounts = count((onTarget ?? []) as Record<string, unknown>[], "target_id");
  const reporterCounts = count((byReporter ?? []) as Record<string, unknown>[], "reporter_id");
  const hiddenCounts = count((hidden ?? []) as Record<string, unknown>[], "author_id");

  const authorOf = new Map(posts.map((row) => [row.id, row.author_id]));

  return new Map(
    reports.map((report) => {
      const author = authorOf.get(report.target_id) ?? null;

      return [
        report.id,
        {
          reportsOnTarget: targetCounts.get(report.target_id) ?? 0,
          reportsByReporter: reporterCounts.get(report.reporter_id) ?? 0,
          hiddenPostsByAuthor: author === null ? 0 : (hiddenCounts.get(author) ?? 0),
        },
      ];
    }),
  );
}

export type ApplyResult =
  | { ok: true; reportStatus: ReportStatus; postStatus: PostStatus | null }
  | { ok: false; status: number; code: string; message: string };

/**
 * 조치를 적용한다.
 *
 * **호출자가 운영자임을 이미 확인했다는 전제**로 서비스롤을 쓴다(라우트가
 * `requireOperator` 를 지난다). 그 확인 없이 이 함수를 부르면 모더레이션 권한이
 * 그대로 열린다 — 그래서 라우트 하나에서만 부른다.
 */
export async function applyModeration(input: {
  reportId: string;
  action: ModerationAction;
  resolution: string;
  operatorId: string;
  now: string;
}): Promise<ApplyResult> {
  const admin = createAdminClient();

  const { data: reportRow } = await admin
    .from("community_reports")
    .select(REPORT_COLUMNS)
    .eq("id", input.reportId)
    .maybeSingle();

  const report = reportRow as unknown as ReportRecord | null;

  if (report === null) {
    return { ok: false, status: 404, code: "MOD_REPORT_NOT_FOUND", message: "신고를 찾을 수 없습니다." };
  }

  if (isReportClosed(report.status as ReportStatus)) {
    return {
      ok: false,
      status: 409,
      code: "MOD_ALREADY_RESOLVED",
      message: "이미 처리된 신고예요.",
    };
  }

  // 글이든 댓글이든 같은 조치를 받는다 — 업체 답변만 예외로 두면 신고할 수 없는
  // 글이 하나 생긴다(S7-16).
  const targetTable = report.target_type === "comment" ? "community_comments" : "community_posts";

  const { data: postRow } = await admin
    .from(targetTable)
    .select("id, status")
    .eq("id", report.target_id)
    .maybeSingle();

  const post = postRow as { id: string; status: string } | null;

  // 대상이 사라졌으면 글 상태를 `deleted` 로 본다 — 그때도 '조치 없음' 은 가능하다.
  const targetStatus = (post?.status ?? "deleted") as PostStatus;

  const problem = moderationProblem({
    action: input.action,
    resolution: input.resolution,
    targetStatus,
  });

  if (problem !== null) {
    return { ok: false, status: 422, code: `MOD_${problem.field.toUpperCase()}`, message: problem.message };
  }

  const outcome = moderationOutcome(input.action);

  if (outcome.postStatus !== null && post !== null) {
    await admin.from(targetTable).update({ status: outcome.postStatus }).eq("id", post.id);

    await recordEvent({
      entityType: report.target_type === "comment" ? "community_comment" : "community_post",
      entityId: post.id,
      eventType: `community_${report.target_type}_${input.action}`,
      actor: { id: input.operatorId, role: "operator" },
      beforeState: post.status,
      afterState: outcome.postStatus,
      // **사유 원문을 넣지 않는다** — `community_reports.resolution` 이 갖는다(§7.3).
      memo: moderationMemo({ action: input.action, reasonCode: report.reason_code as ReportReason }),
    });
  }

  const record = buildResolution({
    action: input.action,
    resolution: input.resolution,
    operatorId: input.operatorId,
    now: input.now,
  });

  await admin
    .from("community_reports")
    .update({
      status: record.status,
      resolution: record.resolution,
      resolved_by: record.resolvedBy,
      resolved_at: record.resolvedAt,
    })
    .eq("id", input.reportId);

  await recordEvent({
    entityType: "community_report",
    entityId: input.reportId,
    eventType: "community_report_resolved",
    actor: { id: input.operatorId, role: "operator" },
    beforeState: report.status,
    afterState: record.status,
    memo: moderationMemo({ action: input.action, reasonCode: report.reason_code as ReportReason }),
  });

  return { ok: true, reportStatus: record.status, postStatus: outcome.postStatus };
}
