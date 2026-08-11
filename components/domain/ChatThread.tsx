"use client";

import { CalendarClock, FileText, Paperclip, Undo2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  CONSULTATION_CARD,
  RETRACTED_TEXT,
  RETRACT_CONFIRM,
  canRetract,
  isMine,
  type AttachmentMeta,
  type ChatSide,
} from "@/lib/core/chat/chat";
import type { ChatMessageView } from "@/lib/core/schemas/chat";
import { cn } from "@/lib/utils";

/**
 * 대화 스레드 (S4-04 · F-C-27 · F-V-15)
 *
 * 소비자 화면(375px)과 업체 인박스(데스크톱)가 **같은 컴포넌트**를 쓴다. 말풍선의
 * 규칙 — 좌우 배치, 읽음 표시, 회수 처리, system 카드 — 은 두 화면에서 같아야 하고,
 * 나누면 한쪽만 고쳐진다.
 *
 * ── 읽음 표시 ───────────────────────────────────────────────────────────────
 * **내가 보낸 메시지에만** 붙인다. `read_at` 은 "상대 편이 처음 읽은 시각" 이므로
 * (S4-01) 상대 메시지에 붙이면 내가 읽은 시각처럼 오독된다.
 *
 * ── 회수 ────────────────────────────────────────────────────────────────────
 * 본문 자리에 "삭제되었습니다" 라고 쓰지 않는다 — 지워지지 않았기 때문이다
 * (`RETRACTED_TEXT`). 회수 버튼도 정직하게 경고한다: 상대 화면에서 가려질 뿐
 * 기록은 남는다(D-23).
 */
export type ChatThreadProps = {
  messages: readonly ChatMessageView[];
  /** 이 화면이 서 있는 편. 서버가 판정해 내려준다. */
  side: ChatSide;
  viewerId: string;
  /** 첨부 내려받기 주소를 얻는 엔드포인트. 소비자·업체가 다르다. */
  attachmentEndpoint: string;
  onRetract?: (messageId: string) => Promise<void> | void;
  pendingId?: string | null;
  /** 상담 제안 카드가 예약 화면으로 보낼 때 쓴다. 업체 화면에서는 넘기지 않는다. */
  vendorId?: string;
  className?: string;
};

export function ChatThread({
  messages,
  side,
  viewerId,
  attachmentEndpoint,
  onRetract,
  pendingId,
  vendorId,
  className,
}: ChatThreadProps) {
  const endRef = useRef<HTMLDivElement>(null);
  const lastId = messages.at(-1)?.id ?? null;

  // 새 메시지가 오면 아래로 붙인다. 메시지 수가 아니라 **마지막 id** 로 판정한다 —
  // 회수 같은 갱신에도 수는 그대로라 놓친다.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [lastId]);

  if (messages.length === 0) {
    return (
      <p className={cn("py-10 text-center text-sm text-muted-foreground", className)}>
        아직 주고받은 메시지가 없어요. 먼저 인사를 건네 보세요.
      </p>
    );
  }

  return (
    <ol className={cn("space-y-3", className)} data-testid="chat-thread">
      {messages.map((message) => {
        if (message.senderType === "system") {
          return <SystemCard key={message.id} message={message} vendorId={vendorId} />;
        }

        const mine = isMine(message.senderType, side);
        const retracted = message.retractedAt !== null;

        return (
          <li
            key={message.id}
            data-testid="chat-message"
            data-mine={mine}
            data-retracted={retracted}
            className={cn("flex flex-col gap-1", mine ? "items-end" : "items-start")}
          >
            <div
              className={cn(
                "max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm",
                retracted
                  ? "border border-dashed border-border bg-muted text-muted-foreground"
                  : mine
                    ? "bg-brand-500 text-primary-foreground"
                    : "bg-secondary text-secondary-foreground",
              )}
            >
              {retracted ? (
                <span className="italic">{RETRACTED_TEXT}</span>
              ) : (
                <>
                  {message.body ? (
                    <p className="whitespace-pre-wrap break-words">{message.body}</p>
                  ) : null}

                  {message.attachments.length > 0 ? (
                    <ul className={cn("space-y-1", message.body ? "mt-2" : "")}>
                      {message.attachments.map((attachment) => (
                        <AttachmentRow
                          key={attachment.path}
                          attachment={attachment}
                          endpoint={attachmentEndpoint}
                          mine={mine}
                        />
                      ))}
                    </ul>
                  ) : null}
                </>
              )}
            </div>

            <div className="flex items-center gap-2 text-caption text-muted-foreground">
              <time dateTime={message.createdAt}>{formatTime(message.createdAt)}</time>

              {/* 읽음 표시는 **내가 보낸 것에만**. read_at 은 상대의 열람 시각이다. */}
              {mine && !retracted ? (
                <span data-testid="read-mark">{message.readAt ? "읽음" : "안읽음"}</span>
              ) : null}

              {onRetract &&
              canRetract(
                {
                  senderId: message.senderId,
                  senderType: message.senderType,
                  retractedAt: message.retractedAt,
                },
                viewerId,
              ) ? (
                <button
                  type="button"
                  disabled={pendingId === message.id}
                  onClick={() => {
                    if (window.confirm(RETRACT_CONFIRM)) void onRetract(message.id);
                  }}
                  className="inline-flex items-center gap-1 rounded px-1 text-caption text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:opacity-50"
                >
                  <Undo2 aria-hidden="true" className="h-3 w-3" />
                  회수
                </button>
              ) : null}
            </div>
          </li>
        );
      })}

      <div ref={endRef} />
    </ol>
  );
}

