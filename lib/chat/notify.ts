import { dedupeKey } from "@/lib/core/schemas/notification";
import { sendNotification } from "@/lib/notify/send";
import { createAdminClient } from "@/lib/supabase/admin";
import { vendorDelivery } from "@/lib/vendor/settings";

import type { ChatSide } from "@/lib/core/chat/chat";

/**
 * 새 메시지 알림 (S4-04 → S4-13 발송 경로)
 *
 * ── 왜 이번에 붙이는가 ──────────────────────────────────────────────────────
 * Realtime 은 **화면을 켜 둔 사람**에게만 닿는다. 대화는 상대가 지금 보고 있지
 * 않을 때가 대부분이고, 분쟁에서 문제가 되는 것도 정확히 그 경우다 — "연락을
 * 받았는가"(D-23). 알림을 붙이지 않으면 채팅은 열어 봐야만 알 수 있는 기능이 되고,
 * 업체 응답 SLA(F-V-15)는 업체가 화면을 켜 두었는지에 좌우된다. 그건 SLA 가 아니다.
 *
 * ── 무엇을 담지 않는가 ──────────────────────────────────────────────────────
 * **본문도, 업체 이름도 담지 않는다.** `payload_json` 에는 방 id 만 들어간다(§7.3).
 * 문장은 `chat.new_message` 틀이 고정으로 만들고, 무엇이 왔는지는 대화 화면이 보여준다.
 *
 * ── 누구에게 보내는가 ───────────────────────────────────────────────────────
 * 상대 편 전원이 아니다.
 *  · 커플 쪽은 **당사자 둘 다**. 방을 공유하므로 둘 다 당사자다(§3.7).
 *  · 업체 쪽은 **담당자가 있으면 담당자에게만**, 없으면 멤버 전원. 담당자를 두고도
 *    전원에게 보내면 배정(F-V-15)이 아무 뜻이 없어진다. 멤버별 수신 채널·영업시간
 *    라우팅은 **S4-14(업체 알림·연동 설정)** 의 몫이라 여기서 흉내내지 않는다.
 *
 * ── 왜 메시지마다 보내지 않는가 ─────────────────────────────────────────────
 * 연달아 세 줄을 보내면 알림도 세 개가 된다. 그래서 **그 사람에게 이미 안읽음이
 * 있으면 보내지 않는다** — 알림은 "대화가 당신을 기다린다" 는 사실을 한 번 전하면
 * 충분하고, 읽고 나면 다시 보낼 수 있다. `dedupe_key` 는 그 위에 한 겹 더 얹어
 * 같은 요청의 재시도를 막는다.
 *
 * **서비스롤로 읽는다.** 참여자 목록(couple_members·vendor_members)은 보내는 쪽이
 * 볼 수 없는 정보이고, 알림 발송 자체가 서버 전용 경로다(S4-13).
 */
export async function notifyNewMessage(input: {
  roomId: string;
  senderId: string;
  side: ChatSide;
}): Promise<void> {
  try {
    const admin = createAdminClient();

    const { data: roomRow } = await admin
      .from("chat_rooms")
      .select("id, couple_id, vendor_id, assigned_to")
      .eq("id", input.roomId)
      .maybeSingle();

    if (!roomRow) return;

    const room = roomRow as {
      couple_id: string;
      vendor_id: string;
      assigned_to: string | null;
    };

    // 받을 사람 — 보낸 편의 반대쪽.
    let recipients: string[] = [];

    if (input.side === "couple") {
      // **업체 조직 설정을 따른다**(S4-14). 여기서 직접 고르던 것을 한 함수로 옮겼다 —
      // 채팅·문의·상담이 각자 판단하면 설정이 한 곳에만 반영되는 날이 온다.
      const delivery = await vendorDelivery({
        vendorId: room.vendor_id,
        assignedTo: room.assigned_to,
        now: new Date(),
      });

      recipients = delivery.recipients;
    } else {
      const { data } = await admin
        .from("couple_members")
        .select("user_id")
        .eq("couple_id", room.couple_id)
        .in("member_role", ["owner", "partner"]);

      recipients = ((data ?? []) as { user_id: string }[]).map((row) => row.user_id);
    }

    // 자기 자신은 뺀다 — 같은 사람이 양쪽에 있을 일은 없지만, 있어도 자기 메시지로
    // 자기에게 알림이 가면 안 된다.
    recipients = [...new Set(recipients)].filter((id) => id !== input.senderId);
    if (recipients.length === 0) return;

    for (const userId of recipients) {
      if (await hasEarlierUnread(admin, input.roomId, userId, input.side)) continue;

      await sendNotification({
        userId,
        topic: "chat",
        // in_app 만 보낸다. 외부 채널은 발송 대행 계약 전이고(D-28), 앱 알림함은
        // 끌 수 없는 채널이라 증적이 반드시 남는다(S4-13).
        channel: "in_app",
        templateKey: "chat.new_message",
        // 참조만. 본문·업체명은 넣지 않는다(§7.3).
        params: { roomId: input.roomId },
        // 방·사람 단위로 하나. 읽고 나면 아래 hasEarlierUnread 가 다시 열어 준다.
        dedupeKey: dedupeKey({
          templateKey: "chat.new_message",
          subjectId: `${input.roomId}:${userId}`,
          period: new Date().toISOString().slice(0, 16),
        }),
      });
    }
  } catch {
    // 알림 실패가 메시지 전송을 되돌리면 안 된다. 식별자만 남긴다 — 방 id 조차
    // 본문이 아니지만, 여기서는 그마저 필요 없다(§5.3).
    console.error("[chat] new message notification failed");
  }
}

/**
 * 이 사람에게 이 방의 안읽음이 **이미** 있었는가.
 *
 * 방금 넣은 메시지도 세어지므로 기준은 `> 1` 이다. 1이면 이번 것이 첫 안읽음이라
 * 알릴 값어치가 있고, 2 이상이면 이미 알렸다.
 */
async function hasEarlierUnread(
  admin: ReturnType<typeof createAdminClient>,
  roomId: string,
  userId: string,
  senderSide: ChatSide,
): Promise<boolean> {
  const { data: read } = await admin
    .from("chat_room_reads")
    .select("last_read_at")
    .eq("room_id", roomId)
    .eq("user_id", userId)
    .maybeSingle();

  const lastReadAt = (read as { last_read_at?: string } | null)?.last_read_at ?? null;

  let counter = admin
    .from("chat_messages")
    .select("id", { count: "exact", head: true })
    .eq("room_id", roomId)
    .eq("sender_type", senderSide);

  if (lastReadAt !== null) counter = counter.gt("created_at", lastReadAt);

  const { count } = await counter;

  return (count ?? 0) > 1;
}
