import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveEscrowAdapterName } from "./adapter";
import { createNoopEscrowAdapter, createStubEscrowAdapter, resetStubEscrowState } from "./stub";

/**
 * 에스크로 스텁 계약 시험 (S5-09 · D-28 · O-03)
 *
 * **깨지면 맡기지도 않은 돈을 맡았다고 기록**하고, 고객은 "안전거래로 보호받고 있다"
 * 는 화면을 보며 안심한다. 결제·지급 스텁과 같은 이유로 vitest 대상에 넣었다.
 */
const ORIGINAL_ENV = process.env.NODE_ENV;
const ORIGINAL_ADAPTER = process.env.ESCROW_ADAPTER;
const ORIGINAL_FAIL = process.env.ESCROW_STUB_FAIL;

function setEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete (process.env as Record<string, string | undefined>)[key];
  else (process.env as Record<string, string | undefined>)[key] = value;
}

beforeEach(() => {
  resetStubEscrowState();
  setEnv("ESCROW_STUB_FAIL", undefined);
});

afterEach(() => {
  setEnv("NODE_ENV", ORIGINAL_ENV);
  setEnv("ESCROW_ADAPTER", ORIGINAL_ADAPTER);
  setEnv("ESCROW_STUB_FAIL", ORIGINAL_FAIL);
});

const request = {
  bookingId: "11111111-1111-1111-1111-111111111111",
  paymentId: "22222222-2222-2222-2222-222222222222",
  amount: 8_000_000,
  currency: "KRW",
  idempotencyKey: "escrow:s1:hold",
};

describe("보관", () => {
  it("맡으면 참조와 시각을 준다", async () => {
    const result = await createStubEscrowAdapter().hold(request);

    expect(result.ok).toBe(true);
    expect(result.ok === true && result.providerRef).toMatch(/^stub_escrow_/);
    expect(result.ok === true && Number.isNaN(Date.parse(result.at))).toBe(false);
  });

  it("같은 멱등 열쇠는 같은 참조를 돌려준다 — 두 번 묶이지 않는다", async () => {
    const adapter = createStubEscrowAdapter();
    const first = await adapter.hold(request);
    const second = await adapter.hold(request);

    expect(first.ok === true && second.ok === true && first.providerRef === second.providerRef).toBe(
      true,
    );
  });

  it("0원은 맡지 않으며 다시 시도해도 결과가 같다", async () => {
    const result = await createStubEscrowAdapter().hold({ ...request, amount: 0 });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.retryable).toBe(false);
  });

  it("실패를 주문할 수 있다 — 재시도 경로를 시험하기 위해서다", async () => {
    setEnv("ESCROW_STUB_FAIL", "hold");

    const result = await createStubEscrowAdapter().hold(request);

    expect(result.ok === false && result.retryable).toBe(true);
  });
});

describe("정산 — 릴리즈와 환불이 같은 문으로 나간다", () => {
  it("릴리즈와 환불이 서로 다른 참조를 만든다", async () => {
    const adapter = createStubEscrowAdapter();
    const held = await adapter.hold(request);
    const ref = held.ok === true ? held.providerRef : "";

    const released = await adapter.settle({
      providerRef: ref,
      amount: 8_000_000,
      direction: "release",
      idempotencyKey: "escrow:s1:release",
      reason: "이행 확인",
    });
    const refunded = await adapter.settle({
      providerRef: ref,
      amount: 8_000_000,
      direction: "refund",
      idempotencyKey: "escrow:s1:refund",
      reason: "조율 결과",
    });

    expect(released.ok && refunded.ok).toBe(true);
    expect(
      released.ok === true && refunded.ok === true && released.providerRef !== refunded.providerRef,
    ).toBe(true);
  });

  it("같은 열쇠의 정산은 같은 참조다 — 두 번 풀리지 않는다", async () => {
    const adapter = createStubEscrowAdapter();
    const held = await adapter.hold(request);
    const ref = held.ok === true ? held.providerRef : "";

    const first = await adapter.settle({
      providerRef: ref,
      amount: 1,
      direction: "release",
      idempotencyKey: "k",
      reason: "r",
    });
    const second = await adapter.settle({
      providerRef: ref,
      amount: 1,
      direction: "release",
      idempotencyKey: "k",
      reason: "r",
    });

    expect(first.ok === true && second.ok === true && first.providerRef === second.providerRef).toBe(
      true,
    );
  });

  it("보관 참조가 없으면 풀지 않는다", async () => {
    const result = await createStubEscrowAdapter().settle({
      providerRef: "",
      amount: 1,
      direction: "release",
      idempotencyKey: "k0",
      reason: "r",
    });

    expect(result.ok).toBe(false);
  });
});

describe("noop — 프로덕션 기본값", () => {
  it("성공을 주장하지 않는다", async () => {
    const adapter = createNoopEscrowAdapter();

    expect((await adapter.hold(request)).ok).toBe(false);
    expect(
      (
        await adapter.settle({
          providerRef: "x",
          amount: 1,
          direction: "release",
          idempotencyKey: "k",
          reason: "r",
        })
      ).ok,
    ).toBe(false);
  });
});

describe("어댑터 선택 — 프로덕션에서 스텁을 거부한다", () => {
  it("로컬 기본값은 스텁이다", () => {
    setEnv("NODE_ENV", "development");
    setEnv("ESCROW_ADAPTER", undefined);

    expect(resolveEscrowAdapterName()).toBe("stub");
  });

  it("프로덕션에서 stub 을 지정하면 던진다", () => {
    setEnv("NODE_ENV", "production");
    setEnv("ESCROW_ADAPTER", "stub");

    expect(() => resolveEscrowAdapterName()).toThrow(/프로덕션/);
  });

  it("프로덕션 기본값은 noop 이다 — 맡지 않은 돈을 맡았다고 적지 않는다", () => {
    setEnv("NODE_ENV", "production");
    setEnv("ESCROW_ADAPTER", undefined);

    expect(resolveEscrowAdapterName()).toBe("noop");
  });
});