/**
 * system 카드 (§3.7 "상담 일정 제안 카드는 system 메시지로 남긴다")
 *
 * **S4-07 에서 예약으로 연결했다.** S4-04 시점에는 F-C-29 가 없어 버튼을 비활성으로
 * 두고 담당 태스크만 적었다 — 없는 화면을 가리키는 버튼은 깨진 것을 켜 둔 상태이기
 * 때문이다. 이제 업체 상세의 예약 폼이 있으므로 그리로 보낸다.
 *
 * **카드가 일정을 확정하지 않는다.** 업체의 제안일 뿐이고, 실제 예약은 고객이
 * 신청하고 업체가 승인해야 성립한다(F-C-29). 그래서 카드는 예약 화면으로 보내는
 * 안내이지 예약 그 자체가 아니다 — 문구도 그렇게 쓴다.
 */
function SystemCard({ message, vendorId }: { message: ChatMessageView; vendorId?: string }) {
  return (
    <li className="flex justify-center" data-testid="chat-system-card">
      <div className="w-full max-w-[92%] rounded-xl border border-border bg-muted px-3.5 py-3">
        <p className="flex items-center gap-1.5 text-caption font-medium text-foreground">
          <CalendarClock aria-hidden="true" className="h-3.5 w-3.5" />
          {CONSULTATION_CARD.label}
        </p>

        {message.body ? (
          <p className="mt-1 whitespace-pre-wrap text-sm text-foreground">{message.body}</p>
        ) : null}

        {vendorId ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="mt-2"
            asChild
            data-testid="consultation-card-cta"
          >
            <Link href={CONSULTATION_CARD.href(vendorId)}>{CONSULTATION_CARD.cta}</Link>
          </Button>
        ) : (
          <Badge variant="outline" className="mt-2">
            업체 화면에서는 고객이 예약을 신청해요
          </Badge>
        )}
      </div>
    </li>
  );
}

/**
 * 첨부 한 줄.
 *
 * **주소를 미리 만들어 두지 않는다.** 서명 URL 은 5분이면 만료되므로 목록을 그릴
 * 때 발급하면 대부분 죽은 링크가 된다. 누를 때 받아서 그 자리에서 연다
 * (S4-01: 서명 URL 을 저장하지 않는다).
 */
function AttachmentRow({
  attachment,
  endpoint,
  mine,
}: {
  attachment: AttachmentMeta;
  endpoint: string;
  mine: boolean;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);

  async function open() {
    setPending(true);
    setError(false);

    try {
      const response = await fetch(
        `${endpoint}?attachment=${encodeURIComponent(attachment.path)}`,
      );
      const payload = await response.json();

      if (!response.ok || !payload.ok) {
        setError(true);

        return;
      }

      window.open(payload.data.url, "_blank", "noopener,noreferrer");
    } catch {
      setError(true);
    } finally {
      setPending(false);
    }
  }

  return (
    <li>
      <button
        type="button"
        onClick={open}
        disabled={pending}
        className={cn(
          "inline-flex max-w-full items-center gap-1.5 rounded-lg px-2 py-1 text-left text-caption underline-offset-2 hover:underline disabled:opacity-60",
          mine ? "bg-brand-600/40" : "bg-background",
        )}
      >
        <FileText aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{attachment.name}</span>
        <span className="shrink-0 opacity-70">{formatBytes(attachment.size)}</span>
      </button>

      {error ? (
        <span role="alert" className="ml-1 text-caption text-danger">
          열지 못했어요
        </span>
      ) : null}
    </li>
  );
}

export function AttachmentChip({
  name,
  onRemove,
}: {
  name: string;
  onRemove: () => void;
}) {
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded-full bg-secondary px-2.5 py-1 text-caption text-secondary-foreground">
      <Paperclip aria-hidden="true" className="h-3 w-3 shrink-0" />
      <span className="truncate">{name}</span>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-4 w-4 p-0 text-muted-foreground"
        onClick={onRemove}
        aria-label={`${name} 첨부 빼기`}
      >
        ×
      </Button>
    </span>
  );
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";

  return new Intl.DateTimeFormat("ko-KR", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;

  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}
