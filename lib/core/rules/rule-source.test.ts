import { describe, expect, it } from "vitest";

import { DETECT_RULES, DETECT_RULES_VERSION } from "./detect-rules";
import {
  RULE_SET_EMPTY_MESSAGE,
  codeOnlyRuleSet,
  hasDrift,
  mergeDetectRules,
  ruleSetUsable,
  type DetectRuleRow,
} from "./rule-source";

const V = DETECT_RULES_VERSION;

function row(code: string, patch: Partial<DetectRuleRow> = {}): DetectRuleRow {
  return {
    code,
    prompt_fragment: null,
    basis_ref: null,
    version: V,
    is_active: true,
    ...patch,
  };
}

function allRows(): DetectRuleRow[] {
  return DETECT_RULES.map((rule) => row(rule.code));
}

describe("mergeDetectRules — 무엇을 누가 갖는가", () => {
  it("DB 행이 전부 있으면 코드 룰 20종이 그대로 살아 있다", () => {
    const merged = mergeDetectRules(DETECT_RULES, allRows());

    expect(merged.source).toBe("database");
    expect(merged.rules).toHaveLength(DETECT_RULES.length);
    expect(hasDrift(merged.drift)).toBe(false);
  });

  it("정규식은 언제나 코드에서 온다 — DB 행에는 패턴이 없다", () => {
    const merged = mergeDetectRules(DETECT_RULES, allRows());
    const first = merged.rules.find((rule) => rule.code === "R-01");

    expect(first?.detect).toEqual(DETECT_RULES[0].detect);
  });

  it("DB 가 끈 룰은 스캔에서 빠지고 그 사실이 남는다", () => {
    const rows = allRows().map((r) => (r.code === "R-03" ? { ...r, is_active: false } : r));
    const merged = mergeDetectRules(DETECT_RULES, rows);

    expect(merged.rules.some((rule) => rule.code === "R-03")).toBe(false);
    expect(merged.disabled).toContain("R-03");
  });

  it("운영자가 다듬은 문안·근거는 DB 값을 쓴다", () => {
    const rows = allRows().map((r) =>
      r.code === "R-05" ? { ...r, prompt_fragment: "다듬은 지시문", basis_ref: "다듬은 근거" } : r,
    );
    const merged = mergeDetectRules(DETECT_RULES, rows);
    const rule = merged.rules.find((r) => r.code === "R-05");

    expect(rule?.prompt_fragment).toBe("다듬은 지시문");
    expect(rule?.basis_ref).toBe("다듬은 근거");
  });

  it("빈 문자열은 '지웠다' 가 아니라 사고로 본다 — 코드 값을 남긴다", () => {
    const rows = allRows().map((r) =>
      r.code === "R-05" ? { ...r, prompt_fragment: "   ", basis_ref: "" } : r,
    );
    const merged = mergeDetectRules(DETECT_RULES, rows);
    const rule = merged.rules.find((r) => r.code === "R-05");
    const source = DETECT_RULES.find((r) => r.code === "R-05");

    expect(rule?.prompt_fragment).toBe(source?.prompt_fragment);
    expect(rule?.basis_ref).toBe(source?.basis_ref);
  });
});

describe("어긋남을 삼키지 않는다", () => {
  it("DB 에만 있는 코드는 실행하지 않고 drift 로 알린다", () => {
    const merged = mergeDetectRules(DETECT_RULES, [...allRows(), row("R-99")]);

    expect(merged.rules.some((rule) => rule.code === "R-99")).toBe(false);
    expect(merged.drift.unknownInDatabase).toEqual(["R-99"]);
    expect(hasDrift(merged.drift)).toBe(true);
  });

  it("DB 에 없는 룰은 코드 값으로 돌되 시드가 밀렸다는 사실을 남긴다", () => {
    const rows = allRows().filter((r) => r.code !== "R-07");
    const merged = mergeDetectRules(DETECT_RULES, rows);

    expect(merged.rules.some((rule) => rule.code === "R-07")).toBe(true);
    expect(merged.drift.missingInDatabase).toEqual(["R-07"]);
  });

  it("판본이 다르면 알린다 — 룰 내용이 달라졌을 수 있다", () => {
    const rows = allRows().map((r) => (r.code === "R-02" ? { ...r, version: "2020-01-01" } : r));
    const merged = mergeDetectRules(DETECT_RULES, rows);

    expect(merged.drift.versionMismatch).toEqual(["R-02"]);
  });
});

describe("DB 를 못 읽었을 때", () => {
  it("행이 0건이면 코드 경로로 되돌린다", () => {
    const merged = mergeDetectRules(DETECT_RULES, []);

    expect(merged.source).toBe("code");
    expect(merged.rules).toHaveLength(DETECT_RULES.length);
  });

  it("0건 폴백은 '시드 전' 이라는 사실을 전부 drift 로 남긴다", () => {
    const merged = mergeDetectRules(DETECT_RULES, []);

    expect(merged.drift.missingInDatabase).toHaveLength(DETECT_RULES.length);
  });

  it("codeOnlyRuleSet 은 코드가 꺼 둔 룰까지 되살리지 않는다", () => {
    const merged = codeOnlyRuleSet([
      { ...DETECT_RULES[0] },
      { ...DETECT_RULES[1], is_active: false },
    ]);

    expect(merged.rules).toHaveLength(1);
    expect(merged.source).toBe("code");
  });
});

describe("룰 0건으로 분석을 시작하지 않는다", () => {
  it("전부 꺼져 있으면 사용할 수 없는 룰 세트다", () => {
    const rows = allRows().map((r) => ({ ...r, is_active: false }));
    const merged = mergeDetectRules(DETECT_RULES, rows);

    expect(merged.rules).toHaveLength(0);
    expect(ruleSetUsable(merged)).toBe(false);
  });

  it("'위험 없음' 과 '아무것도 보지 않았다' 를 구분하는 문구가 있다", () => {
    expect(RULE_SET_EMPTY_MESSAGE).toContain("분석을 시작하지 않았");
  });

  it("한 종이라도 켜져 있으면 사용할 수 있다", () => {
    const rows = allRows().map((r) => ({ ...r, is_active: r.code === "R-01" }));
    const merged = mergeDetectRules(DETECT_RULES, rows);

    expect(ruleSetUsable(merged)).toBe(true);
  });
});

describe("시드와 코드가 같은 것을 가리킨다", () => {
  it("룰은 20종이고 코드가 중복되지 않는다", () => {
    expect(DETECT_RULES).toHaveLength(20);
    expect(new Set(DETECT_RULES.map((rule) => rule.code)).size).toBe(20);
  });

  it("모든 룰이 같은 판본을 쓴다 — 시드가 판본 하나로 들어간다", () => {
    expect(DETECT_RULES.every((rule) => rule.version === V)).toBe(true);
  });

  it("근거에 조항 번호를 적지 않는다 (법무 검수 전 · 부록 D ②)", () => {
    for (const rule of DETECT_RULES) {
      expect(rule.basis_ref).not.toMatch(/제\s*\d+\s*조/);
    }
  });

  it("모든 룰이 검출 조건을 갖는다 — 조건 없는 룰은 시드에서 빈 칸이 된다", () => {
    for (const rule of DETECT_RULES) {
      expect(Boolean(rule.detect.presence ?? rule.detect.absence)).toBe(true);
    }
  });
});
