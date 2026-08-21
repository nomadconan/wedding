import { describe, expect, it } from "vitest";

import { AI_DISCLAIMER } from "../legal";
import {
  CONTRACT_TERM_KINDS,
  CONTRACT_TERM_LABEL,
  barBp,
  comparisonOf,
  contractTermOf,
  excessSentence,
  isDisclosable,
  ruleStateOf,
  standardZeroReason,
} from "./penalty-view";

const settlement = (penalty: number) => ({ penalty, depositRefund: 0, balanceDue: 0 });

describe("기준의 출처 — '0원' 이 아니라 '기준 미설정'", () => {
  it("**DB 에 기준이 없으면 그 사실을 말한다** — 금액을 0으로 두지 않는다", () => {
    const state = ruleStateOf({ source: "draft", isDraft: true });

    expect(state.settled).toBe(false);
    expect(state.headline).toContain("등록되지 않았");
    // '0원' 이라고 말하지 않는다.
    expect(state.headline).not.toContain("0원");
  });

  it("등록은 됐지만 일부가 가정치면 그것도 말한다", () => {
    const state = ruleStateOf({ source: "database", isDraft: true });

    expect(state.settled).toBe(false);
    expect(state.headline).toContain("가정치");
  });

  it("확정 기준으로 계산했을 때만 `settled` 다", () => {
    expect(ruleStateOf({ source: "database", isDraft: false }).settled).toBe(true);
  });

  it("어느 상태든 무엇을 해야 확정되는지 적는다", () => {
    for (const source of ["draft", "database"] as const) {
      for (const isDraft of [true, false]) {
        expect(ruleStateOf({ source, isDraft }).detail).not.toBe("");
      }
    }
  });
});

describe("비교 막대", () => {
  it("**둘 중 큰 값을 100% 로 잡는다** — 총액 기준이면 차이가 안 보인다", () => {
    const comparison = comparisonOf({
      result: { standard: settlement(1_000_000), contract: settlement(3_000_000), excessPenalty: 2_000_000 },
      totalAmount: 30_000_000,
    });

    expect(comparison.scale).toBe(3_000_000);
    expect(comparison.contractBp).toBe(10_000);
    expect(comparison.standardBp).toBe(3_333);
  });

  it("둘 다 0이면 나눗셈을 하지 않는다", () => {
    const comparison = comparisonOf({
      result: { standard: settlement(0), contract: settlement(0), excessPenalty: 0 },
      totalAmount: 0,
    });

    expect(comparison.standardBp).toBe(0);
    expect(comparison.contractBp).toBe(0);
    expect(comparison.excessOverStandardBp).toBeNull();
    expect(comparison.excessOverTotalBp).toBeNull();
  });

  it("**기준이 0이면 기준 대비 비율을 만들지 않는다** — 무한대가 된다", () => {
    const comparison = comparisonOf({
      result: { standard: settlement(0), contract: settlement(500_000), excessPenalty: 500_000 },
      totalAmount: 10_000_000,
    });

    expect(comparison.excessOverStandardBp).toBeNull();
    expect(comparison.excessOverTotalBp).toBe(500);
  });

  it("막대는 bp 정수이며 10000 을 넘지 않는다", () => {
    expect(barBp(5, 3)).toBe(10_000);
    expect(barBp(1, 3)).toBe(3_333);
    expect(Number.isInteger(barBp(7, 11))).toBe(true);
  });

  it("음수·0 입력에서 막대가 0이다", () => {
    expect(barBp(-5, 100)).toBe(0);
    expect(barBp(100, 0)).toBe(0);
  });
});

