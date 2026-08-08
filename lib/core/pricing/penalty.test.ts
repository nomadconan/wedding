import { describe, expect, it } from "vitest";

import type { PenaltyInput, PenaltyRuleSet } from "../schemas/penalty";
import { percentToBp } from "../schemas/penalty";
import {
  PenaltyRuleError,
  calculatePenalty,
  daysUntilEvent,
  getDraftPenaltyRuleSet,
  selectBand,
} from "./penalty";

const HALL_RULES = getDraftPenaltyRuleSet("hall");

const EVENT_DATE = "2026-10-01";
const TOTAL = 10_000_000;
const DEPOSIT = 1_000_000;

/** 예식일 기준으로 남은 일수가 정확히 N일이 되는 취소일. */
const CANCEL_DATE: Record<number, string> = {
  91: "2026-07-02",
  90: "2026-07-03",
  89: "2026-07-04",
  60: "2026-08-02",
  59: "2026-08-03",
  30: "2026-09-01",
  29: "2026-09-02",
  1: "2026-09-30",
  0: "2026-10-01",
  [-1]: "2026-10-02",
};

function input(overrides: Partial<PenaltyInput> = {}): PenaltyInput {
  return {
    category: "hall",
    totalAmount: TOTAL,
    depositAmount: DEPOSIT,
    eventDate: EVENT_DATE,
    cancelDate: CANCEL_DATE[89],
    contractTerm: { kind: "none" },
    ...overrides,
  };
}

describe("daysUntilEvent", () => {
  it("샘플 취소일이 의도한 남은 일수를 만든다", () => {
    for (const [days, date] of Object.entries(CANCEL_DATE)) {
      expect(daysUntilEvent(date, EVENT_DATE), `${date}`).toBe(Number(days));
    }
  });

  it("예식 당일 취소는 0일이다", () => {
    expect(daysUntilEvent(EVENT_DATE, EVENT_DATE)).toBe(0);
  });

  it("예식일이 지난 취소는 음수다", () => {
    expect(daysUntilEvent("2026-10-05", EVENT_DATE)).toBe(-4);
  });

  it("타임존이 붙은 ISO 문자열이어도 날짜가 밀리지 않는다", () => {
    // KST 자정은 UTC 로는 전날이다. 날짜 부분만 쓰므로 결과가 같아야 한다.
    expect(daysUntilEvent("2026-09-02T00:00:00+09:00", "2026-10-01T00:00:00+09:00")).toBe(29);
    expect(daysUntilEvent("2026-09-02T23:59:59+09:00", "2026-10-01")).toBe(29);
  });

  it("윤년 2월을 넘는 구간도 정확하다", () => {
    expect(daysUntilEvent("2028-02-28", "2028-03-01")).toBe(2); // 2028-02-29 존재
    expect(daysUntilEvent("2027-02-28", "2027-03-01")).toBe(1);
  });
});

describe("취소 시점 구간 경계 — 경계일 당일이 어느 구간에 속하는가", () => {
  const cases: Array<[number, string]> = [
    [91, "D90_PLUS"],
    [90, "D90_PLUS"], // 경계일 당일은 상위 구간
    [89, "D60_89"], // 경계 -1
    [60, "D60_89"],
    [59, "D30_59"],
    [30, "D30_59"],
    [29, "D00_29"],
    [1, "D00_29"],
    [0, "D00_29"], // 예식 당일
    [-1, "AFTER_EVENT"], // 예식일 경과
  ];

  for (const [days, expectedBand] of cases) {
    it(`D-${days} → ${expectedBand}`, () => {
      const result = calculatePenalty(input({ cancelDate: CANCEL_DATE[days] }), HALL_RULES);

      expect(result.daysBeforeEvent).toBe(days);
      expect(result.bandCode).toBe(expectedBand);
    });
  }

  it("selectBand 는 구간 배열의 정렬 순서에 좌우되지 않는다", () => {
    const reversed: PenaltyRuleSet = { ...HALL_RULES, bands: [...HALL_RULES.bands].reverse() };

    expect(selectBand(reversed, 90).code).toBe("D90_PLUS");
    expect(selectBand(reversed, 89).code).toBe("D60_89");
    expect(selectBand(reversed, 0).code).toBe("D00_29");
  });

  it("어느 구간에도 걸리지 않으면 PenaltyRuleError 를 던진다", () => {
    const sparse: PenaltyRuleSet = {
      ...HALL_RULES,
      bands: [HALL_RULES.bands.find((b) => b.code === "D90_PLUS")!],
    };

    expect(() => selectBand(sparse, 10)).toThrow(PenaltyRuleError);
  });
});

