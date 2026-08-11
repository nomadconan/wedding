"use client";

import Link from "next/link";
import { useCallback, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/EmptyState";
import { useRoomSignal } from "@/hooks/use-room-signal";
import {
  REALTIME_FALLBACK_NOTE,
  ROOMS_EMPTY_DESCRIPTION,
  ROOMS_EMPTY_TITLE,
  ROOM_STATUS_LABEL,
  unreadBadge,
} from "@/lib/core/chat/chat";
import type { RoomListItem } from "@/lib/chat/loader";
import { VENDOR_CATEGORY_LABEL, type VendorCategory } from "@/lib/core/schemas/vendor";

/**
 * 대화 목록 (F-C-27, §6.2 `/chat`)
 *
 * **최근 순.** 서버가 `last_message_at` 내림차순으로 준다(0021 인덱스가 그 경로다).
 * 안읽음이 있는 방을 위로 올리지 않는다 — 목록의 순서가 바뀌면 "방금 그 자리에
 * 있던 대화" 를 다시 찾아야 한다. 안읽음은 배지로 말한다.
 *
 * 실시간은 `chat_rooms` 구독이다(O-11 · 0022). **소켓은 신호이고 진실은 재조회다** —
 * 신호를 받으면 `/api/chat/rooms` 를 다시 부른다.
 */
export function ChatRoomsView({ initialRooms }: { initialRooms: RoomListItem[] }) {
  const [rooms, setRooms] = useState(initialRooms);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/chat/rooms");
      const payload = await response.json();

      if (response.ok && payload.ok) setRooms(payload.data.rooms as RoomListItem[]);
    } catch {
      // 조용히 넘긴다 — 다음 주기에 다시 시도한다. 목록은 이미 그려져 있다.
    }
  }, []);

  const signal = useRoomSignal({ onSignal: () => void refresh() });

  if (rooms.length === 0) {
    return (
      <EmptyState
        assetId="explore.empty"
        title={ROOMS_EMPTY_TITLE}
        description={ROOMS_EMPTY_DESCRIPTION}
        action={
          <Link href="/explore" className="text-sm font-medium text-brand-600">
            업체 둘러보기
          </Link>
        }
      />
    );
  }

  return (
    <div className="space-y-3" data-testid="chat-rooms">
      {signal === "polling" ? (
        <p className="text-caption text-muted-foreground" data-testid="chat-transport-note">
          {REALTIME_FALLBACK_NOTE}
        </p>
      ) : null}

      <ul className="space-y-2">
        {rooms.map((room) => {
          const badge = unreadBadge(room.unread);

          return (
            <li key={room.id}>
              <Link href={`/chat/${room.id}`} className="block">
                <Card className="transition-colors hover:bg-secondary/50">
                  <CardContent className="flex items-start gap-3 py-3.5">
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
                        <span className="truncate">{room.vendorName}</span>
                        {room.status !== "active" ? (
                          <Badge variant="outline" className="shrink-0">
                            {ROOM_STATUS_LABEL[room.status]}
                          </Badge>
                        ) : null}
                      </p>

                      <p className="mt-0.5 truncate text-caption text-muted-foreground">
                        {room.vendorCategory
                          ? VENDOR_CATEGORY_LABEL[room.vendorCategory as VendorCategory] ??
                            room.vendorCategory
                          : ""}
                      </p>

                      <p className="mt-1 truncate text-sm text-muted-foreground">{room.preview}</p>
                    </div>

                    <div className="flex shrink-0 flex-col items-end gap-1">
                      {room.lastMessageAt ? (
                        <time
                          dateTime={room.lastMessageAt}
                          className="text-caption text-muted-foreground"
                        >
                          {formatDay(room.lastMessageAt)}
                        </time>
                      ) : null}

                      {badge ? (
                        <span
                          data-testid="unread-badge"
                          className="inline-flex min-w-5 items-center justify-center rounded-full bg-brand-500 px-1.5 py-0.5 text-caption font-semibold text-primary-foreground"
                        >
                          {badge}
                        </span>
                      ) : null}
                    </div>
                  </CardContent>
                </Card>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** 오늘이면 시각, 아니면 날짜. 375px 목록에서 두 줄이 되지 않게 짧게 쓴다. */
function formatDay(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";

  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();

  return new Intl.DateTimeFormat(
    "ko-KR",
    sameDay ? { hour: "2-digit", minute: "2-digit" } : { month: "numeric", day: "numeric" },
  ).format(date);
}