describe("초과분 문장 — 평가어를 쓰지 않는다", () => {
  const evaluative = ["과도", "부당", "불리", "악성", "심각", "위험한"];

  it("넘지 않으면 넘지 않았다고만 한다", () => {
    const comparison = comparisonOf({
      result: { standard: settlement(1_000), contract: settlement(500), excessPenalty: 0 },
      totalAmount: 10_000,
    });

    expect(excessSentence(comparison)).toContain("넘지 않아요");
  });

  it("넘으면 **금액과 비율만** 말한다", () => {
    const comparison = comparisonOf({
      result: { standard: settlement(1_000_000), contract: settlement(1_500_000), excessPenalty: 500_000 },
      totalAmount: 10_000_000,
    });

    const sentence = excessSentence(comparison);

    expect(sentence).toContain("500,000원");
    expect(sentence).toContain("50.0%");
  });

  it("**어떤 경우에도 평가적 단정을 쓰지 않는다**(CLAUDE.md §2.3)", () => {
    for (const [standard, contract] of [
      [0, 0],
      [0, 500_000],
      [1_000_000, 9_000_000],
      [9_000_000, 1_000_000],
    ]) {
      const comparison = comparisonOf({
        result: {
          standard: settlement(standard),
          contract: settlement(contract),
          excessPenalty: Math.max(0, contract - standard),
        },
        totalAmount: 10_000_000,
      });

      const sentence = excessSentence(comparison);
      for (const word of evaluative) expect(sentence).not.toContain(word);
    }
  });

  it("기준이 0이면 비율 없이 금액만 말한다", () => {
    const comparison = comparisonOf({
      result: { standard: settlement(0), contract: settlement(300_000), excessPenalty: 300_000 },
      totalAmount: 10_000_000,
    });

    expect(excessSentence(comparison)).toBe("계약서 조건이 기준보다 300,000원 많아요.");
  });
});

describe("계약 조항 입력", () => {
  it("세 가지뿐이고 전부 라벨을 갖는다", () => {
    expect([...CONTRACT_TERM_KINDS]).toEqual(["rate", "forfeit_deposit", "none"]);
    for (const kind of CONTRACT_TERM_KINDS) expect(CONTRACT_TERM_LABEL[kind]).not.toBe("");
  });

  it("퍼센트를 bp 정수로 옮긴다", () => {
    expect(contractTermOf({ kind: "rate", ratePercent: 10.5 })).toEqual({ kind: "rate", rateBp: 1050 });
    expect(contractTermOf({ kind: "rate", ratePercent: 100 })).toEqual({ kind: "rate", rateBp: 10_000 });
  });

  it("**비율을 비워 두면 0% 가 아니라 '규정 없음' 이다**", () => {
    expect(contractTermOf({ kind: "rate", ratePercent: null })).toEqual({ kind: "none" });
  });

  it("나머지 둘은 그대로 넘어간다", () => {
    expect(contractTermOf({ kind: "forfeit_deposit", ratePercent: 5 })).toEqual({
      kind: "forfeit_deposit",
    });
    expect(contractTermOf({ kind: "none", ratePercent: 5 })).toEqual({ kind: "none" });
  });
});

describe("고지 — 상시 노출을 코드가 요구한다", () => {
  it("엔진이 붙인 고지는 통과한다", () => {
    expect(isDisclosable({ disclaimer: AI_DISCLAIMER })).toBe(true);
  });

  it("**고지 없는 결과는 그리지 않는다**", () => {
    expect(isDisclosable({ disclaimer: "" })).toBe(false);
    expect(isDisclosable({ disclaimer: "참고용입니다." })).toBe(false);
  });
});

describe("기준 위약금 0원 — 계산된 0과 모르는 0을 가른다", () => {
  it("**계약금 반환 구간이면 그 이유를 적는다** — '기준이 없어서 0' 으로 읽히면 안 된다", () => {
    const reason = standardZeroReason({
      standard: { penalty: 0 },
      depositRefundable: true,
      bandLabel: "예식일 90일 전까지",
    });

    expect(reason).toContain("계약금을 돌려받아요");
    expect(reason).toContain("계산 결과");
  });

  it("요율이 0% 인 구간도 이유를 적는다", () => {
    const reason = standardZeroReason({
      standard: { penalty: 0 },
      depositRefundable: false,
      bandLabel: "예식일 90일 전까지",
    });

    expect(reason).toContain("0%");
    expect(reason).toContain("계산 결과");
  });

  it("금액이 있으면 설명하지 않는다 — 숫자가 스스로 말한다", () => {
    expect(
      standardZeroReason({
        standard: { penalty: 6_000_000 },
        depositRefundable: false,
        bandLabel: "예식일 59~30일 전",
      }),
    ).toBeNull();
  });
});
