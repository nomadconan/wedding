import { readIntSetting } from "@/lib/app-settings";
import { recordEvent } from "@/lib/audit/record";
import {
  type AbuseFlag,
  type AbuseSample,
  type BurstThreshold,
  REVIEW_ABUSE_OPEN_ISSUE,
  detectBurst,
  detectDirectSignals,
} from "@/lib/core/review/abuse";
import {
  type ReviewReportReason,
  type ReviewReportResolveInput,
  REVIEW_REPORT_REASON_LABEL,
  hidesReview,
  isVerifiableReason,
} from "@/lib/core/review/report";
import type { ReviewModerationInput } from "@/lib/core/review/write";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

/**
 * 후기 관리 콘솔 (S8-11 · F-A-13)
 *
 * **읽기는 RLS 로, 조치는 서비스롤로**(S8-02 D-115 · D-62 와 같은 갈림길).
 * F-A-13 은 **행을 읽는 것이 목적**이다 — 어떤 후기가 신고됐고 무엇이 적혀 있는지
 * 보지 않고는 판단할 수 없다. 목적이 행이면 경계는 정책이다(0058 이 운영자 SELECT
 * 정책 둘을 세웠다). 반대로 비공개·복구는 **업체의 평판을 움직이는 조치**라
 * 클라이언트 번들이 닿는 자리에 권한을 두지 않는다.
 *
 * **탐지 큐를 표로 저장하지 않는다**(D-124 와 같은 판단). 신호는 `reviews` 와
 * `review_reports` 에서 세어지는 값이고, 저장하면 신고가 처리되거나 후기가 철회될
 * 때 큐가 낡는다. 볼 때마다 같은 순수 함수로 다시 센다.
 */

export async function readBurstThreshold(): Promise<BurstThreshold> {
  // **`readIntSetting` 이 `null` 을 0 으로 읽지 않는다**(S7-17 이 물린 자리).
  // 0시간 창·1건 임계는 "모든 후기가 몰아쓰기" 라는 뜻이라 미결과 정반대다.
  const [windowHours, minCount] = await Promise.all([
    readIntSetting("reviews.burst_window_hours", "value"),
    readIntSetting("reviews.burst_min_count", "value"),
  ]);

  return { windowHours, minCount };
}

export type AdminReviewRow = {
  id: string;
  vendorId: string;
  vendorName: string;
  coupleId: string;
  status: string;
  retractedAt: string | null;
  scorePrice: number | null;
  scoreResponse: number | null;
  scoreFulfillment: number | null;
  body: string | null;
  disclosedAmount: number | null;
  hiddenReason: string | null;
  hiddenAt: string | null;
  vendorReply: string | null;
  createdAt: string;
  flags: AbuseFlag[];
  reports: AdminReportRow[];
};

export type AdminReportRow = {
  id: string;
  reviewId: string;
  reason: ReviewReportReason;
  reasonLabel: string;
  /** 우리가 확인할 수 있는 사유인가(거래 이력 하나뿐이다 · D-24). */
  verifiable: boolean;
  status: string;
  resolutionNote: string | null;
  resolvedAt: string | null;
  createdAt: string;
};

export type ReviewQueue = {
  rows: AdminReviewRow[];
  openReportCount: number;
  /** 몰아쓰기 신호의 상태. **빈 목록과 구분한다**(함정 2 · S8-10 이 세운 규칙). */
  burst:
    | { status: "scanned"; count: number }
    | { status: "blocked"; reason: "threshold_undecided"; openIssue: string };
  threshold: BurstThreshold;
};

type ReviewRow = {
  id: string;
  vendor_id: string;
  couple_id: string;
  status: string;
  retracted_at: string | null;
  score_price: number | null;
  score_response: number | null;
  score_fulfillment: number | null;
  body: string | null;
  disclosed_amount: number | null;
  hidden_reason: string | null;
  hidden_at: string | null;
  vendor_reply: string | null;
  created_at: string;
};

type ReportRow = {
  id: string;
  review_id: string;
  reason_code: ReviewReportReason;
  status: string;
  resolution_note: string | null;
  resolved_at: string | null;
  created_at: string;
};

