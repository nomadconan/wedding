import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveChargeAdapterName } from "./charge-adapter";
import { createNoopChargeAdapter, createStubChargeAdapter, resetStubChargeState } from "./charge-stub";

/**
 * 결제 스텁 계약 시험 (S5-06 · D-28)
 *
 * **스텁이 멱등을 지키는지 여기서 확인한다.** 안 지키면 실연동 시점에야 호출부의
 * 버그가 드러나고, 그때는 진짜 돈이 두 번 빠진다. DB 유니크가 최종 경계이지만
 * 어댑터 계약도 계약이다.
 *
 * **프로덕션에서 스텁이 거부되는지도 여기서 본다.** 결제 스텁이 운영에서 돌면
 * 받지 않은 돈이 `paid` 로 쌓이고 정산이 그것을 지급 대상으로 올린다.
 */
const ORIGINAL_ENV = process.env.NODE_ENV;
const ORIGINAL_ADAPTER = process.env.PAYMENT_ADAPTER;
const ORIGINAL_FAIL = process.env.PAYMENT_STUB_FAIL;

function setEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete (process.env as Record<string, string | undefined>)[key];
  else (process.env as Record<string, string | undefined>)[key] = value;
}

beforeEach(() => {
  resetStubChargeState();
  setEnv("PAYMENT_STUB_FAIL", undefined);
});

afterEach(() => {
  setEnv("NODE_ENV", ORIGINAL_ENV);
  setEnv("PAYMENT_ADAPTER", ORIGINAL_ADAPTER);
  setEnv("PAYMENT_STUB_FAIL", ORIGINAL_FAIL);
});

const request = {
  paymentScheduleId: "11111111-1111-1111-1111-111111111111",
  amount: 2_000_000,
  currency: "KRW",
  idempotencyKey: "schedule:s1:charge:1",
};

describe("승인", () => {
  it("승인하면 참조와 승인 시각을 준다", async () => {
    const result = await createStubChargeAdapter().charge(request);

    expect(result.ok).toBe(true);
    expect(result.ok === true && result.providerRef).toMatch(/^stub_pay_/);
    expect(result.ok === true && Number.isNaN(Date.parse(result.approvedAt))).toBe(false);
  });

  it("같은 멱등 열쇠는 같은 참조를 돌려준다 — 두 번 결제되지 않는다", async () => {
    const adapter = createStubChargeAdapter();
    const first = await adapter.charge(request);
    const second = await adapter.charge(request);

    expect(first.ok && second.ok).toBe(true);
    expect(first.ok === true && second.ok === true && first.providerRef === second.providerRef).toBe(
      true,
    );
  });

  it("열쇠가 다르면 다른 결제다 — 명시적 재결제는 새 승인이다", async () => {
    const adapter = createStubChargeAdapter();
    const first = await adapter.charge(request);
    const second = await adapter.charge({ ...request, idempotencyKey: "schedule:s1:charge:2" });

    expect(first.ok === true && second.ok === true && first.providerRef !== second.providerRef).toBe(
      true,
    );
  });

  it("0원은 승인하지 않으며 다시 시도해도 결과가 같다", async () => {
    const result = await createStubChargeAdapter().charge({ ...request, amount: 0 });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.retryable).toBe(false);
  });

  it("실패를 주문할 수 있다 — 재시도 경로를 시험하기 위해서다", async () => {
    setEnv("PAYMENT_STUB_FAIL", "charge");

    const result = await createStubChargeAdapter().charge(request);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.retryable).toBe(true);
  });
});

describe("환불 — 부분 환불", () => {
  it("남은 금액 안에서는 여러 번 돌려줄 수 있다", async () => {
    const adapter = createStubChargeAdapter();
    const approved = await adapter.charge(request);
    const ref = approved.ok === true ? approved.providerRef : "";

    const first = await adapter.refund({
      providerRef: ref,
      amount: 500_000,
      idempotencyKey: "r1",
      reason: "부분 취소",
    });
    const second = await adapter.refund({
      providerRef: ref,
      amount: 1_500_000,
      idempotencyKey: "r2",
      reason: "잔여 취소",
    });

    expect(first.ok && second.ok).toBe(true);
  });

  it("승인 금액을 넘는 환불은 스텁도 거절한다", async () => {
    const adapter = createStubChargeAdapter();
    const approved = await adapter.charge(request);
    const ref = approved.ok === true ? approved.providerRef : "";

    await adapter.refund({ providerRef: ref, amount: 1_900_000, idempotencyKey: "r1", reason: "x" });

    const over = await adapter.refund({
      providerRef: ref,
      amount: 200_000,
      idempotencyKey: "r2",
      reason: "x",
    });

    expect(over.ok).toBe(false);
  });

  it("참조가 없으면 환불하지 않는다", async () => {
    const result = await createStubChargeAdapter().refund({
      providerRef: "",
      amount: 1,
      idempotencyKey: "r0",
      reason: "x",
    });

    expect(result.ok).toBe(false);
  });
});

describe("noop — 프로덕션 기본값", () => {
  it("성공을 주장하지 않는다", async () => {
    const adapter = createNoopChargeAdapter();

    expect((await adapter.charge(request)).ok).toBe(false);
    expect((await adapter.cancel({ providerRef: "x", idempotencyKey: "k", reason: "r" })).ok).toBe(
      false,
    );
    expect(
      (await adapter.refund({ providerRef: "x", amount: 1, idempotencyKey: "k", reason: "r" })).ok,
    ).toBe(false);
  });
});

describe("어댑터 선택 — 프로덕션에서 스텁을 거부한다", () => {
  it("로컬 기본값은 스텁이다", () => {
    setEnv("NODE_ENV", "development");
    setEnv("PAYMENT_ADAPTER", undefined);

    expect(resolveChargeAdapterName()).toBe("stub");
  });

  it("프로덕션에서 stub 을 지정하면 던진다", () => {
    setEnv("NODE_ENV", "production");
    setEnv("PAYMENT_ADAPTER", "stub");

    expect(() => resolveChargeAdapterName()).toThrow(/프로덕션/);
  });

  it("프로덕션 기본값은 noop 이다 — 성공을 주장하지 않는 쪽이 안전하다", () => {
    setEnv("NODE_ENV", "production");
    setEnv("PAYMENT_ADAPTER", undefined);

    expect(resolveChargeAdapterName()).toBe("noop");
  });
});
