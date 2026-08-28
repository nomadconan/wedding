"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/EmptyState";
import { dateTimeAttr, formatTimestamp } from "@/lib/core/format/timestamp";
import {
  TICKET_CATEGORIES,
  TICKET_CATEGORY_LABEL,
  TICKET_STATUS_LABEL,
  TicketCreateSchema,
  type TicketStatus,
  isTerminal,
} from "@/lib/core/support/ticket";

/**
 * 문의·신고 (S8-09 · F-A-06 접수 면)
 *
 * ── 이 화면이 지키는 규칙 ───────────────────────────────────────────────────
 * 1. **접수 경로가 없으면 운영자 큐가 영원히 빈다.** 빈 큐는 "신고가 없다" 로 읽힌다 —
 *    화면과 라우트가 함께 있어야 F-A-06 이 성립한다(FIX-25 계열).
 * 2. **상태를 고를 수 없다.** 스키마에도 DB 컬럼 권한에도 자리가 없다 — 신고자가
 *    자기 신고를 닫으면 운영자 큐에 뜨지 않는다(FIX-43).
 * 3. **처리 결과를 보여준다.** 접수만 받고 결과를 안 보여주면 그것은 처리가 아니다.
 * 4. **처리 기한을 약속하지 않는다.** 정해진 기한이 없고, 지키지 못할 약속을 화면에
 *    적지 않는다(S3-09 가 삭제 요청에서 정한 것과 같은 규칙).
 */
export type SupportViewProps = {
  tickets: {
    id: string;
    category: string;
    subject: string;
    status: string;
    resolution: string | null;
    created_at: string;
  }[];
};

export function SupportView({ tickets }: SupportViewProps) {
  const router = useRouter();
  const [category, setCategory] = useState<string>("other");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const payload = {
    category,
    subject: subject.trim(),
    body: body.trim() === "" ? null : body.trim(),
  };
  const parsed = TicketCreateSchema.safeParse(payload);
  const problem = parsed.success ? null : parsed.error.issues[0]?.message ?? "입력을 확인해 주세요.";

  async function submit() {
    if (!parsed.success) return;

    setPending(true);
    setError(null);

    try {
      const response = await fetch("/api/tickets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed.data),
      });
      const result = (await response.json()) as { ok: boolean; error?: { message: string } };

      if (!result.ok) {
        setError(result.error?.message ?? "접수하지 못했어요.");

        return;
      }

      setSubject("");
      setBody("");
      setDone(true);
      router.refresh();
    } catch {
      setError("접수하지 못했어요. 잠시 후 다시 시도해 주세요.");
    } finally {
      setPending(false);
    }
  }

  const field = "w-full rounded-md border border-border bg-background px-3 py-2 text-sm";

  return (
    <div className="space-y-4 px-gutter py-6" data-testid="support">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">문의·신고 보내기</CardTitle>
          <CardDescription>
            계정·결제·업체 관련 문의를 받습니다. 게시물이나 후기 신고는 그 글에서 직접
            신고해 주세요 — 처리 절차가 달라 따로 받습니다.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <label className="block space-y-1">
            <span className="text-caption font-medium text-foreground">무엇에 대한 것인가요?</span>
            <select
              value={category}
              onChange={(event) => setCategory(event.target.value)}
              className={field}
              data-testid="ticket-category"
            >
              {TICKET_CATEGORIES.map((value) => (
                <option key={value} value={value}>
                  {TICKET_CATEGORY_LABEL[value]}
                </option>
              ))}
            </select>
          </label>

          <label className="block space-y-1">
            <span className="text-caption font-medium text-foreground">한 줄 요약</span>
            <input
              value={subject}
              onChange={(event) => setSubject(event.target.value)}
              maxLength={200}
              className={field}
              data-testid="ticket-subject"
            />
          </label>

          <label className="block space-y-1">
            <span className="text-caption font-medium text-foreground">자세한 내용 (선택)</span>
            <textarea
              value={body}
              onChange={(event) => setBody(event.target.value)}
              rows={5}
              maxLength={5_000}
              className={`${field} resize-none`}
              data-testid="ticket-body"
            />
          </label>

          {problem !== null && subject !== "" ? (
            <p role="alert" className="text-sm text-warning">
              {problem}
            </p>
          ) : null}

          {error !== null ? (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          ) : null}

          {done ? (
            <p className="text-sm text-foreground" data-testid="ticket-done">
              접수했습니다. 아래 목록에서 처리 상태를 확인하실 수 있어요.
            </p>
          ) : null}

          <Button
            type="button"
            size="touch"
            className="w-full"
            disabled={pending || !parsed.success}
            onClick={() => void submit()}
          >
            {pending ? "보내는 중…" : "보내기"}
          </Button>

          {/* 지키지 못할 약속을 적지 않는다 — 처리 기한이 정해져 있지 않다. */}
          <p className="text-caption text-muted-foreground">
            담당자가 확인하고 처리 결과를 이 화면에 남깁니다. <strong>처리 기한은 아직
            정해져 있지 않아 약속드리지 않습니다.</strong>
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">보낸 문의 {tickets.length}건</CardTitle>
          <CardDescription>
            <strong>&apos;조치하지 않음&apos;은 회원님이 틀렸다는 뜻이 아닙니다.</strong>{" "}
            저희가 조치하지 않기로 했다는 뜻이며, 그 이유를 함께 적습니다.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {tickets.length === 0 ? (
            <EmptyState
              title="보낸 문의가 없어요"
              description="위에서 문의를 보내시면 여기에 쌓입니다."
            />
          ) : (
            <ul className="space-y-2">
              {tickets.map((ticket) => (
                <li key={ticket.id} className="rounded-lg border border-border p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-foreground">{ticket.subject}</span>
                    <Badge variant={isTerminal(ticket.status) ? "outline" : "default"}>
                      {TICKET_STATUS_LABEL[ticket.status as TicketStatus] ?? ticket.status}
                    </Badge>
                    <Badge variant="outline">
                      {TICKET_CATEGORY_LABEL[
                        ticket.category as keyof typeof TICKET_CATEGORY_LABEL
                      ] ?? ticket.category}
                    </Badge>
                  </div>

                  {ticket.resolution !== null ? (
                    <p className="mt-2 rounded-md bg-muted p-2 text-caption text-foreground">
                      처리 결과 — {ticket.resolution}
                    </p>
                  ) : null}

                  <p className="mt-1 text-caption text-muted-foreground">
                    <time dateTime={dateTimeAttr(ticket.created_at)}>
                      {formatTimestamp(ticket.created_at)}
                    </time>
                  </p>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
