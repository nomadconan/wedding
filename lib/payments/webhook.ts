import { createHmac, timingSafeEqual } from "node:crypto";

import { recordEvent } from "@/lib/audit/record";
import { decideWebhook, minimizeWebhook, webhookDedupeKey } from "@/lib/core/payment/payment";
import { payloadDigest } from "@/lib/contract/hash";
import { tryWrite } from "@/lib/db/write";
import { createAdminClient } from "@/lib/supabase/admin";

import { applyRefund, cancelPendingPayment } from "./charge";
import type { Json } from "@/types/database";

/**
 * 결제 웹훅 수신 (S5-06 · §3.4 payment_webhook_events · §7.3 · D-23 · D-28)
 *
 * ── 순서가 곧 보안이다 ──────────────────────────────────────────────────────
 *  1. **서명 검증** — 먼저 한다. 중복을 먼저 접으면 남이 보낸 이벤트 id 로 진짜
 *     이벤트를 막을 수 있다(선점 공격). 그래서 **서명이 틀린 요청은 수신 원장에
 *     행을 만들지 않는다** — 행을 만들면 그 id 가 점유된다.
 *  2. **중복 확인** — `(provider, event_id)` 유니크가 판정한다(0028). 코드가 먼저
 *     조회해 없으면 넣는 방식은 동시 수신에서 둘 다 통과한다.
 *  3. **상태 전이** — 그 다음이다.
 *
 * ── 원문을 저장하지 않는다 (§7.3) ───────────────────────────────────────────
 * PG 웹훅에는 카드·구매자 식별정보가 섞여 온다. 남기는 것은 **정규화 스냅샷**
 * (`minimizeWebhook`)과 **원문 해시**(sha256)뿐이다. 원문은 PG 사에 남아 있어
 * 분쟁 시 대조할 수 있다.
 *
 * ── 서명 비밀이 없으면 거부한다 ─────────────────────────────────────────────
 * **닫힌 쪽으로 실패한다.** 비밀이 없을 때 통과시키면 로컬 편의가 그대로 운영
 * 취약점이 된다 — 누구나 "결제됐다" 를 보낼 수 있고, 그것이 `paid` 로 적힌다.
 */
export type WebhookOutcome =
  | { status: "processed"; eventId: string; action: string }
  // `reason` 은 **쓰기가 실패했을 때만** 붙는다(FIX-73) — 처리 결과가 아니라
  // "기록을 못 남겼다" 를 운영에 알리는 자리다.
  | { status: "duplicate"; eventId: string; reason?: string }
  | { status: "ignored"; eventId: string; reason: string }
  | { status: "rejected"; reason: "bad_signature" | "no_secret" };

/** 우리가 다루는 이벤트. 나머지는 기록만 하고 넘긴다(무시도 기록이다). */
const HANDLED_EVENTS = ["payment.paid", "payment.cancelled", "payment.refunded"] as const;

export function verifyWebhookSignature(rawBody: string, signature: string | null): boolean {
  const secret = process.env.TOSS_SECRET_KEY;

  if (!secret || !signature) return false;

  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const given = signature.trim().toLowerCase();

  if (given.length !== expected.length) return false;

  // 길이가 같을 때만 비교한다. timingSafeEqual 은 길이가 다르면 던진다.
  return timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(given, "utf8"));
}

