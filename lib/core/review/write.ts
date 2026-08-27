// 후기 작성·수정·철회 / 업체 답변 / 운영자 조치의 입력 규약 (S8-11)
//
// **자격은 여기서 정하지 않는다.** "이 사람이 이 업체에 후기를 쓸 수 있는가" 의
// 최종 경계는 `reviews_insert` RLS 정책이다 — 확정·이행된 예약이 있어야 통과한다
// (CLAUDE.md §5.5). 이 파일이 하는 일은 **입력의 모양**을 정하는 것과, 화면이
// 자격 없는 사람에게 폼을 그리지 않도록 **같은 조건을 미리 읽어 주는 것**이다.
// 둘의 답이 갈리면 RLS 가 이긴다.

import { z } from "zod";

import { RATING_MAX, RATING_MIN } from "./rating";

/**
 * 후기를 쓸 수 있는 예약 상태.
 *
 * `reviews_insert` 정책이 쓰는 목록과 **같아야 한다**(0005). 두 곳에 적혀 있으므로
 * 갈릴 수 있고, 갈리면 화면은 폼을 열어 주는데 저장이 거절되는 모양이 된다.
 * `db:rls` 가 이 목록과 정책을 대조한다(S7-01 이 검출 룰에서 세운 방식과 같다).
 */
export const REVIEWABLE_BOOKING_STATUSES = ["confirmed", "fulfilled"] as const;

export function bookingReviewable(status: string): boolean {
  return (REVIEWABLE_BOOKING_STATUSES as readonly string[]).includes(status);
}

/** 폼을 열 수 없는 이유. **"쓸 수 없다" 만 말하고 끝내지 않는다.** */
export const REVIEW_BLOCK_REASONS = [
  "not_a_member",
  "booking_not_reviewable",
  "already_written",
] as const;
export type ReviewBlockReason = (typeof REVIEW_BLOCK_REASONS)[number];

export const REVIEW_BLOCK_MESSAGE: Record<ReviewBlockReason, string> = {
  not_a_member: "이 예약의 커플 구성원만 후기를 쓸 수 있습니다.",
  booking_not_reviewable: "계약이 확정된 예약에만 후기를 쓸 수 있습니다.",
  already_written: "이 예약에는 이미 후기를 쓰셨습니다. 기존 후기를 고쳐 주세요.",
};

const score = z
  .number()
  .int()
  .min(RATING_MIN)
  .max(RATING_MAX)
  .nullable();

/**
 * 작성·수정 공통 입력.
 *
 * **점수를 필수로 두지 않았다.** 세 축 모두 선택 입력이고 DB 도 nullable 이다 —
 * 응대만 겪고 이행은 아직 안 본 시점이 실제로 있다. 대신 **아무것도 남기지 않은
 * 후기는 막는다**(아래 refine): 점수도 본문도 없는 행은 평점에도 안 잡히고 읽을
 * 것도 없어 업체 목록의 건수만 부풀린다.
 *
 * **`disclosed_amount` 는 선택 공개다**(F-C-17). 값이 있으면 공개하겠다는 뜻이고,
 * `null` 은 "적지 않았다" 다. 0원을 넣어 "공개했는데 0원" 을 만들지 않는다.
 */
const reviewBody = {
  scorePrice: score,
  scoreResponse: score,
  scoreFulfillment: score,
  body: z.string().trim().max(2_000).nullable(),
  disclosedAmount: z.number().int().positive().nullable(),
};

function hasSomething(value: {
  scorePrice: number | null;
  scoreResponse: number | null;
  scoreFulfillment: number | null;
  body: string | null;
}): boolean {
  return (
    value.scorePrice !== null ||
    value.scoreResponse !== null ||
    value.scoreFulfillment !== null ||
    (value.body !== null && value.body.length > 0)
  );
}

const EMPTY_MESSAGE = "점수나 후기 내용 중 하나는 남겨 주세요.";

export const ReviewCreateSchema = z
  .object({ bookingId: z.string().uuid(), ...reviewBody })
  .refine(hasSomething, { message: EMPTY_MESSAGE, path: ["body"] });
export type ReviewCreateInput = z.infer<typeof ReviewCreateSchema>;

export const ReviewUpdateSchema = z
  .object(reviewBody)
  .refine(hasSomething, { message: EMPTY_MESSAGE, path: ["body"] });
export type ReviewUpdateInput = z.infer<typeof ReviewUpdateSchema>;

/**
 * 업체 답변 (F-V-11).
 *
 * **빈 답변을 저장하지 않는다** — DB CHECK 이 같은 말을 한다(0058). 답변을 지우는
 * 경로를 두지 않았다: 답변은 공개된 말이고, 지울 수 있으면 후기 옆의 대화가
 * 한쪽만 남는다(D-23 과 같은 결). 고칠 수는 있다.
 */
export const VendorReplySchema = z.object({
  reviewId: z.string().uuid(),
  reply: z.string().trim().min(1, "답변 내용을 적어 주세요.").max(2_000),
});
export type VendorReplyInput = z.infer<typeof VendorReplySchema>;

/**
 * 운영자 조치 (F-A-13).
 *
 * **복구에도 사유를 요구한다.** 내릴 때만 사유를 묻고 되돌릴 때는 묻지 않으면,
 * 기록에는 "내렸다(사유 있음) → 올렸다(사유 없음)" 만 남아 왜 되돌렸는지 답할 수
 * 없다. DB CHECK 은 `hidden` 쪽만 강제할 수 있으므로(복구된 행에는 사유 칸이
 * 비어야 한다) **복구 사유는 증적으로 남긴다.**
 */
export const REVIEW_MODERATION_ACTIONS = ["hide", "restore"] as const;
export type ReviewModerationAction = (typeof REVIEW_MODERATION_ACTIONS)[number];

export const ReviewModerationSchema = z.object({
  reviewId: z.string().uuid(),
  action: z.enum(REVIEW_MODERATION_ACTIONS),
  reason: z.string().trim().min(1, "사유를 적어 주세요.").max(1_000),
});
export type ReviewModerationInput = z.infer<typeof ReviewModerationSchema>;

/** 지금 공개 중인가. 화면·API·큐가 **이 한 함수**로 판단한다. */
export function isVisible(review: { status: string; retracted_at: string | null }): boolean {
  return review.status === "published" && review.retracted_at === null;
}
