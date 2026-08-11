import {
  PAYMENT_ADAPTER_NOT_READY,
  type DepositAdapter,
  type DepositHoldRequest,
  type DepositReleaseRequest,
  type PaymentResult,
} from "./adapter";

/**
 * 로컬 보증금 스텁 (S4-08 골격 · D-28)
 *
 * **돈을 한 푼도 옮기지 않는다. 대신 결제가 있었다는 사실을 기록 경로에 흘려보낸다.**
 * 이 태스크가 증명해야 하는 것은 카드가 실제로 긁히는 것이 아니라 **보관 → 판정 →
 * 환불/몰취의 상태 전이가 실제로 도는 것**이다(§3.11, D-23).
 *
 * ── 스텁도 계약을 지킨다 ────────────────────────────────────────────────────
 * **멱등을 흉내만 내지 않고 실제로 지킨다.** 같은 `idempotencyKey` 로 다시 오면
 * 앞서 돌려준 것과 **같은 참조**를 돌려준다. 스텁이 멱등을 안 지키면 실연동 시점에야
 * 호출부의 버그가 드러나고, 그때는 진짜 돈이 두 번 빠진다.
 *
 * 참조는 프로세스 메모리에 둔다 — 스텁의 수명은 개발 서버의 수명이면 충분하고,
 * **진짜 멱등 경계는 DB 의 `consultation_deposits.idempotency_key` 유니크**다.
 * 이 맵은 어댑터 계약을 지키기 위한 것이지 그 자체가 보증은 아니다.
 *
 * ── 실패도 만들 수 있어야 한다 ──────────────────────────────────────────────
 * 성공만 하는 스텁으로는 실패 경로(재시도·`failed` 기록)를 시험할 수 없다.
 * `PAYMENT_STUB_FAIL` 로 실패를 주문할 수 있게 둔다 — 로컬 전용 스위치다.
 */
const holds = new Map<string, string>();

export function createStubDepositAdapter(): DepositAdapter {
  return {
    name: "stub",

    async hold(request: DepositHoldRequest): Promise<PaymentResult> {
      const forced = forcedFailure("hold");
      if (forced) return forced;

      if (request.amount <= 0) {
        // 0원을 잡아 둘 수는 없다. 다시 시도해도 결과가 같다.
        return { ok: false, failureReason: "보증금 금액이 0원입니다.", retryable: false };
      }

      const existing = holds.get(request.idempotencyKey);
      if (existing) return { ok: true, providerRef: existing };

      // 실제 PG 참조 형식을 흉내 낸다. 형식이 비슷해야 실연동 때 호출부가 안 바뀐다.
      const providerRef = `stub_hold_${crypto.randomUUID()}`;
      holds.set(request.idempotencyKey, providerRef);

      return { ok: true, providerRef };
    },

    async release(request: DepositReleaseRequest): Promise<PaymentResult> {
      const forced = forcedFailure("release");
      if (forced) return forced;

      if (!request.providerRef) {
        return {
          ok: false,
          failureReason: "보관 참조가 없어 처리할 수 없습니다.",
          retryable: false,
        };
      }

      const existing = holds.get(request.idempotencyKey);
      if (existing) return { ok: true, providerRef: existing };

      const providerRef = `stub_${request.direction}_${crypto.randomUUID()}`;
      holds.set(request.idempotencyKey, providerRef);

      return { ok: true, providerRef };
    },
  };
}

/**
 * 아무것도 하지 않고 성공도 주장하지 않는 어댑터. **프로덕션 기본값이다.**
 *
 * 알림의 noop 과 같은 자리이지만 무게가 다르다 — 알림이 안 나가면 사용자가 못 받는
 * 것으로 끝나지만, 결제가 조용히 성공했다고 기록되면 있지도 않은 돈을 두고 판정이
 * 돌아간다. 그래서 실연동 전에는 **실패를 돌려주는 쪽이 안전한 기본값**이다.
 */
export function createNoopDepositAdapter(): DepositAdapter {
  return {
    name: "noop",
    async hold(): Promise<PaymentResult> {
      return { ok: false, failureReason: PAYMENT_ADAPTER_NOT_READY, retryable: false };
    },
    async release(): Promise<PaymentResult> {
      return { ok: false, failureReason: PAYMENT_ADAPTER_NOT_READY, retryable: false };
    },
  };
}

/** 로컬에서 실패 경로를 시험하기 위한 스위치. 프로덕션에서는 스텁 자체가 못 돈다. */
function forcedFailure(stage: "hold" | "release"): PaymentResult | null {
  const flag = process.env.PAYMENT_STUB_FAIL;
  if (!flag) return null;
  if (flag !== "1" && flag !== stage) return null;

  return {
    ok: false,
    failureReason: `스텁이 ${stage} 실패를 흉내 냈습니다(PAYMENT_STUB_FAIL).`,
    retryable: true,
  };
}

/** 테스트가 상태를 비울 수 있게 열어 둔다. */
export function resetStubDepositState(): void {
  holds.clear();
}
