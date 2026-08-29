import { describe, expect, it } from "vitest";

import { checkoutAmounts } from "../payment/checkout";
import {
  type WalletInput,
  applyVerdict,
  buildWallet,
  walletSummary,
} from "./wallet";

const NOW = new Date("2026-08-29T00:00:00.000Z");

const entry = (over: Partial<WalletInput> = {}): WalletInput => ({
  issueId: "i1",
  couponId: "c1",
  name: "첫 거래 5만원 할인",
  issuerType: "platform",
  issuerId: null,
  issuerName: null,
  discountType: "amount",
  discountValue: 50_000,
  maxDiscountAmount: null,
  minOrderAmount: 100_000,
  couponStatus: "active",
  validFrom: null,
  totalQuantity: null,
  issuedCount: 0,
  issueStatus: "issued",
  expiresAt: "2026-09-30T00:00:00.000Z",
  ...over,
});

// ══════════════════════════════════════════════════════════════════════════
// 못 쓰는 쿠폰을 감추지 않는다 (F-C-36)
// ══════════════════════════════════════════════════════════════════════════

describe("buildWallet", () => {
  it("쓸 수 있으면 할인액이 함께 나온다", () => {
    const [row] = buildWallet({ entries: [entry()], orderAmount: 1_000_000, now: NOW });

    expect(row.usable).toBe(true);
    expect(row.discountAmount).toBe(50_000);
  });

  it("**못 쓰는 쿠폰도 목록에 남고 사유가 붙는다** — 감추면 '쿠폰이 없다' 로 읽힌다", () => {
    const [row] = buildWallet({
      entries: [entry({ minOrderAmount: 2_000_000 })],
      orderAmount: 1_000_000,
      now: NOW,
    });

    expect(row.usable).toBe(false);
    expect(row.blockedReason).toBe("min_order");
    expect(row.blockedDetail).toContain("2,000,000원 이상");
  });

  it("**주문 금액을 모르면 판정하지 않는다** — 0원으로 재면 전부 '못 쓴다' 가 된다(함정 2)", () => {
    const [row] = buildWallet({ entries: [entry()], orderAmount: null, now: NOW });

    expect(row.usable).toBeNull();
    expect(row.discountAmount).toBeNull();
    expect(row.blockedReason).toBeNull();
  });

  it("만료된 발급분은 사유가 만료다", () => {
    const [row] = buildWallet({
      entries: [entry({ expiresAt: "2026-08-01T00:00:00.000Z" })],
      orderAmount: 1_000_000,
      now: NOW,
    });

    expect(row.blockedReason).toBe("expired");
  });

  it("이미 쓴 발급분도 목록에 남는다 — 사라지면 '어디 갔지' 가 된다", () => {
    const [row] = buildWallet({
      entries: [entry({ issueStatus: "used" })],
      orderAmount: 1_000_000,
      now: NOW,
    });

    expect(row.usable).toBe(false);
    expect(row.blockedReason).toBe("already_used");
  });

  it("**정률 쿠폰은 상한으로 잘린다** — 상한 없는 정률은 업체 정산을 통째로 지운다", () => {
    const [row] = buildWallet({
      entries: [
        entry({ discountType: "rate", discountValue: 1_000, maxDiscountAmount: 30_000 }),
      ],
      orderAmount: 1_000_000,
      now: NOW,
    });

    expect(row.discountAmount).toBe(30_000);
  });

  it("**중복은 기본으로 막힌다** — 두 장이 겹치면 부담 주체가 둘이 된다", () => {
    const [row] = buildWallet({
      entries: [entry()],
      orderAmount: 1_000_000,
      appliedCount: 1,
      now: NOW,
    });

    expect(row.blockedReason).toBe("stacking");
  });
});

