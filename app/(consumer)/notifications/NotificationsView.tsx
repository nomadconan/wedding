"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { EmptyState } from "@/components/ui/EmptyState";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  ALWAYS_ON_CHANNELS,
  BODY_UNAVAILABLE_TEXT,
  CHANNEL_LABEL,
  CHANNEL_PENDING,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_TOPICS,
  TOPIC_DESCRIPTION,
  TOPIC_LABEL,
  TOPIC_PENDING,
  isAllowed,
  type ChannelFlags,
  type NotificationChannel,
  type NotificationTopic,
} from "@/lib/core/schemas/notification";

/**
 * 알림센터 (F-C-21, §6.2 `/notifications`)
 *
 * **상태를 네 가지로 갈라 보인다** — 안 읽음 · 읽음 · 보내지 않음(수신 설정) · 실패.
 * 하나로 합치면 "안 왔다" 와 "껐다" 와 "실패했다" 가 같아 보이는데, 그 셋은 사용자가
 * 할 일이 완전히 다르다(설정을 켜라 / 기다려라 / 문의해라).
 *
 * **본문은 서버가 틀로 다시 만든 문장**이다. DB 에는 문장이 없다(§7.3).
 */
export type NotificationItem = {
  id: string;
  topic: string;
  channel: string;
  body: string | null;
  sentAt: string | null;
  deliveredAt: string | null;
  readAt: string | null;
  failedAt: string | null;
  failureReason: string | null;
  createdAt: string;
};

export type NotificationsViewProps = {
  items: NotificationItem[];
  unreadCount: number;
  prefs: Record<string, ChannelFlags>;
};

export function NotificationsView({ items, unreadCount, prefs }: NotificationsViewProps) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function call(body: unknown, key: string) {
    setPending(key);
    setError(null);

    try {
      const response = await fetch("/api/notifications", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json();

      if (!response.ok || !payload.ok) {
        setError(payload.error?.message ?? "처리하지 못했어요.");

        return;
      }

      router.refresh();
    } catch {
      setError("처리하지 못했어요. 잠시 후 다시 시도해 주세요.");
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="space-y-5" data-testid="notifications-view">
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}

      {/* ── 목록 ─────────────────────────────────────────────────────── */}
      <section className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-base font-semibold text-foreground">
            알림
            {unreadCount > 0 ? (
              <span className="ml-1 text-brand-600" data-testid="unread-count">
                {unreadCount}
              </span>
            ) : null}
          </h2>

          {unreadCount > 0 ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={pending !== null}
              data-testid="mark-all-read"
              onClick={() => call({ action: "mark_all_read" }, "all")}
            >
              모두 읽음
            </Button>
          ) : null}
        </div>

        {items.length === 0 ? (
          <EmptyState
            assetId="explore.empty"
            title="아직 받은 알림이 없어요"
            description="예식일이 다가오거나 준비 상태가 바뀌면 여기로 알려드릴게요."
          />
        ) : (
          <ul className="space-y-2">
            {items.map((item) => {
              const blocked = item.failedAt !== null;
              const unread = item.readAt === null && !blocked;

              return (
                <li key={item.id}>
                  <Card data-testid="notification-item" data-state={blocked ? "failed" : unread ? "unread" : "read"}>
                    <CardContent className="space-y-1 pt-4">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-caption text-muted-foreground">
                          {TOPIC_LABEL[item.topic as NotificationTopic] ?? item.topic} ·{" "}
                          {CHANNEL_LABEL[item.channel as NotificationChannel] ?? item.channel}
                        </span>
                        {unread ? <Badge data-testid="unread-badge">새 알림</Badge> : null}
                      </div>

                      <p className="text-sm text-foreground">{item.body ?? BODY_UNAVAILABLE_TEXT}</p>

                      {/* 발송·도달·열람을 나눠 적는다(D-23). 하나로 합치면 셋 다 증명 못 한다. */}
                      <p className="text-caption text-muted-foreground" data-testid="delivery-trail">
                        {blocked
                          ? `보내지 않음 · ${item.failureReason ?? "사유 없음"}`
                          : [
                              item.sentAt ? `보냄 ${item.sentAt.slice(5, 16).replace("T", " ")}` : "발송 대기",
                              item.deliveredAt ? "도달" : null,
                              item.readAt ? "읽음" : null,
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                      </p>

                      {unread ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={pending !== null}
                          data-testid="mark-read"
                          onClick={() => call({ action: "mark_read", id: item.id }, item.id)}
                        >
                          읽음으로 표시
                        </Button>
                      ) : null}
                    </CardContent>
                  </Card>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <Separator />

      {/* ── 수신 설정 ────────────────────────────────────────────────── */}
      <section className="space-y-3" data-testid="notification-prefs">
        <h2 className="text-base font-semibold text-foreground">수신 설정</h2>
        <p className="text-caption text-muted-foreground">
          앱 알림함은 끌 수 없어요. 무엇을 안내했는지 남는 자리라서, 꺼 두면 나중에 확인할
          방법이 없어집니다.
        </p>

        {NOTIFICATION_TOPICS.map((topic) => (
          <div key={topic} className="space-y-1.5 rounded-lg border border-border p-4" data-testid="pref-topic">
            <p className="text-sm font-medium text-foreground">{TOPIC_LABEL[topic]}</p>
            <p className="text-caption text-muted-foreground">{TOPIC_DESCRIPTION[topic]}</p>

            {/* 아직 보내지 않는 토픽도 설정은 미리 받는다 — 생긴 뒤에 켜져 있으면
                원치 않는 첫 알림을 받고 나서야 끌 수 있다. 다만 사실을 적는다. */}
            {TOPIC_PENDING[topic] ? (
              <p className="text-caption text-warning" data-testid="topic-pending">
                아직 보내지 않는 알림이에요 ({TOPIC_PENDING[topic]}).
              </p>
            ) : null}

            <div className="flex flex-wrap gap-3 pt-1">
              {NOTIFICATION_CHANNELS.map((channel) => {
                const always = ALWAYS_ON_CHANNELS.includes(channel);
                const enabled = isAllowed(topic, channel, prefs[topic]);
                const key = `${topic}:${channel}`;

                return (
                  <div key={channel} className="flex items-center gap-2">
                    <Checkbox
                      id={key}
                      checked={enabled}
                      disabled={always || pending !== null}
                      onCheckedChange={(checked) =>
                        call({ action: "set_pref", topic, channel, enabled: checked === true }, key)
                      }
                    />
                    <Label htmlFor={key} className="font-normal">
                      {CHANNEL_LABEL[channel]}
                      {always ? <span className="ml-1 text-caption text-muted-foreground">항상</span> : null}
                    </Label>
                  </div>
                );
              })}
            </div>

            {/* 계약 전 채널은 켜도 나가지 않는다. 켜 두고 안 오면 고장으로 읽힌다. */}
            {Object.entries(CHANNEL_PENDING).map(([channel, note]) => (
              <p key={channel} className="text-caption text-muted-foreground">
                {CHANNEL_LABEL[channel as NotificationChannel]} — {note}
              </p>
            ))}
          </div>
        ))}
      </section>
    </div>
  );
}

export default NotificationsView;