const ADMIN_COLUMNS =
  "id, vendor_id, couple_id, status, retracted_at, score_price, score_response, score_fulfillment, body, disclosed_amount, hidden_reason, hidden_at, vendor_reply, created_at";

/**
 * 큐를 만든다.
 *
 * **후기 전부를 싣는다** — 신고된 것만 싣지 않는다. F-A-13 은 '검증 상태 확인' 도
 * 요구하고, 무엇보다 **비공개된 후기를 다시 찾을 수 있어야 복구가 가능하다**.
 * 화면이 필터로 좁힌다.
 */
export async function loadReviewQueue(limit = 200): Promise<ReviewQueue> {
  const supabase = await createClient();

  const [{ data: reviewData, error: reviewError }, { data: reportData }] = await Promise.all([
    supabase
      .from("reviews")
      .select(ADMIN_COLUMNS)
      .order("created_at", { ascending: false })
      .limit(limit),
    supabase
      .from("review_reports")
      .select("id, review_id, reason_code, status, resolution_note, resolved_at, created_at")
      .order("created_at", { ascending: false })
      .limit(500),
  ]);

  if (reviewError) throw new Error("REVIEW_QUEUE_FAILED");

  const reviews = (reviewData ?? []) as ReviewRow[];
  const reports = (reportData ?? []) as ReportRow[];

  const vendorNames = await loadVendorNames(reviews.map((row) => row.vendor_id));

  const reportsByReview = new Map<string, AdminReportRow[]>();
  for (const report of reports) {
    const bucket = reportsByReview.get(report.review_id) ?? [];
    bucket.push({
      id: report.id,
      reviewId: report.review_id,
      reason: report.reason_code,
      reasonLabel: REVIEW_REPORT_REASON_LABEL[report.reason_code] ?? report.reason_code,
      verifiable: isVerifiableReason(report.reason_code),
      status: report.status,
      resolutionNote: report.resolution_note,
      resolvedAt: report.resolved_at,
      createdAt: report.created_at,
    });
    reportsByReview.set(report.review_id, bucket);
  }

  const samples: AbuseSample[] = reviews.map((row) => ({
    reviewId: row.id,
    vendorId: row.vendor_id,
    coupleId: row.couple_id,
    createdAt: row.created_at,
    // **본문을 탐지에 넘기지 않는다** — 비었는지만 본다(§7.3).
    hasBody: (row.body ?? "").trim().length > 0,
    scores: [row.score_price, row.score_response, row.score_fulfillment],
    openReportCount: (reportsByReview.get(row.id) ?? []).filter((report) => report.status === "open")
      .length,
  }));

  const threshold = await readBurstThreshold();
  const burstScan = detectBurst(samples, threshold);
  const flags = [
    ...detectDirectSignals(samples),
    ...(burstScan.status === "scanned" ? burstScan.flags : []),
  ];

  const flagsByReview = new Map<string, AbuseFlag[]>();
  for (const flag of flags) {
    const bucket = flagsByReview.get(flag.reviewId) ?? [];
    bucket.push(flag);
    flagsByReview.set(flag.reviewId, bucket);
  }

  return {
    rows: reviews.map((row) => ({
      id: row.id,
      vendorId: row.vendor_id,
      vendorName: vendorNames.get(row.vendor_id) ?? "등록 업체",
      coupleId: row.couple_id,
      status: row.status,
      retractedAt: row.retracted_at,
      scorePrice: row.score_price,
      scoreResponse: row.score_response,
      scoreFulfillment: row.score_fulfillment,
      body: row.body,
      disclosedAmount: row.disclosed_amount,
      hiddenReason: row.hidden_reason,
      hiddenAt: row.hidden_at,
      vendorReply: row.vendor_reply,
      createdAt: row.created_at,
      flags: flagsByReview.get(row.id) ?? [],
      reports: reportsByReview.get(row.id) ?? [],
    })),
    openReportCount: reports.filter((report) => report.status === "open").length,
    burst:
      burstScan.status === "scanned"
        ? { status: "scanned", count: burstScan.flags.length }
        : { status: "blocked", reason: "threshold_undecided", openIssue: REVIEW_ABUSE_OPEN_ISSUE },
    threshold,
  };
}

