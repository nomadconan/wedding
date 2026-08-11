import { z } from "zod";

import { ATTACHMENT_MAX_COUNT, MESSAGE_MAX_LENGTH, QUICK_REPLIES } from "../chat/chat";

/**
 * 채팅 API 입출력 스키마 (S4-04 · 명세서 §4.2 `/api/chat/*`, §4.3 `/api/vendor/chat`)
 *
 * CLAUDE.md §6: API 입출력은 zod 로 양방향 검증하고 실패는 **422** 다.
 *
 * **쓰기를 하나의 POST 에 동작으로 실어 보낸다.** §4.2 가 정한 API 표면
 * (`/api/chat/rooms`·`/api/chat/messages`·`/api/vendor/chat`)을 늘리지 않기 위해서다 —
 * 첨부 업로드 주소 발급도 별도 라우트가 아니라 `messages` 의 한 동작이다
 * (S4-13 이 `/api/notifications` 를 PUT 하나로 묶은 것과 같은 판단).
 */

const uuid = z.string().uuid();

// =============================================================================
// 방 (/api/chat/rooms)
// =============================================================================

/**
 * 방 열기. **업체 id 만 받는다.**
 *
 * 커플 id 를 클라이언트에서 받지 않는다 — 서버가 세션에서 찾는다. 받으면 남의 커플
 * id 를 적어 보내는 경로가 열리고, RLS 가 막더라도 그런 입력을 받는 API 자체가
 * 잘못된 모양이다.
 *
 * 상품 id 도 받지 않는다. 방은 커플·업체 조합당 하나이며 상품별로 나뉘지 않는다
 * (S4-01). 이미 있으면 그 방을 돌려준다 — 열기는 멱등이다.
 */
export const OpenRoomSchema = z.object({
  action: z.literal("open").default("open"),
  vendorId: uuid,
});

export type OpenRoomInput = z.infer<typeof OpenRoomSchema>;

// =============================================================================
// 첨부
// =============================================================================

export const AttachmentMetaSchema = z.object({
  path: z.string().min(1).max(400),
  name: z.string().min(1).max(200),
  mime: z.string().min(1).max(100),
  size: z.number().int().positive(),
});

/**
 * 업로드 주소 요청.
 *
 * 파일 자체가 API 를 지나가지 않는다 — 서버는 서명 URL 만 내주고 클라이언트가
 * Storage 로 직접 올린다. 20MB 파일이 서버리스 함수 본문을 통과할 이유가 없다.
 */
export const AttachmentUrlSchema = z.object({
  action: z.literal("attachment_url"),
  roomId: uuid,
  files: z
    .array(
      z.object({
        name: z.string().min(1).max(200),
        mime: z.string().min(1).max(100),
        size: z.number().int().positive(),
      }),
    )
    .min(1)
    .max(ATTACHMENT_MAX_COUNT),
});

// =============================================================================
// 메시지 (/api/chat/messages, /api/vendor/chat)
// =============================================================================

export const SendMessageSchema = z.object({
  action: z.literal("send"),
  roomId: uuid,
  /** 빈 문자열 허용 — 첨부만 보내는 경우가 있다. 둘 다 비면 아래 refine 이 막는다. */
  body: z.string().max(MESSAGE_MAX_LENGTH).default(""),
  attachments: z.array(AttachmentMetaSchema).max(ATTACHMENT_MAX_COUNT).default([]),
});

/**
 * 회수. **수정이 아니다** — 본문을 바꾸는 입력이 없다는 것이 이 스키마의 요점이다
 * (S4-01: 메시지는 어떤 역할도 수정·삭제할 수 없다).
 */
export const RetractMessageSchema = z.object({
  action: z.literal("retract"),
  messageId: uuid,
});

