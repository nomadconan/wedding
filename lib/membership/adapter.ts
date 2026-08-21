/**
 * 멤버십 구독 어댑터 (S7-11 · D-28)
 *
 * S4-08(보증금) · S5-06(회차 결제) · S5-07(지급) · S5-09(에스크로)가 세운 형태를
 * 그대로 쓴다 — **인터페이스를 먼저 못박고 로컬 스텁을 끼운다.** 토스 계약이 되면
 * 어댑터 하나를 갈아 끼우면 되고 호출부·기록 경로는 그대로다.
 *
 * ── 회차 결제 어댑터와 왜 나누는가 ─────────────────────────────────────────
 * 회차 결제는 **한 번 승인하고 끝나는** 것이고 구독은 **주기마다 갱신되는** 것이다.
 * 상태 기계가 다르고(구독 시작·갱신·해지 예약·만료) PG API 도 다르다(빌링키).
 * 하나로 합치면 인터페이스가 "무엇을 하는지 모르는" 모양이 되고, 실연동에서 한쪽
 * 규칙이 다른 쪽으로 새어 들어온다.
 *
 * ── 이 어댑터가 다루지 않는 것 ──────────────────────────────────────────────
 * **금액을 정하지 않는다.** `app_settings.membership.monthly_price` 가 갖고 호출자가
 * 넘긴다 — 값이 없으면 **호출조차 하지 않는다**(O-17).
 * **상태를 기록하지 않는다.** `memberships`·`subscription_payments` 에 쓰는 것은
 * `lib/membership/actions.ts` 의 일이다 — 어댑터가 DB 를 알면 실연동 어댑터마다
 * 기록 로직이 갈라진다.
 * **기간을 정하지 않는다.** 주기 길이는 `membership.period_days` 가 갖는다.
 */

export type SubscribeRequest = {
  userId: string;
  amount: number;
  currency: string;
  /** CLAUDE.md §6 — 결제는 Idempotency-Key 필수. 서버가 만든다. */
  idempotencyKey: string;
};

export type CancelSubscriptionRequest = {
  /** 구독 시작 때 받은 참조. 무엇을 끊을지 가리킨다. */
  providerRef: string;
  idempotencyKey: string;
  reason: string;
};

export type SubscribeResult =
  | { ok: true; providerRef: string; approvedAt: string }
  /** `retryable` 이 false 면 다시 시도하지 않는다 — 같은 요청을 세 번 해도 결과가 같다. */
  | { ok: false; failureReason: string; retryable: boolean };

export type CancelResult =
  | { ok: true; providerRef: string }
  | { ok: false; failureReason: string; retryable: boolean };

export type MembershipAdapter = {
  name: string;
  subscribe(request: SubscribeRequest): Promise<SubscribeResult>;
  cancel(request: CancelSubscriptionRequest): Promise<CancelResult>;
};

export const MEMBERSHIP_ADAPTER_NOT_READY = "구독 결제 어댑터가 연결되지 않았습니다.";

/**
 * 어댑터 선택.
 *
 * **프로덕션에서 스텁이 도는 것을 막는다.** 회차 결제(S5-06)와 같은 규칙이다.
 * 스텁이 운영에서 돌면 **받지 않은 돈으로 멤버십이 열리고**, 그 등급이 AI 턴 상한을
 * 풀며(§5.6), `subscription_payments` 에 받은 적 없는 금액이 쌓인다 — 장부는 정상으로
 * 보이는데 돈은 오지 않았다.
 *
 * 그래서 프로덕션 기본값은 `noop` 이며, noop 은 성공을 주장하지 않고 **실패를
 * 돌려준다** — 구독이 안 되는 것은 고칠 수 있는 사고이고, 안 된 구독이 됐다고
 * 기록되는 것은 되돌릴 수 없는 사고다.
 */
export function resolveMembershipAdapterName(): "stub" | "noop" {
  const configured = process.env.MEMBERSHIP_ADAPTER;

  if (process.env.NODE_ENV === "production") {
    if (configured === "stub") {
      throw new Error(
        "MEMBERSHIP_ADAPTER=stub 은 프로덕션에서 쓸 수 없습니다. 실제 결제 어댑터를 붙이거나 noop 으로 두세요.",
      );
    }

    return "noop";
  }

  return configured === "noop" ? "noop" : "stub";
}

/** 아무것도 하지 않고 **실패를 돌려준다.** 성공을 주장하지 않는 것이 요점이다. */
export function createNoopMembershipAdapter(): MembershipAdapter {
  return {
    name: "noop",

    async subscribe() {
      return { ok: false, failureReason: MEMBERSHIP_ADAPTER_NOT_READY, retryable: false };
    },

    async cancel() {
      return { ok: false, failureReason: MEMBERSHIP_ADAPTER_NOT_READY, retryable: false };
    },
  };
}