async function loadVendorNames(ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();

  // **이름 하나 때문에 `vendors` 를 임베드하지 않는다** — 운영자 정책이 없는 표를
  // 조인하면 이름이 조용히 null 이 된다(S8-02 가 `profiles` 에서 물린 함정 1).
  // 업체명은 공개 값이므로 서비스롤로 딱 두 칸만 읽는다.
  const { data } = await createAdminClient().from("vendors").select("id, name").in("id", unique);

  return new Map(((data ?? []) as { id: string; name: string }[]).map((row) => [row.id, row.name]));
}

export type ModerationResult =
  | { ok: true }
  | { ok: false; status: number; code: string; message: string };

/**
 * 비공개·복구 (F-A-13).
 *
 * **되돌릴 때도 사유를 요구한다.** DB CHECK 은 `hidden` 쪽만 강제할 수 있으므로
 * (복구된 행에는 사유 칸이 비어야 한다) **복구 사유는 증적에 남긴다** — 기록에
 * "내렸다(사유 있음) → 올렸다(사유 없음)" 만 남으면 왜 되돌렸는지 답할 수 없다.
 *
 * **거둬진 후기는 조치 대상이 아니다** — 이미 안 보이고, `hidden` 을 덧씌우면
 * 작성자가 거뒀다는 사실이 운영자 조치처럼 읽힌다.
 */
export async function moderateReview(
  input: ReviewModerationInput & { operatorId: string; operatorRole: string | null },
): Promise<ModerationResult> {
  const admin = createAdminClient();

  const { data: review } = await admin
    .from("reviews")
    .select("id, vendor_id, status, retracted_at")
    .eq("id", input.reviewId)
    .maybeSingle();

  if (!review) {
    return { ok: false, status: 404, code: "REVIEW_NOT_FOUND", message: "후기를 찾을 수 없습니다." };
  }

  if (review.retracted_at !== null) {
    return {
      ok: false,
      status: 409,
      code: "REVIEW_RETRACTED",
      message: "작성자가 거둔 후기에는 조치를 적용하지 않습니다.",
    };
  }

  const nextStatus = input.action === "hide" ? "hidden" : "published";
  if (review.status === nextStatus) {
    return {
      ok: false,
      status: 409,
      code: "REVIEW_ALREADY_IN_STATE",
      message: "이미 그 상태입니다.",
    };
  }

  const { error } = await admin
    .from("reviews")
    .update(
      input.action === "hide"
        ? {
            status: "hidden",
            hidden_reason: input.reason,
            hidden_by: input.operatorId,
            hidden_at: new Date().toISOString(),
          }
        : { status: "published", hidden_reason: null, hidden_by: null, hidden_at: null },
    )
    .eq("id", input.reviewId);

  if (error) {
    return {
      ok: false,
      status: 500,
      code: "REVIEW_MODERATION_FAILED",
      message: "조치를 저장하지 못했습니다.",
    };
  }

  await recordEvent({
    entityType: "review",
    entityId: input.reviewId,
    eventType: input.action === "hide" ? "review_hidden" : "review_restored",
    actor: { id: input.operatorId, role: input.operatorRole },
    beforeState: review.status,
    afterState: nextStatus,
    source: "admin",
    // **사유 본문을 담지 않는다**(§7.3). 비공개 사유는 행이 갖고, 복구 사유는
    // `audit_logs.after_json` 이 갖는다 — 증적에는 무엇이 일어났는지만 적는다.
  });

  await writeAuditLog(admin, {
    actorId: input.operatorId,
    actorRole: input.operatorRole,
    action: `review_${input.action}`,
    targetType: "review",
    targetId: input.reviewId,
    before: { status: review.status },
    after: { status: nextStatus, reason: input.reason },
  });

  return { ok: true };
}