describe("sortWallet", () => {
  it("**쓸 수 있는 것이 위, 그 안에서 할인액이 큰 것부터**", () => {
    const rows = buildWallet({
      entries: [
        entry({ issueId: "small", discountValue: 10_000 }),
        entry({ issueId: "blocked", minOrderAmount: 9_000_000 }),
        entry({ issueId: "big", discountValue: 90_000 }),
      ],
      orderAmount: 1_000_000,
      now: NOW,
    });

    expect(rows.map((row) => row.issueId)).toEqual(["big", "small", "blocked"]);
  });

  it("할인액이 같으면 **먼저 만료되는 것**이 위다 — 놓치면 사라지는 쪽이 급하다", () => {
    const rows = buildWallet({
      entries: [
        entry({ issueId: "late", expiresAt: "2026-12-01T00:00:00.000Z" }),
        entry({ issueId: "soon", expiresAt: "2026-09-02T00:00:00.000Z" }),
      ],
      orderAmount: 1_000_000,
      now: NOW,
    });

    expect(rows.map((row) => row.issueId)).toEqual(["soon", "late"]);
  });

  it("순서가 고정이다 — 흔들리면 읽는 사람이 목록을 의심한다", () => {
    const once = buildWallet({ entries: [entry({ issueId: "a" }), entry({ issueId: "b" })], orderAmount: null, now: NOW });
    const twice = buildWallet({ entries: [entry({ issueId: "b" }), entry({ issueId: "a" })], orderAmount: null, now: NOW });

    expect(once.map((row) => row.issueId)).toEqual(twice.map((row) => row.issueId));
  });
});

