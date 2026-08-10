import type { NextRequest } from "next/server";

import { fail, failValidation, ok } from "@/lib/api/response";
import {
  NOTIFICATION_TOPICS,
  NotificationActionSchema,
  renderBody,
  type ChannelFlags,
} from "@/lib/core/schemas/notification";
import { getSessionUser } from "@/lib/supabase/auth";
import { createClient } from "@/lib/supabase/server";

/**
 * GET/PUT /api/notifications — 알림 목록·읽음 처리·수신 설정 (F-C-21, §4.2)
 *
 * **본문은 응답에서 만든다.** DB 에는 틀 id 와 참조만 있고 문장은 없다(§7.3).
 * 틀이 사라졌으면 지어내지 않고 그 사실을 그대로 내보낸다.
 *
 * 쓰기는 `PUT` 하나에 동작을 실어 보낸다 — §4.2 가 정한 API 표면을 늘리지 않는다.
 * 읽음 처리는 **세션 클라이언트**로 한다. `read_at` 만 열려 있는 권한(0019)이
 * 그대로 경계이므로, 서비스롤을 쓰면 그 경계를 우회하게 된다.
 */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  const supabase = await createClient();

  // RLS 가 본인 것만 보여준다.
  const { data: rows, error } = await supabase
    .from("notifications")
    .select(
      "id, topic, channel, template_key, payload_json, sent_at, delivered_at, read_at, failed_at, failure_reason, created_at",
    )
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) return fail(500, "NOTIFICATION_LOAD_FAILED", "알림을 불러오지 못했습니다.");

  const { data: prefRows } = await supabase
    .from("notification_prefs")
    .select("topic, channel_flags");

  const prefs = Object.fromEntries(
    ((prefRows ?? []) as { topic: string; channel_flags: ChannelFlags }[]).map((row) => [
      row.topic,
      row.channel_flags ?? {},
    ]),
  );

  const items = ((rows ?? []) as {
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
    // 저장된 문장이 아니라 **다시 만든** 문장이다.
    body: row.template_key ? renderBody(row.template_key, row.payload_json ?? {}) : null,
    sentAt: row.sent_at,
    deliveredAt: row.delivered_at,
    readAt: row.read_at,
    failedAt: row.failed_at,
    failureReason: row.failure_reason,
    createdAt: row.created_at,
  }));

  return ok({
    items,
    unreadCount: items.filter((item) => item.readAt === null && item.failedAt === null).length,
    prefs,
    topics: NOTIFICATION_TOPICS,
  });
}

export async function PUT(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return fail(401, "AUTH_REQUIRED", "로그인이 필요합니다.");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "NOTIFICATION_INVALID_BODY", "요청 본문을 읽을 수 없습니다.");
  }

  const parsed = NotificationActionSchema.safeParse(body);
  if (!parsed.success) return failValidation(parsed.error.issues);

  const supabase = await createClient();
  const now = new Date().toISOString();

  if (parsed.data.action === "mark_read") {
    const { data: updated, error } = await supabase
      .from("notifications")
      .update({ read_at: now })
      .eq("id", parsed.data.id)
      .select("id");

    // 권한이 좁혀져 있어(0019) 다른 컬럼을 건드리면 여기서 오류가 난다.
    if (error) return fail(403, "NOTIFICATION_FORBIDDEN", "이 알림을 바꿀 권한이 없습니다.");

    if (!updated || updated.length === 0) {
      return fail(404, "NOTIFICATION_NOT_FOUND", "알림을 찾을 수 없습니다.");
    }

    return ok({ id: parsed.data.id, readAt: now });
  }

  if (parsed.data.action === "mark_all_read") {
    const { data: updated } = await supabase
      .from("notifications")
      .update({ read_at: now })
      .is("read_at", null)
      .select("id");

    return ok({ readCount: updated?.length ?? 0, readAt: now });
  }

  // 수신 설정 — 토픽별 채널 플래그를 병합해 저장한다.
  const { topic, channel, enabled } = parsed.data;

  const { data: existing } = await supabase
    .from("notification_prefs")
    .select("id, channel_flags")
    .eq("topic", topic)
    .maybeSingle();

  const flags: ChannelFlags = { ...((existing?.channel_flags ?? {}) as ChannelFlags), [channel]: enabled };

  const { error } = existing
    ? await supabase.from("notification_prefs").update({ channel_flags: flags }).eq("id", existing.id)
    : await supabase
        .from("notification_prefs")
        .insert({ user_id: user.id, topic, channel_flags: flags });

  if (error) return fail(500, "NOTIFICATION_PREF_FAILED", "수신 설정을 저장하지 못했습니다.");

  return ok({ topic, channelFlags: flags });
}
