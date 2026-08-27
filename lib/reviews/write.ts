import { recordEvent } from "@/lib/audit/record";
import type { ReviewReportInput } from "@/lib/core/review/report";
import type { ReviewCreateInput, ReviewUpdateInput } from "@/lib/core/review/write";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import { loadReviewFormContext } from "./read";

/**
 * 후기 쓰기 (S8-11 · F-C-17)
 *
 * ══════════════════════════════════════════════════════════════════════════
 * **여기만 서비스롤을 쓰지 않는다.**
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 이 리포의 다른 운영자·업체 경로는 대부분 서비스롤 경유다(D-62). 후기 작성은
 * 반대로 **세션 클라이언트**로 쓴다 — `reviews_insert` 정책이 "확정·이행된 예약이
 * 있는 커플 구성원인가" 를 검사하고, **그 검사가 검증 후기의 전부**이기 때문이다.
 * 서비스롤로 쓰면 그 조건을 앱이 다시 구현해야 하고, 다시 구현한 조건은 언젠가
 * 정책과 갈린다. 갈리는 쪽이 앱이면 **거래하지 않은 업체에 검증 후기가 붙는다.**
 *
 * 수정·철회도 같은 이유로 세션이다. 무엇을 만질 수 있는지는 **컬럼 권한**이 정한다
 * (0058) — `vendor_id`·`booking_id`·`status` 는 목록에 없어 바꿀 수 없다.
 */
export type ReviewWriteResult =
  | { ok: true; reviewId: string }
  | { ok: false; status: number; code: string; message: string };

export async function createReview(
  userId: string,
  input: ReviewCreateInput,
): Promise<ReviewWriteResult> {
  // 폼과 같은 전제를 다시 읽는다 — 화면을 연 뒤 예약이 취소됐을 수 있다.
  // **이것이 경계는 아니다.** 경계는 아래 insert 를 받는 RLS 정책이다.
  const context = await loadReviewFormContext(userId, input.bookingId);

  if (!context.ok) {
    return {
      ok: false,
      status: context.reason === "already_written" ? 409 : 403,
      code: `REVIEW_${context.reason.toUpperCase()}`,
      message: "지금은 후기를 쓸 수 없습니다.",
    };
  }

  const supabase = await createClient();

  const { data, error } = await supabase
    .from("reviews")
    .insert({
      booking_id: context.bookingId,
      couple_id: context.coupleId,
      vendor_id: context.vendorId,
      score_price: input.scorePrice,
      score_response: input.scoreResponse,
      score_fulfillment: input.scoreFulfillment,
      body: input.body,
      disclosed_amount: input.disclosedAmount,
    })
    .select("id")
    .maybeSingle();

  if (error || !data) {
    return {
      ok: false,
      status: 403,
      code: "REVIEW_WRITE_DENIED",
      message: "후기를 저장하지 못했습니다. 계약이 확정된 예약인지 확인해 주세요.",
    };
  }

  await recordEvent({
    entityType: "review",
    entityId: data.id,
    eventType: "review_written",
    actor: { id: userId },
    afterState: "published",
    // **본문도 점수도 담지 않는다**(§7.3). 행이 이미 갖고 있다.
    // 남길 사실은 **금액을 공개했는가** — 나중에 "왜 이 금액이 공개돼 있나" 를 묻는
    // 자리가 실제로 생긴다(F-C-17 의 선택 공개).
    memo: input.disclosedAmount === null ? "amount:private" : "amount:disclosed",
  });

  return { ok: true, reviewId: data.id };
}

export async function updateReview(
  userId: string,
  reviewId: string,
  input: ReviewUpdateInput,
): Promise<ReviewWriteResult> {
  const supabase = await createClient();

  // 정책이 `is_couple_member` · `status='published'` · `retracted_at is null` 을 모두
  // 본다. 조건에 맞지 않으면 0행이 갱신되고 오류는 나지 않는다 — 그래서 반환 행으로
  // 확인한다(조용한 실패를 성공으로 읽지 않는다).
  const { data, error } = await supabase
    .from("reviews")
    .update({
      score_price: input.scorePrice,
      score_response: input.scoreResponse,
      score_fulfillment: input.scoreFulfillment,
      body: input.body,
      disclosed_amount: input.disclosedAmount,
    })
    .eq("id", reviewId)
    .select("id")
    .maybeSingle();

  if (error || !data) {
    return {
      ok: false,
      status: 403,
      code: "REVIEW_UPDATE_DENIED",
      message: "이 후기를 고칠 수 없습니다. 이미 거뒀거나 비공개된 후기일 수 있습니다.",
    };
  }

  await recordEvent({
    entityType: "review",
    entityId: reviewId,
    eventType: "review_edited",
    actor: { id: userId },
    beforeState: "published",
    afterState: "published",
  });

  return { ok: true, reviewId };
}

