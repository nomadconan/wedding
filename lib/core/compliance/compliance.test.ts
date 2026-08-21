import { describe, expect, it } from "vitest";

import { DETECT_RULES } from "../rules/detect-rules";
import { scanDocument } from "../rules/scan";
import type { RuleMatch } from "../rules/types";

import {
  BADGE_CRITERIA_NOTICE,
  BADGE_CRITERIA_PUBLIC_NOTICE,
  BADGE_REASON_NOTE,
  BADGE_SCOPE_NOTICE,
  COMPLIANCE_DISCLAIMER,
  COMPLIANCE_SETTING_KEYS,
  TERMS_MAX_LENGTH,
  TERMS_MIN_LENGTH,
  TRANSPARENT_CONTRACT_BADGE,
  activeRuleCount,
  cleanScanNote,
  countBySeverity,
  decideBadge,
  termsIssue,
  toFindings,
} from "./compliance";
import {
  COMPLIANCE_GUIDES,
  VENDOR_SEVERITY_LABEL,
  guideFor,
  rulesWithoutGuide,
} from "./guides";

/**
 * 컴플라이언스 자가 진단 (S7-13)
 *
 * **여기서 붙잡는 것은 배지다.** 배지가 붙으면 고객이 그것을 신뢰의 근거로 삼으므로,
 * 기준이 없을 때 붙거나 진단하지 않았는데 붙는 일이 없어야 한다.
 */

const match = (over: Partial<RuleMatch> = {}): RuleMatch => ({
  rule_code: "R-01",
  title: "위약금률 과다",
  category: "penalty",
  severity: "high",
  basis_ref: "소비자분쟁해결기준",
  kind: "presence",
  clause_excerpt: "위약금은 총액의 50%로 한다",
  index: 10,
  ...over,
});

