"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { ChatComposer } from "@/components/domain/ChatComposer";
import { ChatThread } from "@/components/domain/ChatThread";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/EmptyState";
import { LoadingState } from "@/components/ui/LoadingState";
import {
  QUICK_REPLIES,
  REALTIME_FALLBACK_NOTE,
  SLA_LEVEL_LABEL,
  VENDOR_INBOX_EMPTY_DESCRIPTION,
  VENDOR_INBOX_EMPTY_TITLE,
  formatDuration,
  unreadBadge,
  type SlaLevel,
} from "@/lib/core/chat/chat";
import type { RoomListItem } from "@/lib/chat/loader";
import type { ChatMessageView } from "@/lib/core/schemas/chat";
import { useRoomSignal } from "@/hooks/use-room-signal";
import { cn } from "@/lib/utils";

const ENDPOINT = "/api/vendor/chat";

type Member = { userId: string; displayName: string | null; role: string };

/**
 * 업체 채팅 인박스 (F-V-15, §6.3 `/vendor/chat`)
 *
 * 데스크톱 2단 — 왼쪽 목록, 오른쪽 대화. 소비자 화면과 달리 목록과 대화를 한 화면에
 * 둔다: 업체는 여러 대화를 오가며 처리하고, 라우팅으로 나누면 매번 목록으로
 * 돌아가야 한다.
 *
 * **SLA 는 사실만 말한다.** "응답 지연" 은 시각과 기준의 차이일 뿐이고, 업체에 대한
 * 평가적 단정을 쓰지 않는다(§2.3). 기준이 설정돼 있지 않으면 아예 그리지 않는다 —
 * 기본값을 지어내면 그 지어낸 값으로 업체가 늦었다고 말하게 된다.
 */
