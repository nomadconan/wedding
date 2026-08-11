import { z } from "zod";

import {
  CONFIRM_CHOICES,
  CONSULTATION_TYPES,
} from "../consultation/consultation";

/**
 * 상담·탐방 API 입출력 스키마 (S4-07 · 명세서 §4.2 `/api/consultations`,
 * §4.3 `/api/vendor/consultations`·`/api/vendor/availability`)
 *
 * CLAUDE.md §6: 입출력은 zod 로 양방향 검증하고 실패는 **422** 다.
 *
 * ── 이 파일에 **없는 것** ───────────────────────────────────────────────────
 * 어느 입력에도 **보증금 금액·상태**가 없다. 금액은 `app_settings` 가 갖고 상태는
 * 서버가 §3.11 규칙으로 정한다(§3.9: "상태 변경은 서비스롤 전용"). 당사자가 보낼 수
 * 있는 것은 **무엇을 신청할지**와 **무엇을 확인했는지**뿐이다.
 *
 * `outcome` 도 없다 — 그것은 양측 주장을 대조한 **결론**이지 주장이 아니다.
 */

const uuid = z.string().uuid();

// =============================================================================
// 소비자 (/api/consultations)
// =============================================================================

/**
 * 예약 신청.
 *
 * **커플 id 를 받지 않는다** — 세션에서 찾는다(장바구니·채팅·문의와 같은 규칙).
 * **`duration_minutes` 도 받지 않는다** — 업체가 등록한 슬롯 길이를 서버가 가져와
 * 박는다. 클라이언트가 정하면 30분 슬롯을 5분으로 신청해 자리를 쪼갤 수 있다.
 */
export const CreateConsultationSchema = z.object({
  action: z.literal("create"),
  vendorId: uuid,
  type: z.enum(CONSULTATION_TYPES),
  /** 업체 가능 시간대에서 고른 슬롯의 시작. 서버가 그 슬롯이 실재하는지 다시 본다. */
  scheduledAt: z.string().datetime({ offset: true }),
  /** 방문·탐방의 만날 장소 메모. 자유 텍스트지만 금액·항목이 아니다. */
  location: z.string().max(200).nullable().default(null),
});

export type CreateConsultationInput = z.infer<typeof CreateConsultationSchema>;

/** 고객 취소. 무료 여부는 **서버가 규칙으로 판정한다** — 클라이언트가 주장하지 않는다. */
export const CancelConsultationSchema = z.object({
  action: z.literal("cancel"),
  consultationId: uuid,
  reason: z.string().max(300).nullable().default(null),
});

/**
 * 보증금 결제.
 *
 * `idempotencyKey` 를 **클라이언트가 만들어 보낸다**(CLAUDE.md §6 — 결제는
 * Idempotency-Key 필수). 같은 열쇠로 두 번 오면 서버가 앞의 결과를 그대로 돌려준다.
 */
export const PayDepositSchema = z.object({
  action: z.literal("pay_deposit"),
  consultationId: uuid,
  idempotencyKey: z.string().min(8).max(200),
});

export const ConsultationActionSchema = z.discriminatedUnion("action", [
  CreateConsultationSchema,
  CancelConsultationSchema,
  PayDepositSchema,
]);

export type ConsultationAction = z.infer<typeof ConsultationActionSchema>;

// =============================================================================
// 이행 확인 (POST /api/consultations/[id]/confirm — 양측이 각각 부른다)
// =============================================================================

/**
 * §4.2: "이행 확인 — 고객·업체 **양측이 각각 호출**한다".
 *
 * **어느 편인지를 입력으로 받지 않는다.** 서버가 세션으로 판정한다 — 받으면 고객이
 * 업체 칸에 답하는 요청을 보낼 수 있고, DB 트리거가 막더라도 그런 모양의 API 를
 * 두지 않는다.
 */
export const ConfirmConsultationSchema = z.object({
  outcome: z.enum(CONFIRM_CHOICES as unknown as [string, ...string[]]),
});

export type ConfirmConsultationInput = z.infer<typeof ConfirmConsultationSchema>;

// =============================================================================
// 업체 (/api/vendor/consultations)
// =============================================================================

export const ApproveConsultationSchema = z.object({
  action: z.literal("approve"),
  consultationId: uuid,
});

/** 거절에는 사유가 있다. 사유 없는 거절은 고객에게 아무것도 알려 주지 못한다. */
export const RejectConsultationSchema = z.object({
  action: z.literal("reject"),
  consultationId: uuid,
  reason: z.string().min(2).max(300),
});

/**
 * 노쇼 신고(F-V-17).
 *
 * **별도 동작을 만들지 않고 이행 확인과 같은 경로를 쓴다.** "신고" 를 따로 두면
 * 업체의 일방 주장이 확인 절차를 건너뛰는 길이 생긴다 — §3.11 은 양측 대조를
 * 요구하고, 노쇼 신고는 그 대조에서 업체가 내는 **한쪽 답**일 뿐이다.
 * 그래서 업체의 노쇼 신고 = `confirm` 에 `no_show_couple` 을 내는 것이다.
 */
export const VendorConfirmSchema = z.object({
  action: z.literal("confirm"),
  consultationId: uuid,
  outcome: z.enum(CONFIRM_CHOICES as unknown as [string, ...string[]]),
});

export const VendorConsultationActionSchema = z.discriminatedUnion("action", [
  ApproveConsultationSchema,
  RejectConsultationSchema,
  VendorConfirmSchema,
]);

export type VendorConsultationAction = z.infer<typeof VendorConsultationActionSchema>;

// =============================================================================
// 가능 시간대 (CRUD /api/vendor/availability — F-V-17 · S4-06)
// =============================================================================

const TimeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, "시각은 HH:MM 형식으로 입력해 주세요.");

export const CreateAvailabilitySchema = z.object({
  action: z.literal("create"),
  /** 0=일요일 … 6=토요일. 0007 이 `extract(dow from date)` 와 같은 규약으로 정했다. */
  weekday: z.number().int().min(0).max(6),
  startTime: TimeSchema,
  endTime: TimeSchema,
  slotMinutes: z.number().int().min(5).max(1440),
});

export const DeleteAvailabilitySchema = z.object({
  action: z.literal("delete"),
  id: uuid,
});

export const AvailabilityActionSchema = z.discriminatedUnion("action", [
  CreateAvailabilitySchema,
  DeleteAvailabilitySchema,
]);

export type AvailabilityAction = z.infer<typeof AvailabilityActionSchema>;

// =============================================================================
// 응답 모양
// =============================================================================

export const ConsultationViewSchema = z.object({
  id: uuid,
  coupleId: uuid,
  vendorId: uuid,
  vendorName: z.string(),
  plannerId: uuid.nullable(),
  type: z.enum(CONSULTATION_TYPES),
  scheduledAt: z.string(),
  durationMinutes: z.number().int(),
  status: z.string(),
  location: z.string().nullable(),
  rejectReason: z.string().nullable(),
  cancelReason: z.string().nullable(),
  confirmDueAt: z.string().nullable(),
  coupleOutcome: z.string().nullable(),
  vendorOutcome: z.string().nullable(),
  outcome: z.string().nullable(),
  /** 보증금. 대상이 아니거나 아직 결제 전이면 null. */
  deposit: z
    .object({
      id: uuid,
      amount: z.number().int(),
      status: z.string(),
      resolutionReason: z.string().nullable(),
    })
    .nullable(),
  createdAt: z.string(),
});

export type ConsultationView = z.infer<typeof ConsultationViewSchema>;
