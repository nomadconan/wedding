import { z } from "zod";

import {
  GUEST_NAME_MAX_LENGTH,
  GUEST_PARTY_SIZE_MAX,
  GUEST_SIDES,
  RSVP_STATUSES,
  SEATING_MAX_TABLES,
  SEATING_TABLE_NAME_MAX,
} from "../guest/guest";

/**
 * 하객·좌석 입출력 (S7-09 · 명세서 §4.2 · CLAUDE.md §6)
 *
 * `/api/guests` 는 **행위 union** 이다(`/api/tasks`·`/api/budget` 과 같은 모양) —
 * §4.2 에 하객 API 행이 없어 이번에 신설하며, 경로를 넷으로 쪼개는 대신 명단 조작을
 * 한 경로에 모은다. **좌석과 초대는 다른 경로**다: 좌석은 문서 하나를 통째로 쓰는
 * 일이고, 초대는 **되돌리기 어려운 링크 발급**이라 같은 문에 두면 실수하기 쉽다.
 */

export const GuestActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create"),
    name: z.string().min(1).max(GUEST_NAME_MAX_LENGTH),
    side: z.enum(GUEST_SIDES),
    partySize: z.number().int().min(1).max(GUEST_PARTY_SIZE_MAX),
    /** 연락처는 **해시만 저장한다**(§7.3). 원문은 서버가 받고 남기지 않는다. */
    contact: z.string().max(40).optional(),
  }),
  z.object({
    action: z.literal("update"),
    guestId: z.string().uuid(),
    name: z.string().min(1).max(GUEST_NAME_MAX_LENGTH).optional(),
    side: z.enum(GUEST_SIDES).optional(),
    partySize: z.number().int().min(1).max(GUEST_PARTY_SIZE_MAX).optional(),
    /** 커플이 대신 답을 적을 수 있다 — 전화로 받은 답이 그렇다. */
    rsvpStatus: z.enum(RSVP_STATUSES).optional(),
  }),
  z.object({ action: z.literal("delete"), guestId: z.string().uuid() }),
]);

export type GuestAction = z.infer<typeof GuestActionSchema>;

export const SeatingSaveSchema = z.object({
  tables: z
    .array(
      z.object({
        id: z.string().min(1).max(64),
        name: z.string().min(1).max(SEATING_TABLE_NAME_MAX),
        capacity: z.number().int().min(0).max(100),
        // **이름이 아니라 id 다.** 배치가 이름을 갖고 있으면 명단에서 지운 사람의
        // 이름이 배치에 남는다.
        guestIds: z.array(z.string().uuid()).max(100),
      }),
    )
    .max(SEATING_MAX_TABLES),
});

export type SeatingSaveInput = z.infer<typeof SeatingSaveSchema>;

export const InviteActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("issue"), guestId: z.string().uuid() }),
  z.object({ action: z.literal("revoke"), guestId: z.string().uuid() }),
]);

export type InviteAction = z.infer<typeof InviteActionSchema>;

/** 비로그인 응답. **이름 필드가 없다** — 링크를 받은 사람은 답만 한다. */
export const RsvpAnswerSchema = z.object({
  answer: z.enum(["attending", "declined"]),
  partySize: z.number().int().min(1).max(GUEST_PARTY_SIZE_MAX),
});

export type RsvpAnswerInput = z.infer<typeof RsvpAnswerSchema>;
