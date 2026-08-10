import type { Metadata } from "next";
import { Suspense } from "react";

import { ConsumerShell } from "@/components/layout/ConsumerShell";
import { ErrorState } from "@/components/ui/ErrorState";
import { LoadingState } from "@/components/ui/LoadingState";
import { renderBody, type ChannelFlags } from "@/lib/core/schemas/notification";
import { requireUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";

import { NotificationsView, type NotificationItem } from "./NotificationsView";

export const metadata: Metadata = {
  title: "알림센터 — 웨딩클리어",
};

/**
 * /notifications (F-C-21, §6.2)
 *
 * 로그인이 필요하다. 미인증 차단은 미들웨어가 한다(S3-01).
 * 로딩 상태는 `loading.tsx` 가 아니라 페이지 안쪽 Suspense 다(S3-03).
 */
export default async function NotificationsPage() {
  await requireUser("/notifications");

  return (
    <ConsumerShell title="알림">
      <Suspense fallback={<LoadingState label="알림을 불러오는 중" rows={4} variant="list" />}>
        <NotificationsSection />
      </Suspense>
    </ConsumerShell>
  );
}

async function NotificationsSection() {
  await requireUser("/notifications");

  const supabase = await createClient();

  // RLS 가 본인 것만 보여준다 — 여기서 user_id 로 다시 거르지 않는다.
  const { data: rows, error } = await supabase
    .from("notifications")
    .select(
      "id, topic, channel, template_key, payload_json, sent_at, delivered_at, read_at, failed_at, failure_reason, created_at",
    )
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) {
    return (
      <ErrorState
        code="NOTIFICATION_LOAD_FAILED"
        title="알림을 불러오지 못했어요"
        description="잠시 후 다시 시도해 주세요."
      />
    );
  }

  const { data: prefRows } = await supabase
    .from("notification_prefs")
    .select("topic, channel_flags");

  const items: NotificationItem[] = ((rows ?? []) as {
    id: string;
    topic: string;
    channel: string;
    template_key: string | null;
    payload_json: Record<string, unknown> | null;
    sent_at: string | null;
    delivered_at: string | null;
    read_at: string | null;
    failed_at: string | null;
    failure_reason: string | null;
    created_at: string;
  }[]).map((row) => ({
    id: row.id,
    topic: row.topic,
    channel: row.channel,
    // **저장된 문장이 아니다.** 틀 + 참조로 지금 다시 만든다(§7.3).
    body: row.template_key ? renderBody(row.template_key, row.payload_json ?? {}) : null,
    sentAt: row.sent_at,
    deliveredAt: row.delivered_at,
    readAt: row.read_at,
    failedAt: row.failed_at,
    failureReason: row.failure_reason,
    createdAt: row.created_at,
  }));

  const prefs = Object.fromEntries(
    ((prefRows ?? []) as { topic: string; channel_flags: ChannelFlags }[]).map((row) => [
      row.topic,
      row.channel_flags ?? {},
    ]),
  );

  return (
    <NotificationsView
      items={items}
      unreadCount={items.filter((item) => item.readAt === null && item.failedAt === null).length}
      prefs={prefs}
    />
  );
}
