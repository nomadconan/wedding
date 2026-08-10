import type { NotificationChannel } from "@/lib/core/schemas/notification";

/**
 * 발송 어댑터 (S4-13 · D-28)
 *
 * **골격만 만든다.** 실제 발송(이메일·SMS·알림톡·푸시)은 외부 서비스 계약이 필요하고
 * 그 계약은 아직 없다. 그렇다고 발송 경로를 미루면 **증적(D-23)이 성립하지 않는다** —
 * 기록은 발송을 시도할 때 남는 것이지 발송이 성공해야 남는 것이 아니다.
 *
 * 그래서 인터페이스를 먼저 못박고 로컬 스텁을 끼운다. 계약이 되면 어댑터 하나를
 * 갈아 끼우면 되고, 호출부와 기록 경로는 그대로다.
 */
export type SendRequest = {
  channel: NotificationChannel;
  /** 수신자. 채널이 무엇을 필요로 하는지는 어댑터가 안다. */
  to: { userId: string; email?: string | null };
  /** 렌더된 본문. **어댑터 밖으로 나가지 않으며 어디에도 저장하지 않는다**(§7.3). */
  body: string;
  topic: string;
  templateKey: string;
};

export type SendResult =
  | { ok: true; providerMessageId: string | null }
  /** `retryable` 이 false 면 다시 시도하지 않는다 — 잘못된 주소를 세 번 보내도 결과는 같다. */
  | { ok: false; failureReason: string; retryable: boolean };

export type NotificationChannelAdapter = {
  channel: NotificationChannel;
  send(request: SendRequest): Promise<SendResult>;
};

/**
 * 어댑터 선택.
 *
 * **프로덕션에서 스텁이 도는 것을 막는다.** 스텁은 아무것도 보내지 않으면서 성공을
 * 돌려주므로, 운영에서 돌면 "보냈다" 는 기록만 쌓이고 사용자는 아무것도 받지 못한다.
 * 그 상태는 증적이 아니라 거짓말이다.
 */
export function resolveAdapterName(): "stub" | "noop" {
  const configured = process.env.NOTIFY_ADAPTER;

  if (process.env.NODE_ENV === "production") {
    if (configured === "stub") {
      throw new Error(
        "NOTIFY_ADAPTER=stub 은 프로덕션에서 쓸 수 없습니다. 실제 발송 어댑터를 붙이거나 noop 으로 두세요.",
      );
    }

    return "noop";
  }

  return configured === "noop" ? "noop" : "stub";
}