describe("walletSummary", () => {
  it("**판정하지 않았으면 쓸 수 있는 수를 0 으로 적지 않는다**", () => {
    const rows = buildWallet({ entries: [entry()], orderAmount: null, now: NOW });

    expect(walletSummary(rows, NOW).usable).toBeNull();
    expect(walletSummary(rows, NOW).total).toBe(1);
  });

  it("판정했으면 센다", () => {
    const rows = buildWallet({ entries: [entry()], orderAmount: 1_000_000, now: NOW });

    expect(walletSummary(rows, NOW).usable).toBe(1);
  });

  it("**만료 임박은 판정 없이도 센다** — 시계만 있으면 되기 때문이다", () => {
    const rows = buildWallet({
      entries: [entry({ expiresAt: "2026-09-02T00:00:00.000Z" })],
      orderAmount: null,
      now: NOW,
    });

    expect(walletSummary(rows, NOW).expiringSoon).toBe(1);
  });

  it("이미 지난 것은 임박이 아니다", () => {
    const rows = buildWallet({
      entries: [entry({ expiresAt: "2026-08-01T00:00:00.000Z" })],
      orderAmount: null,
      now: NOW,
    });

    expect(walletSummary(rows, NOW).expiringSoon).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 결제 적용 — 서버가 다시 센다
// ══════════════════════════════════════════════════════════════════════════

describe("applyVerdict", () => {
  const base = {
    installmentAmount: 1_000_000,
    appliedCount: 0,
    stackingMode: "single" as const,
    now: NOW,
  };

  it("쓸 수 있으면 **할인액과 낼 금액을 서버가 계산해 돌려준다**", () => {
    const verdict = applyVerdict({ ...base, entry: entry() });

    expect(verdict).toEqual({
      ok: true,
      discountAmount: 50_000,
      payableAmount: 950_000,
      borneBy: "platform",
    });
  });

  it("**부담 주체는 발행 주체를 따른다**(D-27) — 업체 쿠폰은 업체 정산에서 나간다", () => {
    const verdict = applyVerdict({
      ...base,
      entry: entry({ issuerType: "vendor", issuerId: "v1" }),
      bookingVendorId: "v1",
    });

    expect(verdict.ok && verdict.borneBy).toBe("vendor");
  });

  it("**업체 쿠폰을 다른 업체 결제에 쓸 수 없다**(FIX-45) — 정산은 예약의 업체에서 뺀다", () => {
    const verdict = applyVerdict({
      ...base,
      entry: entry({ issuerType: "vendor", issuerId: "v1" }),
      bookingVendorId: "v2",
    });

    expect(verdict.ok).toBe(false);
    expect(!verdict.ok && verdict.reason).toBe("other_vendor");
  });

  it("**예약의 업체를 모르면 판정하지 않는다** — 모르는 것을 '안 맞는다' 로 적지 않는다", () => {
    const verdict = applyVerdict({
      ...base,
      entry: entry({ issuerType: "vendor", issuerId: "v1" }),
      bookingVendorId: null,
    });

    expect(verdict.ok).toBe(true);
  });

  it("**플랫폼 쿠폰은 어느 업체에서든 쓴다** — 비용을 플랫폼이 지기 때문이다", () => {
    const verdict = applyVerdict({ ...base, entry: entry(), bookingVendorId: "v2" });

    expect(verdict.ok).toBe(true);
  });

  it("없는 발급분은 거절하고 이유를 말한다", () => {
    const verdict = applyVerdict({ ...base, entry: null });

    expect(verdict).toEqual({ ok: false, reason: "not_found", message: expect.any(String) });
  });

  it("**막힌 사유를 그대로 올려보낸다** — API 가 자기 말로 바꾸면 왜 막혔는지 흐려진다", () => {
    const verdict = applyVerdict({ ...base, entry: entry({ minOrderAmount: 9_000_000 }) });

    expect(verdict.ok).toBe(false);
    expect(!verdict.ok && verdict.reason).toBe("min_order");
  });

  it("**할인액이 회차 금액을 넘지 않는다** — 넘으면 거스름돈을 주는 셈이다", () => {
    const verdict = applyVerdict({
      ...base,
      installmentAmount: 30_000,
      entry: entry({ discountValue: 50_000, minOrderAmount: 0 }),
    });

    expect(verdict.ok && verdict.discountAmount).toBe(30_000);
    expect(verdict.ok && verdict.payableAmount).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// FIX-13 — 회차 합계가 총액과 맞는가
// ══════════════════════════════════════════════════════════════════════════

describe("checkoutAmounts 와 쿠폰 (FIX-13)", () => {
  it("**할인을 쓰면 그만큼 총 부담이 줄어든다** — 남는 금액이 할인만큼 함께 줄어야 한다", () => {
    const first = checkoutAmounts({
      contractTotal: 12_000_000,
      installmentAmount: 6_000_000,
      paidAmount: 0,
      discountAmount: 500_000,
    });

    expect(first.payableAmount).toBe(5_500_000);
    // 낼 금액 5,500,000 + 할인 500,000 을 총액에서 뺀다 → 남는 것은 두 번째 회차뿐이다.
    expect(first.remainingAfterThis).toBe(6_000_000);
  });

  it("**마지막 회차까지 내면 잔액이 0 이다** — 안 그러면 다 내고도 빚이 남는다", () => {
    const second = checkoutAmounts({
      contractTotal: 12_000_000,
      installmentAmount: 6_000_000,
      // 1회차에서 550만원을 냈고 50만원은 쿠폰이 대신했다.
      paidAmount: 5_500_000,
      priorDiscountAmount: 500_000,
      discountAmount: 0,
    });

    expect(second.payableAmount).toBe(6_000_000);
    expect(second.remainingAfterThis).toBe(0);
  });

  it("이미 쓴 할인을 안 넘기면 **다 내고도 잔액이 남는다** — 이것이 FIX-13 이 말한 어긋남이다", () => {
    const wrong = checkoutAmounts({
      contractTotal: 12_000_000,
      installmentAmount: 6_000_000,
      paidAmount: 5_500_000,
    });

    expect(wrong.remainingAfterThis).toBe(500_000);
  });

  it("쿠폰이 없으면 예전과 같다", () => {
    const plain = checkoutAmounts({
      contractTotal: 12_000_000,
      installmentAmount: 6_000_000,
      paidAmount: 6_000_000,
    });

    expect(plain.payableAmount).toBe(6_000_000);
    expect(plain.remainingAfterThis).toBe(0);
  });

  it("음수 할인은 거절한다", () => {
    expect(() =>
      checkoutAmounts({
        contractTotal: 100,
        installmentAmount: 100,
        paidAmount: 0,
        priorDiscountAmount: -1,
      }),
    ).toThrow();
  });
});
