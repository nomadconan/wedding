import type { NextRequest } from "next/server";

import { fail, failValidation, ok } from "@/lib/api/response";
import {
  assertRoomAccess,
  createAttachmentDownloadUrl,
  createAttachmentUploadUrls,
  markRead,
  retractMessage,
  sendMessage,
} from "@/lib/chat/actions";
import { loadMessages, loadMyLastRead, loadRoom } from "@/lib/chat/loader";
import { roomIdFromAttachmentPath } from "@/lib/core/chat/chat";
import { ChatMessageActionSchema } from "@/lib/core/schemas/chat";
import { getSessionUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";

/**
 * GET/POST /api/chat/messages — 소비자 메시지 조회·전송·읽음·첨부 (F-C-27, §4.2)
 *
 * **쓰기를 POST 하나에 동작으로 싣는다.** §4.2 가 정한 API 표면을 늘리지 않기
 * 위해서다 — 첨부 업로드 주소도 별도 라우트가 아니라 여기의 한 동작이다
 * (S4-13 이 `/api/notifications` 를 PUT 하나로 묶은 것과 같은 판단).
 *
 * **읽기는 언제나 `chat_messages_visible` 뷰를 지난다**(`loadMessages`). 표를 직접
 * 읽으면 회수된 메시지의 본문이 그대로 나간다(S4-01).
 *
 * 실시간은 이 API 를 대체하지 않는다. 소켓은 `chat_rooms` 변경 신호만 나르고
 * (0022 · O-11), 화면은 신호를 받으면 여기로 다시 조회한다 — **소켓은 신호이고
 * 진실은 이 응답이다.** 그래서 소켓이 끊긴 환경에서도 같은 화면이 나온다.
 */
export async function GET(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  const roomId = request.nextUrl.searchParams.get("roomId");
  const attachment = request.nextUrl.searchParams.get("attachment");

  const supabase = await createClient();

  // ── 첨부 내려받기 주소 ────────────────────────────────────────────────────
  if (attachment) {
    const owningRoom = roomIdFromAttachmentPath(attachment);
    if (!owningRoom) {
      return fail(400, "CHAT_ATTACHMENT_PATH", "첨부 경로가 올바르지 않습니다.");
    }

    // 경로에 적힌 방의 참여자인지 **RLS 에게 묻는다** — 읽히면 참여자다.
    // Storage 에는 정책이 없으므로(§3.10) 이 판정이 유일한 문이다.
    if (!(await assertRoomAccess(supabase, owningRoom))) {
      return fail(404, "CHAT_ROOM_NOT_FOUND", "대화를 찾을 수 없습니다.");
    }

    const signed = await createAttachmentDownloadUrl(attachment);
    if ("status" in signed) return fail(signed.status, signed.code, signed.message);

    return ok(signed);
  }

  if (!roomId) return fail(400, "CHAT_ROOM_REQUIRED", "대화를 지정해 주세요.");

  const room = await loadRoom(supabase, roomId);
  // 없는 것과 못 보는 것을 구분해 알려 주지 않는다 — 방의 존재 자체가 정보다.
  if (!room) return fail(404, "CHAT_ROOM_NOT_FOUND", "대화를 찾을 수 없습니다.");

  try {
    const [messages, lastReadAt] = await Promise.all([
      loadMessages(supabase, roomId),
      loadMyLastRead(supabase, roomId),
    ]);

    return ok({
      room: {
        id: room.room.id,
        vendorId: room.room.vendor_id,
        vendorName: room.vendorName,
        vendorCategory: room.vendorCategory,
        status: room.room.status,
        lastMessageAt: room.room.last_message_at,
      },
      messages,
      lastReadAt,
    });
  } catch {
    return fail(500, "CHAT_MESSAGES_LOAD_FAILED", "메시지를 불러오지 못했습니다.");
  }
}

export async function POST(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "CHAT_INVALID_BODY", "요청 본문을 읽을 수 없습니다.");
  }

  const parsed = ChatMessageActionSchema.safeParse(body);
  if (!parsed.success) return failValidation(parsed.error.issues);

  const supabase = await createClient();
  const action = parsed.data;

  if (action.action === "retract") {
    const result = await retractMessage(supabase, {
      messageId: action.messageId,
      actorId: user.id,
    });

    return "status" in result
      ? fail(result.status, result.code, result.message)
      : ok(result);
  }

  // 나머지 동작은 전부 방을 지정한다. 참여 판정을 한 번에 끝낸다.
  if (!(await assertRoomAccess(supabase, action.roomId))) {
    return fail(404, "CHAT_ROOM_NOT_FOUND", "대화를 찾을 수 없습니다.");
  }

  if (action.action === "attachment_url") {
    const result = await createAttachmentUploadUrls({
      roomId: action.roomId,
      files: action.files,
    });

    return "status" in result
      ? fail(result.status, result.code, result.message)
      : ok(result);
  }

  if (action.action === "mark_read") {
    const result = await markRead(supabase, {
      roomId: action.roomId,
      userId: user.id,
      readAt: action.readAt,
    });

    return "status" in result
      ? fail(result.status, result.code, result.message)
      : ok(result);
  }

  // 보내기 — **편은 서버가 'couple' 로 고정한다.** 이 라우트는 소비자용이고,
  // 업체 계정이 불러도 RLS 가 거절한다(is_couple_principal 이 거짓이다).
  const result = await sendMessage(supabase, {
    roomId: action.roomId,
    senderId: user.id,
    side: "couple",
    body: action.body,
    attachments: action.attachments,
  });

  return "status" in result
    ? fail(result.status, result.code, result.message)
    : ok(result, { status: 201 });
}