export async function handleWebhook(input: {
  provider: string;
  rawBody: string;
  signature: string | null;
  /**
   * **웹훅에는 사람이 없으므로 null 이다**(D-173 · FIX-72).
   * 전에는 0 으로 채운 uuid 를 넣었는데 `entity_events.actor_id` 는 `auth.users` 를
   * 참조해 **FK 가 거절했고 증적이 통째로 사라졌다** — `recordEvent` 가 결과를
   * 보긴 했지만 부르는 쪽은 그것을 몰랐다. 실행자는 `source` 가 말한다.
   */
  actorId: string | null;
}): Promise<WebhookOutcome> {
  const admin = createAdminClient();

  if (!process.env.TOSS_SECRET_KEY) {
    return { status: "rejected", reason: "no_secret" };
  }

  const signatureOk = verifyWebhookSignature(input.rawBody, input.signature);

  let payload: Record<string, Json | undefined>;
  try {
    payload = JSON.parse(input.rawBody) as Record<string, Json | undefined>;
  } catch {
    // 읽을 수 없는 본문은 서명이 맞아도 처리할 수 없다.
    return { status: "rejected", reason: "bad_signature" };
  }

  const eventId = String(payload.eventId ?? "");
  const eventType = String(payload.eventType ?? "");

  // (1) 서명 검증이 먼저다. 실패하면 원장에 행을 만들지 않는다(선점 방지).
  const decision = decideWebhook({ signatureOk, alreadyProcessed: false });

  if (decision.action === "reject") return { status: "rejected", reason: "bad_signature" };

  if (eventId === "") return { status: "ignored", eventId: "", reason: "이벤트 식별자가 없습니다." };

  // 열쇠 형태를 순수 함수가 검증한다(빈 값이면 던진다).
  webhookDedupeKey({ provider: input.provider, eventId });

  const digest = payloadDigest(input.rawBody);
  const snapshot = minimizeWebhook(payload);

  // (2) 중복 판정은 DB 유니크가 한다.
  const { data: created, error: insertError } = await admin
    .from("payment_webhook_events")
    .insert({
      provider: input.provider,
      event_id: eventId,
      event_type: eventType,
      payment_key: (snapshot.paymentKey as string | undefined) ?? null,
      payload_digest: digest,
      signature_ok: true,
      status: "received",
    })
    .select("id")
    .maybeSingle();

  if (insertError) {
    if ((insertError as { code?: string }).code === "23505") {
      // PG 재시도는 정상 동작이다. 오류가 아니라 **센다** — 우리 처리 실패를
      // 알아보는 신호가 된다(0028 attempt_count).
      // **세었는지도 값으로 받는다.** `tryWrite` 의 boolean 을 버리면
      // `check:writes` 가 잡는다 — 그게 "삼키는 것이 아니다" 를 코드로 지키는
      // 방법이고, 여기서는 못 센 사실을 응답에 적어 운영이 볼 수 있게 한다.
      const bumped = await bumpAttempt(input.provider, eventId);

      return {
        status: "duplicate",
        eventId,
        reason: bumped ? undefined : "재시도 횟수를 갱신하지 못했습니다.",
      };
    }

    return { status: "ignored", eventId, reason: "수신 기록을 남기지 못했습니다." };
  }

  const eventRowId = (created as { id: string }).id;

  // (3) 상태 전이.
  if (!(HANDLED_EVENTS as readonly string[]).includes(eventType)) {
    // **여기서는 던지지 않는다**(FIX-73). 던지면 라우트가 5xx 를 내고 PG 가
    // 재전송하는데, 재전송이 같은 이유로 또 실패하면 **무한 재시도**가 된다.
    // 값으로 받아 응답에 적는다 — 삼키는 것이 아니다.
    const marked = await tryWrite(
      "payment_webhook_events.update:ignore-unhandled",
      admin
        .from("payment_webhook_events")
        .update({ status: "ignored", last_error: null })
        .eq("id", eventRowId),
    );

    return {
      status: "ignored",
      eventId,
      reason: `다루지 않는 이벤트입니다: ${eventType}${marked ? "" : " (수신 기록 갱신 실패)"}`,
    };
  }

  const paymentKey = (snapshot.paymentKey as string | undefined) ?? null;

  const { data: paymentRow } = paymentKey
    ? await admin
        .from("payments")
        .select("id, status, amount, refunded_amount")
        .eq("toss_payment_key", paymentKey)
        .maybeSingle()
    : { data: null };

  const payment = paymentRow as {
    id: string;
    status: string;
    amount: number;
    refunded_amount: number;
  } | null;

  if (!payment) {
    // 웹훅이 우리 승인 응답보다 먼저 도착할 수 있다. 그래도 **기록은 남긴다** —
    // 나중에 "그 이벤트를 받았는가" 를 답할 수 있어야 한다(0028 근거).
    const marked = await tryWrite(
      "payment_webhook_events.update:ignore-unmatched",
      admin
        .from("payment_webhook_events")
        .update({ status: "ignored", last_error: "매칭되는 결제를 찾지 못했습니다." })
        .eq("id", eventRowId),
    );

    return {
      status: "ignored",
      eventId,
      reason: `매칭되는 결제를 찾지 못했습니다.${marked ? "" : " (수신 기록 갱신 실패)"}`,
    };
  }

  // 연결을 못 걸어도 처리는 이어 간다 — 이벤트 행에 `payment_id` 가 비는 것은
  // **조회가 불편해지는 일**이지 돈이 틀어지는 일이 아니다. 대신 아래 증적에 적는다.
  const linked = await tryWrite(
    "payment_webhook_events.update:link-payment",
    admin
      .from("payment_webhook_events")
      .update({ payment_id: payment.id })
      .eq("id", eventRowId),
  );

  let action = eventType;

  if (eventType === "payment.cancelled") {
    await cancelPendingPayment({
      paymentId: payment.id,
      reason: "결제사 취소 통지",
      actorId: input.actorId,
    });
  }

  if (eventType === "payment.refunded") {
    const amount = Number(snapshot.amount ?? 0);
    const requested = Number.isInteger(amount) && amount > 0 ? amount : payment.amount - payment.refunded_amount;

    await applyRefund({
      paymentId: payment.id,
      amount: requested,
      reason: "결제사 환불 통지",
      actorId: input.actorId,
    });

    action = `${eventType}:${requested}`;
  }

  // 정규화 스냅샷만 담는다. 원문이 아니다(§7.3 · payments_webhook_no_pii CHECK).
  const snapped = await tryWrite(
    "payments.update:webhook-snapshot",
    admin.from("payments").update({ raw_webhook_json: snapshot }).eq("id", payment.id),
  );

  /**
   * **이 줄이 이 함수에서 가장 위험하다.**
   *
   * 못 적으면 이벤트가 `received` 로 남고, PG 가 재전송하면 **취소·환불을 다시
   * 탄다.** 그쪽이 멱등 가드를 갖고 있어(`canCancelPayment` · 환불 누계 판정)
   * 실제 중복 청구로 이어지지는 않지만, **그 가드가 마지막 방어선이 된다.**
   * 그래서 던지지 않되(무한 재전송) **증적에 반드시 적는다** — FIX-72 가
   * `audit_lost:1` 을 밖으로 낸 것과 같은 모양이다.
   */
  const finished = await tryWrite(
    "payment_webhook_events.update:mark-processed",
    admin
      .from("payment_webhook_events")
      .update({ status: "processed", processed_at: new Date().toISOString() })
      .eq("id", eventRowId),
  );

  const writeFlags = [
    linked ? null : "linkFailed=1",
    snapped ? null : "snapshotFailed=1",
    finished ? null : "markProcessedFailed=1",
  ].filter((flag) => flag !== null);

  await recordEvent({
    entityType: "payment",
    entityId: payment.id,
    eventType: "payment_webhook_processed",
    actor: { id: input.actorId },
    source: "system",
    memo: [`event=${eventType}`, ...writeFlags].join(" "),
  });

  return { status: "processed", eventId, action };
}

async function bumpAttempt(provider: string, eventId: string): Promise<boolean> {
  const admin = createAdminClient();

  const { data } = await admin
    .from("payment_webhook_events")
    .select("id, attempt_count")
    .eq("provider", provider)
    .eq("event_id", eventId)
    .maybeSingle();

  const row = data as { id: string; attempt_count: number } | null;
  // 행이 없으면 셀 것도 없다 — 실패가 아니다.
  if (!row) return true;

  // 횟수를 못 올려도 **처리 자체를 막지 않는다.** 던지면 재전송 경로가 통째로
  // 끊긴다 — 세는 일이 못 세는 것보다 낫지만, 그것 때문에 처리를 잃지는 않는다.
  return tryWrite(
    "payment_webhook_events.update:bump-attempt",
    admin
      .from("payment_webhook_events")
      .update({ attempt_count: row.attempt_count + 1 })
      .eq("id", row.id),
  );
}
