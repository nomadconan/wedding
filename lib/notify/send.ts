import { createHash } from "node:crypto";

import {
  NOTIFICATION_TEMPLATES,
  SEND_BLOCKED_BY_PREFS,
  isAllowed,
  renderBody,
  retryBlock,
  type ChannelFlags,
  type NotificationChannel,
  type NotificationTopic,
  type TemplateKey,
} from "@/lib/core/schemas/notification";
import { recordEvent } from "@/lib/audit/record";
import { tryWrite } from "@/lib/db/write";
import { createAdminClient } from "@/lib/supabase/admin";

import { resolveAdapterName, type SendResult } from "./adapter";
import { createNoopAdapter, createStubAdapter } from "./stub";
import type { Json } from "@/types/database";

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
  params: Record<string, Json | undefined>;
  /** 멱등 열쇠. `lib/core/schemas/notification.ts` 의 `dedupeKey()` 로 만든다. */
  dedupeKey?: string | null;
  /** 이메일 채널이 쓰는 주소. 저장하지 않고 어댑터에만 넘긴다. */
  email?: string | null;
};

/**
 * `recorded` — **그 결과를 행에 적었는가**(FIX-73f).
 *
 * `status` 와 다른 것을 말한다. `status: "sent"` 는 **발송사가 받았다** 이고,
 * `recorded: false` 는 **그 사실을 표에 못 적었다** 이다. 둘은 같이 생길 수 있고,
 * 그때가 **가장 위험하다** — 행이 `sent_at` 없이 남아 나중의 재시도가 이미 나간
 * 알림을 한 번 더 보낸다.
 *
 * 행이 아예 없는 경우(틀이 없거나 삽입 자체가 실패)엔 적을 것이 없으므로 빌다.
 */
export type SendNotificationResult =
  | { status: "sent"; id: string; recorded: boolean }
  | { status: "skipped"; id: string; reason: string; recorded: boolean }
  | { status: "failed"; id: string; reason: string; retryable: boolean; recorded?: boolean }
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
    /**
     * **`tryWrite` 다**(D-244). 보내는 일은 안 했지만 **행은 이미 들어갔고**,
     * `dedupe_key` 가 유니크라 **같은 사건으로 다시 부르면 `duplicate` 로 끝난다** —
     * 즉 재시도가 이 표시를 다시 적어 주지 못한다. 던져도 고쳐지지 않고,
     * 부르는 쪽은 대개 본 작업을 끝낸 뒤라 **알림 한 줄 때문에 거래가 실패한다.**
     *
     * 대신 **못 적은 것을 증적으로 남긴다** — 표시가 없으면 그 행은 화면에서
     * **아직 보낼 것처럼** 보이고, `retryNotification` 이 그것을 집어 **꺼 둔 사람에게
     * 보낼 수 있다**(그 경로는 이번에 막았다 — 아래 `retryNotification`).
     */
    const recorded = await tryWrite(
      "notifications.update:blocked-by-prefs",
      admin
        .from("notifications")
        // **시도 횟수는 0으로 둔다.** 발송사를 부른 적이 없다 — 우리가 보내지 않기로
        // 정한 것이고, 그것을 '1회 시도 실패' 로 적으면 재시도 통계가 거짓이 된다.
        .update({ failed_at: new Date().toISOString(), failure_reason: SEND_BLOCKED_BY_PREFS })
        .eq("id", created.id),
    );

    if (!recorded) await noteRecordFailure(created.id, "blocked_by_prefs");

    return { status: "skipped", id: created.id, reason: SEND_BLOCKED_BY_PREFS, recorded };
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
    /**
     * **이 회차에서 가장 위험한 한 줄이다**(FIX-73f).
     *
     * 바로 위에서 **알림은 이미 나갔다.** 던져도 발송을 되돌리지 못하고,
     * 부르는 쪽은 대개 결제·계약 같은 본 작업을 끝낸 뒤라 **알림 한 줄 때문에
     * 거래가 실패한다**(D-244).
     *
     * **못 적으면 같은 알림이 다시 나갈 수 있다.** 행은 `sent_at` 이 빈 채 남고,
     * 그것은 화면·재시도 경로에서 **아직 안 보낸 것**으로 읽힌다. 같은 사건으로
     * `sendNotification` 이 다시 불리는 것은 `dedupe_key` 가 막지만, **행 id 로 직접
     * 재시도하는 경로는 그 유니크를 지나지 않는다.**
     *
     * 어느 쪽이 더 나쁜가 — **두 번 보내는 쪽**이다. 안 보내지는 것은 사용자가
     * 화면에서 같은 사실을 다시 볼 수 있지만, 두 번 보내는 것은 **되돌릴 수 없고**
     * 수신 설정을 꺼 둔 사람에게까지 갈 수 있다. 그래서 **증적에 남기고**(아래),
     * 재시도 경로에 **수신 설정을 다시 보는 가드**를 넣었다.
     *
     * **실패 자국을 같은 UPDATE 에서 지운다** — 재시도가 성공했는데 `failed_at` 이
     * 남아 있으면 화면은 한 행을 **보냈고 동시에 실패했다** 고 읽는다.
     */
    const recorded = await tryWrite(
      "notifications.update:mark-sent",
      admin
        .from("notifications")
        .update({
          sent_at: now,
          // 앱 알림함은 발송사가 없다 — 기록이 곧 전달이라 도달 시각을 같이 남긴다.
          ...(input.channel === "in_app" ? { delivered_at: now } : {}),
          provider_message_id: result.providerMessageId,
          attempt_count: attempt,
          failed_at: null,
          failure_reason: null,
        })
        .eq("id", id),
    );

    if (!recorded) await noteRecordFailure(id, "sent");

    return { status: "sent", id, recorded };
  }

  /**
   * **`tryWrite` 다** — 위와 같은 이유로 발송사를 이미 불렀다(시도를 썼다).
   *
   * **못 적으면 `attempt_count` 가 안 올라간다** — 재시도 상한(`MAX_SEND_ATTEMPTS`)이
   * 그 칸을 보므로, 영구 오류가 **상한에 닿지 않은 채 계속 재시도된다.**
   */
  const recorded = await tryWrite(
    "notifications.update:mark-failed",
    admin
      .from("notifications")
      .update({ failed_at: now, failure_reason: result.failureReason, attempt_count: attempt })
      .eq("id", id),
  );

  if (!recorded) await noteRecordFailure(id, "failed");

  return {
    status: "failed",
    id,
    reason: result.failureReason,
    retryable: result.retryable,
    recorded,
  };
}

