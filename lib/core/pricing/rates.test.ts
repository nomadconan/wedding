import { describe, expect, it } from "vitest";

import {
  COMMISSION_SCOPE_ORDER,
  PLANNER_FEE_SCOPE_ORDER,
  RateError,
  calculatePlannerFee,
  calculateSettlement,
  resolveRate,
  type RateRecord,
} from "./rates";

/**
 * 여기 쓰이는 요율 숫자는 **테스트 전용 임의값**이다.
 * 운영 요율은 DB(commission_rates·planner_fee_rates·app_settings)가 가지며
 * 코드·마이그레이션·시드 어디에도 값을 고정하지 않는다(O-02).
 */
const VENDOR_ID = "11111111-1111-4111-8111-111111111111";
const PLANNER_ID = "22222222-2222-4222-8222-222222222222";

/**
 * **`as RateRecord` 캐스트를 걷었다**(FIX-12). 캐스트가 있으면 필드를 빠뜨려도 TS 가
 * 통과시키고 zod 가 런타임에야 던진다 — 타입이 거짓말하는 자리다(FIX-38 과 같은 결).
 */
function record(overrides: Partial<RateRecord> & Pick<RateRecord, "scopeType">): RateRecord {
  return {
    scopeKey: null,
    feeRateBp: 100,
    effectiveFrom: "2026-01-01T00:00:00Z",
    effectiveTo: null,
    voidedAt: null,
    ...overrides,
  };
}

const COMMISSION_QUERY = {
  scopeCandidates: COMMISSION_SCOPE_ORDER,
  scopeKeys: { vendor: VENDOR_ID, category: "hall" },
  at: "2026-06-01T00:00:00Z",
};

describe("resolveRate — 우선순위 (§3.8: 좁은 범위가 넓은 범위를 이긴다)", () => {
  const global = record({ scopeType: "global", feeRateBp: 500 });
  const category = record({ scopeType: "category", scopeKey: "hall", feeRateBp: 600 });
  const vendor = record({ scopeType: "vendor", scopeKey: VENDOR_ID, feeRateBp: 700 });

  it("vendor 가 category·global 을 이긴다", () => {
    const result = resolveRate([global, category, vendor], COMMISSION_QUERY);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scopeType).toBe("vendor");
    expect(result.feeRateBp).toBe(700);
  });

  it("vendor 가 없으면 category 를 쓴다", () => {
    const result = resolveRate([global, category], COMMISSION_QUERY);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scopeType).toBe("category");
    expect(result.feeRateBp).toBe(600);
  });

  it("vendor·category 가 없으면 global 을 쓴다", () => {
    const result = resolveRate([global], COMMISSION_QUERY);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scopeType).toBe("global");
    expect(result.feeRateBp).toBe(500);
  });

  it("다른 업체의 요율은 채택하지 않는다", () => {
    const other = record({
      scopeType: "vendor",
      scopeKey: "33333333-3333-4333-8333-333333333333",
      feeRateBp: 900,
    });

    const result = resolveRate([global, other], COMMISSION_QUERY);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scopeType).toBe("global");
  });

  it("다른 카테고리의 요율은 채택하지 않는다", () => {
    const other = record({ scopeType: "category", scopeKey: "studio", feeRateBp: 900 });

    const result = resolveRate([global, other], COMMISSION_QUERY);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scopeType).toBe("global");
  });

  it("카테고리 키가 없으면 그 단계를 건너뛴다", () => {
    const result = resolveRate([global, category], {
      scopeCandidates: COMMISSION_SCOPE_ORDER,
      scopeKeys: { vendor: VENDOR_ID },
      at: "2026-06-01T00:00:00Z",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scopeType).toBe("global");
  });

  it("플래너 요율도 planner → category → global 순으로 해석한다", () => {
    const planner = record({ scopeType: "planner", scopeKey: PLANNER_ID, feeRateBp: 300 });
    const result = resolveRate([global, category, planner], {
      scopeCandidates: PLANNER_FEE_SCOPE_ORDER,
      scopeKeys: { planner: PLANNER_ID, category: "hall" },
      at: "2026-06-01T00:00:00Z",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scopeType).toBe("planner");
    expect(result.feeRateBp).toBe(300);
  });
});

