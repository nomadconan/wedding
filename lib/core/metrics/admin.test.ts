import { describe, expect, it } from "vitest";

import {
  DEFAULT_PERIOD_DAYS,
  PERIOD_DAY_OPTIONS,
  type RawMetrics,
  buildCards,
  buildFunnel,
  feeRevenue,
  pendingCards,
  ratioBp,
  resolvePeriod,
} from "./admin";
import { isMeasured } from "@/lib/core/stats/metric";

const NOW = new Date("2026-08-27T00:00:00.000Z");

/** 전부 0인 기준값. 각 테스트가 필요한 칸만 덮어쓴다. */
const ZERO: RawMetrics = {
  signups: 0,
  consumerSignups: 0,
  mau: 0,
  reportsRequested: 0,
  reportsSucceeded: 0,
  inquiries: 0,
  consultations: 0,
  bookings: 0,
  contracts: 0,
  gmvAmount: 0,
  feeAmount: 0,
  settlementRows: 0,
  membershipsStarted: 0,
  membershipsCanceled: 0,
  membershipsExpired: 0,
  membershipsActive: 0,
  onboardedCouples: 0,
  couplesWithCart: 0,
};

const raw = (over: Partial<RawMetrics> = {}): RawMetrics => ({ ...ZERO, ...over });
const card = (cards: ReturnType<typeof buildCards>, key: string) => {
  const found = cards.find((row) => row.key === key);
  if (!found) throw new Error(`카드 ${key} 가 없다`);

  return found;
};

describe("resolvePeriod", () => {
  it.each(PERIOD_DAY_OPTIONS)("%i일은 그대로 쓴다", (days) => {
    expect(resolvePeriod(String(days), NOW).days).toBe(days);
  });

  it("목록에 없는 값은 기본값으로 좁힌다 — 던지면 대시보드가 통째로 에러가 된다", () => {
    for (const bad of ["1", "999", "abc", "", null, undefined, -7, 30.5]) {
      expect(resolvePeriod(bad, NOW).days).toBe(DEFAULT_PERIOD_DAYS);
    }
  });

  it("from 은 to 보다 정확히 기간만큼 앞이다", () => {
    const period = resolvePeriod("7", NOW);

    expect(period.to).toBe(NOW.toISOString());
    expect(Date.parse(period.to) - Date.parse(period.from)).toBe(7 * 24 * 3600 * 1000);
  });
});

describe("ratioBp — 분모 0을 0%로 적지 않는다", () => {
  it("정상 비율은 bp 정수다", () => {
    expect(ratioBp(1, 4, "문의가")).toEqual({ status: "measured", value: 2_500 });
  });

  it("반올림하고 소수를 만들지 않는다", () => {
    const result = ratioBp(1, 3, "문의가");

    expect(isMeasured(result) && Number.isInteger(result.value)).toBe(true);
    expect(result).toEqual({ status: "measured", value: 3_333 });
  });

  it("분모가 0이면 no_basis 다 — 0%가 아니다", () => {
    const result = ratioBp(0, 0, "문의가");

    expect(result.status).toBe("no_basis");
    expect(result).not.toEqual({ status: "measured", value: 0 });
  });

  it("음수 분모도 no_basis 로 막는다", () => {
    expect(ratioBp(1, -1, "문의가").status).toBe("no_basis");
  });

  it("분자가 0이고 분모가 있으면 그건 진짜 0%다", () => {
    expect(ratioBp(0, 10, "문의가")).toEqual({ status: "measured", value: 0 });
  });

  it("분자가 분모보다 커도 값을 자르지 않는다 — 자르면 이상을 못 본다", () => {
    expect(ratioBp(3, 2, "문의가")).toEqual({ status: "measured", value: 15_000 });
  });
});