/**
 * 발송 결과를 **행에 못 적은 것 자체**를 증적으로 남긴다 (FIX-73f).
 *
 * `tryWrite` 가 콘솔에 한 줄 찍기는 하지만 **그것은 아무도 안 읽는다** — FIX-88 이
 * `logAiCall` 에서 배운 것이 그것이다. 알림은 분쟁에서 *"안내했는가"* 를 묻는
 * 기록이므로(D-23), **그 기록이 비었다는 사실 자체**가 남아야 한다.
 *
 * **본문도 수신자도 담지 않는다**(§7.3) — 행 id 와 어느 단계에서 못 적었는지만.
 */
async function noteRecordFailure(
  id: string,
  stage: "blocked_by_prefs" | "sent" | "failed",
): Promise<void> {
  await recordEvent({
    entityType: "notification",
    entityId: id,
    eventType: "notification_record_failed",
    // 배치·서버가 보낸다 — 사람이 없다(D-173).
    actor: { id: null },
    source: "system",
    afterState: stage,
    memo: `stage:${stage}`,
  });
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

  /**
   * **수신 설정을 함께 본다** (FIX-90).
   *
   * 전에는 이미 보냈는가·상한에 닿았는가 둘만 보고 `deliver()` 를 불렀는데,
   * `deliver` 는 `isAllowed` 를 보지 않는다 — 즉 **수신을 꺼 둔 사람에게 보낼 수
   * 있는 경로**가 열려 있었다. 이 함수의 머리글은 그러면 안 된다고 적어 둔 채였다.
   *
   * 판정은 `lib/core` 의 `retryBlock` 이 갖는다 — 네 가지를 한 자리에서 세야
   * 다음에 하나가 더 생겨도 같은 자리에 붙는다.
   */
  const { data: pref } = await admin
    .from("notification_prefs")
    .select("channel_flags")
    .eq("user_id", row.user_id)
    .eq("topic", row.topic)
    .maybeSingle();

  const block = retryBlock({
    sentAt: row.sent_at,
    attemptCount: row.attempt_count,
    allowed: isAllowed(
      row.topic as NotificationTopic,
      row.channel as NotificationChannel,
      (pref?.channel_flags ?? null) as ChannelFlags | null,
    ),
  });

  // 이미 보낸 것은 행이 그렇게 적혀 있다 — 적을 것이 없으므로 `recorded` 는 참이다.
  if (block === "already_sent") return { status: "sent", id, recorded: true };
  if (block === "blocked_by_prefs") {
    return { status: "skipped", id, reason: SEND_BLOCKED_BY_PREFS, recorded: true };
  }
  if (block === "attempts_exhausted") {
    return { status: "failed", id, reason: "재시도 상한에 닿았습니다.", retryable: false };
  }

  const templateKey = row.template_key as TemplateKey | null;
  if (templateKey === null || !(templateKey in NOTIFICATION_TEMPLATES)) {
    return { status: "failed", id, reason: "문장 틀이 없습니다.", retryable: false };
  }

  const body = renderBody(templateKey, (row.payload_json ?? {}) as Record<string, Json | undefined>);
  if (body === null) {
    return { status: "failed", id, reason: "문장 틀이 없습니다.", retryable: false };
  }

  /**
   * **이전 실패 자국을 여기서 지우지 않는다** (FIX-73f).
   *
   * 전에는 `failed_at`·`failure_reason` 을 미리 비워 두고 보냈는데, 그 쓰기가
   * 실패하면 성공 뒤에도 자국이 남아 행 하나가 **보냈고 동시에 실패한** 모양이
   * 됐다. 이제 `deliver` 의 성공 UPDATE 가 **같은 문장에서** 그 둘을 비운다 —
   * 쓰기가 하나 줄고 상태가 갈라짬 수 없게 됐다.
   *
   * 보내는 동안 행이 아직 '실패' 로 보이는 것은 맞는 말이다 — 아직 성공하지
   * 않았다.
   */
  return deliver(
    id,
    {
      userId: row.user_id,
      topic: row.topic as NotificationTopic,
      channel: row.channel as NotificationChannel,
      templateKey,
      params: (row.payload_json ?? {}) as Record<string, Json | undefined>,
    },
    body,
    row.attempt_count + 1,
  );
}
