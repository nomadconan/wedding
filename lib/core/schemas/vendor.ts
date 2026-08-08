// 입점 신청·심사 입출력 스키마 (S2-01 · 명세서 §2.2 F-V-01, §2.3 F-A-01, §4.3, §4.4)
//
// API 입출력은 zod 로 양방향 검증한다(CLAUDE.md §6). 검증 실패는 422 다.

import { z } from "zod";

import { isValidBusinessNumber, normalizeBusinessNumber } from "../vendor/business-number";

/** 업체 카테고리. `vendors.category`(text)에 그대로 들어가는 코드값이다. */
export const VENDOR_CATEGORIES = [
  "hall",
  "studio",
  "dress",
  "makeup",
  "video",
  "agency",
] as const;

export type VendorCategory = (typeof VENDOR_CATEGORIES)[number];

export const VendorCategorySchema = z.enum(VENDOR_CATEGORIES);

export const VENDOR_CATEGORY_LABEL: Record<VendorCategory, string> = {
  hall: "웨딩홀",
  studio: "스튜디오",
  dress: "드레스",
  makeup: "헤어·메이크업",
  video: "영상",
  agency: "웨딩 에이전시",
};

/** 심사 서류 종류(F-V-01). 사업자등록증은 필수, 나머지는 선택이다. */
export const VENDOR_DOC_TYPES = ["business_license", "mail_order_cert", "etc"] as const;
export type VendorDocType = (typeof VENDOR_DOC_TYPES)[number];
export const VendorDocTypeSchema = z.enum(VENDOR_DOC_TYPES);

export const VENDOR_DOC_TYPE_LABEL: Record<VendorDocType, string> = {
  business_license: "사업자등록증",
  mail_order_cert: "통신판매업 신고증",
  etc: "기타 증빙",
};

const PhoneSchema = z
  .string()
  .trim()
  .min(9, "연락처를 정확히 입력해 주세요.")
  .max(20)
  .refine((value) => /^[0-9-+\s()]+$/.test(value), {
    message: "연락처에는 숫자와 -, +, 공백만 넣을 수 있습니다.",
  });

/** 입점 신청 입력(POST /api/vendor/apply). */
export const VendorApplicationInputSchema = z.object({
  name: z.string().trim().min(2, "업체명을 2자 이상 입력해 주세요.").max(100),
  category: VendorCategorySchema,
  regionCode: z.string().trim().min(2, "지역을 선택해 주세요.").max(40),
  /** 사업자등록번호. 체크섬까지 검증한다 — 오타가 심사 큐로 흘러가지 않게 한다. */
  businessNumber: z
    .string()
    .trim()
    .transform(normalizeBusinessNumber)
    .refine(isValidBusinessNumber, {
      message: "사업자등록번호가 올바르지 않습니다. 10자리 숫자를 확인해 주세요.",
    }),
  /** 통신판매업 신고번호. 미신고 업체가 있어 필수로 두지 않는다. */
  mailOrderNumber: z.string().trim().max(60).optional().or(z.literal("")),
  representativeName: z.string().trim().min(1, "대표자명을 입력해 주세요.").max(50),
  contactPhone: PhoneSchema,
  /** 업로드할 서류 목록. 파일 자체가 아니라 **서명 URL 발급 요청**이다. */
  documents: z
    .array(
      z.object({
        docType: VendorDocTypeSchema,
        fileName: z.string().trim().min(1).max(200),
      }),
    )
    .max(10, "서류는 한 번에 10개까지 올릴 수 있습니다.")
    .default([]),
});

export type VendorApplicationInput = z.input<typeof VendorApplicationInputSchema>;

/** 심사 액션(PATCH /api/admin/vendors/[id]/review). */
export const VENDOR_REVIEW_ACTIONS = ["approve", "request_revision", "reject"] as const;
export type VendorReviewAction = (typeof VENDOR_REVIEW_ACTIONS)[number];

/**
 * 반려·보완요청은 **사유가 필수**다(F-A-01 "승인·반려 사유 기록").
 * DB CHECK 제약과 같은 규칙을 API 경계에서도 건다 — 사유 없는 반려는 422 로 막힌다.
 */
export const VendorReviewInputSchema = z
  .object({
    action: z.enum(VENDOR_REVIEW_ACTIONS),
    note: z.string().trim().max(1000).optional(),
    /** 서류로 사업자 상태를 수동 확인했는지(국세청 API 연동 전까지의 대체 수단). */
    businessNumberVerified: z.boolean().default(false),
  })
  .refine(
    (input) => input.action === "approve" || (input.note !== undefined && input.note.length > 0),
    { message: "반려·보완 요청에는 사유를 반드시 적어야 합니다.", path: ["note"] },
  );

export type VendorReviewInput = z.input<typeof VendorReviewInputSchema>;

/** 신청서 상태. DB 열거 `vendor_application_status` 와 값이 같다. */
export const VENDOR_APPLICATION_STATUSES = [
  "submitted",
  "revision_requested",
  "approved",
  "rejected",
] as const;

export type VendorApplicationStatus = (typeof VENDOR_APPLICATION_STATUSES)[number];

export const VENDOR_APPLICATION_STATUS_LABEL: Record<VendorApplicationStatus, string> = {
  submitted: "심사 중",
  revision_requested: "보완 요청",
  approved: "승인",
  rejected: "반려",
};
