import {
  PAYOUT_ADAPTER_NOT_READY,
  type PayoutAdapter,
  type PayoutRequest,
  type PayoutResult,
} from "./payout-adapter";

/**
 * 로컬 지급 스텁 (S5-07 · D-28)
 *
 * **돈을 한 푼도 옮기지 않는다. 대신 지급 상태 기계를 실제와 똑같이 돌린다.**
 * 이 태스크가 증명해야 하는 것은 이체가 일어나는 것이 아니라
 * **확정 → 지급 시도 → 성공/실패 → 재시도**가 실제로 도는 것이다.
 *
 * ── 무엇을 흉내 내고 무엇을 흉내 내지 않는가 ────────────────────────────────
 * **흉내 낸다** — 성공·실패, **멱등**(같은 열쇠 → 같은 참조), 참조 형식, 지급 시각,
 * 재시도 가능/불가능의 구분, 0원 이체 거절.
 *
 * **흉내 내지 않는다** — 계좌 검증·예금주 조회·은행 영업시간·이체 한도. 그것들은
 * 지급 대행사 API 의 모양에 달려 있어 지금 흉내 내면 실연동에서 버릴 코드가 된다.
 * 우리 상태 기계에 들어오는 신호는 "보냈다 / 못 보냈다" 둘뿐이다.
 *
 * ── 스텁도 계약을 지킨다 ────────────────────────────────────────────────────
 * 같은 `idempotencyKey` 로 다시 오면 앞서 돌려준 것과 **같은 참조**를 돌려준다.
 * 지키지 않으면 실연동 시점에야 호출부의 버그가 드러나고, 그때는 **진짜 돈이 두 번
 * 나간다.** 진짜 멱등 경계는 DB(`settlement_payouts.idempotency_key` 유니크 +
 * 정산서당 pending·paid 부분 유니크)이며 이 맵은 어댑터 계약을 지키기 위한 것이다.
 */
const transfers = new Map<string, string>();

export function createStubPayoutAdapter(): PayoutAdapter {
  return {
    name: "stub",

    async pay(request: PayoutRequest): Promise<PayoutResult> {
      const forced = forcedFailure();
      if (forced) return forced;

      if (!Number.isInteger(request.amount) || request.amount <= 0) {
        // 0원을 이체할 수는 없다. 다시 시도해도 결과가 같다.
        return { ok: false, failureReason: "지급 금액이 0원입니다.", retryable: false };
      }

      const existing = transfers.get(request.idempotencyKey);
      if (existing) return { ok: true, providerRef: existing, paidAt: new Date().toISOString() };

      // 실제 이체 참조 형식을 흉내 낸다. 형식이 비슷해야 실연동 때 호출부가 안 바뀐다.
      const providerRef = `stub_payout_${crypto.randomUUID()}`;
      transfers.set(request.idempotencyKey, providerRef);

      return { ok: true, providerRef, paidAt: new Date().toISOString() };
    },
  };
}

/**
 * 아무것도 하지 않고 **성공도 주장하지 않는** 어댑터. 프로덕션 기본값이다.
 *
 * 지급이 조용히 성공했다고 기록되면 업체는 정산서의 '지급 완료' 를 보고 입금을
 * 기다린다. 돈은 오지 않고 **우리 장부는 지급했다고 말하므로** 문의가 들어와도
 * 우리 쪽에서는 정상으로 보인다. 그래서 실연동 전에는 실패가 안전한 기본값이다.
 */
export function createNoopPayoutAdapter(): PayoutAdapter {
  return {
    name: "noop",
    async pay(): Promise<PayoutResult> {
      return { ok: false, failureReason: PAYOUT_ADAPTER_NOT_READY, retryable: false };
    },
  };
}

/** 로컬에서 실패 경로를 시험하기 위한 스위치. 프로덕션에서는 스텁 자체가 못 돈다. */
function forcedFailure(): PayoutResult | null {
  const flag = process.env.PAYOUT_STUB_FAIL;
  if (flag !== "1") return null;

  return {
    ok: false,
    failureReason: "스텁이 지급 실패를 흉내 냈습니다(PAYOUT_STUB_FAIL).",
    // 재시도 경로를 시험할 수 있어야 한다. 영구 실패는 0원 쪽에서 나온다.
    retryable: true,
  };
}

/** 테스트가 상태를 비울 수 있게 열어 둔다. */
export function resetStubPayoutState(): void {
  transfers.clear();
}