describe("feeRevenue — O-15 미결이면 금액을 만들지 않는다", () => {
  it("기준이 없으면 undecided 이고 O-15 를 가리킨다", () => {
    const result = feeRevenue(raw({ feeAmount: 900_000, settlementRows: 3 }), { basis: null });

    expect(result.metric.status).toBe("undecided");
    expect(result.metric.status === "undecided" && result.metric.openIssue).toBe("O-15");
  });

  it("**0원으로 적지 않는다** — 0원은 기준이 정해졌다는 뜻이 된다", () => {
    const result = feeRevenue(raw(), { basis: null });

    expect(result.metric).not.toEqual({ status: "measured", value: 0 });
  });

  it("기준이 정해지면 같은 합계를 그대로 낸다", () => {
    const result = feeRevenue(raw({ feeAmount: 900_000, settlementRows: 3 }), {
      basis: "pre_discount",
    });

    expect(result.metric).toEqual({ status: "measured", value: 900_000 });
    expect(result.basis).toContain("pre_discount");
  });

  it("기준이 빈 문자열이어도 미결로 본다", () => {
    expect(feeRevenue(raw(), { basis: "" }).metric.status).toBe("undecided");
  });
});

describe("buildCards", () => {
  const cards = buildCards(
    raw({
      signups: 9,
      consumerSignups: 5,
      mau: 2,
      reportsRequested: 4,
      reportsSucceeded: 3,
      inquiries: 4,
      bookings: 1,
      gmvAmount: 12_000_000,
      membershipsStarted: 2,
      membershipsCanceled: 1,
      membershipsActive: 1,
    }),
    { basis: null },
  );

  it("F-A-07 이 요구한 지표가 모두 있다", () => {
    for (const key of [
      "signups",
      "mau",
      "reports",
      "inquiries",
      "bookings",
      "inquiry_to_booking",
      "gmv",
      "fee_revenue",
      "membership_started",
      "membership_churn",
    ]) {
      expect(cards.map((row) => row.key)).toContain(key);
    }
  });

  it("측정된 카드에는 반드시 근거가 붙는다 — 근거 없는 0을 만들지 않는다", () => {
    for (const row of cards) {
      if (isMeasured(row.metric)) expect(row.basis.length).toBeGreaterThan(0);
    }
  });

  it("문의 → 예약 전환은 예약÷문의다", () => {
    expect(card(cards, "inquiry_to_booking").metric).toEqual({ status: "measured", value: 2_500 });
  });

  it("이탈률 분모는 기간 말 활성 + 기간 내 이탈이다", () => {
    // 이탈 1 ÷ (활성 1 + 해지 1 + 만료 0) = 50%
    expect(card(cards, "membership_churn_rate").metric).toEqual({
      status: "measured",
      value: 5_000,
    });
  });

  it("전원이 이탈해도 이탈률이 사라지지 않는다", () => {
    const all = buildCards(raw({ membershipsCanceled: 3, membershipsActive: 0 }), { basis: null });

    expect(card(all, "membership_churn_rate").metric).toEqual({ status: "measured", value: 10_000 });
  });

  it("문의가 0건이면 전환율은 0%가 아니라 모수 없음이다", () => {
    const empty = buildCards(raw({ bookings: 0, inquiries: 0 }), { basis: null });

    expect(card(empty, "inquiry_to_booking").metric.status).toBe("no_basis");
  });

  it("GMV 는 정수다 — 부동소수점을 만들지 않는다", () => {
    const gmv = card(cards, "gmv").metric;

    expect(isMeasured(gmv) && Number.isInteger(gmv.value)).toBe(true);
  });

  it("측정된 0은 그대로 0으로 낸다 — 실제로 0건이었다는 사실이다", () => {
    const empty = buildCards(raw(), { basis: null });

    expect(card(empty, "signups").metric).toEqual({ status: "measured", value: 0 });
  });
});

