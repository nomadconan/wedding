import { z } from "zod";

import { NOTIFICATION_CHANNELS } from "./notification";
import { RECIPIENT_MODES, TEMPLATE_KINDS } from "../vendor/vendor-settings";
import { VENDOR_MEMBER_ROLES } from "./vendor-member";

/**
 * 업체 설정·초대 API 스키마 (S4-14 · S2-09 · 명세서 §4.3)
 *
 * CLAUDE.md §6: 입출력은 zod 로 양방향 검증하고 실패는 **422** 다.
 *
 * ── 이 파일에 **없는 것** ───────────────────────────────────────────────────
 * 어느 입력에도 **`vendor_id` 가 없다** — 세션에서 찾는다(장바구니·채팅·문의·상담과
 * 같은 규칙). 초대에도 **토큰을 클라이언트가 만들지 않는다** — 서버가 만든다.
 */

const uuid = z.string().uuid();
const TimeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "시각은 HH:MM 형식으로 입력해 주세요.");

// =============================================================================
// 조직 설정 (PUT /api/vendor/settings)
// =============================================================================

export const BusinessHourSchema = z.object({
  weekday: z.number().int().min(0).max(6),
  start: TimeSchema,
  end: TimeSchema,
});

export const UpdateVendorSettingsSchema = z.object({
  action: z.literal("update_settings"),
  recipientMode: z.enum(RECIPIENT_MODES).optional(),
  /** null 로 보내면 배정 해제. 그 업체 멤버인지는 **DB 트리거**가 판정한다(0026). */
  defaultAssigneeId: uuid.nullable().optional(),
  businessHours: z.array(BusinessHourSchema).max(50).optional(),
  deferOffhours: z.boolean().optional(),
});

/** 조직 단위 채널 설정. 개인 설정(`/api/notifications`)과 **다른 층**이다. */
export const UpdateVendorChannelSchema = z.object({
  action: z.literal("update_channel"),
  topic: z.string().min(1).max(40),
  channel: z.enum(NOTIFICATION_CHANNELS),
  enabled: z.boolean(),
});

// =============================================================================
// 템플릿 (S4-04 · S4-12 이월)
// =============================================================================

/** 빠른 답변 — 문장 하나. */
export const QuickReplyPayloadSchema = z.object({
  body: z.string().trim().min(2).max(1000),
});

/**
 * 견적 템플릿 — 상품·옵션 구성.
 *
 * **금액 상한을 담지 않는다.** 상한은 보낼 때 `price_rules` 로 다시 계산한다
 * (S4-12). 템플릿에 박아 두면 룰이 바뀐 뒤에도 옛 상한이 따라다닌다.
 */
export const QuoteTemplatePayloadSchema = z.object({
  productId: uuid,
  lines: z
    .array(
      z.object({
        itemType: z.enum(["base", "option"]),
        productOptionId: uuid.nullable().default(null),
        /** 제시가. 생략하면 보낼 때 상한 그대로. */
        amount: z.number().int().min(0).nullable().default(null),
      }),
    )
    .min(1)
    .max(50),
  vendorMemo: z.string().max(1000).nullable().default(null),
});

export const CreateTemplateSchema = z.object({
  action: z.literal("create_template"),
  kind: z.enum(TEMPLATE_KINDS),
  title: z.string().trim().min(1).max(60),
  payload: z.record(z.unknown()),
});

export const DeleteTemplateSchema = z.object({
  action: z.literal("delete_template"),
  id: uuid,
});

export const VendorSettingsActionSchema = z.discriminatedUnion("action", [
  UpdateVendorSettingsSchema,
  UpdateVendorChannelSchema,
  CreateTemplateSchema,
  DeleteTemplateSchema,
]);

export type VendorSettingsAction = z.infer<typeof VendorSettingsActionSchema>;

/**
 * 종류별 payload 검증.
 *
 * DB 는 `payload_json` 이 객체인지까지만 본다(0026) — 종류마다 모양이 달라 CHECK 로
 * 쓸 수 없다. 그래서 여기가 그 경계다.
 */
export function validateTemplatePayload(
  kind: (typeof TEMPLATE_KINDS)[number],
  payload: unknown,
): { ok: true; value: Record<string, unknown> } | { ok: false; message: string } {
  const schema = kind === "quick_reply" ? QuickReplyPayloadSchema : QuoteTemplatePayloadSchema;
  const parsed = schema.safeParse(payload);

  if (!parsed.success) {
    return {
      ok: false,
      message:
        kind === "quick_reply"
          ? "빠른 답변 내용을 확인해 주세요."
          : "견적 템플릿 구성을 확인해 주세요. 상품을 고르고 항목을 하나 이상 담아야 해요.",
    };
  }

  return { ok: true, value: parsed.data as Record<string, unknown> };
}

// =============================================================================
// 초대 (S2-09 · POST /api/vendor/invites)
// =============================================================================

export const InviteMemberSchema = z.object({
  action: z.literal("invite"),
  email: z.string().trim().toLowerCase().email("이메일 형식을 확인해 주세요.").max(200),
  role: z.enum(VENDOR_MEMBER_ROLES),
});

/** 재발송. **새 토큰을 발급한다** — 기존 링크가 유출됐을 수 있으므로 살려 두지 않는다. */
export const ResendInviteSchema = z.object({
  action: z.literal("resend"),
  id: uuid,
});

export const RevokeInviteSchema = z.object({
  action: z.literal("revoke"),
  id: uuid,
});

export const VendorInviteActionSchema = z.discriminatedUnion("action", [
  InviteMemberSchema,
  ResendInviteSchema,
  RevokeInviteSchema,
]);

export type VendorInviteAction = z.infer<typeof VendorInviteActionSchema>;

/**
 * 수락. **토큰만 받는다.**
 *
 * 어느 업체인지·어떤 권한인지를 받지 않는다 — 토큰이 그것을 결정한다. 받으면
 * 초대받은 사람이 `role: 'owner'` 로 수락하는 요청을 만들 수 있고, 그건 권한 상승이다.
 */
export const AcceptInviteSchema = z.object({
  token: z.string().min(20).max(200),
});

// =============================================================================
// 응답 모양
// =============================================================================

export const VendorInviteViewSchema = z.object({
  id: uuid,
  email: z.string(),
  role: z.string(),
  status: z.string(),
  expiresAt: z.string(),
  sentAt: z.string().nullable(),
  acceptedAt: z.string().nullable(),
  createdAt: z.string(),
  /** 발송사 연동 전이라 업체가 직접 전달할 수 있게 내보낸다(D-28). */
  inviteUrl: z.string().nullable(),
});

export type VendorInviteView = z.infer<typeof VendorInviteViewSchema>;

export const VendorTemplateViewSchema = z.object({
  id: uuid,
  kind: z.enum(TEMPLATE_KINDS),
  title: z.string(),
  payload: z.record(z.unknown()),
  sortOrder: z.number().int(),
});

export type VendorTemplateView = z.infer<typeof VendorTemplateViewSchema>;
