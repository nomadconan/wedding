import type { NextRequest } from "next/server";

import { fail, failValidation, ok } from "@/lib/api/response";
import {
  assertRoomAccess,
  assignRoom,
  createAttachmentDownloadUrl,
  createAttachmentUploadUrls,
  markRead,
  proposeConsultation,
  retractMessage,
  sendMessage,
} from "@/lib/chat/actions";
import { loadMessages, loadMyLastRead, loadRoom, loadRooms, loadSlaThreshold } from "@/lib/chat/loader";
import { inboxOrder, roomIdFromAttachmentPath } from "@/lib/core/chat/chat";
import { VendorChatActionSchema, quickReplyBody } from "@/lib/core/schemas/chat";
import { getSessionUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";
import { loadVendorMembers } from "@/lib/vendor/members";
import { findMemberVendor } from "@/lib/vendor/products";

/**
 * GET/POST /api/vendor/chat — 업체 채팅 인박스·응대 (F-V-15, §4.3)
 *
 * 소비자 라우트와 **같은 쓰기 함수**를 부른다(`lib/chat/actions`). 두 벌로 쓰면
 * 한쪽만 고쳐지고, 그 한쪽이 대개 증적 기록이다(D-23).
 *
 * ── staff 도 응대한다 ───────────────────────────────────────────────────────
 * S2-07 은 staff 에게서 **가격·정산**을 막았다. 채팅은 그 둘이 아니다 — 고객 문의에
 * 답하는 것은 staff 의 본래 일이고, 막으면 담당자를 배정해 놓고도 대표만 답할 수
 * 있는 모순이 된다. DB 도 같은 판단이다: 0021 의 정책은 `is_vendor_member` 이지
 * `is_vendor_owner` 가 아니다.
 *
 * ── vendor_id 를 입력으로 받지 않는다 ───────────────────────────────────────
 * 세션에서 찾는다(`findMemberVendor`). 받으면 남의 업체 인박스를 요청하는 경로가
 * 열린다 — RLS 가 막지만 그런 모양의 API 를 두지 않는다.
 */
export async function GET(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  const vendor = await findMemberVendor(user.id);
  if (!vendor) return fail(403, "VENDOR_NOT_FOUND", "등록된 업체가 없습니다.");

  const supabase = await createClient();
  const roomId = request.nextUrl.searchParams.get("roomId");
  const attachment = request.nextUrl.searchParams.get("attachment");

  if (attachment) {
    const owningRoom = roomIdFromAttachmentPath(attachment);
    if (!owningRoom) return fail(400, "CHAT_ATTACHMENT_PATH", "첨부 경로가 올바르지 않습니다.");

    if (!(await assertRoomAccess(supabase, owningRoom))) {
      return fail(404, "CHAT_ROOM_NOT_FOUND", "대화를 찾을 수 없습니다.");
    }

    const signed = await createAttachmentDownloadUrl(attachment);

    return "status" in signed ? fail(signed.status, signed.code, signed.message) : ok(signed);
  }

  // ── 한 방 ─────────────────────────────────────────────────────────────────
  if (roomId) {
    const room = await loadRoom(supabase, roomId);
    if (!room) return fail(404, "CHAT_ROOM_NOT_FOUND", "대화를 찾을 수 없습니다.");

    try {
      const [messages, lastReadAt] = await Promise.all([
        loadMessages(supabase, roomId),
        loadMyLastRead(supabase, roomId),
      ]);

      return ok({
        room: {
          id: room.room.id,
          status: room.room.status,
          assignedTo: room.room.assigned_to,
          awaitingVendorSince: room.room.awaiting_vendor_since,
          lastMessageAt: room.room.last_message_at,
        },
        messages,
        lastReadAt,
      });
    } catch {
      return fail(500, "CHAT_MESSAGES_LOAD_FAILED", "메시지를 불러오지 못했습니다.");
    }
  }

  // ── 인박스 ────────────────────────────────────────────────────────────────
  try {
    const rooms = await loadRooms(supabase, {
      viewerId: user.id,
      side: "vendor",
      vendorId: vendor.id,
      threshold: await loadSlaThreshold(),
      now: new Date(),
    });

    // 미응답이 위다(F-V-15). 정렬 규칙은 `lib/core` 의 순수 함수가 갖는다.
    return ok({
      rooms: inboxOrder(rooms),
      totalUnread: rooms.reduce((sum, room) => sum + room.unread, 0),
      members: (await loadVendorMembers(vendor.id)).map((member) => ({
        userId: member.userId,
        displayName: member.displayName,
        role: member.role,
      })),
    });
  } catch {
    return fail(500, "CHAT_ROOMS_LOAD_FAILED", "대화 목록을 불러오지 못했습니다.");
  }
}

export async function POST(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  const vendor = await findMemberVendor(user.id);
  if (!vendor) return fail(403, "VENDOR_NOT_FOUND", "등록된 업체가 없습니다.");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "CHAT_INVALID_BODY", "요청 본문을 읽을 수 없습니다.");
  }

  const parsed = VendorChatActionSchema.safeParse(body);
  if (!parsed.success) return failValidation(parsed.error.issues);

  const supabase = await createClient();
  const action = parsed.data;

  if (action.action === "retract") {
    const result = await retractMessage(supabase, {
      messageId: action.messageId,
      actorId: user.id,
    });

    return "status" in result ? fail(result.status, result.code, result.message) : ok(result);
  }

  if (!(await assertRoomAccess(supabase, action.roomId))) {
    return fail(404, "CHAT_ROOM_NOT_FOUND", "대화를 찾을 수 없습니다.");
  }

  if (action.action === "assign") {
    const result = await assignRoom(supabase, {
      roomId: action.roomId,
      userId: action.userId,
      actorId: user.id,
    });

    return "status" in result ? fail(result.status, result.code, result.message) : ok(result);
  }

  if (action.action === "attachment_url") {
    const result = await createAttachmentUploadUrls({
      roomId: action.roomId,
      files: action.files,
    });

    return "status" in result ? fail(result.status, result.code, result.message) : ok(result);
  }

  if (action.action === "mark_read") {
    const result = await markRead(supabase, {
      roomId: action.roomId,
      userId: user.id,
      readAt: action.readAt,
    });

    return "status" in result ? fail(result.status, result.code, result.message) : ok(result);
  }

  // 상담 일정 제안 카드(S4-07). S4-01 이 자리만 만들어 둔 것을 여기서 연결한다.
  if (action.action === "propose_consultation") {
    const result = await proposeConsultation(supabase, {
      roomId: action.roomId,
      actorId: user.id,
    });

    return "status" in result
      ? fail(result.status, result.code, result.message)
      : ok(result, { status: 201 });
  }

  // 빠른 답변(F-V-15) — 클라이언트가 키를 보내면 **서버가 본문을 되찾는다.**
  // 화면이 보낸 문자열을 그대로 저장해도 되지만, 그러면 템플릿을 고쳐도 옛 문안이
  // 계속 흘러 들어온다. 본문 자리에 `quick:<key>` 를 담아 보내는 규약을 쓴다.
  const quickKey = action.body.startsWith("quick:") ? action.body.slice("quick:".length) : null;
  const resolved = quickKey ? quickReplyBody(quickKey) : null;

  if (quickKey !== null && resolved === null) {
    return fail(422, "CHAT_QUICK_REPLY_UNKNOWN", "알 수 없는 빠른 답변입니다.");
  }

  const result = await sendMessage(supabase, {
    roomId: action.roomId,
    senderId: user.id,
    // 이 라우트는 업체용이다. RLS 가 is_vendor_member 를 확인한다.
    side: "vendor",
    body: resolved ?? action.body,
    attachments: action.attachments,
  });

  return "status" in result
    ? fail(result.status, result.code, result.message)
    : ok(result, { status: 201 });
}
