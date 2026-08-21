import {
  createNoopMembershipAdapter,
  resolveMembershipAdapterName,
  type CancelResult,
  type CancelSubscriptionRequest,
  type MembershipAdapter,
  type SubscribeRequest,
  type SubscribeResult,
} from "./adapter";

/**
 * 로컬 구독 결제 스텁 (S7-11 · D-28)
 *
 * **돈을 한 푼도 옮기지 않는다. 대신 구독 상태 기계를 실제와 똑같이 돌린다.**
 * 이 태스크가 증명해야 하는 것은 카드가 긁히는 것이 아니라 **시작 → 유효 → 해지
 * 예약 → 만료 → 다시 시작**이 실제로 도는 것이다.
 *
 * ── 무엇을 흉내 내고 무엇을 흉내 내지 않는가 ────────────────────────────────
 * **흉내 낸다** — 시작·해지의 성공/실패, **멱등**(같은 열쇠 → 같은 참조), 참조 형식,
 * 승인 시각, 재시도 가능/불가능의 구분, **없는 구독의 해지 거절**.
 *
 * **흉내 내지 않는다** — 빌링키 발급·카드 등록창·자동 갱신 주기 실행·결제 실패 후
 * 재청구(dunning). 그것들은 **PG 와 배치의 일**이고 우리 상태 기계에 들어오는 신호는
 * 둘뿐이다(시작됐다·끊겼다). 흉내 낼수록 실연동 때 버릴 코드가 늘어난다.
 *
 * ── 스텁도 계약을 지킨다 ────────────────────────────────────────────────────
 * 같은 `idempotencyKey` 로 다시 오면 **앞서 돌려준 것과 같은 참조**를 돌려준다.
 * 스텁이 멱등을 안 지키면 실연동 시점에야 호출부의 버그가 드러나고, 그때는 진짜 돈이
 * 두 번 빠진다. 참조는 프로세스 메모리에 둔다 — **진짜 멱등 경계는 DB**
 * (`memberships` 의 사용자당 유니크 · 0048)다.
 */
const approvals = new Map<string, string>();
const canceled = new Set<string>();

/** 개발 중 실패 경로를 눌러 보는 스위치. 회차 결제 스텁과 같은 모양이다. */
function forcedFailure(action: "subscribe" | "cancel") {
  const forced = process.env.MEMBERSHIP_STUB_FAIL;

  if (forced !== action && forced !== "all") return null;

  return {
    ok: false as const,
    failureReason: `스텁 강제 실패(${action})`,
    retryable: process.env.MEMBERSHIP_STUB_FAIL_RETRYABLE === "true",
  };
}

export function createStubMembershipAdapter(): MembershipAdapter {
  return {
    name: "stub",

    async subscribe(request: SubscribeRequest): Promise<SubscribeResult> {
      const forced = forcedFailure("subscribe");
      if (forced) return forced;

      // **금액을 검사한다.** 어댑터가 금액을 정하지는 않지만, 0원 승인을 성공으로
      // 돌려주면 호출부의 실수가 "무료 멤버십" 으로 조용히 굳는다.
      if (!Number.isInteger(request.amount) || request.amount <= 0) {
        return { ok: false, failureReason: "구독 금액이 올바르지 않습니다.", retryable: false };
      }

      const existing = approvals.get(request.idempotencyKey);
      if (existing !== undefined) {
        return { ok: true, providerRef: existing, approvedAt: new Date().toISOString() };
      }

      const providerRef = `stub-sub-${request.idempotencyKey.slice(0, 24)}`;
      approvals.set(request.idempotencyKey, providerRef);

      return { ok: true, providerRef, approvedAt: new Date().toISOString() };
    },

    async cancel(request: CancelSubscriptionRequest): Promise<CancelResult> {
      const forced = forcedFailure("cancel");
      if (forced) return forced;

      // **없는 구독을 끊었다고 하지 않는다.** 스텁이 아무 참조에나 성공을 주면
      // 호출부가 참조를 잘못 넘기는 버그를 실연동 때까지 못 본다.
      if (!request.providerRef.startsWith("stub-sub-")) {
        return { ok: false, failureReason: "알 수 없는 구독 참조입니다.", retryable: false };
      }

      canceled.add(request.providerRef);

      return { ok: true, providerRef: request.providerRef };
    },
  };
}

export function createMembershipAdapter(): MembershipAdapter {
  return resolveMembershipAdapterName() === "stub"
    ? createStubMembershipAdapter()
    : createNoopMembershipAdapter();
}

/** 테스트가 상태를 지운다. 프로세스 메모리라 테스트 사이에 남는다. */
export function resetMembershipStub(): void {
  approvals.clear();
  canceled.clear();
}
