// 부당 후기 신고와 처리 (S8-11 · F-V-11 접수 → F-A-13 처리)
//
// **플랫폼은 판정자가 아니라 조율자다**(D-24). 신고를 받아 "이 후기는 거짓이다" 를
// 선언하지 않는다 — 우리가 아는 것은 (가) 거래 이력이 있는가(DB 가 안다) (나) 신고
// 사유가 무엇인가(신고자가 적는다) 뿐이고, 후기에 적힌 일이 실제로 있었는지는 모른다.
//
// 그래서 처리 결과의 어휘를 **'참·거짓' 이 아니라 '내렸다·두었다'** 로 적는다.
// `upheld` 는 "신고가 맞다" 가 아니라 **"이 후기를 비공개로 두기로 했다"** 이고,
// `rejected` 는 "후기가 사실이다" 가 아니라 **"내릴 근거를 찾지 못했다"** 이다.
// 화면 문구도 그 선을 지킨다(§7.7 — 평가적 단정 표현 금지).

import { z } from "zod";

/**
 * 신고 사유. DB `review_reports_reason_vocab` CHECK 이 같은 목록을 강제한다(0058).
 *
 * **커뮤니티 신고(S7-17)의 어휘를 그대로 쓰지 않았다.** 저쪽은 게시물이고 이쪽은
 * 거래 후기라 물어야 할 것이 다르다 — `not_a_customer`("거래한 적이 없다")는
 * 커뮤니티에 없는 사유이고, 검증 후기에서는 이것이 가장 무거운 신고다.
 * 사실이라면 후기의 전제 자체가 무너지며, **그 하나만은 우리가 확인할 수 있다.**
 */
export const REVIEW_REPORT_REASONS = [
  "not_a_customer",
  "false_statement",
  "defamation",
  "privacy",
  "irrelevant",
  "competitor",
] as const;
export type ReviewReportReason = (typeof REVIEW_REPORT_REASONS)[number];

export const REVIEW_REPORT_REASON_LABEL: Record<ReviewReportReason, string> = {
  not_a_customer: "거래 사실이 없습니다",
  false_statement: "사실과 다른 내용이 있습니다",
  defamation: "비방·욕설이 포함돼 있습니다",
  privacy: "개인정보가 노출돼 있습니다",
  irrelevant: "거래와 무관한 내용입니다",
  competitor: "경쟁사의 방해로 의심됩니다",
};

/**
 * 우리가 실제로 확인할 수 있는 사유인가.
 *
 * `not_a_customer` 만 참이다 — 후기는 확정·이행된 예약에만 붙일 수 있고(RLS),
 * 그 예약은 DB 에 있다. 나머지 다섯은 **내용에 대한 주장**이라 우리가 판정할 수단이
 * 없으며, 판정하는 척하면 D-24 를 어긴다. 화면이 이 구분을 그대로 적는다.
 */
export function isVerifiableReason(reason: ReviewReportReason): boolean {
  return reason === "not_a_customer";
}

export const REVIEW_REPORT_STATUSES = ["open", "upheld", "rejected"] as const;
export type ReviewReportStatus = (typeof REVIEW_REPORT_STATUSES)[number];

export const REVIEW_REPORT_STATUS_LABEL: Record<ReviewReportStatus, string> = {
  open: "접수",
  upheld: "후기를 내림",
  rejected: "내리지 않음",
};

/** 접수(F-V-11). `status` 를 받지 않는다 — 컬럼 권한이 이미 막지만 입구도 막는다. */
export const ReviewReportSchema = z.object({
  reviewId: z.string().uuid(),
  reason: z.enum(REVIEW_REPORT_REASONS),
});
export type ReviewReportInput = z.infer<typeof ReviewReportSchema>;

/**
 * 처리(F-A-13). **'내리지 않음' 도 사유를 요구한다.**
 *
 * 신고를 받아들이지 않은 이유를 답할 수 없으면 업체 입장에서 그것은 처리가 아니라
 * 무시다(S8-04 가 삭제 요청 거절에서 정한 것과 같은 규칙). DB CHECK 이 같은 말을
 * 하고 있어 화면·라우트·DB 세 층이 겹친다.
 */
export const ReviewReportResolveSchema = z.object({
  reportId: z.string().uuid(),
  status: z.enum(["upheld", "rejected"]),
  note: z.string().trim().min(1, "처리 사유를 적어 주세요.").max(1_000),
});
export type ReviewReportResolveInput = z.infer<typeof ReviewReportResolveSchema>;

/**
 * `upheld` 는 후기를 내리는 일과 **같은 사건**이다.
 *
 * 둘을 따로 두면 "신고는 인정했는데 후기는 그대로" 라는 상태가 생기고, 그것은
 * 기록으로 설명할 수 없다. 라우트가 이 함수를 물어보고 한 트랜잭션처럼 처리한다.
 */
export function hidesReview(status: ReviewReportStatus): boolean {
  return status === "upheld";
}