/**
 * 신고 처리 (F-A-13).
 *
 * **인정은 후기를 내리는 일과 같은 사건이다**(`hidesReview`). 둘을 따로 두면
 * "신고는 인정했는데 후기는 그대로" 라는 상태가 생기고, 그것은 기록으로 설명할 수
 * 없다. 이미 내려간 후기라면 상태를 다시 쓰지 않는다.
 *
 * **어휘가 '참·거짓' 이 아니다**(D-24) — `upheld` 는 "신고가 사실이다" 가 아니라
 * "이 후기를 비공개로 두기로 했다" 이고, `rejected` 는 "후기가 사실이다" 가 아니라
 * "내릴 근거를 찾지 못했다" 이다. 우리는 판정자가 아니라 조율자다.
 */
export async function resolveReviewReport(
  input: ReviewReportResolveInput & { operatorId: string; operatorRole: string | null },
): Promise<ModerationResult> {
  const admin = createAdminClient();

  const { data: report } = await admin
    .from("review_reports")
    .select("id, review_id, status, reason_code")
    .eq("id", input.reportId)
    .maybeSingle();

  if (!report) {
    return { ok: false, status: 404, code: "REPORT_NOT_FOUND", message: "신고를 찾을 수 없습니다." };
  }

  if (report.status !== "open") {
    return {
      ok: false,
      status: 409,
      code: "REPORT_ALREADY_RESOLVED",
      message: "이미 처리된 신고입니다.",
    };
  }

  if (hidesReview(input.status)) {
    const hidden = await moderateReview({
      reviewId: report.review_id,
      action: "hide",
      reason: input.note,
      operatorId: input.operatorId,
      operatorRole: input.operatorRole,
    });

    // 이미 내려가 있으면(`REVIEW_ALREADY_IN_STATE`) 신고 처리는 그대로 진행한다 —
    // 목적은 상태를 바꾸는 것이 아니라 **신고를 닫는 것**이다. 그 외의 실패는
    // 신고를 닫지 않는다: 후기가 그대로인데 '내렸다' 고 기록되면 안 된다.
    if (!hidden.ok && hidden.code !== "REVIEW_ALREADY_IN_STATE") return hidden;
  }

  const { error } = await admin
    .from("review_reports")
    .update({
      status: input.status,
      resolved_by: input.operatorId,
      resolved_at: new Date().toISOString(),
      resolution_note: input.note,
    })
    .eq("id", input.reportId);

  if (error) {
    return {
      ok: false,
      status: 500,
      code: "REPORT_RESOLVE_FAILED",
      message: "신고 처리를 저장하지 못했습니다.",
    };
  }

  await recordEvent({
    entityType: "review_report",
    entityId: input.reportId,
    eventType: `review_report_${input.status}`,
    actor: { id: input.operatorId, role: input.operatorRole },
    beforeState: "open",
    afterState: input.status,
    source: "admin",
    memo: `reason:${report.reason_code}`,
  });

  await writeAuditLog(admin, {
    actorId: input.operatorId,
    actorRole: input.operatorRole,
    action: `review_report_${input.status}`,
    targetType: "review_report",
    targetId: input.reportId,
    before: { status: "open", reason: report.reason_code },
    after: { status: input.status },
  });

  return { ok: true };
}

/** 운영자 액션은 `audit_logs` 에도 남기고 **근거 이벤트 id 를 함께** 남긴다(§7.2). */
async function writeAuditLog(
  admin: ReturnType<typeof createAdminClient>,
  input: {
    actorId: string;
    actorRole: string | null;
    action: string;
    targetType: string;
    targetId: string;
    before: Record<string, unknown>;
    after: Record<string, unknown>;
  },
): Promise<void> {
  const { data: basisRows } = await admin
    .from("entity_events")
    .select("id")
    .eq("actor_id", input.actorId)
    .order("occurred_at", { ascending: false })
    .limit(5);

  const basis = ((basisRows ?? []) as { id: string }[]).map((row) => row.id);

  await admin.from("audit_logs").insert({
    actor_id: input.actorId,
    actor_role: input.actorRole,
    action: input.action,
    target_type: input.targetType,
    target_id: input.targetId,
    before_json: input.before,
    after_json: input.after,
    // 빈 배열은 CHECK 이 막는다.
    resolution_basis: basis.length > 0 ? basis : null,
  });
}
