"use client";

import { SendHorizontal } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { AiDisclaimer } from "@/components/domain/AiDisclaimer";
import { Button } from "@/components/ui/button";
import {
  PLANNER_MESSAGE_MAX_LENGTH,
  messageProblem,
  type PlannerMessageView,
  type ToolCard,
} from "@/lib/core/ai/conversation";
import type { PlannerMode } from "@/lib/core/schemas/planner-chat";
import { cn } from "@/lib/utils";

import { ToolResultCard } from "./ToolResultCard";

const ENDPOINT = "/api/ai/planner";

/**
 * 플래너 대화 (F-C-03 · 명세서 §6.2 `/planner`)
 *
 * **스트림을 직접 읽는다.** `EventSource` 는 GET 만 할 수 있는데 이 대화는 본문이
 * 길어질 수 있어 POST 다(검색어를 URL 로 나르지 않는 것과 같은 이유 · S7-02).
 * 그래서 `fetch` 응답을 읽어 SSE 를 손으로 가른다.
 *
 * **서버가 통과시킨 문장만 도착한다**(S7-06 문장 게이트). 화면은 받은 것을 그대로
 * 이어 붙이며, 검사에 걸리면 `discard` 가 와서 **지금까지 받은 본문을 지운다** —
 * 조용히 두는 것보다 눈에 띄게 되돌리는 편이 낫다.
 *
 * **카드는 본문과 다른 상자다.** 카드 안은 툴이 돌려준 값이고 본문은 모델의 말이다.
 */
export function PlannerView({
  initialConversationId,
  initialMessages,
  mode,
  blockedNotice,
}: {
  initialConversationId: string | null;
  initialMessages: PlannerMessageView[];
  mode: PlannerMode;
  /** 상한이 이미 막혀 있으면 그 문장. 입력창을 닫는다. */
  blockedNotice: string | null;
}) {
  const [messages, setMessages] = useState<PlannerMessageView[]>(initialMessages);
  const [conversationId, setConversationId] = useState(initialConversationId);
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [streamCards, setStreamCards] = useState<ToolCard[]>([]);
  const [notice, setNotice] = useState<string | null>(blockedNotice);
  const [blocked, setBlocked] = useState(blockedNotice !== null);

  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages, streamText, streamCards]);

  const problem = messageProblem(draft);
  const canSend = !streaming && !blocked && problem === null;

  async function send() {
    if (!canSend) return;

    const text = draft.trim();
    const sentAt = new Date().toISOString();

    setDraft("");
    setNotice(null);
    setStreaming(true);
    setStreamText("");
    setStreamCards([]);
    setMessages((prev) => [
      ...prev,
      { id: `local-${sentAt}`, role: "user", text, createdAt: sentAt, cards: [] },
    ]);

    let assistantText = "";
    let cards: ToolCard[] = [];

    try {
      const response = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          ...(conversationId === null ? {} : { conversationId }),
        }),
      });

      if (!response.ok || response.body === null) {
        const payload = await response.json().catch(() => null);
        const message = payload?.error?.message ?? "지금은 답할 수 없어요.";

        setNotice(message);
        // 상한에 막힌 것이면 입력창을 닫는다 — 다시 눌러도 같은 답이 온다.
        if (response.status === 429) setBlocked(true);
        setStreaming(false);

        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() ?? "";

        for (const block of blocks) {
          const event = /^event: (.+)$/m.exec(block)?.[1];
          const raw = /^data: (.*)$/m.exec(block)?.[1];
          if (event === undefined || raw === undefined) continue;

          let data: Record<string, unknown> = {};
          try {
            data = JSON.parse(raw) as Record<string, unknown>;
          } catch {
            continue;
          }

          if (event === "meta" && typeof data.conversationId === "string") {
            setConversationId(data.conversationId);
            continue;
          }

          if (event === "delta" && typeof data.text === "string") {
            assistantText += data.text;
            setStreamText(assistantText);
            continue;
          }

          if (event === "card") {
            cards = [...cards, data as unknown as ToolCard];
            setStreamCards(cards);
            continue;
          }

          if (event === "discard") {
            // 서버가 전체 본문 검사에서 되돌렸다. 받은 문장을 지운다.
            assistantText = "";
            setStreamText("");
            continue;
          }

          if (event === "error" && typeof data.message === "string") {
            setNotice(data.message);
          }
        }
      }
    } catch {
      setNotice("연결이 끊겼어요. 잠시 후 다시 시도해 주세요.");
    } finally {
      if (assistantText !== "" || cards.length > 0) {
        setMessages((prev) => [
          ...prev,
          {
            id: `local-reply-${sentAt}`,
            role: "assistant",
            text: assistantText,
            createdAt: new Date().toISOString(),
            cards,
          },
        ]);
      }

      setStreamText("");
      setStreamCards([]);
      setStreaming(false);
    }
  }

  return (
    <div className="flex flex-col gap-3" data-testid="planner">
      {/* AI 결과가 포함된 화면이라 고지를 **상시 고정** 노출한다(CLAUDE.md §2.3). */}
      <AiDisclaimer />

      {mode === "rules_only" ? (
        <p
          className="rounded-lg border border-border bg-muted p-3 text-caption text-muted-foreground"
          data-testid="planner-mode-notice"
        >
          지금은 조건을 읽어 업체를 찾아드리는 것까지만 할 수 있어요. 대화형 답변은 준비 중이에요.
        </p>
      ) : null}

      <ol className="space-y-3" data-testid="planner-thread">
        {messages.map((message) => (
          <li key={message.id} data-testid="planner-message" data-role={message.role}>
            <MessageBubble message={message} />
          </li>
        ))}

        {streaming ? (
          <li data-testid="planner-streaming">
            <MessageBubble
              message={{
                id: "streaming",
                role: "assistant",
                text: streamText,
                createdAt: "",
                cards: streamCards,
              }}
              pending={streamText === "" && streamCards.length === 0}
            />
          </li>
        ) : null}
      </ol>

      <div ref={endRef} />

      {notice ? (
        <p role="alert" className="text-sm text-warning" data-testid="planner-notice">
          {notice}
        </p>
      ) : null}

      {blocked ? null : (
        <form
          className="flex items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <label className="sr-only" htmlFor="planner-input">
            클리어에게 물어보기
          </label>
          <textarea
            id="planner-input"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            maxLength={PLANNER_MESSAGE_MAX_LENGTH}
            rows={2}
            placeholder="3월 14일 강남 300인 웨딩홀 찾아줘"
            className="min-h-11 flex-1 resize-none rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-neutral-400"
            data-testid="planner-input"
          />
          <Button type="submit" disabled={!canSend} data-testid="planner-send">
            <SendHorizontal aria-hidden="true" className="h-4 w-4" />
            <span className="sr-only">보내기</span>
          </Button>
        </form>
      )}
    </div>
  );
}

function MessageBubble({
  message,
  pending = false,
}: {
  message: PlannerMessageView;
  pending?: boolean;
}) {
  const mine = message.role === "user";

  return (
    <div className={cn("flex flex-col gap-2", mine ? "items-end" : "items-start")}>
      {message.text === "" && !pending ? null : (
        <p
          className={cn(
            "max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm",
            mine
              ? "bg-brand-500 text-primary-foreground"
              : "border border-border bg-background text-foreground",
          )}
        >
          {pending ? "찾아보는 중이에요…" : message.text}
        </p>
      )}

      {message.cards.length > 0 ? (
        <div className="w-full space-y-2">
          {message.cards.map((card, index) => (
            <ToolResultCard key={`${card.tool}-${index}`} card={card} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export default PlannerView;
