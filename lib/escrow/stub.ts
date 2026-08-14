import {
  ESCROW_ADAPTER_NOT_READY,
  type EscrowAdapter,
  type EscrowHoldRequest,
  type EscrowResult,
  type EscrowSettleRequest,
} from "./adapter";

/**
 * 로컬 에스크로 스텁 (S5-09 · D-28 · O-03)
 *
 * **돈을 한 푼도 분리 보관하지 않는다. 대신 절차와 상태 기계를 실제와 똑같이 돌린다.**
 * 이 태스크가 증명해야 하는 것은 자금이 실제로 묶이는 것이 아니라
 * **예치 → 이행 확인 → 릴리즈/환불/조율**이 실제로 도는 것이다(커버리지 표가 "절차·
 * 기록만" 이라고 적은 그대로다).
 *
 * ── 흉내 내지 않는 것 ───────────────────────────────────────────────────────
 * 신탁 계좌·분리 보관·이자·예치 한도. 그것들은 **O-03 결론과 위탁사 계약**에 달려
 * 있어 지금 흉내 내면 실연동에서 버릴 코드가 된다. 우리 상태 기계에 들어오는 신호는
 * "맡았다 / 못 맡았다 / 풀었다 / 못 풀었다" 뿐이다.
 *
 * ── 스텁도 계약을 지킨다 ────────────────────────────────────────────────────
 * 같은 `idempotencyKey` 로 다시 오면 앞서 돌려준 것과 **같은 참조**를 돌려준다.
 * 지키지 않으면 실연동 시점에야 호출부의 버그가 드러나고, 그때는 **진짜 돈이 두 번
 * 묶이거나 두 번 풀린다.** 진짜 멱등 경계는 DB(`uq_escrow_holds_idempotency` ·
 * 회차당 홀드 1건 부분 유니크)다.
 */
const holds = new Map<string, string>();

export function createStubEscrowAdapter(): EscrowAdapter {
  return {
    name: "stub",

    async hold(request: EscrowHoldRequest): Promise<EscrowResult> {
      const forced = forcedFailure("hold");
      if (forced) return forced;

      if (!Number.isInteger(request.amount) || request.amount <= 0) {
        // 0원을 맡아 둘 수는 없다. 다시 시도해도 결과가 같다.
        return { ok: false, failureReason: "보관 금액이 0원입니다.", retryable: false };
      }

      const existing = holds.get(request.idempotencyKey);
      if (existing) return { ok: true, providerRef: existing, at: new Date().toISOString() };

      // 위탁 참조 형식을 흉내 낸다. 형식이 비슷해야 실연동 때 호출부가 안 바뀐다.
      const providerRef = `stub_escrow_${crypto.randomUUID()}`;
      holds.set(request.idempotencyKey, providerRef);

      return { ok: true, providerRef, at: new Date().toISOString() };
    },

    async settle(request: EscrowSettleRequest): Promise<EscrowResult> {
      const forced = forcedFailure("settle");
      if (forced) return forced;

      if (!request.providerRef) {
        return { ok: false, failureReason: "보관 참조가 없어 처리할 수 없습니다.", retryable: false };
      }

      const existing = holds.get(request.idempotencyKey);
      if (existing) return { ok: true, providerRef: existing, at: new Date().toISOString() };

      const providerRef = `stub_${request.direction}_${crypto.randomUUID()}`;
      holds.set(request.idempotencyKey, providerRef);

      return { ok: true, providerRef, at: new Date().toISOString() };
    },
  };
}

/**
 * 아무것도 하지 않고 **성공도 주장하지 않는** 어댑터. 프로덕션 기본값이다.
 *
 * 에스크로가 조용히 성공했다고 기록되면 고객은 **"안전거래로 보호받고 있다"** 는
 * 화면을 보며 안심한다. 그 안심이 거짓일 때 손해는 이미 발생한 뒤에 드러난다 —
 * 결제·지급 스텁보다 더 나쁠 수 있는 이유가 그것이다.
 */
export function createNoopEscrowAdapter(): EscrowAdapter {
  const notReady = {
    ok: false as const,
    failureReason: ESCROW_ADAPTER_NOT_READY,
    retryable: false,
  };

  return {
    name: "noop",
    async hold(): Promise<EscrowResult> {
      return notReady;
    },
    async settle(): Promise<EscrowResult> {
      return notReady;
    },
  };
}

/** 로컬에서 실패 경로를 시험하기 위한 스위치. 프로덕션에서는 스텁 자체가 못 돈다. */
function forcedFailure(stage: "hold" | "settle"): EscrowResult | null {
  const flag = process.env.ESCROW_STUB_FAIL;
  if (!flag) return null;
  if (flag !== "1" && flag !== stage) return null;

  return {
    ok: false,
    failureReason: `스텁이 ${stage} 실패를 흉내 냈습니다(ESCROW_STUB_FAIL).`,
    retryable: true,
  };
}

/** 테스트가 상태를 비울 수 있게 열어 둔다. */
export function resetStubEscrowState(): void {
  holds.clear();
}