describe("계약금 반환 여부 분기", () => {
  it("반환 구간에서는 계약금 전액을 돌려받고 위약금이 0이다", () => {
    const result = calculatePenalty(input({ cancelDate: CANCEL_DATE[90] }), HALL_RULES);

    expect(result.depositRefundable).toBe(true);
    expect(result.standard.penalty).toBe(0);
    expect(result.standard.depositRefund).toBe(DEPOSIT);
    expect(result.standard.balanceDue).toBe(0);
  });

  it("계약금이 위약금과 같으면 반환액도 추가 부담도 0이다", () => {
    // D-89 구간 10% → 1,000,000원 = 계약금
    const result = calculatePenalty(input({ cancelDate: CANCEL_DATE[89] }), HALL_RULES);

    expect(result.standard.penalty).toBe(1_000_000);
    expect(result.standard.depositRefund).toBe(0);
    expect(result.standard.balanceDue).toBe(0);
  });

  it("계약금이 위약금보다 크면 차액을 돌려받는다", () => {
    const result = calculatePenalty(
      input({ cancelDate: CANCEL_DATE[89], depositAmount: 3_000_000 }),
      HALL_RULES,
    );

    expect(result.standard.penalty).toBe(1_000_000);
    expect(result.standard.depositRefund).toBe(2_000_000);
    expect(result.standard.balanceDue).toBe(0);
  });

  it("계약금이 위약금보다 작으면 부족분을 추가 부담한다", () => {
    // D-59 구간 20% → 2,000,000원, 계약금 1,000,000원
    const result = calculatePenalty(input({ cancelDate: CANCEL_DATE[59] }), HALL_RULES);

    expect(result.standard.penalty).toBe(2_000_000);
    expect(result.standard.depositRefund).toBe(0);
    expect(result.standard.balanceDue).toBe(1_000_000);
  });

  it("예식일 경과 후 취소도 계산되며 경고가 붙는다", () => {
    const result = calculatePenalty(input({ cancelDate: CANCEL_DATE[-1] }), HALL_RULES);

    expect(result.bandCode).toBe("AFTER_EVENT");
    expect(result.standard.penalty).toBe(TOTAL);
    expect(result.standard.balanceDue).toBe(TOTAL - DEPOSIT);
    expect(result.notes.some((n) => n.includes("예식일이 지난"))).toBe(true);
  });
});

describe("계약서 조항 대비 초과분", () => {
  it("계약서 위약률이 기준보다 높으면 초과분이 잡힌다", () => {
    const result = calculatePenalty(
      input({ cancelDate: CANCEL_DATE[89], contractTerm: { kind: "rate", rateBp: percentToBp(80) } }),
      HALL_RULES,
    );

    expect(result.standard.penalty).toBe(1_000_000);
    expect(result.contract.penalty).toBe(8_000_000);
    expect(result.excessPenalty).toBe(7_000_000);
    expect(result.objectionScript).toContain("7,000,000원");
  });

  it("계약서 위약률이 기준보다 낮으면 초과분은 0이며 음수가 나오지 않는다", () => {
    const result = calculatePenalty(
      input({ cancelDate: CANCEL_DATE[29], contractTerm: { kind: "rate", rateBp: percentToBp(10) } }),
      HALL_RULES,
    );

    expect(result.standard.penalty).toBe(3_500_000);
    expect(result.contract.penalty).toBe(1_000_000);
    expect(result.excessPenalty).toBe(0);
    expect(result.objectionScript).toContain("기준을 넘지 않습니다");
  });

  it("계약금 전액 몰취 조항은 계약금 전액을 위약금으로 본다", () => {
    const result = calculatePenalty(
      input({ cancelDate: CANCEL_DATE[90], contractTerm: { kind: "forfeit_deposit" } }),
      HALL_RULES,
    );

    expect(result.standard.penalty).toBe(0); // 기준상 반환 구간
    expect(result.contract.penalty).toBe(DEPOSIT);
    expect(result.excessPenalty).toBe(DEPOSIT);
    expect(result.notes.some((n) => n.includes("R-02"))).toBe(true);
  });

  it("계약서에 규정이 없으면 기준 금액을 그대로 비교값으로 쓴다", () => {
    const result = calculatePenalty(
      input({ cancelDate: CANCEL_DATE[59], contractTerm: { kind: "none" } }),
      HALL_RULES,
    );

    expect(result.contract.penalty).toBe(result.standard.penalty);
    expect(result.excessPenalty).toBe(0);
  });
});

