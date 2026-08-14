/**
 * 에스크로 어댑터 (S5-09 · D-24 · D-28 · O-03)
 *
 * S4-08(보증금)·S5-06(결제)·S5-07(지급)이 세운 형태를 그대로 쓴다 — **인터페이스를
 * 먼저 못박고 로컬 스텁을 끼운다.**
 *
 * ── PG 위탁을 수용하는 모양이다 ─────────────────────────────────────────────
 * 자금 보관은 대금을 옮기는 결제보다 법적 요건이 무겁고(O-03 — 전자금융업 등록 등)
 * **우리가 직접 보관하지 않고 PG 사 에스크로에 위탁**하는 편이 현실적일 수 있다.
 * 그래서 이 인터페이스는 "우리가 계좌에 넣어 둔다" 를 전제하지 않는다 —
 * `hold` 가 하는 말은 **"이 금액을 조건부로 잡아 둔다"** 이고, 그것을 우리가 하든
 * 위탁사가 하든 호출부는 알 필요가 없다. `providerRef` 가 그 위탁 건을 가리킨다.
 *
 * ── 이 어댑터가 다루지 않는 것 ──────────────────────────────────────────────
 * **조건을 판정하지 않는다.** 이행 확인·기한·예식일 판정은 `lib/core/escrow` 가 하고
 * 어댑터는 그 결론(release / refund)만 받는다 — 판정이 어댑터마다 갈리면 위탁사를
 * 바꾸는 순간 릴리즈 규칙이 달라진다.
 * **금액을 정하지 않는다.** 잔금 회차 금액을 호출자가 넘긴다.
 * **상태를 기록하지 않는다.** `escrow_holds` 에 쓰는 것은 `lib/escrow/actions.ts` 다.
 */

export type EscrowHoldRequest = {
  bookingId: string;
  paymentId: string;
  amount: number;
  currency: string;
  /** CLAUDE.md §6 — 자금 이동은 Idempotency-Key 필수. */
  idempotencyKey: string;
};

export type EscrowSettleRequest = {
  /** 보관 시점에 받은 참조. 무엇을 푸는지 가리킨다(위탁 건일 수도 있다). */
  providerRef: string;
  amount: number;
  /** 업체에 넘기는가(release) 고객에게 돌려주는가(refund). */
  direction: "release" | "refund";
  idempotencyKey: string;
  reason: string;
};

export type EscrowResult =
  | { ok: true; providerRef: string; at: string }
  /** `retryable` 이 false 면 다시 시도하지 않는다 — 같은 요청을 세 번 해도 결과가 같다. */
  | { ok: false; failureReason: string; retryable: boolean };

export type EscrowAdapter = {
  name: string;
  hold(request: EscrowHoldRequest): Promise<EscrowResult>;
  settle(request: EscrowSettleRequest): Promise<EscrowResult>;
};

export const ESCROW_ADAPTER_NOT_READY = "안전거래 보관 수단이 연결되지 않았습니다.";

/** 재시도 상한. S4-08·S5-06·S5-07 과 같은 값·같은 이유다. */
export const MAX_ESCROW_ATTEMPTS = 3;

/**
 * 어댑터 선택.
 *
 * **프로덕션에서 스텁이 도는 것을 막는다.** 결제·지급 스텁과 같은 이유이고 무게는
 * 더 크다 — 에스크로 스텁이 운영에서 돌면 **맡기지도 않은 돈을 맡았다고 기록**하고,
 * 고객은 "안전거래로 보호받고 있다" 는 화면을 보며 안심한다. 그 안심이 거짓일 때
 * 손해는 이미 발생한 뒤에 드러난다.
 *
 * **O-03 이 미결인 동안에는 실예치 자체를 켜지 않는다**(`escrow.enabled` = false).
 * 어댑터 선택과 별개의 층이며, 둘 다 통과해야 실제로 돈이 움직인다.
 */
export function resolveEscrowAdapterName(): "stub" | "noop" {
  const configured = process.env.ESCROW_ADAPTER;

  if (process.env.NODE_ENV === "production") {
    if (configured === "stub") {
      throw new Error(
        "ESCROW_ADAPTER=stub 은 프로덕션에서 쓸 수 없습니다. 위탁 어댑터를 붙이거나 noop 으로 두세요.",
      );
    }

    return "noop";
  }

  return configured === "noop" ? "noop" : "stub";
}
