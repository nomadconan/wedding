/**
 * 정산 지급 어댑터 (S5-07 · D-28)
 *
 * S4-08(보증금)·S5-06(회차 결제)이 세운 형태를 그대로 쓴다 — **인터페이스를 먼저
 * 못박고 로컬 스텁을 끼운다.** 실제 이체는 지급 대행 계약이 필요하고 그것은 아직 없다.
 *
 * ── 왜 결제 어댑터와 나누는가 ───────────────────────────────────────────────
 * 결제는 **고객에게서 받는** 승인이고 지급은 **업체·플래너에게 보내는** 이체다. 방향이 반대라
 * 상태 기계도 실패 사유도 다르다(승인 거절 vs 계좌 오류·한도). 하나로 합치면
 * 인터페이스가 "돈을 옮긴다" 는 모호한 모양이 되고, 실연동에서 한쪽 규칙이 다른 쪽으로
 * 새어 들어온다.
 *
 * ── 이 어댑터가 다루지 않는 것 ──────────────────────────────────────────────
 * **금액을 정하지 않는다.** 지급액은 정산서가 정하고 호출자가 넘긴다.
 * **상태를 기록하지 않는다.** `settlement_payouts` 에 쓰는 것은 `payout.ts` 의 일이다.
 * **계좌 정보를 다루지 않는다.** 정산 계좌는 아직 우리가 갖고 있지 않다(§7.3 — 갖게
 * 되면 암호화 저장과 마스킹이 함께 와야 한다). 지금은 **받는 쪽 식별자만** 넘긴다.
 */

/**
 * 돈을 받는 쪽.
 *
 * **S6-05 가 플래너를 더하면서 열었다.** 어댑터를 하나 더 만들지 않은 이유 — 업체
 * 지급과 플래너 지급은 **같은 방향·같은 대행사·같은 실패 사유**(계좌 오류·한도)다.
 * 어댑터를 나누면 같은 일을 두 벌 갖게 되고, 그것이 곧 **두 곳이 같은 값을 다르게
 * 해석하는** 자리가 된다(FIX-52 가 요율에서 실제로 그랬다). 반대로 결제 어댑터와는
 * 여전히 나뉘어 있다 — 그쪽은 **받는** 방향이라 상태 기계가 다르다.
 *
 * **누구에게 보내는가는 판정에 들어간다.** 식별자만 넘기면 호출부가 뒤바꿔도 어댑터가
 * 알 수 없다 — 종류를 함께 들어 **업체 정산을 플래너에게 보내는 요청이 만들어지지
 * 않게** 한다(FIX-45 가 드러낸 "누구의 것인가" 와 같은 자리).
 */
export type PayoutPayee =
  | { type: "vendor"; vendorId: string }
  | { type: "planner"; plannerId: string };

export type PayoutRequest = {
  /** 지급의 근거가 되는 원장 행. 업체는 `settlements`, 플래너는 `planner_settlements`. */
  ledgerId: string;
  payee: PayoutPayee;
  amount: number;
  currency: string;
  /** CLAUDE.md §6 — 이체는 Idempotency-Key 필수. 원장별 열쇠 함수가 만든다. */
  idempotencyKey: string;
};

export type PayoutResult =
  | { ok: true; providerRef: string; paidAt: string }
  /** `retryable` 이 false 면 다시 시도하지 않는다 — 같은 요청을 세 번 해도 결과가 같다. */
  | { ok: false; failureReason: string; retryable: boolean };

export type PayoutAdapter = {
  name: string;
  pay(request: PayoutRequest): Promise<PayoutResult>;
};

export const PAYOUT_ADAPTER_NOT_READY = "지급 어댑터가 연결되지 않았습니다.";

/** 재시도 상한. S4-08·S5-06 과 같은 값·같은 이유다. */
export const MAX_PAYOUT_ATTEMPTS = 3;

export function canRetryPayout(attemptCount: number): boolean {
  return attemptCount < MAX_PAYOUT_ATTEMPTS;
}

/**
 * 어댑터 선택.
 *
 * **프로덕션에서 스텁이 도는 것을 막는다.** 결제 스텁과 같은 이유이고 방향만 반대다 —
 * 결제 스텁이 돌면 받지 않은 돈을 받았다고 적히고, **지급 스텁이 돌면 보내지 않은 돈을
 * 보냈다고 적힌다.** 후자가 더 나쁠 수 있다: 업체는 정산서에 '지급 완료' 가 찍힌 것을
 * 보고 입금을 기다리다가, 며칠 뒤에야 돈이 오지 않았음을 알게 된다. 그 사이 우리
 * 장부는 "지급했다" 고 말하고 있으므로 **문의가 들어와도 우리 쪽에서는 정상**으로 보인다.
 *
 * 그래서 프로덕션 기본값은 `noop` 이며 성공을 주장하지 않고 **실패를 돌려준다.**
 */
export function resolvePayoutAdapterName(): "stub" | "noop" {
  const configured = process.env.PAYOUT_ADAPTER;

  if (process.env.NODE_ENV === "production") {
    if (configured === "stub") {
      throw new Error(
        "PAYOUT_ADAPTER=stub 은 프로덕션에서 쓸 수 없습니다. 실제 지급 어댑터를 붙이거나 noop 으로 두세요.",
      );
    }

    return "noop";
  }

  return configured === "noop" ? "noop" : "stub";
}