export function VendorChatView({
  initialRooms,
  members,
  viewerId,
  slaConfigured,
}: {
  initialRooms: RoomListItem[];
  members: Member[];
  viewerId: string;
  slaConfigured: boolean;
}) {
  const [rooms, setRooms] = useState(initialRooms);
  const [activeId, setActiveId] = useState<string | null>(initialRooms[0]?.id ?? null);
  const [messages, setMessages] = useState<ChatMessageView[] | null>(null);
  const [draft, setDraft] = useState("");
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const markedRef = useRef<Record<string, string>>({});
  const active = rooms.find((room) => room.id === activeId) ?? null;

  const refreshRooms = useCallback(async () => {
    try {
      const response = await fetch(ENDPOINT);
      const payload = await response.json();

      if (response.ok && payload.ok) setRooms(payload.data.rooms as RoomListItem[]);
    } catch {
      // 목록은 이미 그려져 있다. 다음 주기에 다시 시도한다.
    }
  }, []);

  const markRead = useCallback(async (roomId: string, upTo: string) => {
    const marked = markedRef.current[roomId];
    if (marked !== undefined && upTo <= marked) return;

    markedRef.current[roomId] = upTo;

    try {
      await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "mark_read", roomId, readAt: upTo }),
      });
    } catch {
      delete markedRef.current[roomId];
    }
  }, []);

  const refreshMessages = useCallback(
    async (roomId: string) => {
      try {
        const response = await fetch(`${ENDPOINT}?roomId=${encodeURIComponent(roomId)}`);
        const payload = await response.json();

        if (!response.ok || !payload.ok) return;

        const next = payload.data.messages as ChatMessageView[];
        setMessages(next);

        const last = next.at(-1);
        if (last) void markRead(roomId, last.createdAt);
      } catch {
        // 유지. 다음 신호에서 다시 맞춘다.
      }
    },
    [markRead],
  );

  const signal = useRoomSignal({
    onSignal: () => {
      void refreshRooms();
      if (activeId) void refreshMessages(activeId);
    },
  });

  // 방을 바꾸면 그 방의 메시지를 받아 온다.
  useEffect(() => {
    if (!activeId) return;

    setMessages(null);
    setDraft("");
    void refreshMessages(activeId);
  }, [activeId, refreshMessages]);

  /** 단발 동작 공용 호출. 제안 카드처럼 인자만 다른 것들이 쓴다. */
  async function call(body: unknown, key: string) {
    setPendingId(key);
    setError(null);

    try {
      const response = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json();

      if (!response.ok || !payload.ok) {
        setError(payload.error?.message ?? "처리하지 못했어요.");

        return;
      }

      if (activeId) await refreshMessages(activeId);
      await refreshRooms();
    } catch {
      setError("처리하지 못했어요. 잠시 후 다시 시도해 주세요.");
    } finally {
      setPendingId(null);
    }
  }

  async function assign(userId: string | null) {
    if (!activeId) return;

    setError(null);

    try {
      const response = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "assign", roomId: activeId, userId }),
      });
      const payload = await response.json();

      if (!response.ok || !payload.ok) {
        setError(payload.error?.message ?? "담당자를 바꾸지 못했어요.");

        return;
      }

      await refreshRooms();
    } catch {
      setError("담당자를 바꾸지 못했어요.");
    }
  }

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

      if (activeId) await refreshMessages(activeId);
    } catch {
      setError("회수하지 못했어요.");
    } finally {
      setPendingId(null);
    }
  }

  if (rooms.length === 0) {
    return (
      <Card>
        <CardContent className="pt-6">
          <EmptyState
            assetId="vendor.dashboard.empty"
            title={VENDOR_INBOX_EMPTY_TITLE}
            description={VENDOR_INBOX_EMPTY_DESCRIPTION}
          />
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3" data-testid="vendor-chat">
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

      <div className="grid gap-4 lg:grid-cols-[20rem_1fr]">
        {/* ── 인박스 ─────────────────────────────────────────────────────── */}
        <Card className="h-fit">
          <CardContent className="p-0">
            <ul className="divide-y divide-border" data-testid="vendor-chat-inbox">
              {rooms.map((room) => {
                const badge = unreadBadge(room.unread);
                const assignee = members.find((member) => member.userId === room.assignedTo);

                return (
                  <li key={room.id}>
                    <button
                      type="button"
                      onClick={() => setActiveId(room.id)}
                      aria-current={room.id === activeId ? "true" : undefined}
                      className={cn(
                        "w-full px-4 py-3 text-left transition-colors hover:bg-secondary/60",
                        room.id === activeId && "bg-brand-50",
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-sm font-medium text-foreground">
                          {room.preview || "새 대화"}
                        </span>
                        {badge ? (
                          <span className="inline-flex min-w-5 shrink-0 items-center justify-center rounded-full bg-brand-500 px-1.5 py-0.5 text-caption font-semibold text-primary-foreground">
                            {badge}
                          </span>
                        ) : null}
                      </div>

                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        {slaConfigured && room.sla ? <SlaBadge sla={room.sla} /> : null}
                        {assignee ? (
                          <Badge variant="secondary" className="font-normal">
                            {assignee.displayName ?? "담당자"}
                          </Badge>
                        ) : null}
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>

        {/* ── 대화 ───────────────────────────────────────────────────────── */}
        <Card>
          <CardContent className="space-y-3 pt-5">
            {active ? (
              <>
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-3">
                  <div className="flex items-center gap-2">
                    {slaConfigured && active.sla ? <SlaBadge sla={active.sla} /> : null}
                  </div>

                  <label className="flex items-center gap-2 text-caption text-muted-foreground">
                    담당자
                    <select
                      value={active.assignedTo ?? ""}
                      onChange={(event) => void assign(event.target.value || null)}
                      className="h-8 rounded-md border border-input bg-background px-2 text-sm"
                    >
                      <option value="">미배정</option>
                      {members.map((member) => (
                        <option key={member.userId} value={member.userId}>
                          {member.displayName ?? member.userId.slice(0, 8)}
                          {member.role === "owner" ? " (대표)" : ""}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                {messages === null ? (
                  <LoadingState label="메시지를 불러오는 중" rows={4} variant="list" />
                ) : (
                  <ChatThread
                    messages={messages}
                    side="vendor"
                    viewerId={viewerId}
                    attachmentEndpoint={ENDPOINT}
                    onRetract={retract}
                    pendingId={pendingId}
                    className="max-h-[52vh] overflow-y-auto pr-1"
                  />
                )}

                <ChatComposer
                  roomId={active.id}
                  endpoint={ENDPOINT}
                  status={active.status}
                  draft={draft}
                  onDraftChange={setDraft}
                  onSent={() => {
                    void refreshMessages(active.id);
                    void refreshRooms();
                  }}
                  slot={
                    // 빠른 답변(F-V-15). 문안을 **입력창에 채워 넣기만** 한다 —
                    // 바로 보내면 고객마다 다른 맥락에 같은 말이 나간다.
                    <div className="flex flex-wrap gap-1.5">
                      {QUICK_REPLIES.map((reply) => (
                        <Button
                          key={reply.key}
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => setDraft(reply.body)}
                        >
                          {reply.label}
                        </Button>
                      ))}

                      {/* 상담 일정 제안 카드(S4-07). 문구는 서버가 고정으로 넣는다 —
                          업체가 "잡아 두었다" 처럼 확정으로 읽히는 말을 쓸 수 없게. */}
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={() =>
                          void call(
                            { action: "propose_consultation", roomId: active.id },
                            `propose-${active.id}`,
                          )
                        }
                        data-testid="propose-consultation"
                      >
                        상담 일정 제안
                      </Button>
                    </div>
                  }
                />
              </>
            ) : (
              <p className="py-10 text-center text-sm text-muted-foreground">
                왼쪽에서 대화를 골라 주세요.
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

/**
 * SLA 배지.
 *
 * 사실만 적는다 — 경과 시간과 기준 대비 상태. "늦었다" 같은 평가어를 쓰지 않는다.
 */
function SlaBadge({ sla }: { sla: { level: SlaLevel; elapsedMinutes: number | null } }) {
  const tone: Record<SlaLevel, string> = {
    clear: "bg-success-surface text-success-foreground",
    waiting: "bg-secondary text-secondary-foreground",
    due: "bg-warning-surface text-warning-foreground",
    overdue: "bg-danger-surface text-danger-foreground",
  };

  return (
    <span
      data-testid="sla-badge"
      data-level={sla.level}
      className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-caption", tone[sla.level])}
    >
      {SLA_LEVEL_LABEL[sla.level]}
      {sla.elapsedMinutes !== null ? ` · ${formatDuration(sla.elapsedMinutes)}` : ""}
    </span>
  );
}