describe("buildFunnel", () => {
  const steps = buildFunnel(
    raw({
      signups: 100,
      consumerSignups: 100,
      onboardedCouples: 50,
      couplesWithCart: 25,
      inquiries: 10,
      consultations: 5,
      bookings: 2,
      contracts: 1,
    }),
  );

  it("일곱 단계를 순서대로 낸다", () => {
    expect(steps.map((step) => step.key)).toEqual([
      "signup",
      "onboarded",
      "cart",
      "inquiry",
      "consultation",
      "booking",
      "contract",
    ]);
  });

  it("첫 단계에는 잔존율이 없다 — 직전이 없다", () => {
    expect(steps[0].vsPreviousBp).toBeNull();
  });

  it("잔존율은 직전 단계 대비다", () => {
    expect(steps[1].vsPreviousBp).toEqual({ status: "measured", value: 5_000 });
    expect(steps[2].vsPreviousBp).toEqual({ status: "measured", value: 5_000 });
  });

  it("직전 단계가 0이면 잔존율은 0%가 아니라 모수 없음이다", () => {
    const broken = buildFunnel(raw({ consumerSignups: 0, onboardedCouples: 0 }));

    expect(broken[1].vsPreviousBp?.status).toBe("no_basis");
  });

  it("모든 단계가 세는 근거를 갖는다", () => {
    for (const step of steps) expect(step.basis.length).toBeGreaterThan(0);
  });

  /**
   * **코호트가 아니라는 사실을 테스트로 못 박는다.** 뒷 칸이 앞 칸보다 큰 값을 100% 로
   * 자르고 싶은 유혹이 있는데, 자르는 순간 "예약이 상담보다 많다" 는 관측이 화면에서
   * 사라진다 — 그것은 데이터가 이상하다는 신호이지 표시 버그가 아니다.
   */
  it("뒷 칸이 앞 칸보다 커도 자르지 않는다 — 코호트가 아니라 기간 내 건수다", () => {
    const crossPeriod = buildFunnel(
      raw({ consumerSignups: 1, onboardedCouples: 1, couplesWithCart: 1, inquiries: 1, bookings: 5 }),
    );
    const booking = crossPeriod.find((step) => step.key === "booking");

    // 상담 0 이라 직전 대비는 모수 없음이고, 건수는 5 그대로 남는다.
    expect(booking?.count).toEqual({ status: "measured", value: 5 });
    expect(booking?.vsPreviousBp?.status).toBe("no_basis");
  });

  it("소비자 가입이 첫 칸이다 — 운영자·업체 계정을 분모에 넣지 않는다", () => {
    const mixed = buildFunnel(raw({ signups: 100, consumerSignups: 10, onboardedCouples: 5 }));

    expect(mixed[0].count).toEqual({ status: "measured", value: 10 });
    // 5/10 = 50%. 전체 가입(100)으로 나눴다면 5% 가 나왔을 것이다.
    expect(mixed[1].vsPreviousBp).toEqual({ status: "measured", value: 5_000 });
  });
});

describe("pendingCards — 못 세는 지표를 0으로 두지 않는다", () => {
  // **못 세는 이유가 둘이다**(D-108 · S8-07 이 갈랐다).
  //
  //   `not_yet`    기능이 아직 없다 → 담당 태스크를 밝힌다
  //   `undecided`  기능은 있는데 **기준이 없다** → 오픈 이슈 번호를 밝힌다
  //
  // AI 비용이 뒤쪽으로 옮겨 갔다: 토큰은 실제로 쌓이고(0059) 단가만 비어 있다(O-21).
  // 둘을 한 상태로 묶으면 "만들면 되는 것" 과 "정해야 하는 것" 이 같아 보인다.
  it("전부 not_yet 이거나 undecided 이고, 각자 근거를 밝힌다", () => {
    for (const row of pendingCards()) {
      expect(["not_yet", "undecided"]).toContain(row.metric.status);

      if (row.metric.status === "not_yet") {
        expect(row.metric.filledBy).toMatch(/^S\d+-\d+$/);
        expect(row.metric.reason.length).toBeGreaterThan(0);
      }

      if (row.metric.status === "undecided") {
        expect(row.metric.openIssue).toMatch(/^O-\d+$/);
        expect(row.metric.reason.length).toBeGreaterThan(0);
      }
    }
  });

  it("**0 으로 적힌 카드가 하나도 없다** — 0은 '측정했더니 0' 이라는 뜻이다", () => {
    for (const row of pendingCards()) expect(row.metric.status).not.toBe("measured");
  });

  it("측정 카드와 키가 겹치지 않는다", () => {
    const measuredKeys = buildCards(raw(), { basis: null }).map((row) => row.key);

    for (const row of pendingCards()) expect(measuredKeys).not.toContain(row.key);
  });
});
