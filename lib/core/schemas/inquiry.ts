import { z } from "zod";

import { DECLINE_REASONS, INQUIRY_NOTE_MAX } from "../inquiry/inquiry";

/**
 * 문의·견적 API 입출력 스키마 (S4-12 · 명세서 §4.2 `/api/inquiries`, §4.3 `/api/vendor/quotes`)
 *
 * CLAUDE.md §6: 입출력은 zod 로 양방향 검증하고 실패는 **422** 다.
 *
 * ── 이 파일에 **없는 것**이 요점이다 ────────────────────────────────────────
 * 견적 입력에 **항목 이름(label)·분류(category_code)·상한(capAmount) 필드가 없다.**
 * 이름과 분류는 DB 트리거가 참조된 상품·추가금에서 덮어쓰고(0024), 상한은 서버가
 * `price_rules` 를 평가해 계산한다. 클라이언트가 보낼 수 있는 것은 **무엇을 고를지와
 * 얼마를 깎을지**뿐이다 — 그것이 "표준 견적서 폼으로만 응답"(F-V-07)의 실질이다.
 */

const uuid = z.string().uuid();
const DateStringSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "날짜는 YYYY-MM-DD 형식으로 입력해 주세요.");

// =============================================================================
// 문의 생성 (POST /api/inquiries)
// =============================================================================

/**
 * 표준 요청 폼.
 *
 * **커플 id 를 받지 않는다** — 서버가 세션에서 찾는다(장바구니·채팅과 같은 규칙).
 * **상한 개수를 스키마에 박지 않는다** — `app_settings.inquiry.max_targets` 가 갖는
 * 값이라 런타임에 검사한다. 여기 `.max(50)` 은 스키마 상한이 아니라 **폭주 방지**다.
 */
export const CreateInquirySchema = z.object({
  // 판별 유니온의 판별자라 **기본값을 줄 수 없다** — 판별은 파싱 전에 일어나므로
  // `.default()` 가 적용될 자리가 없다. 클라이언트가 명시해 보낸다.
  action: z.literal("create"),
  vendorIds: z.array(uuid).min(1).max(50),
  eventDate: DateStringSchema,
  guestCount: z.number().int().min(0).max(100_000).nullable().default(null),
  regionCode: z.string().max(60).nullable().default(null),
  budgetTotal: z.number().int().min(0).nullable().default(null),
  categories: z.array(z.string().max(40)).min(1).max(20),
  note: z.string().max(INQUIRY_NOTE_MAX).nullable().default(null),
  /** 표준 폼의 나머지(필수 옵션 선택 등). 날짜·하객수는 여기 두지 않는다. */
  requestJson: z.record(z.unknown()).default({}),
});

export type CreateInquiryInput = z.infer<typeof CreateInquirySchema>;

/** 문의 거두기·마감. 고객만 한다. */
export const CloseInquirySchema = z.object({
  action: z.literal("close"),
  inquiryId: uuid,
});

/** 받은 견적에 답하기. 계약 전환은 5단계라 여기서는 상태만 바꾼다. */
export const DecideQuoteSchema = z.object({
  action: z.literal("decide_quote"),
  quoteId: uuid,
  decision: z.enum(["accepted", "declined"]),
});

export const InquiryActionSchema = z.discriminatedUnion("action", [
  CreateInquirySchema,
  CloseInquirySchema,
  DecideQuoteSchema,
]);

export type InquiryAction = z.infer<typeof InquiryActionSchema>;

// =============================================================================
// 견적 응답 (POST /api/vendor/quotes)
// =============================================================================

/**
 * 견적 한 줄.
 *
 * 고를 수 있는 것은 **어떤 옵션인지**와 **얼마를 제시할지**뿐이다.
 * `amount` 를 생략하면 상한 그대로(할인 없음)로 본다.
 */
export const QuoteLineInputSchema = z.object({
  itemType: z.enum(["base", "option"]),
  /** 옵션 줄에만 있다. 본체 줄의 상품은 견적의 `productId` 가 정한다. */
  productOptionId: uuid.nullable().default(null),
  /** 업체가 제시하는 금액(원, 정수). 생략하면 상한 그대로. */
  amount: z.number().int().min(0).nullable().default(null),
});

export const CreateQuoteSchema = z.object({
  action: z.literal("send"),
  inquiryTargetId: uuid,
  /** 어느 상품에 대한 견적인가. **필수다** — 등록되지 않은 것에는 견적을 낼 수 없다. */
  productId: uuid,
  lines: z.array(QuoteLineInputSchema).min(1).max(50),
  /** 유효기간. 생략하면 서버가 기본값을 넣지 않고 무기한으로 둔다. */
  validUntil: z.string().datetime({ offset: true }).nullable().default(null),
  /** **견적서에서 자유 텍스트가 허용되는 유일한 자리.** 항목·금액에는 쓸 수 없다. */
  vendorMemo: z.string().max(1000).nullable().default(null),
});

export type CreateQuoteInput = z.infer<typeof CreateQuoteSchema>;

/** 거절. 사유는 **코드**다 — 자유 텍스트로 두면 비교가 안 되고 남을 깎아내릴 자리가 된다. */
export const DeclineInquirySchema = z.object({
  action: z.literal("decline"),
  inquiryTargetId: uuid,
  reasonCode: z.enum(
    DECLINE_REASONS.map((reason) => reason.code) as [string, ...string[]],
  ),
});

/** 업체가 문의를 열어 본 사실. "못 봤다" 와 "보고도 안 답했다" 를 가른다(D-23). */
export const ViewInquirySchema = z.object({
  action: z.literal("view"),
  inquiryTargetId: uuid,
});

/** 보낸 견적 회수. 본문을 바꾸는 입력이 없다는 것이 요점이다 — 견적은 수정하지 않는다. */
export const WithdrawQuoteSchema = z.object({
  action: z.literal("withdraw"),
  quoteId: uuid,
});

export const VendorQuoteActionSchema = z.discriminatedUnion("action", [
  CreateQuoteSchema,
  DeclineInquirySchema,
  ViewInquirySchema,
  WithdrawQuoteSchema,
]);

export type VendorQuoteAction = z.infer<typeof VendorQuoteActionSchema>;

// =============================================================================
// 응답 모양
// =============================================================================

export const QuoteItemViewSchema = z.object({
  id: uuid,
  itemType: z.enum(["base", "option"]),
  label: z.string(),
  categoryCode: z.string(),
  amount: z.number().int(),
  capAmount: z.number().int(),
  discountAmount: z.number().int(),
  isOption: z.boolean(),
  isMandatory: z.boolean(),
});

export type QuoteItemView = z.infer<typeof QuoteItemViewSchema>;

export const QuoteViewSchema = z.object({
  id: uuid,
  inquiryTargetId: uuid,
  productId: uuid,
  productName: z.string().nullable(),
  status: z.string(),
  totalAmount: z.number().int(),
  capTotal: z.number().int(),
  discountTotal: z.number().int(),
  basePriceSnapshot: z.number().int(),
  validUntil: z.string().nullable(),
  vendorMemo: z.string().nullable(),
  sentAt: z.string().nullable(),
  items: z.array(QuoteItemViewSchema),
  /** 가격 재현에 필요한 사실들. 화면이 "왜 이 상한인가" 를 설명한다. */
  pricingContext: z.record(z.unknown()),
  pricingSteps: z.array(z.record(z.unknown())),
});

export type QuoteView = z.infer<typeof QuoteViewSchema>;
