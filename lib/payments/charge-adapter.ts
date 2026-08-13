/**
 * 회차 결제 어댑터 (S5-06 · D-28)
 *
 * S4-08 이 보증금에서 세운 형태를 그대로 쓴다 — **인터페이스를 먼저 못박고 로컬
 * 스텁을 끼운다.** 토스 계약이 되면 어댑터 하나를 갈아 끼우면 되고 호출부·기록
 * 경로는 그대로다.
 *
 * ── 보증금 어댑터와 왜 나누는가 ─────────────────────────────────────────────
 * 보증금은 **잡아 두었다 풀거나 몰취**하는 것(hold/release)이고 회차 결제는
 * **승인하고 취소하거나 환불**하는 것(charge/cancel/refund)이다. 상태 기계가 다르고
 * PG API 도 다르다. 하나로 합치면 인터페이스가 "무엇을 하는지 모르는" 모양이 되고,
 * 실연동에서 한쪽 규칙이 다른 쪽으로 새어 들어온다.
 *
 * ── 이 어댑터가 다루지 않는 것 ──────────────────────────────────────────────
 * **금액을 정하지 않는다.** 회차 금액은 계약이 정하고 호출자가 넘긴다.
 * **상태를 기록하지 않는다.** `payments` 에 쓰는 것은 `charge.ts` 의 일이다 —
 * 어댑터가 DB 를 알면 실연동 어댑터마다 기록 로직이 갈라진다.
 * **결제 수단을 고르지 않는다.** 카드·계좌 선택은 PG 화면의 일이며, 우리 상태
 * 기계에 영향을 주는 것은 "승인됐다·실패했다·취소됐다·환불됐다" 네 가지뿐이다.
 */

export type ChargeRequest = {
  paymentScheduleId: string;
  amount: number;
  currency: string;
  /** CLAUDE.md §6 — 결제는 Idempotency-Key 필수. `paymentIdempotencyKey()` 가 만든다. */
  idempotencyKey: string;
};

export type CancelRequest = {
  /** 승인 요청 때 받은 참조. 무엇을 거둘지 가리킨다. */
  providerRef: string;
  idempotencyKey: string;
  reason: string;
};

export type RefundRequest = {
  providerRef: string;
  /** **부분 환불이 기본형이다.** 전액 환불은 남은 금액 전부를 넘기는 경우일 뿐이다. */
  amount: number;
  idempotencyKey: string;
  reason: string;
};

export type ChargeResult =
  | { ok: true; providerRef: string; approvedAt: string }
  /** `retryable` 이 false 면 다시 시도하지 않는다 — 같은 요청을 세 번 해도 결과가 같다. */
  | { ok: false; failureReason: string; retryable: boolean };

export type SimpleResult =
  | { ok: true; providerRef: string }
  | { ok: false; failureReason: string; retryable: boolean };

export type ChargeAdapter = {
  name: string;
  charge(request: ChargeRequest): Promise<ChargeResult>;
  cancel(request: CancelRequest): Promise<SimpleResult>;
  refund(request: RefundRequest): Promise<SimpleResult>;
};

export const CHARGE_ADAPTER_NOT_READY = "결제 어댑터가 연결되지 않았습니다.";

/**
 * 어댑터 선택.
 *
 * **프로덕션에서 스텁이 도는 것을 막는다.** 보증금 어댑터(S4-08)와 같은 규칙이고
 * 무게는 더 크다 — 보증금은 잡아 두는 돈이지만 이쪽은 **계약 대금**이다. 스텁이
 * 운영에서 돌면 `payments` 에 `paid` 가 쌓이고, 회차가 완료로 넘어가고, 정산이
 * 그 금액을 업체에 지급 대상으로 올린다. **받지 않은 돈을 지급하게 된다.**
 *
 * 그래서 프로덕션 기본값은 `noop` 이며, noop 은 성공을 주장하지 않고 **실패를
 * 돌려준다** — 결제가 안 되는 것은 고칠 수 있는 사고이고, 안 된 결제가 됐다고
 * 기록되는 것은 되돌릴 수 없는 사고다.
 */
export function resolveChargeAdapterName(): "stub" | "noop" {
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