/**
 * 철회 — **행을 지우지 않는다**(D-23).
 *
 * 업체 답변과 신고가 이 행에 매달려 있고, "무엇에 대한 답변이었나" 를 나중에 답할
 * 수 있어야 한다. 그래서 묘비만 세운다. 되돌릴 수 없다 — 정책의 `using` 이 이미
 * 거둔 행을 대상에서 뺀다(지울 수 있는 묘비는 묘비가 아니다).
 */
export async function retractReview(
  userId: string,
  reviewId: string,
): Promise<ReviewWriteResult> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("reviews")
    .update({ retracted_at: new Date().toISOString(), retracted_by: userId })
    .eq("id", reviewId)
    .select("id")
    .maybeSingle();

  if (error || !data) {
    return {
      ok: false,
      status: 403,
      code: "REVIEW_RETRACT_DENIED",
      message: "이 후기를 거둘 수 없습니다.",
    };
  }

  await recordEvent({
    entityType: "review",
    entityId: reviewId,
    eventType: "review_retracted",
    actor: { id: userId },
    beforeState: "published",
    afterState: "retracted",
  });

  return { ok: true, reviewId };
}

/**
 * 부당 후기 신고 (F-V-11).
 *
 * 세션으로 쓴다 — `review_reports_insert` 가 `reporter_id = auth.uid()` 를 강제하고,
 * **컬럼 권한이 `status`·`resolved_*` 를 아예 못 쓰게 한다**(0058). 그래서 신고자가
 * 자기 신고를 '처리 완료' 로 접수할 수 없다(FIX-36 과 같은 모양이었다).
 *
 * **같은 사람이 같은 후기를 여러 번 신고하는 것을 막지 않는다** — 사유가 여럿일 수
 * 있고, 중복은 큐에서 한 줄로 접힌다. 대신 열린 신고가 이미 있으면 새로 만들지 않는다.
 */
export async function reportReview(
  userId: string,
  input: ReviewReportInput,
): Promise<{ ok: true; duplicated: boolean } | { ok: false; status: number; code: string; message: string }> {
  const supabase = await createClient();

  const { data: existing } = await supabase
    .from("review_reports")
    .select("id")
    .eq("review_id", input.reviewId)
    .eq("reporter_id", userId)
    .eq("reason_code", input.reason)
    .eq("status", "open")
    .maybeSingle();

  if (existing) return { ok: true, duplicated: true };

  const { data, error } = await supabase
    .from("review_reports")
    .insert({
      review_id: input.reviewId,
      reporter_id: userId,
      reason_code: input.reason,
    })
    .select("id")
    .maybeSingle();

  if (error || !data) {
    return {
      ok: false,
      status: 403,
      code: "REVIEW_REPORT_DENIED",
      message: "신고를 접수하지 못했습니다.",
    };
  }

  await recordEvent({
    entityType: "review_report",
    entityId: data.id,
    eventType: "review_reported",
    actor: { id: userId },
    afterState: "open",
    // **사유 코드만** 남긴다. 신고 본문은 애초에 받지 않는다(§7.3).
    memo: `reason:${input.reason}`,
  });

  return { ok: true, duplicated: false };
}

/** 커플이 쓴 후기 목록. `/me` · 예약 목록이 "이미 썼다" 를 보이는 데 쓴다. */
export async function loadMyReviewIndex(
  coupleId: string,
): Promise<Record<string, { id: string; retractedAt: string | null; status: string }>> {
  const admin = createAdminClient();

  const { data } = await admin
    .from("reviews")
    .select("id, booking_id, status, retracted_at")
    .eq("couple_id", coupleId);

  const rows = (data ?? []) as {
    id: string;
    booking_id: string;
    status: string;
    retracted_at: string | null;
  }[];

  return Object.fromEntries(
    rows.map((row) => [row.booking_id, { id: row.id, retractedAt: row.retracted_at, status: row.status }]),
  );
}
