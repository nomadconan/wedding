import { recordEvent } from "@/lib/audit/record";
import {
  ATTACHMENT_SIGNED_URL_SECONDS,
  CONSULTATION_PROPOSAL_BODY,
  attachmentPath,
  messageProblem,
  roomIdFromAttachmentPath,
  validateAttachment,
  type AttachmentMeta,
  type ChatSide,
} from "@/lib/core/chat/chat";
import { createAdminClient } from "@/lib/supabase/admin";

import { notifyNewMessage } from "./notify";

/**
 * 채팅 쓰기 동작 (S4-04)
 *
 * 소비자 라우트와 업체 라우트가 **같은 함수**를 부른다. 두 벌로 쓰면 한쪽만 고쳐지고,
 * 그 한쪽이 대개 증적 기록이다(D-23).
 *
 * ── 어떤 손으로 쓰는가 ──────────────────────────────────────────────────────
 * 전부 **세션 클라이언트**다. 서비스롤로 쓰면 0021 의 정책(자기 이름으로·자기 편으로·
 * 열린 방에만)이 통째로 우회된다. 서비스롤은 두 곳에만 쓴다 —
 *   · 첨부 서명 URL 발급 (Storage 는 정책을 두지 않기로 했다, §3.10)
 *   · 회수 (`chat_messages` 는 클라이언트 UPDATE 권한이 회수돼 있다, S4-01)
 * 두 경우 모두 **서버가 방 참여를 먼저 확인**한다.
 */

/** 세션 클라이언트 타입. 손으로 제네릭을 적지 않고 원본 모듈에서 따온다. */
type Client = Awaited<ReturnType<typeof import("@/lib/supabase/server").createClient>>;

export const CHAT_ATTACHMENT_BUCKET = "chat-attachments";

export type ActionFailure = { status: number; code: string; message: string };

/**
 * 이 사람이 이 방의 참여자인가 — **서버 판정용**.
 *
 * RLS 가 이미 막지만, 서비스롤을 쓰는 두 경로(첨부·회수)에는 RLS 가 없다.
 * 그래서 세션 클라이언트로 방을 한 번 읽어 본다 — **읽히면 참여자다**. 판정을
 * 새로 구현하지 않고 RLS 에게 묻는 것이 핵심이다(경계가 둘이 되지 않는다).
 */
export async function assertRoomAccess(
  supabase: Client,
  roomId: string,
): Promise<{ coupleId: string; vendorId: string; status: string } | null> {
  const { data } = await supabase
    .from("chat_rooms")
    .select("id, couple_id, vendor_id, status")
    .eq("id", roomId)
    .maybeSingle();

  if (!data) return null;

  const row = data as { couple_id: string; vendor_id: string; status: string };

  return { coupleId: row.couple_id, vendorId: row.vendor_id, status: row.status };
}

// =============================================================================
// 방 열기 (고객만 — S4-01)
// =============================================================================

export async function openRoom(
  supabase: Client,
  input: { coupleId: string; vendorId: string; actorId: string },
): Promise<{ roomId: string; created: boolean } | ActionFailure> {
  // 이미 있으면 그 방이다. 방은 커플·업체 조합당 하나이므로 열기는 멱등하다(S4-01).
  const { data: existing } = await supabase
    .from("chat_rooms")
    .select("id")
    .eq("couple_id", input.coupleId)
    .eq("vendor_id", input.vendorId)
    .maybeSingle();

  if (existing) return { roomId: (existing as { id: string }).id, created: false };

  const { data: created, error } = await supabase
    .from("chat_rooms")
    .insert({ couple_id: input.coupleId, vendor_id: input.vendorId })
    .select("id")
    .maybeSingle();

  if (error || !created) {
    // 동시에 두 번 눌러 유니크에 걸렸을 수 있다. 한 번 더 찾아본다.
    const { data: raced } = await supabase
      .from("chat_rooms")
      .select("id")
      .eq("couple_id", input.coupleId)
      .eq("vendor_id", input.vendorId)
      .maybeSingle();

    if (raced) return { roomId: (raced as { id: string }).id, created: false };

    return {
      status: 403,
      code: "CHAT_ROOM_OPEN_FAILED",
      message: "대화를 시작하지 못했어요. 승인된 업체인지 확인해 주세요.",
    };
  }

  const roomId = (created as { id: string }).id;

  await recordEvent({
    entityType: "chat_room",
    entityId: roomId,
    eventType: "chat_room_opened",
    actor: { id: input.actorId, role: "couple" },
    afterState: "active",
    memo: null,
  });

  return { roomId, created: true };
}

