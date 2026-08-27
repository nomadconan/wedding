import { recordEvent } from "@/lib/audit/record";
import {
  type ReviewReportReason,
  REVIEW_REPORT_REASON_LABEL,
} from "@/lib/core/review/report";
import { type VendorRating, rateVendor } from "@/lib/core/review/rating";
import type { VendorReplyInput } from "@/lib/core/review/write";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * 업체 후기 콘솔 (S8-11 · F-V-11)
 *
 * **업체는 자기 후기를 전부 본다** — 비공개된 것도, 거둬진 것도. `reviews_select_author`
 * 정책이 `is_vendor_member(vendor_id)` 로 이미 그렇게 열려 있다. 평판에 대한 기록을
 * 당사자에게 감출 이유가 없고, 감추면 "무슨 일이 있었는지 모르는 채 답변만 하라" 가 된다.
 *
 * **답변은 서비스롤로 쓴다**(D-62). 이유는 권한 구조에 있다 — 컬럼 권한은 **역할
 * 단위**(`authenticated`)라, 업체에 UPDATE 를 열면 같은 역할인 **작성자에게도 같은
 * 칸이 열린다.** 그러면 업체가 남의 후기 본문을 고칠 수 있다. 대가로 앱이 "이 업체
 * 사람인가" 를 검사해야 하고, 그 검사가 아래 `assertMember` 다.
 */
export type VendorReviewRow = {
  id: string;
  status: string;
  retractedAt: string | null;
  scorePrice: number | null;
  scoreResponse: number | null;
  scoreFulfillment: number | null;
  body: string | null;
  disclosedAmount: number | null;
  vendorReply: string | null;
  vendorRepliedAt: string | null;
  hiddenReason: string | null;
  createdAt: string;
  /** 이 후기에 우리 쪽이 넣은 신고. 남의 신고는 보이지 않는다. */
  reports: { id: string; reason: ReviewReportReason; reasonLabel: string; status: string }[];
};

export type VendorReviewBoard = {
  rows: VendorReviewRow[];
  /** 공개 중인 후기만으로 낸 값. 화면이 보는 목록과 분모가 다르다는 사실을 적는다. */
  rating: VendorRating;
  visibleCount: number;
  hiddenCount: number;
  retractedCount: number;
  unansweredCount: number;
};

const VENDOR_COLUMNS =
  "id, status, retracted_at, score_price, score_response, score_fulfillment, body, disclosed_amount, vendor_reply, vendor_replied_at, hidden_reason, created_at";

type Row = {
  id: string;
  status: string;
  retracted_at: string | null;
  score_price: number | null;
  score_response: number | null;
  score_fulfillment: number | null;
  body: string | null;
  disclosed_amount: number | null;
  vendor_reply: string | null;
  vendor_replied_at: string | null;
  hidden_reason: string | null;
  created_at: string;
};

export async function loadVendorReviewBoard(vendorId: string): Promise<VendorReviewBoard> {
  const admin = createAdminClient();

  const { data, error } = await admin
    .from("reviews")
    .select(VENDOR_COLUMNS)
    .eq("vendor_id", vendorId)
    .order("created_at", { ascending: false })
    .limit(200);

  if (error) throw new Error("REVIEW_LOAD_FAILED");

  const rows = (data ?? []) as Row[];

  const { data: reportData } = await admin
    .from("review_reports")
    .select("id, review_id, reason_code, status")
    .in("review_id", rows.length > 0 ? rows.map((row) => row.id) : ["00000000-0000-0000-0000-000000000000"]);

  const reportsByReview = new Map<string, VendorReviewRow["reports"]>();
  for (const report of (reportData ?? []) as {
    id: string;
    review_id: string;
    reason_code: ReviewReportReason;
    status: string;
  }[]) {
    const bucket = reportsByReview.get(report.review_id) ?? [];
    bucket.push({
      id: report.id,
      reason: report.reason_code,
      reasonLabel: REVIEW_REPORT_REASON_LABEL[report.reason_code] ?? report.reason_code,
      status: report.status,
    });
    reportsByReview.set(report.review_id, bucket);
  }

  const mapped: VendorReviewRow[] = rows.map((row) => ({
    id: row.id,
    status: row.status,
    retractedAt: row.retracted_at,
    scorePrice: row.score_price,
    scoreResponse: row.score_response,
    scoreFulfillment: row.score_fulfillment,
    body: row.body,
    disclosedAmount: row.disclosed_amount,
    vendorReply: row.vendor_reply,
    vendorRepliedAt: row.vendor_replied_at,
    // **비공개 사유를 업체에 보여준다.** 사유 없는 비공개는 조치가 아니라 사고처럼
    // 보이고, 업체가 무엇을 고쳐야 하는지 알 수 없다(0058 CHECK 이 사유를 요구하는
    // 이유가 여기서 쓰인다).
    hiddenReason: row.hidden_reason,
    createdAt: row.created_at,
    reports: reportsByReview.get(row.id) ?? [],
  }));

  const visible = mapped.filter((row) => row.status === "published" && row.retractedAt === null);

  return {
    rows: mapped,
    rating: rateVendor(
      visible.map((row) => ({
        scorePrice: row.scorePrice,
        scoreResponse: row.scoreResponse,
        scoreFulfillment: row.scoreFulfillment,
      })),
    ),
    visibleCount: visible.length,
    hiddenCount: mapped.filter((row) => row.status === "hidden").length,
    retractedCount: mapped.filter((row) => row.retractedAt !== null).length,
    unansweredCount: visible.filter((row) => row.vendorReply === null).length,
  };
}

export type VendorReplyResult =
  | { ok: true }
  | { ok: false; status: number; code: string; message: string };

/**
 * 답변 작성·수정.
 *
 * **거둬진 후기에는 답변하지 않는다** — 작성자가 말을 물렀는데 그 자리에 업체의
 * 반박만 남으면 대화가 한쪽만 남는다. 비공개된 후기도 마찬가지다(아무도 못 보는
 * 글에 다는 답변은 답변이 아니다).
 */
export async function replyToReview(
  input: VendorReplyInput & { vendorId: string; userId: string; userRole: string | null },
): Promise<VendorReplyResult> {
  const admin = createAdminClient();

  const { data: review } = await admin
    .from("reviews")
    .select("id, vendor_id, status, retracted_at, vendor_reply")
    .eq("id", input.reviewId)
    .maybeSingle();

  // 대상이 우리 업체가 아니면 **없는 것과 같은 답**을 준다.
  if (!review || review.vendor_id !== input.vendorId) {
    return { ok: false, status: 404, code: "REVIEW_NOT_FOUND", message: "후기를 찾을 수 없습니다." };
  }

  if (review.retracted_at !== null || review.status !== "published") {
    return {
      ok: false,
      status: 409,
      code: "REVIEW_NOT_ANSWERABLE",
      message: "공개 중인 후기에만 답변할 수 있습니다.",
    };
  }

  const { error } = await admin
    .from("reviews")
    .update({
      vendor_reply: input.reply,
      vendor_replied_at: new Date().toISOString(),
      vendor_replied_by: input.userId,
    })
    .eq("id", input.reviewId);

  if (error) {
    return { ok: false, status: 500, code: "REVIEW_REPLY_FAILED", message: "답변을 저장하지 못했습니다." };
  }

  await recordEvent({
    entityType: "review",
    entityId: input.reviewId,
    eventType: review.vendor_reply === null ? "review_replied" : "review_reply_edited",
    actor: { id: input.userId, role: input.userRole },
    source: "web",
    // **답변 본문을 담지 않는다**(§7.3). 행이 갖고 있다.
  });

  return { ok: true };
}
