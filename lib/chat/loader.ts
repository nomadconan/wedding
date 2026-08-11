import {
  previewText,
  slaState,
  unreadCount,
  type ChatSide,
  type SlaState,
  type SlaThreshold,
} from "@/lib/core/chat/chat";
import type { AttachmentMeta } from "@/lib/core/chat/chat";
import type { ChatMessageView, ChatRoomView } from "@/lib/core/schemas/chat";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * 채팅 서버 공통 조각 (S4-04)
 *
 * `route.ts` 는 HTTP 메서드 외의 export 를 허용하지 않으므로, 소비자 라우트·업체
 * 라우트·화면이 함께 쓰는 것을 여기에 둔다.
 *
 * ── 이 파일이 지키는 두 가지 ────────────────────────────────────────────────
 *
 * 1. **메시지는 언제나 `chat_messages_visible` 뷰에서 읽는다.** 표를 직접 읽으면
 *    회수된 메시지의 본문이 그대로 나간다. 뷰는 `security_invoker` 라 밑의 RLS 를
 *    그대로 통과하므로, 뷰를 쓴다고 경계가 느슨해지지 않는다(S4-01).
 *
 * 2. **세션 클라이언트로 읽고 쓴다.** 서비스롤은 RLS 를 우회하므로 방 참여 판정이
 *    애플리케이션 코드로 넘어온다. 0021 이 만든 정책이 그대로 경계여야 한다
 *    (CLAUDE.md §5.5). 서비스롤은 **RLS 로 볼 수 없는 것**(업체 이름은 공개라 필요
 *    없고, 상대 참여자 목록은 알림 대상을 찾기 위해 필요하다)에만 쓴다.
 */

/**
 * 세션 클라이언트 타입.
 *
 * `@/lib/supabase/server` 의 반환 타입을 그대로 따온다 — 손으로 제네릭을 적으면
 * 그 모듈이 바뀔 때 조용히 어긋난다. `import type` 이라 next/headers 가 딸려 오지 않는다.
 */
type Client = Awaited<ReturnType<typeof import("@/lib/supabase/server").createClient>>;

/** 뷰 컬럼. 한 곳에서 관리해야 소비자·업체 응답이 갈라지지 않는다. */
export const MESSAGE_COLUMNS =
  "id, room_id, sender_id, sender_type, body, attachments, read_at, retracted_at, created_at";

export const ROOM_COLUMNS =
  "id, couple_id, vendor_id, status, assigned_to, last_message_at, awaiting_vendor_since, created_at";

type RoomRow = {
  id: string;
  couple_id: string;
  vendor_id: string;
  status: "active" | "archived" | "blocked";
  assigned_to: string | null;
  last_message_at: string | null;
  awaiting_vendor_since: string | null;
};

type MessageRow = {
  id: string;
  room_id: string;
  sender_id: string | null;
  sender_type: "couple" | "vendor" | "system";
  body: string | null;
  attachments: unknown;
  read_at: string | null;
  retracted_at: string | null;
  created_at: string;
};

function toAttachments(value: unknown): AttachmentMeta[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const meta = item as Record<string, unknown>;
    if (typeof meta.path !== "string" || typeof meta.name !== "string") return [];

    return [
      {
        path: meta.path,
        name: meta.name,
        mime: typeof meta.mime === "string" ? meta.mime : "application/octet-stream",
        size: typeof meta.size === "number" ? meta.size : 0,
      },
    ];
  });
}

export function toMessageView(row: MessageRow): ChatMessageView {
  return {
    id: row.id,
    roomId: row.room_id,
    senderId: row.sender_id,
    senderType: row.sender_type,
    body: row.body,
    attachments: toAttachments(row.attachments),
    readAt: row.read_at,
    retractedAt: row.retracted_at,
    createdAt: row.created_at,
  };
}

// =============================================================================
// SLA 눈금 (§7.4 가변 파라미터 — 값은 app_settings 가 갖는다)
// =============================================================================

