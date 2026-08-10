import { createHash } from "node:crypto";

import {
  MAX_SEND_ATTEMPTS,
  NOTIFICATION_TEMPLATES,
  SEND_BLOCKED_BY_PREFS,
  isAllowed,
  renderBody,
  type ChannelFlags,
  type NotificationChannel,
  type NotificationTopic,
  type TemplateKey,
} from "@/lib/core/schemas/notification";
import { createAdminClient } from "@/lib/supabase/admin";

import { resolveAdapterName, type SendResult } from "./adapter";
import { createNoopAdapter, createStubAdapter } from "./stub";

/**
 * 알림 발송 (S4-13 · D-23 · D-28 · §7.3)
 *
 * 순서가 곧 설계다.
 *  1. **수신 설정 확인** — 껐으면 보내지 않는다. 다만 **기록은 남긴다**(아래 참조).
 *  2. **행을 먼저 만든다** — 발송 전에 만들어야 `dedupe_key` 유니크가 동시 실행을
 *     막는다. 보내고 나서 기록하면 두 프로세스가 둘 다 보낸 뒤에야 충돌을 안다.
 *  3. **어댑터 호출** — 결과에 따라 `sent_at`·`provider_message_id` 또는
 *     `failed_at`·`failure_reason` 을 채운다.
 *
 * **본문을 저장하지 않는다**(§7.3). 틀 id 와 참조(payload)와 해시만 남기고, 화면은
 * 읽을 때마다 다시 만든다. 어댑터에 넘긴 문자열은 이 함수 밖으로 나가지 않는다.
 *
 * **서비스롤로 쓴다.** `notifications` 에는 INSERT 정책이 없다 — 사용자가 자기 알림을
 * 만들 수 있으면 "안내를 받았다" 는 기록을 스스로 지어낼 수 있다.
 */
export type SendNotificationInput = {
  userId: string;
  topic: NotificationTopic;
  channel: NotificationChannel;
  templateKey: TemplateKey;
  /** 틀에 끼울 **참조 ID와 숫자만**. 이름·주소 같은 식별정보를 넣지 않는다(§7.3). */
  params: Record<string, unknown>;
  /** 멱등 열쇠. `lib/core/schemas/notification.ts` 의 `dedupeKey()` 로 만든다. */
  dedupeKey?: string | null;
  /** 이메일 채널이 쓰는 주소. 저장하지 않고 어댑터에만 넘긴다. */
  email?: string | null;
};

export type SendNotificationResult =
  | { status: "sent"; id: string }
  | { status: "skipped"; id: string; reason: string }
  | { status: "failed"; id: string; reason: string; retryable: boolean }
  | { status: "duplicate" };

export async function sendNotification(
  input: SendNotificationInput,
): Promise<SendNotificationResult> {
  const admin = createAdminClient();

  const body = renderBody(input.templateKey, input.params);
  if (body === null) {
    // 틀이 없으면 보낼 수 없다. 지어낸 문장을 보내는 것보다 안 보내는 편이 낫다.
    return { status: "failed", id: "", reason: "문장 틀이 없습니다.", retryable: false };
  }

  const { data: pref } = await admin
    .from("notification_prefs")
    .select("channel_flags")
    .eq("user_id", input.userId)
    .eq("topic", input.topic)
    .maybeSingle();

  const allowed = isAllowed(
    input.topic,
    input.channel,
    (pref?.channel_flags ?? null) as ChannelFlags | null,
  );

  // 행을 **먼저** 만든다. dedupe 유니크가 동시 실행을 막는 지점이 여기다.
  const { data: created, error } = await admin
    .from("notifications")
    .insert({
      user_id: input.userId,
      topic: input.topic,
      channel: input.channel,
      template_key: input.templateKey,
      // 참조와 숫자만. 본문은 넣지 않는다.
      payload_json: input.params,
      body_hash: createHash("sha256").update(body).digest("hex"),
      dedupe_key: input.dedupeKey ?? null,
    })
    .select("id")
    .maybeSingle();

  // 같은 열쇠가 이미 있다 — 이미 보낸 알림이다. 두 번 보내지 않는다.
  if (error?.code === "23505") return { status: "duplicate" };
  if (error || !created) {
    return { status: "failed", id: "", reason: "알림을 기록하지 못했습니다.", retryable: true };
  }

  /**
   * **껐어도 행은 남긴다.** 수신 설정을 껐다는 것은 "보내지 말라" 이지 "그런 일이
   * 없었다" 가 아니다. 분쟁에서 필요한 사실은 "안내 대상이었고, 사용자가 꺼 두어
   * 보내지 않았다" 이며, 행을 안 만들면 그 사실이 사라진다(D-23).
   */
  if (!allowed) {
    await admin
      .from("notifications")
      // **시도 횟수는 0으로 둔다.** 발송사를 부른 적이 없다 — 우리가 보내지 않기로
      // 정한 것이고, 그것을 '1회 시도 실패' 로 적으면 재시도 통계가 거짓이 된다.
      .update({ failed_at: new Date().toISOString(), failure_reason: SEND_BLOCKED_BY_PREFS })
      .eq("id", created.id);

    return { status: "skipped", id: created.id, reason: SEND_BLOCKED_BY_PREFS };
  }

  return deliver(created.id, input, body, 1);
}