describe("비정상 입력 방어", () => {
  it("총액 0원이면 모든 금액이 0이고 경고가 붙는다", () => {
    const result = calculatePenalty(
      input({ totalAmount: 0, depositAmount: 0, cancelDate: CANCEL_DATE[29] }),
      HALL_RULES,
    );

    expect(result.standard.penalty).toBe(0);
    expect(result.contract.penalty).toBe(0);
    expect(result.excessPenalty).toBe(0);
    expect(result.notes.some((n) => n.includes("0원"))).toBe(true);
  });

  it("총액이 음수면 거부한다", () => {
    expect(() => calculatePenalty(input({ totalAmount: -1 }), HALL_RULES)).toThrow();
  });

  it("계약금이 음수면 거부한다", () => {
    expect(() => calculatePenalty(input({ depositAmount: -1 }), HALL_RULES)).toThrow();
  });

  it("금액이 정수가 아니면 거부한다", () => {
    expect(() => calculatePenalty(input({ totalAmount: 1_000_000.5 }), HALL_RULES)).toThrow();
  });

  it("계약금이 총액보다 크면 총액으로 자르고 경고를 남긴다", () => {
    const result = calculatePenalty(
      input({ totalAmount: 1_000_000, depositAmount: 5_000_000, cancelDate: CANCEL_DATE[90] }),
      HALL_RULES,
    );

    expect(result.standard.depositRefund).toBe(1_000_000);
    expect(result.notes.some((n) => n.includes("계약금"))).toBe(true);
  });

  it("날짜 형식이 잘못되면 거부한다", () => {
    expect(() => calculatePenalty(input({ cancelDate: "2026년 9월 2일" }), HALL_RULES)).toThrow();
  });

  it("룰 세트 카테고리가 입력과 다르면 PenaltyRuleError 를 던진다", () => {
    expect(() => calculatePenalty(input({ category: "studio" }), HALL_RULES)).toThrow(
      PenaltyRuleError,
    );
  });
});

describe("정수 연산·출력 규약", () => {
  it("나누어떨어지지 않는 금액도 정수로 반올림된다", () => {
    const result = calculatePenalty(
      input({ totalAmount: 3_333_333, depositAmount: 0, cancelDate: CANCEL_DATE[89] }),
      HALL_RULES,
    );

    // 3,333,333 × 10% = 333,333.3
    expect(result.standard.penalty).toBe(333_333);
    expect(Number.isInteger(result.standard.penalty)).toBe(true);
    expect(Number.isInteger(result.contract.penalty)).toBe(true);
    expect(Number.isInteger(result.excessPenalty)).toBe(true);
  });

  it("같은 입력이면 항상 같은 결과가 나온다 (LLM 미사용·결정적)", () => {
    const a = calculatePenalty(input(), HALL_RULES);
    const b = calculatePenalty(input(), HALL_RULES);

    expect(a).toEqual(b);
  });

  it("가정치 룰 세트를 쓰면 결과에 경고가 붙는다", () => {
    const result = calculatePenalty(input(), HALL_RULES);

    expect(result.notes.some((n) => n.includes("가정치"))).toBe(true);
    expect(result.ruleVersion).toBe(HALL_RULES.version);
    expect(result.basisRef).toBe(HALL_RULES.basisRef);
  });

  it("결과에 법적 고지가 상시 포함된다", () => {
    const result = calculatePenalty(input(), HALL_RULES);

    expect(result.disclaimer).toContain("법률 자문이 아닙니다");
  });

  it("이의 제기 문구가 확정적 법적 결론을 담지 않는다", () => {
    const result = calculatePenalty(
      input({ contractTerm: { kind: "rate", rateBp: percentToBp(80) } }),
      HALL_RULES,
    );

    for (const banned of ["위법", "무효", "승소", "불법", "손해배상 청구가 가능"]) {
      expect(result.objectionScript).not.toContain(banned);
    }
  });

  it("스드메 카테고리는 별도 구간을 쓴다", () => {
    const studio = getDraftPenaltyRuleSet("studio");
    const result = calculatePenalty(
      input({ category: "studio", cancelDate: CANCEL_DATE[29] }),
      studio,
    );

    expect(result.bandCode).toBe("D10_29");
    expect(result.standard.penalty).toBe(1_000_000); // 10%
  });
});

describe("percentToBp", () => {
  it("퍼센트를 basis point 정수로 바꾼다", () => {
    expect(percentToBp(10)).toBe(1_000);
    expect(percentToBp(10.5)).toBe(1_050);
    expect(percentToBp(100)).toBe(10_000);
    expect(percentToBp(0)).toBe(0);
  });
});