/**
 * `app_settings.chat.sla_response_minutes` 를 읽는다.
 *
 * 행이 없거나 모양이 다르면 **null** 이다 — 기본값을 코드가 지어내지 않는다.
 * 화면은 null 을 받으면 타이머를 그리지 않고 그 사실을 적는다(`SLA_UNSET_NOTE`).
 *
 * `app_settings` 는 클라이언트 정책이 없는 표라 서비스롤로 읽는다. 담기는 값이
 * 운영 파라미터 하나뿐이라 노출 위험이 없다.
 */
export async function loadSlaThreshold(): Promise<SlaThreshold | null> {
  const { data } = await createAdminClient()
    .from("app_settings")
    .select("value_json")
    .eq("key", "chat.sla_response_minutes")
    .maybeSingle();

  const value = (data?.value_json ?? null) as { minutes?: unknown; warnPercent?: unknown } | null;
  if (value === null) return null;

  const minutes = Number(value.minutes);
  const warnPercent = Number(value.warnPercent);

  if (!Number.isFinite(minutes) || minutes <= 0) return null;

  return {
    minutes,
    // warnPercent 만 빠진 경우까지 눈금 전체를 버리지는 않는다 — 지연 판정은 여전히 가능하다.
    warnPercent: Number.isFinite(warnPercent) && warnPercent > 0 && warnPercent <= 100
      ? warnPercent
      : 100,
  };
}

// =============================================================================
// 방 목록
// =============================================================================

export type RoomListItem = ChatRoomView & { sla: SlaState | null };

/**
 * 방 목록 + 안읽음 + 미리보기.
 *
 * **안읽음을 방마다 메시지를 다 세어 구하지 않는다.** 방이 20개면 조회가 20번이
 * 된다. 대신 (가) 내 읽음 시점을 한 번에 읽고, (나) 각 방의 마지막 메시지 한 건과
 * 안읽음 개수를 count 질의로 구한다.
 *
 * `side` 는 **서버가 판정한 값**이다. 클라이언트가 보낸 값을 쓰면 업체가 커플인
 * 척하며 안읽음을 조작할 수 있다.
 */