// =============================================================================
// 보내기
// =============================================================================

export async function sendMessage(
  supabase: Client,
  input: {
    roomId: string;
    senderId: string;
    side: ChatSide;
    body: string;
    attachments: AttachmentMeta[];
  },
): Promise<{ messageId: string } | ActionFailure> {
  const problem = messageProblem(input.body, input.attachments);
  if (problem) return { status: 422, code: "CHAT_MESSAGE_INVALID", message: problem };

  // 첨부 경로가 이 방의 것인지 확인한다. 남의 방 경로를 붙여 보내면 그 파일의
  // 서명 URL 을 이 방 참여자가 받아 갈 수 있다.
  for (const attachment of input.attachments) {
    if (roomIdFromAttachmentPath(attachment.path) !== input.roomId) {
      return {
        status: 422,
        code: "CHAT_ATTACHMENT_PATH",
        message: "첨부 경로가 이 대화의 것이 아니에요.",
      };
    }

    const rejection = validateAttachment(attachment);
    if (rejection) return { status: 422, ...rejection };
  }

  const { data, error } = await supabase
    .from("chat_messages")
    .insert({
      room_id: input.roomId,
      sender_id: input.senderId,
      // **편은 서버가 정한다.** 클라이언트가 보낸 값을 쓰지 않는다 — RLS 가 거짓말을
      // 막지만, 애초에 받지 않는 편이 맞다.
      sender_type: input.side,
      body: input.body.trim() === "" ? null : input.body.trim(),
      attachments: input.attachments,
    })
    .select("id")
    .maybeSingle();

  if (error || !data) {
    return {
      status: 403,
      code: "CHAT_SEND_FORBIDDEN",
      message: "메시지를 보내지 못했어요. 대화가 차단되었거나 권한이 없습니다.",
    };
  }

  const messageId = (data as { id: string }).id;

  // 증적 — **본문을 담지 않는다.** recordEvent 에는 본문을 담을 자리가 없고(§7.3),
  // 무엇을 말했는지는 chat_messages 가 이미 불변으로 들고 있다(S4-01).
  await recordEvent({
    entityType: "chat_message",
    entityId: messageId,
    eventType: "chat_message_sent",
    actor: { id: input.senderId, role: input.side },
    afterState: "sent",
    memo: input.attachments.length > 0 ? `attachments=${input.attachments.length}` : null,
  });

  // 알림은 실패해도 전송을 되돌리지 않는다 — "보냈는데 알림이 안 갔다" 가
  // "못 보냈다" 보다 낫다.
  await notifyNewMessage({ roomId: input.roomId, senderId: input.senderId, side: input.side });

  return { messageId };
}

// =============================================================================
// 회수 (수정·삭제가 아니다 — S4-01)
// =============================================================================

export async function retractMessage(
  supabase: Client,
  input: { messageId: string; actorId: string },
): Promise<{ messageId: string } | ActionFailure> {
  // 세션 클라이언트로 먼저 읽는다 — 읽히면 그 방의 참여자다(RLS 가 판정한다).
  const { data } = await supabase
    .from("chat_messages")
    .select("id, room_id, sender_id, sender_type, retracted_at")
    .eq("id", input.messageId)
    .maybeSingle();

  if (!data) {
    return { status: 404, code: "CHAT_MESSAGE_NOT_FOUND", message: "메시지를 찾을 수 없어요." };
  }

  const message = data as {
    room_id: string;
    sender_id: string | null;
    sender_type: string;
    retracted_at: string | null;
  };

  if (message.sender_type === "system") {
    return {
      status: 403,
      code: "CHAT_RETRACT_SYSTEM",
      message: "안내 카드는 회수할 수 없어요.",
    };
  }

  if (message.sender_id !== input.actorId) {
    return {
      status: 403,
      code: "CHAT_RETRACT_FORBIDDEN",
      message: "자기가 보낸 메시지만 회수할 수 있어요.",
    };
  }

  if (message.retracted_at !== null) {
    return { messageId: input.messageId };
  }

  // **여기만 서비스롤이다.** chat_messages 는 클라이언트 UPDATE 권한이 회수돼 있어
  // (S4-01) 세션 클라이언트로는 쓸 수 없다. 위에서 소유·참여를 모두 확인했다.
  const { error } = await createAdminClient()
    .from("chat_messages")
    .update({ retracted_at: new Date().toISOString(), retracted_by: input.actorId })
    .eq("id", input.messageId)
    .is("retracted_at", null);

  if (error) {
    return { status: 500, code: "CHAT_RETRACT_FAILED", message: "회수하지 못했어요." };
  }

  // 회수는 진짜 상태 전이다 — 누가 언제 내렸는지가 분쟁에서 쟁점이 된다(D-23).
  await recordEvent({
    entityType: "chat_message",
    entityId: input.messageId,
    eventType: "chat_message_retracted",
    actor: { id: input.actorId },
    beforeState: "sent",
    afterState: "retracted",
    memo: null,
  });

  return { messageId: input.messageId };
}