/** 읽음 처리. 참여자별 층(`chat_room_reads`)에만 쓴다 — 메시지의 read_at 은 트리거가 만든다. */
export const MarkReadSchema = z.object({
  action: z.literal("mark_read"),
  roomId: uuid,
  /**
   * 이 시각까지 읽었다. 생략하면 지금까지. 뒤로 가는 값은 DB 트리거가 클램프한다.
   *
   * **`offset: true` 가 필요하다.** 화면은 방금 받은 메시지의 `created_at` 을 그대로
   * 돌려보내는데, PostgREST 는 `2026-08-11T14:32:10.123456+00:00` 처럼 **오프셋 표기**로
   * 준다. zod 의 `.datetime()` 은 기본적으로 `Z` 만 받고 오프셋을 거절하므로, 이것이
   * 없으면 읽음 처리가 조용히 422 로 떨어지고 **읽음 표시가 영영 붙지 않는다.**
   * (S4-04 검증에서 실제로 이 경로가 막혀 있었다.)
   */
  readAt: z.string().datetime({ offset: true }).optional(),
});

export const ChatMessageActionSchema = z.discriminatedUnion("action", [
  SendMessageSchema,
  RetractMessageSchema,
  MarkReadSchema,
  AttachmentUrlSchema,
]);

export type ChatMessageAction = z.infer<typeof ChatMessageActionSchema>;

// =============================================================================
// 업체 (/api/vendor/chat)
// =============================================================================

/**
 * 담당자 배정 (F-V-15).
 *
 * `userId: null` 은 배정 해제다. 그 사람이 그 업체 멤버인지는 **DB 트리거**가
 * 판정한다(0021 `assert_chat_assignee`) — 여기서 다시 검사하지 않는다. 두 곳에서
 * 판정하면 한쪽만 고쳐지는 날이 온다.
 */
export const AssignRoomSchema = z.object({
  action: z.literal("assign"),
  roomId: uuid,
  userId: uuid.nullable(),
});

export const VendorChatActionSchema = z.discriminatedUnion("action", [
  SendMessageSchema,
  RetractMessageSchema,
  MarkReadSchema,
  AttachmentUrlSchema,
  AssignRoomSchema,
]);

export type VendorChatAction = z.infer<typeof VendorChatActionSchema>;

// =============================================================================
// 빠른 답변
// =============================================================================

export const QuickReplyKeySchema = z.enum(
  QUICK_REPLIES.map((reply) => reply.key) as [string, ...string[]],
);

/** 템플릿 본문을 서버가 되찾는다. 클라이언트가 보낸 문자열을 그대로 믿지 않아도 되게. */
export function quickReplyBody(key: string): string | null {
  return QUICK_REPLIES.find((reply) => reply.key === key)?.body ?? null;
}

// =============================================================================
// 응답 모양 (화면·API 가 같은 타입을 쓴다)
// =============================================================================

export const ChatMessageViewSchema = z.object({
  id: uuid,
  roomId: uuid,
  senderId: uuid.nullable(),
  senderType: z.enum(["couple", "vendor", "system"]),
  /** 회수된 메시지는 뷰가 null 로 내보낸다(`chat_messages_visible`). */
  body: z.string().nullable(),
  attachments: z.array(AttachmentMetaSchema),
  readAt: z.string().nullable(),
  retractedAt: z.string().nullable(),
  createdAt: z.string(),
});

export type ChatMessageView = z.infer<typeof ChatMessageViewSchema>;

export const ChatRoomViewSchema = z.object({
  id: uuid,
  vendorId: uuid,
  vendorName: z.string(),
  vendorCategory: z.string().nullable(),
  coupleId: uuid,
  status: z.enum(["active", "archived", "blocked"]),
  assignedTo: uuid.nullable(),
  lastMessageAt: z.string().nullable(),
  awaitingVendorSince: z.string().nullable(),
  unread: z.number().int().nonnegative(),
  preview: z.string(),
});

export type ChatRoomView = z.infer<typeof ChatRoomViewSchema>;