describe("가이드 — 걸렸으면 무엇을 고칠지 함께 준다", () => {
  it("**룰 20종 전부에 가이드가 있다** — 없으면 업체는 고치라는 말만 듣는다", () => {
    expect(rulesWithoutGuide()).toEqual([]);
    expect(COMPLIANCE_GUIDES).toHaveLength(DETECT_RULES.length);
  });

  it("가이드 코드가 겹치지 않는다", () => {
    const codes = COMPLIANCE_GUIDES.map((guide) => guide.ruleCode);

    expect(new Set(codes).size).toBe(codes.length);
  });

  it("**조항 번호를 지어내지 않는다** — basis_ref 와 같은 규칙이다(T-04)", () => {
    for (const guide of COMPLIANCE_GUIDES) {
      const text = `${guide.why} ${guide.needs.join(" ")}`;

      expect(text).not.toMatch(/제\s*\d+\s*조/);
      expect(text).not.toMatch(/\d+\s*항/);
    }
  });

  it("**조항 문안을 대신 써 주지 않는다** — 무엇이 담겨야 하는지까지만 적는다", () => {
    for (const guide of COMPLIANCE_GUIDES) {
      expect(guide.needs.length).toBeGreaterThan(0);
      // 문안이면 따옴표로 감싼 문장이 나온다. 항목 나열은 그렇지 않다.
      for (const need of guide.needs) {
        expect(need).not.toMatch(/^["'“]/);
        expect(need.length).toBeLessThan(60);
      }
    }
  });

  it("모르는 룰 코드는 던지지 않고 null 이다", () => {
    expect(guideFor("R-99")).toBeNull();
    expect(guideFor("R-01")).not.toBeNull();
  });

  it("**업체용 등급 이름이 소비자용과 다르다** — 읽는 사람이 다르면 문장이 다르다", () => {
    expect(VENDOR_SEVERITY_LABEL.high).toBe("먼저 손볼 곳");
    // 평가적 단정을 쓰지 않는다(CLAUDE.md §2.3).
    for (const label of Object.values(VENDOR_SEVERITY_LABEL)) {
      expect(label).not.toMatch(/위험|불법|위법|나쁨/);
    }
  });
});

describe("finding 만들기", () => {
  it("**같은 룰이 여러 번 걸리면 하나로 합친다** — 할 일은 하나다", () => {
    const findings = toFindings([match(), match({ index: 40 }), match({ rule_code: "R-04" })]);

    expect(findings).toHaveLength(2);
  });

  it("합칠 때 처음 걸린 문장을 남긴다", () => {
    const findings = toFindings([
      match({ clause_excerpt: "첫 문장" }),
      match({ clause_excerpt: "둘째 문장" }),
    ]);

    expect(findings[0].clauseExcerpt).toBe("첫 문장");
  });

  it("**심각한 것부터, 같은 등급이면 코드 순** — 매번 같은 순서여야 어제와 견줄 수 있다", () => {
    const findings = toFindings([
      match({ rule_code: "R-12", severity: "mid" }),
      match({ rule_code: "R-08", severity: "mid" }),
      match({ rule_code: "R-02", severity: "high" }),
    ]);

    expect(findings.map((f) => f.ruleCode)).toEqual(["R-02", "R-08", "R-12"]);
  });

  it("가이드를 함께 싣는다", () => {
    expect(toFindings([match()])[0].guide?.needs.length).toBeGreaterThan(0);
  });

  it("등급별로 센다", () => {
    const counts = countBySeverity(
      toFindings([
        match({ rule_code: "R-01", severity: "high" }),
        match({ rule_code: "R-08", severity: "mid" }),
        match({ rule_code: "R-12", severity: "mid" }),
      ]),
    );

    expect(counts).toEqual({ high: 1, mid: 2, low: 0 });
  });

  it("빈 스캔은 빈 목록이다", () => {
    expect(toFindings([])).toEqual([]);
    expect(countBySeverity([])).toEqual({ high: 0, mid: 0, low: 0 });
  });
});

describe("**소비자 리포트와 같은 엔진을 쓴다** — 룰을 새로 만들지 않았다", () => {
  it("실제 약관 텍스트를 룰 스캔에 넣으면 finding 이 나온다", () => {
    const terms = [
      "제1조 본 계약은 예식 서비스에 관한 것이다.",
      "계약 해지 시 위약금은 총 계약금액의 50%로 한다.",
      "계약금은 어떠한 경우에도 환불되지 않는다.",
      "상세 금액은 별도 문의 바랍니다.",
    ].join("\n");

    const findings = toFindings(scanDocument(terms));

    expect(findings.length).toBeGreaterThan(0);
    // 소비자 리포트가 쓰는 것과 같은 룰 코드다.
    expect(findings.every((f) => DETECT_RULES.some((rule) => rule.code === f.ruleCode))).toBe(true);
  });

  it("검사한 룰 수를 셀 수 있다 (화면이 '무엇까지 봤는가' 를 적는 근거)", () => {
    expect(activeRuleCount()).toBeGreaterThan(0);
    expect(activeRuleCount()).toBeLessThanOrEqual(DETECT_RULES.length);
  });
});

describe("배지 — 붙으면 고객이 신뢰의 근거로 삼는다", () => {
  it("high 가 허용 개수 이하면 붙는다", () => {
    expect(decideBadge({ highCount: 0, maxHigh: 0 })).toEqual({ granted: true, reason: "passed" });
  });

  it("high 가 남아 있으면 붙지 않는다", () => {
    expect(decideBadge({ highCount: 1, maxHigh: 0 })).toEqual({
      granted: false,
      reason: "has_high",
    });
  });

  it("**진단한 적이 없으면 0건이 아니다** — 계산된 0 과 겹쳐 읽히게 두지 않는다", () => {
    const decision = decideBadge({ highCount: null, maxHigh: 0 });

    expect(decision).toEqual({ granted: false, reason: "never_scanned" });
    expect(BADGE_REASON_NOTE.never_scanned).toContain("0건이 아니라");
  });

  it("**기준이 없으면 배지를 주지 않는다** — 없는 기준을 '0건이면 통과' 로 읽지 않는다", () => {
    expect(decideBadge({ highCount: 0, maxHigh: null })).toEqual({
      granted: false,
      reason: "criteria_unconfigured",
    });
  });

  it("기준이 정수가 아니거나 음수면 미설정으로 본다", () => {
    expect(decideBadge({ highCount: 0, maxHigh: 1.5 }).granted).toBe(false);
    expect(decideBadge({ highCount: 0, maxHigh: -1 }).granted).toBe(false);
  });

  it("**코드가 기준 숫자를 갖지 않는다** — 키만 갖는다(§7.4)", () => {
    expect(COMPLIANCE_SETTING_KEYS.badgeMaxHigh.key).toBe("compliance.badge_max_high");
  });

  it("모든 사유에 설명이 있다", () => {
    for (const reason of ["passed", "never_scanned", "has_high", "criteria_unconfigured"] as const) {
      expect(BADGE_REASON_NOTE[reason].length).toBeGreaterThan(0);
    }
  });

  it("**배지가 무엇까지 참인지 함께 적는다** — 자가 진단의 한계를 감추지 않는다", () => {
    expect(BADGE_SCOPE_NOTICE).toContain("제출한 약관");
    expect(BADGE_SCOPE_NOTICE).toContain("실제 계약서와 다를 수 있");
    expect(BADGE_CRITERIA_NOTICE.length).toBeGreaterThan(0);
  });

  it("**기준 설명이 관객마다 다르다** — 고객 화면에 업체가 할 일을 적지 않는다", () => {
    expect(BADGE_CRITERIA_NOTICE).toContain("다시 진단");
    expect(BADGE_CRITERIA_PUBLIC_NOTICE).not.toContain("다시 진단");
    expect(BADGE_CRITERIA_PUBLIC_NOTICE.length).toBeGreaterThan(0);
  });

  it("배지 코드는 vendors.badge_flags 에 넣는 값이다", () => {
    expect(TRANSPARENT_CONTRACT_BADGE).toBe("transparent_contract");
  });
});

describe("입력 검증", () => {
  it("빈 값·짧은 값·긴 값을 가른다", () => {
    expect(termsIssue("   ")).toBe("empty");
    expect(termsIssue("짧다")).toBe("too_short");
    expect(termsIssue("가".repeat(TERMS_MAX_LENGTH + 1))).toBe("too_long");
    expect(termsIssue("가".repeat(TERMS_MIN_LENGTH))).toBeNull();
  });

  it("경계값에서 통과한다", () => {
    expect(termsIssue("가".repeat(TERMS_MIN_LENGTH - 1))).toBe("too_short");
    expect(termsIssue("가".repeat(TERMS_MAX_LENGTH))).toBeNull();
  });
});

describe("문구", () => {
  it("**법률 자문이 아님을 밝힌다**(§7.7)", () => {
    expect(COMPLIANCE_DISCLAIMER).toContain("법률 자문이 아닙니다");
  });

  it("**깨끗해도 '문제 없음' 이라고 적지 않는다** — 0 에 무엇을 세어 0 인지 붙인다", () => {
    const note = cleanScanNote(20);

    expect(note).toContain("20종");
    expect(note).toContain("밖의 내용은 검사하지 않았");
    expect(note).not.toContain("문제 없");
  });
});
