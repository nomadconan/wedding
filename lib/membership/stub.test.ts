import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  MEMBERSHIP_ADAPTER_NOT_READY,
  createNoopMembershipAdapter,
  resolveMembershipAdapterName,
} from "./adapter";
import { createStubMembershipAdapter, resetMembershipStub } from "./stub";

const ORIGINAL_ENV = process.env.NODE_ENV;
const ORIGINAL_ADAPTER = process.env.MEMBERSHIP_ADAPTER;
const ORIGINAL_FAIL = process.env.MEMBERSHIP_STUB_FAIL;

/** `process.env` 는 재정의할 수 없다 — 인덱스로 쓴다(회차 결제 스텁 시험과 같은 방식). */
function setEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete (process.env as Record<string, string | undefined>)[key];
  else (process.env as Record<string, string | undefined>)[key] = value;
}

afterEach(() => {
  setEnv("NODE_ENV", ORIGINAL_ENV);
  setEnv("MEMBERSHIP_ADAPTER", ORIGINAL_ADAPTER);
  setEnv("MEMBERSHIP_STUB_FAIL", ORIGINAL_FAIL);
});

const request = (key: string) => ({
  userId: "u-1",
  amount: 9900,
  currency: "KRW",
  idempotencyKey: key,
});

describe("구독 스텁 — 상태 기계를 실제와 똑같이 돌린다", () => {
  beforeEach(() => {
    resetMembershipStub();
    setEnv("MEMBERSHIP_STUB_FAIL", undefined);
  });

  it("구독을 시작한다", async () => {
    const result = await createStubMembershipAdapter().subscribe(request("k1"));

    expect(result.ok).toBe(true);
    expect(result.ok && result.providerRef).toMatch(/^stub-sub-/);
  });

  it("**멱등을 흉내만 내지 않고 실제로 지킨다** — 안 지키면 실연동 때 돈이 두 번 빠진다", async () => {
    const adapter = createStubMembershipAdapter();
    const first = await adapter.subscribe(request("same"));
    const second = await adapter.subscribe(request("same"));

    expect(first.ok && second.ok && first.providerRef === second.providerRef).toBe(true);
  });

  it("열쇠가 다르면 참조도 다르다", async () => {
    const adapter = createStubMembershipAdapter();
    const a = await adapter.subscribe(request("a"));
    const b = await adapter.subscribe(request("b"));

    expect(a.ok && b.ok && a.providerRef !== b.providerRef).toBe(true);
  });

  it("**0원 승인을 성공으로 돌려주지 않는다** — 호출부의 실수가 '무료 멤버십' 으로 굳는다", async () => {
    const adapter = createStubMembershipAdapter();

    expect((await adapter.subscribe({ ...request("z"), amount: 0 })).ok).toBe(false);
    expect((await adapter.subscribe({ ...request("n"), amount: -1 })).ok).toBe(false);
    expect((await adapter.subscribe({ ...request("f"), amount: 1.5 })).ok).toBe(false);
  });

  it("구독을 끊는다", async () => {
    const adapter = createStubMembershipAdapter();
    const started = await adapter.subscribe(request("c1"));

    const result = await adapter.cancel({
      providerRef: started.ok ? started.providerRef : "",
      idempotencyKey: "c1-cancel",
      reason: "user",
    });

    expect(result.ok).toBe(true);
  });

  it("**없는 구독을 끊었다고 하지 않는다** — 참조 실수를 실연동까지 숨기지 않는다", async () => {
    const result = await createStubMembershipAdapter().cancel({
      providerRef: "누군가-지어낸-참조",
      idempotencyKey: "x",
      reason: "user",
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.retryable).toBe(false);
  });

  it("강제 실패 스위치가 돈다 (실패 경로를 눌러 볼 수 있다)", async () => {
    setEnv("MEMBERSHIP_STUB_FAIL", "subscribe");

    expect((await createStubMembershipAdapter().subscribe(request("k"))).ok).toBe(false);
  });
});

describe("어댑터 선택 — 프로덕션에서 스텁이 돌지 않는다", () => {
  it("개발에서는 스텁이다", () => {
    setEnv("NODE_ENV", "development");
    setEnv("MEMBERSHIP_ADAPTER", undefined);

    expect(resolveMembershipAdapterName()).toBe("stub");
  });

  it("**프로덕션 기본값은 noop 이다**", () => {
    setEnv("NODE_ENV", "production");
    setEnv("MEMBERSHIP_ADAPTER", undefined);

    expect(resolveMembershipAdapterName()).toBe("noop");
  });

  it("**프로덕션에서 스텁을 켜면 던진다** — 받지 않은 돈으로 멤버십이 열린다", () => {
    setEnv("NODE_ENV", "production");
    setEnv("MEMBERSHIP_ADAPTER", "stub");

    expect(() => resolveMembershipAdapterName()).toThrow(/프로덕션/);

    setEnv("MEMBERSHIP_ADAPTER", undefined);
  });

  it("**noop 은 성공을 주장하지 않고 실패를 돌려준다**", async () => {
    const adapter = createNoopMembershipAdapter();
    const result = await adapter.subscribe(request("k"));

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.failureReason).toBe(MEMBERSHIP_ADAPTER_NOT_READY);
  });
});