/**
 * 어댑터를 부르고 결과를 기록한다. 재시도도 이 함수를 다시 부른다.
 *
 * **시도 횟수를 호출부가 정한다.** 여기서 1로 고정하면 재시도가 횟수를 되돌려
 * 상한이 영원히 오지 않는다.
 */
async function deliver(
  id: string,
  input: SendNotificationInput,
  body: string,
  attempt: number,
): Promise<SendNotificationResult> {
  const admin = createAdminClient();
  const name = resolveAdapterName();
  const adapter =
    name === "stub" ? createStubAdapter(input.channel) : createNoopAdapter(input.channel);

  let result: SendResult;
  try {
    result = await adapter.send({
      channel: input.channel,
      to: { userId: input.userId, email: input.email ?? null },
      body,
      topic: input.topic,
      templateKey: input.templateKey,
    });
  } catch {
    // 어댑터가 던진 예외는 일시적일 수 있다 — 다시 시도할 수 있는 실패로 다룬다.
    // **예외 메시지를 그대로 저장하지 않는다**(§7.3, CLAUDE.md §5.3).
    result = { ok: false, failureReason: "발송 중 오류가 발생했습니다.", retryable: true };
  }

  const now = new Date().toISOString();

  if (result.ok) {
    await admin
      .from("notifications")
      .update({
        sent_at: now,
        // 앱 알림함은 발송사가 없다 — 기록이 곧 전달이라 도달 시각을 같이 남긴다.
        ...(input.channel === "in_app" ? { delivered_at: now } : {}),
        provider_message_id: result.providerMessageId,
        attempt_count: attempt,
      })
      .eq("id", id);

    return { status: "sent", id };
  }

  await admin
    .from("notifications")
    .update({ failed_at: now, failure_reason: result.failureReason, attempt_count: attempt })
    .eq("id", id);

  return { status: "failed", id, reason: result.failureReason, retryable: result.retryable };
}

/**
 * 실패한 알림 재시도.
 *
 * **다시 시도할 수 있는 실패만** 대상이다. 잘못된 주소를 세 번 보내도 결과는 같고,
 * 수신 설정으로 막힌 것은 재시도가 아니라 설정 변경으로 풀린다.
 * 상한(`MAX_SEND_ATTEMPTS`)에 닿으면 멈춘다 — 영구 오류가 큐를 영원히 막지 않게.
 */
export async function retryNotification(id: string): Promise<SendNotificationResult> {
  const admin = createAdminClient();

  const { data: row } = await admin
    .from("notifications")
    .select("id, user_id, topic, channel, template_key, payload_json, attempt_count, failed_at, sent_at")
    .eq("id", id)
    .maybeSingle();

  if (!row) return { status: "failed", id, reason: "알림을 찾을 수 없습니다.", retryable: false };
  if (row.sent_at) return { status: "sent", id };
  if (row.attempt_count >= MAX_SEND_ATTEMPTS) {
    return { status: "failed", id, reason: "재시도 상한에 닿았습니다.", retryable: false };
  }

  const templateKey = row.template_key as TemplateKey | null;
  if (templateKey === null || !(templateKey in NOTIFICATION_TEMPLATES)) {
    return { status: "failed", id, reason: "문장 틀이 없습니다.", retryable: false };
  }

  const body = renderBody(templateKey, (row.payload_json ?? {}) as Record<string, unknown>);
  if (body === null) {
    return { status: "failed", id, reason: "문장 틀이 없습니다.", retryable: false };
  }

  // 이전 실패 자국을 지우고 다시 시도한다. 시도 횟수는 누적한다.
  await admin
    .from("notifications")
    .update({ failed_at: null, failure_reason: null })
    .eq("id", id);

  return deliver(
    id,
    {
      userId: row.user_id,
      topic: row.topic as NotificationTopic,
      channel: row.channel as NotificationChannel,
      templateKey,
      params: (row.payload_json ?? {}) as Record<string, unknown>,
    },
    body,
    row.attempt_count + 1,
  );
}
