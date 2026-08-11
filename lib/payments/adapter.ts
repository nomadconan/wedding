/**
 * 보증금 결제 어댑터 (S4-08 골격 · D-22 · D-28)
 *
 * **골격만 만든다.** 실제 결제(토스)는 외부 계약과 심사가 필요하고 그것은 아직 없다
 * (D-28). 결제 자체를 미루면 예약 흐름 전체가 서지 않으므로, S4-13 이 알림에서 쓴
 * 방식을 그대로 가져온다 — **인터페이스를 먼저 못박고 로컬 스텁을 끼운다.**
 * 계약이 되면 어댑터 하나를 갈아 끼우면 되고 호출부·기록 경로는 그대로다.
 *
 * ── 이 어댑터가 다루지 않는 것 ──────────────────────────────────────────────
 * **금액을 정하지 않는다.** 금액은 `app_settings.consultation.deposit_amount` 가
 * 갖고 호출자가 넘긴다. 어댑터는 "얼마를 어디에 잡아 둔다" 만 안다.
 *
 * **상태를 기록하지 않는다.** `consultation_deposits` 에 쓰는 것은 호출자의 일이다.
 * 어댑터가 DB 를 알면 실연동 어댑터마다 기록 로직이 갈라진다.
 *
 * ── 멱등 ────────────────────────────────────────────────────────────────────
 * `idempotencyKey` 를 어댑터까지 넘긴다. 실제 PG 는 이 값을 받아 같은 요청을 두 번
 * 처리하지 않는다. 스텁도 같은 계약을 지킨다 — 계약을 지키지 않는 스텁은 실연동
 * 시점에 드러날 문제를 지금 숨기는 것이다.
 */
export type DepositHoldRequest = {
  consultationId: string;
  amount: number;
  currency: string;
  /** CLAUDE.md §6 — 결제는 Idempotency-Key 필수. */
  idempotencyKey: string;
};

export type DepositReleaseRequest = {
  consultationId: string;
  /** 보관 시점에 받은 참조. 무엇을 풀지 가리킨다. */
  providerRef: string;
  amount: number;
  /** 환불인가 지급(몰취)인가. */
  direction: "refund" | "forfeit";
  idempotencyKey: string;
};

export type PaymentResult =
  | { ok: true; providerRef: string }
  /** `retryable` 이 false 면 다시 시도하지 않는다 — 같은 요청을 세 번 해도 결과가 같다. */
  | { ok: false; failureReason: string; retryable: boolean };

export type DepositAdapter = {
  name: string;
  hold(request: DepositHoldRequest): Promise<PaymentResult>;
  release(request: DepositReleaseRequest): Promise<PaymentResult>;
};

/** 재시도 상한. S4-13 의 알림 발송과 같은 값·같은 이유다. */
export const MAX_PAYMENT_ATTEMPTS = 3;

export function canRetryPayment(attemptCount: number): boolean {
  return attemptCount < MAX_PAYMENT_ATTEMPTS;
}

export const PAYMENT_ADAPTER_NOT_READY = "결제 어댑터가 연결되지 않았습니다.";

/**
 * 어댑터 선택.
 *
 * **프로덕션에서 스텁이 도는 것을 막는다.** 스텁은 돈을 한 푼도 옮기지 않으면서
 * 성공을 돌려주므로, 운영에서 돌면 `consultation_deposits` 에 "보관 중" 만 쌓이고
 * 실제로는 아무 데도 잡혀 있지 않다. 그 상태로 몰취 판정이 나면 **있지도 않은 돈을
 * 업체에 지급했다고 기록**하게 된다 — 증적이 아니라 거짓말이고, 알림 스텁보다
 * 위험이 크다(그쪽은 안 보내고 보냈다고 하는 것이지만, 이쪽은 돈이다).
 *
 * S4-13 의 `resolveAdapterName()` 과 같은 형태를 쓴다 — 두 어댑터가 같은 규칙으로
 * 안전해야 나중에 한쪽만 빠뜨리는 일이 없다.
 */
export function resolveDepositAdapterName(): "stub" | "noop" {
  const configured = process.env.PAYMENT_ADAPTER;

  if (process.env.NODE_ENV === "production") {
    if (configured === "stub") {
      throw new Error(
        "PAYMENT_ADAPTER=stub 은 프로덕션에서 쓸 수 없습니다. 실제 결제 어댑터를 붙이거나 noop 으로 두세요.",
      );
    }

    return "noop";
  }

  return configured === "noop" ? "noop" : "stub";
}
