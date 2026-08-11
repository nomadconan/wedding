"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { ChatComposer } from "@/components/domain/ChatComposer";
import { ChatThread } from "@/components/domain/ChatThread";
import { useRoomSignal } from "@/hooks/use-room-signal";
import { REALTIME_FALLBACK_NOTE, type ChatRoomStatus } from "@/lib/core/chat/chat";
import type { ChatMessageView } from "@/lib/core/schemas/chat";

const ENDPOINT = "/api/chat/messages";

/**
 * 대화 화면 (F-C-27, §6.2 `/chat/[roomId]`)
 *
 * ── 읽음 처리 시점 ──────────────────────────────────────────────────────────
 * 화면에 들어왔을 때와 **새 메시지를 받았을 때** 올린다. 스크롤 위치로 판정하지
 * 않는다 — 375px 에서 방을 열면 곧바로 마지막 메시지가 보이고, 스크롤 기반 판정은
 * "읽었는데 안 읽음" 을 자주 만든다. 읽음은 상대에게 보이는 사실이라(§3.7) 틀리면
 * 상대가 오해한다.
 *
 * 쓰는 것은 `chat_room_reads` 한 행뿐이고, 메시지의 `read_at` 은 DB 트리거가
 * 유도한다(S4-01). 그래서 이 화면은 읽음을 "위조" 할 수 없다.
 */
export function ChatRoomView({
  roomId,
  status,
  viewerId,
  vendorId,
  initialMessages,
  initialLastReadAt,
}: {
  roomId: string;
  status: ChatRoomStatus;
  viewerId: string;
  /** 상담 제안 카드가 예약 화면으로 보낼 때 쓴다(S4-07). */
  vendorId: string;
  initialMessages: ChatMessageView[];
  initialLastReadAt: string | null;
}) {
  const [messages, setMessages] = useState(initialMessages);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 마지막으로 올린 읽음 시각. 같은 값을 반복해 올리지 않기 위한 것이다.
  const markedRef = useRef<string | null>(initialLastReadAt);

  const markRead = useCallback(
    async (upTo: string | null) => {
      if (upTo === null) return;
      if (markedRef.current !== null && upTo <= markedRef.current) return;

      markedRef.current = upTo;

      try {
        await fetch(ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "mark_read", roomId, readAt: upTo }),
        });
      } catch {
        // 다음 신호에서 다시 올린다. 읽음이 한 박자 늦는 것은 복구 가능한 상태다.
        markedRef.current = null;
      }
    },
    [roomId],
  );

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(`${ENDPOINT}?roomId=${encodeURIComponent(roomId)}`);
      const payload = await response.json();

      if (!response.ok || !payload.ok) return;

      const next = payload.data.messages as ChatMessageView[];
      setMessages(next);

      const last = next.at(-1);
      if (last) void markRead(last.createdAt);
    } catch {
      // 목록은 이미 그려져 있다. 다음 주기에 다시 시도한다.
    }
  }, [roomId, markRead]);

  const signal = useRoomSignal({ roomId, onSignal: () => void refresh() });

  // 들어오자마자 한 번 — 서버 렌더로 받은 메시지까지 읽음으로 올린다.
  useEffect(() => {
    const last = initialMessages.at(-1);
    if (last) void markRead(last.createdAt);
  }, [initialMessages, markRead]);

  async function retract(messageId: string) {
    setPendingId(messageId);
    setError(null);

    try {
      const response = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "retract", messageId }),
      });
      const payload = await response.json();

      if (!response.ok || !payload.ok) {
        setError(payload.error?.message ?? "회수하지 못했어요.");

        return;
      }

      await refresh();
    } catch {
      setError("회수하지 못했어요. 잠시 후 다시 시도해 주세요.");
    } finally {
      setPendingId(null);
    }
  }

  return (
    <div className="flex flex-col gap-3" data-testid="chat-room">
      {signal === "polling" ? (
        <p className="text-caption text-muted-foreground" data-testid="chat-transport-note">
          {REALTIME_FALLBACK_NOTE}
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}

      <ChatThread
        messages={messages}
        side="couple"
        viewerId={viewerId}
        attachmentEndpoint={ENDPOINT}
        onRetract={retract}
        pendingId={pendingId}
        vendorId={vendorId}
        className="min-h-[40vh]"
      />

      <ChatComposer
        roomId={roomId}
        endpoint={ENDPOINT}
        status={status}
        onSent={() => void refresh()}
      />
    </div>
  );
}