// =============================================================================
// 읽음
// =============================================================================

/**
 * 참여자별 읽음을 올린다. **메시지의 `read_at` 은 건드리지 않는다** — 0021 트리거가
 * 이 행에서 유도한다. 그래서 여기서 할 일은 upsert 한 번이다.
 *
 * 증적(`entity_events`)에는 적지 않는다. `chat_messages.read_at` 이 이미 그 사실을
 * 들고 있고, 그 값은 트리거가 만들며 당사자는 UPDATE 권한이 없어 위조할 수 없다
 * (S4-01). 같은 사실을 이벤트로 또 적으면 진실이 둘이 되고, 방을 열 때마다 쌓여
 * 분쟁 타임라인이 열람 기록으로 덮인다.
 */
export async function markRead(
  supabase: Client,
  input: { roomId: string; userId: string; readAt?: string },
): Promise<{ readAt: string } | ActionFailure> {
  const readAt = input.readAt ?? new Date().toISOString();

  const { error } = await supabase
    .from("chat_room_reads")
    .upsert(
      { room_id: input.roomId, user_id: input.userId, last_read_at: readAt },
      { onConflict: "room_id,user_id" },
    );

  if (error) {
    return { status: 403, code: "CHAT_READ_FORBIDDEN", message: "읽음을 남기지 못했어요." };
  }

  return { readAt };
}

// =============================================================================
// 담당자 배정 (F-V-15)
// =============================================================================

export async function assignRoom(
  supabase: Client,
  input: { roomId: string; userId: string | null; actorId: string },
): Promise<{ assignedTo: string | null } | ActionFailure> {
  const { data: before } = await supabase
    .from("chat_rooms")
    .select("assigned_to")
    .eq("id", input.roomId)
    .maybeSingle();

  const { data, error } = await supabase
    .from("chat_rooms")
    .update({ assigned_to: input.userId })
    .eq("id", input.roomId)
    .select("assigned_to")
    .maybeSingle();

  // 그 업체 멤버가 아닌 사람을 지정하면 0021 트리거가 거절한다. 메시지를 그대로
  // 흘리지 않고 우리 문장으로 바꾼다 — DB 예외문이 화면에 나가면 안 된다.
  if (error) {
    return {
      status: 403,
      code: "CHAT_ASSIGN_FORBIDDEN",
      message: "담당자는 이 업체의 구성원이어야 하고, 배정은 업체만 할 수 있어요.",
    };
  }

  if (!data) {
    return { status: 404, code: "CHAT_ROOM_NOT_FOUND", message: "대화를 찾을 수 없어요." };
  }

  await recordEvent({
    entityType: "chat_room",
    entityId: input.roomId,
    eventType: "chat_room_assigned",
    actor: { id: input.actorId, role: "vendor" },
    beforeState: (before as { assigned_to?: string | null } | null)?.assigned_to ?? "unassigned",
    afterState: input.userId ?? "unassigned",
    memo: null,
  });

  return { assignedTo: (data as { assigned_to: string | null }).assigned_to };
}

// =============================================================================
// 상담 일정 제안 카드 (S4-07 · §3.7)
// =============================================================================

/**
 * `sender_type='system'` 메시지를 남긴다.
 *
 * **서비스롤로 쓴다.** S4-01 의 RLS 는 클라이언트가 system 메시지를 만들지 못하게
 * 막았다 — 어느 편도 아닌 말을 당사자가 지어낼 수 있으면 그것은 시스템 안내가 아니다.
 * 그래서 업체의 요청을 받아 **서버가** 쓴다.
 *
 * **본문은 고정 문장이다.** 업체가 자유롭게 쓰면 "이 시각으로 잡아 두었다" 처럼
 * 확정된 것으로 읽히는 말을 쓸 수 있는데, 실제 예약은 고객 신청 + 업체 승인으로만
 * 성립한다(F-C-29).
 */
