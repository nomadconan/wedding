import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolvePayoutAdapterName } from "./payout-adapter";
import { createNoopPayoutAdapter, createStubPayoutAdapter, resetStubPayoutState } from "./payout-stub";

/**
 * 지급 스텁 계약 시험 (S5-07 · D-28)
 *
 * **깨지면 돈이 두 번 나가거나, 나가지 않은 돈이 나갔다고 기록된다.** 어댑터는
 * `lib/core` 가 아니지만 그런 불변식을 시험 없이 둘 수 없어 vitest 대상에 넣었다
 * (S5-06 이 결제 스텁에서 같은 판단을 했다).
 */
const ORIGINAL_ENV = process.env.NODE_ENV;
const ORIGINAL_ADAPTER = process.env.PAYOUT_ADAPTER;
const ORIGINAL_FAIL = process.env.PAYOUT_STUB_FAIL;

function setEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete (process.env as Record<string, string | undefined>)[key];
  else (process.env as Record<string, string | undefined>)[key] = value;
}

beforeEach(() => {
  resetStubPayoutState();
  setEnv("PAYOUT_STUB_FAIL", undefined);
});

afterEach(() => {
  setEnv("NODE_ENV", ORIGINAL_ENV);
  setEnv("PAYOUT_ADAPTER", ORIGINAL_ADAPTER);
  setEnv("PAYOUT_STUB_FAIL", ORIGINAL_FAIL);
});

const request = {
  settlementId: "11111111-1111-1111-1111-111111111111",
  vendorId: "22222222-2222-2222-2222-222222222222",
  amount: 9_500_000,
  currency: "KRW",
  idempotencyKey: "settlement:s1:payout:1",
};

describe("지급", () => {
  it("이체하면 참조와 시각을 준다", async () => {
    const result = await createStubPayoutAdapter().pay(request);

    expect(result.ok).toBe(true);
    expect(result.ok === true && result.providerRef).toMatch(/^stub_payout_/);
    expect(result.ok === true && Number.isNaN(Date.parse(result.paidAt))).toBe(false);
  });

  it("같은 멱등 열쇠는 같은 참조를 돌려준다 — 두 번 나가지 않는다", async () => {
    const adapter = createStubPayoutAdapter();
    const first = await adapter.pay(request);
    const second = await adapter.pay(request);

    expect(first.ok === true && second.ok === true && first.providerRef === second.providerRef).toBe(
      true,
    );
  });

  it("열쇠가 다르면 다른 이체다 — 명시적 재지급은 새 이체다", async () => {
    const adapter = createStubPayoutAdapter();
    const first = await adapter.pay(request);
    const second = await adapter.pay({ ...request, idempotencyKey: "settlement:s1:payout:2" });

    expect(first.ok === true && second.ok === true && first.providerRef !== second.providerRef).toBe(
      true,
    );
  });

  it("0원은 이체하지 않으며 다시 시도해도 결과가 같다", async () => {
    const result = await createStubPayoutAdapter().pay({ ...request, amount: 0 });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.retryable).toBe(false);
  });

  it("실패를 주문할 수 있다 — 재시도 경로를 시험하기 위해서다", async () => {
    setEnv("PAYOUT_STUB_FAIL", "1");

    const result = await createStubPayoutAdapter().pay(request);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.retryable).toBe(true);
  });
});

describe("noop — 프로덕션 기본값", () => {
  it("성공을 주장하지 않는다", async () => {
    expect((await createNoopPayoutAdapter().pay(request)).ok).toBe(false);
  });
});

describe("어댑터 선택 — 프로덕션에서 스텁을 거부한다", () => {
  it("로컬 기본값은 스텁이다", () => {
    setEnv("NODE_ENV", "development");
    setEnv("PAYOUT_ADAPTER", undefined);

    expect(resolvePayoutAdapterName()).toBe("stub");
  });

  it("프로덕션에서 stub 을 지정하면 던진다", () => {
    setEnv("NODE_ENV", "production");
    setEnv("PAYOUT_ADAPTER", "stub");

    expect(() => resolvePayoutAdapterName()).toThrow(/프로덕션/);
  });

  it("프로덕션 기본값은 noop 이다 — 보내지 않은 돈을 보냈다고 적지 않는다", () => {
    setEnv("NODE_ENV", "production");
    setEnv("PAYOUT_ADAPTER", undefined);

    expect(resolvePayoutAdapterName()).toBe("noop");
  });
});