describe("resolveRate — 기간 경계 [effectiveFrom, effectiveTo)", () => {
  const bounded = record({
    scopeType: "global",
    feeRateBp: 500,
    effectiveFrom: "2026-03-01T00:00:00Z",
    effectiveTo: "2026-06-01T00:00:00Z",
  });

  function at(instant: string) {
    return resolveRate([bounded], { scopeCandidates: ["global"], at: instant });
  }

  it("effective_from 당일(정각)은 포함이다", () => {
    expect(at("2026-03-01T00:00:00Z").ok).toBe(true);
  });

  it("effective_from 직전 1ms 는 제외다", () => {
    expect(at("2026-02-28T23:59:59.999Z").ok).toBe(false);
  });

  it("effective_to 당일(정각)은 제외다 — 반개구간이라 경계에서 겹치지 않는다", () => {
    expect(at("2026-06-01T00:00:00Z").ok).toBe(false);
  });

  it("effective_to 직전 1ms 는 포함이다", () => {
    expect(at("2026-05-31T23:59:59.999Z").ok).toBe(true);
  });

  it("effective_to 가 null 이면 무기한이다", () => {
    const openEnded = record({ scopeType: "global", effectiveFrom: "2026-01-01T00:00:00Z" });
    const result = resolveRate([openEnded], {
      scopeCandidates: ["global"],
      at: "2099-12-31T23:59:59Z",
    });

    expect(result.ok).toBe(true);
  });

  it("맞닿은 두 구간은 경계 시점에 정확히 하나만 유효하다", () => {
    const before = record({
      scopeType: "global",
      feeRateBp: 400,
      effectiveFrom: "2025-01-01T00:00:00Z",
      effectiveTo: "2026-01-01T00:00:00Z",
    });
    const after = record({
      scopeType: "global",
      feeRateBp: 500,
      effectiveFrom: "2026-01-01T00:00:00Z",
    });

    const onBoundary = resolveRate([before, after], {
      scopeCandidates: ["global"],
      at: "2026-01-01T00:00:00Z",
    });

    expect(onBoundary.ok).toBe(true);
    if (!onBoundary.ok) return;
    expect(onBoundary.feeRateBp).toBe(500);

    const justBefore = resolveRate([before, after], {
      scopeCandidates: ["global"],
      at: "2025-12-31T23:59:59.999Z",
    });

    expect(justBefore.ok).toBe(true);
    if (!justBefore.ok) return;
    expect(justBefore.feeRateBp).toBe(400);
  });

  it("과거 시점으로 조회하면 그때의 요율이 그대로 나온다 — 정산 이의 제기 대응", () => {
    const old = record({
      scopeType: "global",
      feeRateBp: 400,
      effectiveFrom: "2025-01-01T00:00:00Z",
      effectiveTo: "2026-01-01T00:00:00Z",
    });
    const current = record({ scopeType: "global", feeRateBp: 800 });

    const result = resolveRate([old, current], {
      scopeCandidates: ["global"],
      at: "2025-07-01T00:00:00Z",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.feeRateBp).toBe(400);
  });
});

describe("resolveRate — 실패는 실패로 반환한다 (기본값 날조 금지)", () => {
  it("후보가 없으면 no_matching_rate 를 반환한다", () => {
    const result = resolveRate([], COMMISSION_QUERY);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("no_matching_rate");
    expect(result.detail.length).toBeGreaterThan(0);
  });

  it("시점이 어느 구간에도 안 들면 실패다 — 가장 가까운 요율을 끌어오지 않는다", () => {
    const future = record({ scopeType: "global", effectiveFrom: "2030-01-01T00:00:00Z" });
    const result = resolveRate([future], { scopeCandidates: ["global"], at: "2026-06-01T00:00:00Z" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("no_matching_rate");
  });

  it("실패 결과에는 요율 값이 없다", () => {
    const result = resolveRate([], COMMISSION_QUERY);

    expect(result).not.toHaveProperty("feeRateBp");
  });

  it("겹치는 기간이 들어오면 하나를 고르지 않고 ambiguous_rate 로 실패한다", () => {
    // DB EXCLUDE 제약이 막지만, 다른 경로로 들어온 데이터를 방어한다.
    // 임의로 하나를 고르면 어느 요율이 적용됐는지 설명할 수 없어 정산 분쟁이 된다.
    const a = record({ scopeType: "global", feeRateBp: 500, effectiveFrom: "2026-01-01T00:00:00Z" });
    const b = record({ scopeType: "global", feeRateBp: 700, effectiveFrom: "2026-03-01T00:00:00Z" });

    const result = resolveRate([a, b], { scopeCandidates: ["global"], at: "2026-06-01T00:00:00Z" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("ambiguous_rate");
    expect(result.conflicts).toHaveLength(2);
  });

  it("겹침이 좁은 스코프에 있으면 넓은 스코프로 도망가지 않는다", () => {
    const global = record({ scopeType: "global", feeRateBp: 500 });
    const v1 = record({ scopeType: "vendor", scopeKey: VENDOR_ID, feeRateBp: 700 });
    const v2 = record({
      scopeType: "vendor",
      scopeKey: VENDOR_ID,
      feeRateBp: 800,
      effectiveFrom: "2026-02-01T00:00:00Z",
    });

    const result = resolveRate([global, v1, v2], COMMISSION_QUERY);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("ambiguous_rate");
  });

  it("잘못된 레코드는 스키마 단계에서 걸린다", () => {
    expect(() =>
      resolveRate([record({ scopeType: "global", scopeKey: "hall" })], COMMISSION_QUERY),
    ).toThrow();

    expect(() => resolveRate([record({ scopeType: "vendor", scopeKey: null })], COMMISSION_QUERY)).toThrow();

    expect(() =>
      resolveRate([record({ scopeType: "global", feeRateBp: 10_001 })], COMMISSION_QUERY),
    ).toThrow();
  });
});

describe("resolveRate — 서비스 등급 (planner_fee_rates.service_level)", () => {
  const anyLevel = record({ scopeType: "global", feeRateBp: 300, serviceLevel: null });
  const premium = record({ scopeType: "global", feeRateBp: 800, serviceLevel: "premium" });

  it("등급을 지정하면 등급 일치 행이 등급 무관 행을 이긴다", () => {
    const result = resolveRate([anyLevel, premium], {
      scopeCandidates: ["global"],
      at: "2026-06-01T00:00:00Z",
      serviceLevel: "premium",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.feeRateBp).toBe(800);
  });

  it("일치하는 등급이 없으면 등급 무관 행으로 내려간다", () => {
    const result = resolveRate([anyLevel, premium], {
      scopeCandidates: ["global"],
      at: "2026-06-01T00:00:00Z",
      serviceLevel: "basic",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.feeRateBp).toBe(300);
  });

  it("등급을 지정하지 않으면 특정 등급 행을 집어오지 않는다", () => {
    const result = resolveRate([premium], { scopeCandidates: ["global"], at: "2026-06-01T00:00:00Z" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("no_matching_rate");
  });
});

describe("calculateSettlement — 수수료는 판매가에서 차감된다 (D-16)", () => {
  it("요율 0bp 면 수수료가 0원이고 전액이 정산된다", () => {
    expect(calculateSettlement({ salePrice: 1_000_000, feeRateBp: 0 })).toEqual({
      salePrice: 1_000_000,
      feeRateBp: 0,
      feeAmount: 0,
      netAmount: 1_000_000,
    });
  });

  it("판매가 0원이면 수수료도 0원이다", () => {
    expect(calculateSettlement({ salePrice: 0, feeRateBp: 750 })).toMatchObject({
      feeAmount: 0,
      netAmount: 0,
    });
  });

  it("수수료 + 정산액 = 판매가 항등식이 항상 성립한다", () => {
    for (const salePrice of [1, 999, 1_000_000, 12_345_678]) {
      for (const feeRateBp of [1, 33, 250, 1_234, 9_999]) {
        const result = calculateSettlement({ salePrice, feeRateBp });
        expect(result.feeAmount + result.netAmount).toBe(salePrice);
        expect(Number.isInteger(result.feeAmount)).toBe(true);
      }
    }
  });

  it("1원 단위에서도 정수만 나온다 (반올림 경계)", () => {
    // 1원 * 5000bp = 0.5원 → 0.5 는 올림(+∞ 방향)이라 1원이다.
    expect(calculateSettlement({ salePrice: 1, feeRateBp: 5_000 }).feeAmount).toBe(1);
    // 1원 * 4999bp = 0.4999원 → 0원.
    expect(calculateSettlement({ salePrice: 1, feeRateBp: 4_999 }).feeAmount).toBe(0);
    // 3원 * 1666bp = 0.4998원 → 0원.
    expect(calculateSettlement({ salePrice: 3, feeRateBp: 1_666 }).feeAmount).toBe(0);
    // 3원 * 1667bp = 0.5001원 → 1원.
    expect(calculateSettlement({ salePrice: 3, feeRateBp: 1_667 }).feeAmount).toBe(1);
  });

  it("100% 요율이면 정산액이 0원이다 (sanity bound 상단)", () => {
    expect(calculateSettlement({ salePrice: 500_000, feeRateBp: 10_000 })).toMatchObject({
      feeAmount: 500_000,
      netAmount: 0,
    });
  });

  it("정수 안전 범위를 벗어나면 계산하지 않고 던진다", () => {
    expect(() =>
      calculateSettlement({ salePrice: Number.MAX_SAFE_INTEGER, feeRateBp: 10_000 }),
    ).toThrow(RateError);
  });

  it("안전 범위 안의 큰 금액은 정확히 계산한다", () => {
    // 1조원 * 10000bp 는 1e16 으로 안전 범위(약 9.007e15)를 넘지만,
    // 실무 상한인 100억원대는 문제없이 계산된다.
    const result = calculateSettlement({ salePrice: 10_000_000_000, feeRateBp: 1_500 });
    expect(result.feeAmount).toBe(1_500_000_000);
    expect(result.netAmount).toBe(8_500_000_000);
  });

  it("음수·소수 금액과 범위 밖 요율은 거부한다", () => {
    expect(() => calculateSettlement({ salePrice: -1, feeRateBp: 500 })).toThrow();
    expect(() => calculateSettlement({ salePrice: 1_000.5, feeRateBp: 500 })).toThrow();
    expect(() => calculateSettlement({ salePrice: 1_000, feeRateBp: -1 })).toThrow();
    expect(() => calculateSettlement({ salePrice: 1_000, feeRateBp: 10_001 })).toThrow();
    expect(() => calculateSettlement({ salePrice: 1_000, feeRateBp: 12.5 })).toThrow();
  });
});

describe("calculatePlannerFee — 미선택이면 부과하지 않는다 (D-17)", () => {
  it("선택하지 않으면 요율이 있어도 0원이다", () => {
    expect(
      calculatePlannerFee({ salePrice: 10_000_000, feeRateBp: 900, selected: false }),
    ).toBe(0);
  });

  it("선택하면 판매가에 요율을 적용한다", () => {
    expect(calculatePlannerFee({ salePrice: 10_000_000, feeRateBp: 900, selected: true })).toBe(
      900_000,
    );
  });

  it("선택했어도 요율이 0bp 면 0원이다", () => {
    expect(calculatePlannerFee({ salePrice: 10_000_000, feeRateBp: 0, selected: true })).toBe(0);
  });

  it("판매가 0원이면 선택 여부와 무관하게 0원이다", () => {
    expect(calculatePlannerFee({ salePrice: 0, feeRateBp: 900, selected: true })).toBe(0);
    expect(calculatePlannerFee({ salePrice: 0, feeRateBp: 900, selected: false })).toBe(0);
  });

  it("반올림은 정산과 같은 방식이다", () => {
    expect(calculatePlannerFee({ salePrice: 1, feeRateBp: 5_000, selected: true })).toBe(1);
    expect(calculatePlannerFee({ salePrice: 1, feeRateBp: 4_999, selected: true })).toBe(0);
  });
});


describe("resolveRate — 무효화된 요율은 후보가 아니다 (FIX-12)", () => {
  it("무효화된 행은 해석에서 빠진다 — 그것이 오타를 되돌리는 방식이다", () => {
    const typo = record({
      scopeType: "global",
      feeRateBp: 7000,
      voidedAt: "2026-05-01T00:00:00Z",
    });
    const corrected = record({ scopeType: "global", feeRateBp: 700 });

    const resolved = resolveRate([typo, corrected], {
      scopeCandidates: COMMISSION_SCOPE_ORDER,
      scopeKeys: {},
      at: "2026-06-01T00:00:00Z",
    });

    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.feeRateBp).toBe(700);
  });

  it("살아 있는 요율이 무효화된 것 하나뿐이면 '요율 없음' 이다 — 조용히 통과하지 않는다", () => {
    const onlyVoided = record({
      scopeType: "global",
      feeRateBp: 500,
      voidedAt: "2026-05-01T00:00:00Z",
    });

    const resolved = resolveRate([onlyVoided], {
      scopeCandidates: COMMISSION_SCOPE_ORDER,
      scopeKeys: {},
      at: "2026-06-01T00:00:00Z",
    });

    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.reason).toBe("no_matching_rate");
  });

  it("무효화된 행은 모호(ambiguous) 판정에도 끼지 않는다", () => {
    // 같은 스코프·같은 구간에 둘이 있지만 하나가 무효면 남은 하나로 결정된다.
    const voided = record({
      scopeType: "global",
      feeRateBp: 900,
      voidedAt: "2026-05-01T00:00:00Z",
    });
    const alive = record({ scopeType: "global", feeRateBp: 500 });

    const resolved = resolveRate([voided, alive], {
      scopeCandidates: COMMISSION_SCOPE_ORDER,
      scopeKeys: {},
      at: "2026-06-01T00:00:00Z",
    });

    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.feeRateBp).toBe(500);
  });

  it("무효화하지 않은 행은 그대로 후보다 — 무효화가 해석을 무디게 하지 않았다", () => {
    const alive = record({ scopeType: "global", feeRateBp: 500 });

    const resolved = resolveRate([alive], {
      scopeCandidates: COMMISSION_SCOPE_ORDER,
      scopeKeys: {},
      at: "2026-06-01T00:00:00Z",
    });

    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.feeRateBp).toBe(500);
  });
});