export async function proposeConsultation(
  supabase: Client,
  input: { roomId: string; actorId: string },
): Promise<{ messageId: string } | ActionFailure> {
  const room = await assertRoomAccess(supabase, input.roomId);
  if (!room) {
    return { status: 404, code: "CHAT_ROOM_NOT_FOUND", message: "대화를 찾을 수 없어요." };
  }

  if (room.status !== "active") {
    return { status: 409, code: "CHAT_ROOM_CLOSED", message: "대화가 열려 있지 않아요." };
  }

  const { data, error } = await createAdminClient()
    .from("chat_messages")
    .insert({
      room_id: input.roomId,
      sender_id: null,
      sender_type: "system",
      body: CONSULTATION_PROPOSAL_BODY,
    })
    .select("id")
    .maybeSingle();

  if (error || !data) {
    return { status: 500, code: "CHAT_PROPOSAL_FAILED", message: "제안 카드를 보내지 못했어요." };
  }

  const messageId = (data as { id: string }).id;

  await recordEvent({
    entityType: "chat_message",
    entityId: messageId,
    eventType: "consultation_proposed",
    actor: { id: input.actorId, role: "vendor" },
    afterState: "sent",
    memo: null,
  });

  return { messageId };
}

// =============================================================================
// 첨부 — 서명 URL (§3.10, S4-01)
// =============================================================================

/**
 * 업로드 주소를 만든다.
 *
 * **파일은 이 서버를 지나가지 않는다.** 20MB 파일이 서버리스 함수 본문을 통과할
 * 이유가 없고, 통과시키면 원문이 로그·트레이스에 실릴 위험만 생긴다(§5.3).
 *
 * `storage.objects` 에 정책이 없으므로(S4-01) 서명 URL 이 유일한 문이고, 그 문을
 * 여는 조건이 **방 참여**다. 그 판정은 위 `assertRoomAccess` 가 RLS 에게 묻는다.
 */
export async function createAttachmentUploadUrls(
  input: {
    roomId: string;
    files: { name: string; mime: string; size: number }[];
  },
): Promise<{ uploads: { path: string; token: string; signedUrl: string; name: string }[] } | ActionFailure> {
  for (const file of input.files) {
    const rejection = validateAttachment(file);
    if (rejection) return { status: 422, ...rejection };
  }

  const admin = createAdminClient();
  const uploads: { path: string; token: string; signedUrl: string; name: string }[] = [];

  for (const file of input.files) {
    // nonce 로 같은 이름의 파일이 서로를 덮어쓰지 않게 한다.
    const path = attachmentPath(input.roomId, crypto.randomUUID(), file.name);

    const { data, error } = await admin.storage
      .from(CHAT_ATTACHMENT_BUCKET)
      .createSignedUploadUrl(path);

    if (error || !data) {
      return {
        status: 500,
        code: "CHAT_ATTACHMENT_URL_FAILED",
        message: "업로드 주소를 만들지 못했어요.",
      };
    }

    uploads.push({ path, token: data.token, signedUrl: data.signedUrl, name: file.name });
  }

  return { uploads };
}

/**
 * 내려받기 주소. 유효 5분(§3.10 이 계약 원문에 쓴 값과 같다).
 *
 * **DB 에 저장하지 않는다**(S4-01) — 만료되며, 저장하면 접근권이 새어 나간다.
 * 볼 때마다 새로 발급한다.
 */
export async function createAttachmentDownloadUrl(
  path: string,
): Promise<{ url: string } | ActionFailure> {
  const { data, error } = await createAdminClient()
    .storage.from(CHAT_ATTACHMENT_BUCKET)
    .createSignedUrl(path, ATTACHMENT_SIGNED_URL_SECONDS);

  if (error || !data) {
    return {
      status: 404,
      code: "CHAT_ATTACHMENT_NOT_FOUND",
      message: "첨부를 찾을 수 없어요.",
    };
  }

  return { url: data.signedUrl };
}

export function isFailure(value: unknown): value is ActionFailure {
  return typeof value === "object" && value !== null && "status" in value && "code" in value;
}