export async function loadRooms(
  supabase: Client,
  options: {
    viewerId: string;
    side: ChatSide;
    /** 업체 인박스는 이 업체의 방만. 소비자는 RLS 가 자기 커플로 좁혀 준다. */
    vendorId?: string;
    threshold: SlaThreshold | null;
    now: Date;
  },
): Promise<RoomListItem[]> {
  let query = supabase.from("chat_rooms").select(ROOM_COLUMNS);
  if (options.vendorId) query = query.eq("vendor_id", options.vendorId);

  const { data: roomRows, error } = await query
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .limit(100);

  if (error) throw new Error("CHAT_ROOMS_LOAD_FAILED");

  const rooms = (roomRows ?? []) as RoomRow[];
  if (rooms.length === 0) return [];

  const roomIds = rooms.map((room) => room.id);

  // 업체 이름은 공개 데이터라 세션 클라이언트로 읽어도 된다(vendors_select_public).
  const { data: vendorRows } = await supabase
    .from("vendors")
    .select("id, name, category")
    .in("id", [...new Set(rooms.map((room) => room.vendor_id))]);

  const vendors = new Map(
    ((vendorRows ?? []) as { id: string; name: string; category: string | null }[]).map((row) => [
      row.id,
      row,
    ]),
  );

  // 내 읽음 시점. RLS 가 자기 행만 보여준다(S4-01).
  const { data: readRows } = await supabase
    .from("chat_room_reads")
    .select("room_id, last_read_at")
    .in("room_id", roomIds);

  const reads = new Map(
    ((readRows ?? []) as { room_id: string; last_read_at: string }[]).map((row) => [
      row.room_id,
      row.last_read_at,
    ]),
  );

  // 마지막 메시지 — 방마다 한 건씩 필요하지만 질의는 한 번이다. 최근 200건을 받아
  // 방별로 첫 건만 취한다(정렬이 내림차순이라 첫 건이 마지막 메시지다).
  const { data: recentRows } = await supabase
    .from("chat_messages_visible")
    .select(MESSAGE_COLUMNS)
    .in("room_id", roomIds)
    .order("created_at", { ascending: false })
    .limit(200);

  const lastByRoom = new Map<string, MessageRow>();
  for (const row of (recentRows ?? []) as MessageRow[]) {
    if (!lastByRoom.has(row.room_id)) lastByRoom.set(row.room_id, row);
  }

  // 안읽음 — 최근 200건 안에서 세면 오래 안 본 방이 틀린다. 방별 count 질의를
  // 병렬로 던진다(방 수만큼이지만 head 질의라 가볍다).
  const unreadEntries = await Promise.all(
    rooms.map(async (room) => {
      const lastReadAt = reads.get(room.id) ?? null;

      let counter = supabase
        .from("chat_messages_visible")
        .select("id", { count: "exact", head: true })
        .eq("room_id", room.id)
        .neq("sender_type", options.side);

      if (lastReadAt !== null) counter = counter.gt("created_at", lastReadAt);

      const { count } = await counter;

      return [room.id, count ?? 0] as const;
    }),
  );

  const unreadByRoom = new Map(unreadEntries);

  return rooms.map((room) => {
    const vendor = vendors.get(room.vendor_id);
    const last = lastByRoom.get(room.id) ?? null;

    return {
      id: room.id,
      vendorId: room.vendor_id,
      vendorName: vendor?.name ?? "이름을 불러오지 못한 업체",
      vendorCategory: vendor?.category ?? null,
      coupleId: room.couple_id,
      status: room.status,
      assignedTo: room.assigned_to,
      lastMessageAt: room.last_message_at,
      awaitingVendorSince: room.awaiting_vendor_since,
      unread: unreadByRoom.get(room.id) ?? 0,
      preview: previewText(
        last === null
          ? null
          : {
              body: last.body,
              retractedAt: last.retracted_at,
              attachmentCount: toAttachments(last.attachments).length,
            },
      ),
      sla: slaState(room.awaiting_vendor_since, options.now, options.threshold),
    };
  });
}

// =============================================================================
// 한 방의 메시지
// =============================================================================

export async function loadRoom(
  supabase: Client,
  roomId: string,
): Promise<{ room: RoomRow; vendorName: string; vendorCategory: string | null } | null> {
  const { data } = await supabase
    .from("chat_rooms")
    .select(ROOM_COLUMNS)
    .eq("id", roomId)
    .maybeSingle();

  if (!data) return null;

  const room = data as RoomRow;

  const { data: vendor } = await supabase
    .from("vendors")
    .select("name, category")
    .eq("id", room.vendor_id)
    .maybeSingle();

  return {
    room,
    vendorName: (vendor as { name?: string } | null)?.name ?? "이름을 불러오지 못한 업체",
    vendorCategory: (vendor as { category?: string } | null)?.category ?? null,
  };
}

/** 메시지는 오래된 것부터 준다 — 대화는 위에서 아래로 읽는다. */
export async function loadMessages(
  supabase: Client,
  roomId: string,
  limit = 200,
): Promise<ChatMessageView[]> {
  const { data, error } = await supabase
    .from("chat_messages_visible")
    .select(MESSAGE_COLUMNS)
    .eq("room_id", roomId)
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error) throw new Error("CHAT_MESSAGES_LOAD_FAILED");

  return ((data ?? []) as MessageRow[]).map(toMessageView);
}

/** 내가 이 방을 어디까지 읽었는가. */
export async function loadMyLastRead(
  supabase: Client,
  roomId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from("chat_room_reads")
    .select("last_read_at")
    .eq("room_id", roomId)
    .maybeSingle();

  return (data as { last_read_at?: string } | null)?.last_read_at ?? null;
}

/** 화면이 쓰는 안읽음 계산. 목록과 같은 규칙(`unreadCount`)을 쓴다. */
export function countUnread(
  messages: readonly ChatMessageView[],
  lastReadAt: string | null,
  side: ChatSide,
): number {
  return unreadCount(messages, lastReadAt, side);
}
