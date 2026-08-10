import { CHANNEL_PENDING, SEND_CHANNEL_NOT_READY } from "@/lib/core/schemas/notification";

import type { NotificationChannelAdapter, SendRequest, SendResult } from "./adapter";

/**
 * 로컬 스텁 어댑터 (S4-13 · D-28)
 *
 * **아무 데도 보내지 않는다. 대신 보냈다는 사실을 기록 경로에 흘려보낸다.**
 * 이 태스크가 증명해야 하는 것은 메일이 도착하는 것이 아니라 **발송·도달·열람·실패가
 * 각각 기록되는 경로가 실제로 도는 것**이다(D-23).
 *
 * **Mailpit(127.0.0.1:54324)을 쓰지 않는다.** 세 가지 이유다 —
 *  1. SMTP 로 보내려면 클라이언트 라이브러리가 필요한데 **새 의존성을 넣지 않는다**.
 *  2. Mailpit 의 HTTP API 로 메시지를 밀어 넣는 것은 발송이 아니라 **뷰어 조작**이다.
 *     우리가 보낸 적 없는 메일을 받은 것처럼 보이게 만드는 것이라 증적으로서 의미가 없다.
 *  3. 확인해야 할 것은 메일 본문이 아니라 `notifications` 행의 상태 전이다. 그것은
 *     `npm run db:rls` 와 플로우 스크립트가 DB 에서 직접 본다.
 *
 * 다만 **Supabase Auth 는 이미 Mailpit 으로 확인 메일을 보내고 있다.** 실제 SMTP 발송이
 * 필요해지는 시점(외부 계약 후)에는 그 경로를 어댑터로 감싸면 되고, 그때 이 파일 대신
 * 새 어댑터를 끼운다.
 *
 * 스텁이 하는 일:
 *  · 아직 계약하지 않은 채널(SMS·푸시)은 **실패로 돌려준다** — 켜 뒀다고 나가는 것처럼
 *    기록하면 그것이 곧 거짓 증적이다. 재시도 대상도 아니다.
 *  · 나머지는 성공으로 돌려주고 **가짜 발송사 id** 를 만든다. 형식이 실제와 같아야
 *    웹훅 대조 경로(provider_message_id 유니크)를 지금 시험할 수 있다.
 */
export function createStubAdapter(channel: SendRequest["channel"]): NotificationChannelAdapter {
  return {
    channel,
    async send(request: SendRequest): Promise<SendResult> {
      if (CHANNEL_PENDING[request.channel] !== undefined) {
        return { ok: false, failureReason: SEND_CHANNEL_NOT_READY, retryable: false };
      }

      // 이메일인데 주소가 없으면 보낼 수 없다. 다시 시도해도 결과가 같다.
      if (request.channel === "email" && !request.to.email) {
        return { ok: false, failureReason: "수신 이메일 주소가 없습니다.", retryable: false };
      }

      // 앱 알림함은 발송사가 없다. 기록 자체가 전달이다.
      if (request.channel === "in_app") return { ok: true, providerMessageId: null };

      // 발송사 id 형식만 흉내 낸다. **본문은 어디에도 남기지 않는다**(§7.3).
      return {
        ok: true,
        providerMessageId: `stub-${request.channel}-${crypto.randomUUID()}`,
      };
    },
  };
}

/** 아무것도 하지 않고 성공도 주장하지 않는 어댑터. 프로덕션 기본값이다. */
export function createNoopAdapter(channel: SendRequest["channel"]): NotificationChannelAdapter {
  return {
    channel,
    async send(): Promise<SendResult> {
      return {
        ok: false,
        failureReason: "발송 어댑터가 연결되지 않았습니다.",
        retryable: false,
      };
    },
  };
}
