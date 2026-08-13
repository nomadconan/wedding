import {
  CHARGE_ADAPTER_NOT_READY,
  type CancelRequest,
  type ChargeAdapter,
  type ChargeRequest,
  type ChargeResult,
  type RefundRequest,
  type SimpleResult,
} from "./charge-adapter";

/**
 * 로컬 회차 결제 스텁 (S5-06 · D-28)
 *
 * **돈을 한 푼도 옮기지 않는다. 대신 결제 상태 기계를 실제와 똑같이 돌린다.**
 * 이 태스크가 증명해야 하는 것은 카드가 긁히는 것이 아니라
 * **승인 → 회차 완료 → 완납 판정 / 실패 → 재시도 / 환불 → 부분·전액** 이 실제로
 * 도는 것이다(§3.4, D-23).
 *
 * ── 무엇을 흉내 내고 무엇을 흉내 내지 않는가 ────────────────────────────────
 * **흉내 낸다** — 승인·취소·환불의 성공/실패, **멱등**(같은 열쇠 → 같은 참조),
 * 참조 형식, 승인 시각, 재시도 가능/불가능의 구분, 남은 금액을 넘는 환불 거절.
 *
 * **흉내 내지 않는다** — 카드사 인증(3DS)·결제창·결제 수단 분기(가상계좌 입금 대기
 * 같은 비동기 승인)·부분 취소 수수료. 이유는 그것들이 **PG 화면과 정산의 일**이고
 * 우리 상태 기계에 들어오는 신호는 네 가지(승인·실패·취소·환불)뿐이기 때문이다.
 * 흉내 낼수록 실연동 때 버릴 코드가 늘어난다.
 *
 * ── 스텁도 계약을 지킨다 ────────────────────────────────────────────────────
 * **멱등을 흉내만 내지 않고 실제로 지킨다.** 같은 `idempotencyKey` 로 다시 오면
 * 앞서 돌려준 것과 **같은 참조**를 돌려준다. 스텁이 멱등을 안 지키면 실연동
 * 시점에야 호출부의 버그가 드러나고, 그때는 진짜 돈이 두 번 빠진다.
 *
 * 참조는 프로세스 메모리에 둔다 — **진짜 멱등 경계는 DB**(`payments.idempotency_key`
 * 유니크 + 회차당 pending 부분 유니크)다. 이 맵은 어댑터 계약을 지키기 위한 것이지
 * 그 자체가 보증은 아니다.
 */
const approvals = new Map<string, string>();
/** 승인 참조별 누적 환불액. 남은 금액을 넘는 환불을 스텁도 거절한다. */
const refunded = new Map<string, number>();
/** 승인 참조별 승인 금액. */
const approvedAmount = new Map<string, number>();

export function createStubChargeAdapter(): ChargeAdapter {
  return {
    name: "stub",

    async charge(request: ChargeRequest): Promise<ChargeResult> {
      const forced = forcedFailure("charge");
      if (forced) return forced;

      if (!Number.isInteger(request.amount) || request.amount <= 0) {
        // 0원을 승인할 수는 없다. 다시 시도해도 결과가 같다.
        return { ok: false, failureReason: "결제 금액이 0원입니다.", retryable: false };
      }

      const existing = approvals.get(request.idempotencyKey);
      if (existing) {
        return { ok: true, providerRef: existing, approvedAt: new Date().toISOString() };
      }

      // 실제 PG 참조 형식을 흉내 낸다. 형식이 비슷해야 실연동 때 호출부가 안 바뀐다.
      const providerRef = `stub_pay_${crypto.randomUUID()}`;
      approvals.set(request.idempotencyKey, providerRef);
      approvedAmount.set(providerRef, request.amount);

      return { ok: true, providerRef, approvedAt: new Date().toISOString() };
    },

    async cancel(request: CancelRequest): Promise<SimpleResult> {
      const forced = forcedFailure("cancel");
      if (forced) return forced;

      if (!request.providerRef) {
        return { ok: false, failureReason: "결제 참조가 없어 거둘 수 없습니다.", retryable: false };
      }

      const existing = approvals.get(request.idempotencyKey);
      if (existing) return { ok: true, providerRef: existing };

      const providerRef = `stub_cancel_${crypto.randomUUID()}`;
      approvals.set(request.idempotencyKey, providerRef);

      return { ok: true, providerRef };
    },

    async refund(request: RefundRequest): Promise<SimpleResult> {
      const forced = forcedFailure("refund");
      if (forced) return forced;

      if (!request.providerRef) {
        return { ok: false, failureReason: "결제 참조가 없어 환불할 수 없습니다.", retryable: false };
      }

      const existing = approvals.get(request.idempotencyKey);
      if (existing) return { ok: true, providerRef: existing };

      const approved = approvedAmount.get(request.providerRef);
      const already = refunded.get(request.providerRef) ?? 0;

      // 승인 금액을 아는 경우에만 본다. 모르는 참조(재기동 뒤)는 DB 가 이미 막는다.
      if (approved !== undefined && already + request.amount > approved) {
        return {
          ok: false,
          failureReason: "환불 가능액을 넘었습니다.",
          retryable: false,
        };
      }

      const providerRef = `stub_refund_${crypto.randomUUID()}`;
      approvals.set(request.idempotencyKey, providerRef);
      refunded.set(request.providerRef, already + request.amount);

      return { ok: true, providerRef };
    },
  };
}

/**
 * 아무것도 하지 않고 **성공도 주장하지 않는** 어댑터. 프로덕션 기본값이다.
 *
 * 결제가 조용히 성공했다고 기록되면 회차가 완료로 넘어가고 정산이 그 금액을 업체에
 * 지급 대상으로 올린다 — **받지 않은 돈을 지급**하게 된다. 그래서 실연동 전에는
 * 실패를 돌려주는 쪽이 안전한 기본값이다.
 */
export function createNoopChargeAdapter(): ChargeAdapter {
  const notReady = {
    ok: false as const,
    failureReason: CHARGE_ADAPTER_NOT_READY,
    retryable: false,
  };

  return {
    name: "noop",
    async charge(): Promise<ChargeResult> {
      return notReady;
    },
    async cancel(): Promise<SimpleResult> {
      return notReady;
    },
    async refund(): Promise<SimpleResult> {
      return notReady;
    },
  };
}

/** 로컬에서 실패 경로를 시험하기 위한 스위치. 프로덕션에서는 스텁 자체가 못 돈다. */
function forcedFailure(stage: "charge" | "cancel" | "refund"): ChargeResult | null {
  const flag = process.env.PAYMENT_STUB_FAIL;
  if (!flag) return null;
  if (flag !== "1" && flag !== stage) return null;

  return {
    ok: false,
    failureReason: `스텁이 ${stage} 실패를 흉내 냈습니다(PAYMENT_STUB_FAIL).`,
    // 재시도 경로를 시험할 수 있어야 한다. 영구 실패는 금액 0원 쪽에서 나온다.
    retryable: true,
  };
}

/** 테스트가 상태를 비울 수 있게 열어 둔다. */
export function resetStubChargeState(): void {
  approvals.clear();
  refunded.clear();
  approvedAmount.clear();
}
