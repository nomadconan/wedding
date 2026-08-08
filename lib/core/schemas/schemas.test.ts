import { describe, expect, it } from "vitest";

import { Constants } from "../../../types/database";
import { AI_DISCLAIMER, DISCLAIMER_REQUIRED_PHRASE } from "../legal";
import { DRAFT_PENALTY_RULE_SETS, PENALTY_RULES_VERSION } from "../pricing/penalty-rules";
import { DETECT_RULES } from "../rules/detect-rules";
import { RULE_CATEGORIES, RULE_CATEGORY_LABEL, RULE_SEVERITIES } from "../rules/types";
import {
  ESTIMATE_CATEGORIES,
  ESTIMATE_CATEGORY_LABEL,
  ESTIMATE_FLAGS,
  EstimateCategorySchema,
  EstimateComparisonSchema,
  EstimateFlagSchema,
  EstimateItemSchema,
  EstimateParseResultSchema,
  NormalizedEstimateSchema,
} from "./estimate";
import {
  ContractPenaltyTermSchema,
  PENALTY_CATEGORIES,
  PenaltyBandSchema,
  PenaltyInputSchema,
  PenaltyRuleSetSchema,
  PenaltySettlementSchema,
  bpToPercent,
  percentToBp,
} from "./penalty";
import { FindingSchema, ReportSchema, SeveritySchema } from "./report";

const validFinding = {
  rule_code: "R-02",
  severity: "high" as const,
  clause_excerpt: "계약 해지 시 계약금은 일체 반환하지 아니한다.",
  issue: "취소 시점과 무관하게 계약금 전액을 몰취하는 조항입니다.",
  basis_ref: "소비자분쟁해결기준(예식업)",
  negotiation_script: "취소 시점별 환불 비율을 조항에 명시해 주실 수 있을까요?",
};

const validReport = {
  risk_score: 72,
  summary: "위약·해지 조항에서 기준 대비 편차가 확인됩니다.",
  findings: [validFinding],
  missing_clauses: ["불가항력 시 처리 조항"],
  negotiation_points: ["계약금 환불 구간 명시 요청"],
  disclaimer: AI_DISCLAIMER,
};

describe("ReportSchema — 유효 입력", () => {
  it("유효한 리포트를 통과시킨다", () => {
    const parsed = ReportSchema.parse(validReport);

    expect(parsed.findings).toHaveLength(1);
    expect(parsed.findings[0].severity).toBe("high");
    expect(parsed.risk_score).toBe(72);
  });

  it("negotiation_points 를 생략하면 빈 배열로 채운다", () => {
    const { negotiation_points: _omitted, ...withoutPoints } = validReport;
    const parsed = ReportSchema.parse(withoutPoints);

    expect(parsed.negotiation_points).toEqual([]);
  });

  it("disclaimer 를 생략하면 고정 고지로 채운다", () => {
    const { disclaimer: _omitted, ...withoutDisclaimer } = validReport;
    const parsed = ReportSchema.parse(withoutDisclaimer);

    expect(parsed.disclaimer).toBe(AI_DISCLAIMER);
    expect(parsed.disclaimer).toContain(DISCLAIMER_REQUIRED_PHRASE);
  });

  it("findings 가 비어 있어도 통과한다 (위험 조항 없음)", () => {
    expect(ReportSchema.safeParse({ ...validReport, findings: [] }).success).toBe(true);
  });

  it("점수 경계값 0·100 을 허용한다", () => {
    expect(ReportSchema.safeParse({ ...validReport, risk_score: 0 }).success).toBe(true);
    expect(ReportSchema.safeParse({ ...validReport, risk_score: 100 }).success).toBe(true);
  });
});

describe("ReportSchema — 필수 필드 누락·위반", () => {
  const required = ["risk_score", "summary", "findings", "missing_clauses"] as const;

  for (const field of required) {
    it(`${field} 가 없으면 실패한다`, () => {
      const partial: Record<string, unknown> = { ...validReport };
      delete partial[field];

      expect(ReportSchema.safeParse(partial).success).toBe(false);
    });
  }

  it("점수가 범위를 벗어나면 실패한다", () => {
    expect(ReportSchema.safeParse({ ...validReport, risk_score: 101 }).success).toBe(false);
    expect(ReportSchema.safeParse({ ...validReport, risk_score: -1 }).success).toBe(false);
  });

  it("점수가 정수가 아니면 실패한다", () => {
    expect(ReportSchema.safeParse({ ...validReport, risk_score: 72.5 }).success).toBe(false);
  });

  it("summary 가 빈 문자열이면 실패한다", () => {
    expect(ReportSchema.safeParse({ ...validReport, summary: "" }).success).toBe(false);
  });

  it("고지 문구가 요건을 벗어나면 실패한다", () => {
    const result = ReportSchema.safeParse({ ...validReport, disclaimer: "참고용 정보입니다." });

    expect(result.success).toBe(false);
  });
});

describe("FindingSchema", () => {
  it("정의되지 않은 rule_code 를 거부한다", () => {
    expect(FindingSchema.safeParse({ ...validFinding, rule_code: "R-99" }).success).toBe(false);
  });

  it("rule_code 형식이 다르면 거부한다", () => {
    expect(FindingSchema.safeParse({ ...validFinding, rule_code: "PENALTY" }).success).toBe(false);
  });

  it("정의된 20종 코드는 모두 통과한다", () => {
    for (const rule of DETECT_RULES) {
      const result = FindingSchema.safeParse({ ...validFinding, rule_code: rule.code });
      expect(result.success, `${rule.code} 가 거부됨`).toBe(true);
    }
  });

  it("허용되지 않은 severity 를 거부한다", () => {
    expect(FindingSchema.safeParse({ ...validFinding, severity: "critical" }).success).toBe(false);
    expect(FindingSchema.safeParse({ ...validFinding, severity: "red" }).success).toBe(false);
  });

  it("근거·협상 문구가 비면 거부한다", () => {
    expect(FindingSchema.safeParse({ ...validFinding, basis_ref: "" }).success).toBe(false);
    expect(FindingSchema.safeParse({ ...validFinding, negotiation_script: "" }).success).toBe(false);
  });
});

describe("PenaltyInputSchema", () => {
  const valid = {
    category: "hall" as const,
    totalAmount: 10_000_000,
    depositAmount: 1_000_000,
    eventDate: "2026-10-01",
    cancelDate: "2026-09-01",
    contractTerm: { kind: "rate" as const, rateBp: percentToBp(20) },
  };

  it("유효 입력을 통과시킨다", () => {
    expect(PenaltyInputSchema.safeParse(valid).success).toBe(true);
  });

  it("요율 상한(10000bp = 100%)을 넘으면 거부한다", () => {
    expect(
      PenaltyInputSchema.safeParse({ ...valid, contractTerm: { kind: "rate", rateBp: 10_001 } })
        .success,
    ).toBe(false);
  });

  it("정의되지 않은 카테고리를 거부한다", () => {
    expect(PenaltyInputSchema.safeParse({ ...valid, category: "flower" }).success).toBe(false);
  });

  it("계약서 위약 조건 3종을 모두 허용한다", () => {
    for (const contractTerm of [
      { kind: "rate", rateBp: 1_000 },
      { kind: "forfeit_deposit" },
      { kind: "none" },
    ]) {
      expect(PenaltyInputSchema.safeParse({ ...valid, contractTerm }).success).toBe(true);
    }
  });
});

describe("견적 정규화 스키마 (§5.4)", () => {
  const item = {
    raw_label: "홀 대관료",
    mapped_category: "hall" as const,
    amount: 5_000_000,
    is_option: false,
    is_mandatory: true,
    confidence: 0.92,
    is_estimated: false,
  };

  it("유효 항목을 통과시킨다", () => {
    expect(EstimateItemSchema.safeParse(item).success).toBe(true);
  });

  it("confidence 범위(0~1)를 강제한다", () => {
    expect(EstimateItemSchema.safeParse({ ...item, confidence: 1.1 }).success).toBe(false);
    expect(EstimateItemSchema.safeParse({ ...item, confidence: -0.1 }).success).toBe(false);
  });

  it("금액이 정수가 아니면 거부한다", () => {
    expect(EstimateItemSchema.safeParse({ ...item, amount: 100.5 }).success).toBe(false);
  });

  it("미매핑 항목을 버리지 않고 unmapped 로 유지한다", () => {
    const parsed = EstimateItemSchema.parse({ ...item, mapped_category: "unmapped" });

    expect(parsed.mapped_category).toBe("unmapped");
  });

  it("모든 카테고리에 라벨이 있다", () => {
    for (const category of ESTIMATE_CATEGORIES) {
      expect(ESTIMATE_CATEGORY_LABEL[category]).toBeTruthy();
    }
  });

  it("업체명은 마스킹 값 또는 null 만 받는다", () => {
    const parsed = EstimateParseResultSchema.parse({
      vendor_name_masked: null,
      items: [item],
      declared_total: 5_000_000,
    });

    expect(parsed.vendor_name_masked).toBeNull();
  });

  it("정규화 결과에 검증 플래그를 담을 수 있다", () => {
    const parsed = NormalizedEstimateSchema.parse({
      vendor_name_masked: "[VENDOR_1]",
      by_category: [{ category: "hall", amount: 5_000_000, is_estimated: false }],
      base_total: 5_000_000,
      real_total: 5_500_000,
      declared_total: 5_000_000,
      flags: ["total_mismatch", "has_estimated"],
    });

    expect(parsed.flags).toContain("total_mismatch");
  });

  it("정의되지 않은 플래그를 거부한다", () => {
    const result = NormalizedEstimateSchema.safeParse({
      vendor_name_masked: null,
      by_category: [],
      base_total: 0,
      real_total: 0,
      declared_total: null,
      flags: ["something_else"],
    });

    expect(result.success).toBe(false);
  });
});

describe("types/database.ts enum 과의 값 일치", () => {
  it("severity 값이 finding_severity enum 과 같다", () => {
    expect([...RULE_SEVERITIES]).toEqual([...Constants.public.Enums.finding_severity]);
  });

  it("리포트 severity 후보가 DB enum 을 벗어나지 않는다", () => {
    for (const severity of Constants.public.Enums.finding_severity) {
      expect(SeveritySchema.safeParse(severity).success).toBe(true);
      expect(FindingSchema.safeParse({ ...validFinding, severity }).success).toBe(true);
    }
  });

  it("DB enum 에 없는 severity 는 거부한다", () => {
    expect(SeveritySchema.safeParse("critical").success).toBe(false);
  });

  it("위약금 카테고리가 vendors 카테고리 표기 규약(ASCII 코드)을 따른다", () => {
    for (const category of PENALTY_CATEGORIES) {
      expect(category).toMatch(/^[a-z_]+$/);
    }
  });

  it("견적 카테고리도 ASCII 코드 규약을 따른다", () => {
    for (const category of ESTIMATE_CATEGORIES) {
      expect(category).toMatch(/^[a-z_]+$/);
    }
  });

  it("detect_rules 코드 규약(R-NN)을 지킨다", () => {
    for (const rule of DETECT_RULES) {
      expect(rule.code).toMatch(/^R-\d{2}$/);
      expect(rule.category).toMatch(/^[a-z_]+$/);
    }
  });

  it("룰 카테고리 전부에 표시용 라벨이 있다", () => {
    for (const category of RULE_CATEGORIES) {
      expect(RULE_CATEGORY_LABEL[category]).toBeTruthy();
    }
  });
});

describe("위약금 룰 스키마 검증", () => {
  const band = {
    code: "D30_59",
    label: "예식일 59~30일 전",
    minDaysBeforeEvent: 30,
    maxDaysBeforeEvent: 59,
    rateBp: 2_000,
    refundDeposit: false,
  };

  it("유효한 구간을 통과시킨다", () => {
    expect(PenaltyBandSchema.safeParse(band).success).toBe(true);
  });

  it("상한이 null 인 구간(무제한)을 허용한다", () => {
    expect(PenaltyBandSchema.safeParse({ ...band, maxDaysBeforeEvent: null }).success).toBe(true);
  });

  it("min > max 인 구간을 거부한다", () => {
    const result = PenaltyBandSchema.safeParse({
      ...band,
      minDaysBeforeEvent: 60,
      maxDaysBeforeEvent: 30,
    });

    expect(result.success).toBe(false);
  });

  it("요율이 100%를 넘는 구간을 거부한다", () => {
    expect(PenaltyBandSchema.safeParse({ ...band, rateBp: 10_001 }).success).toBe(false);
  });

  it("구간이 하나도 없는 룰 세트를 거부한다", () => {
    const result = PenaltyRuleSetSchema.safeParse({
      category: "hall",
      version: "test",
      basisRef: "test",
      isDraft: true,
      bands: [],
      afterEvent: band,
    });

    expect(result.success).toBe(false);
  });

  it("기본 룰 세트가 카테고리 전부에 대해 스키마를 만족한다", () => {
    for (const category of PENALTY_CATEGORIES) {
      const ruleSet = DRAFT_PENALTY_RULE_SETS[category];

      expect(PenaltyRuleSetSchema.safeParse(ruleSet).success, category).toBe(true);
      expect(ruleSet.category).toBe(category);
      expect(ruleSet.version).toBe(PENALTY_RULES_VERSION);
      expect(ruleSet.isDraft).toBe(true);
    }
  });

  it("계약서 위약 조건 판별 유니온이 알 수 없는 kind 를 거부한다", () => {
    expect(ContractPenaltyTermSchema.safeParse({ kind: "whatever" }).success).toBe(false);
  });

  it("정산 결과에 음수 금액을 허용하지 않는다", () => {
    expect(
      PenaltySettlementSchema.safeParse({ penalty: -1, depositRefund: 0, balanceDue: 0 }).success,
    ).toBe(false);
  });

  it("bpToPercent 는 percentToBp 의 역이다", () => {
    for (const percent of [0, 10, 10.5, 35, 100]) {
      expect(bpToPercent(percentToBp(percent))).toBe(percent);
    }
  });
});

describe("견적 비교표 스키마 (F-C-06 — 2~5개)", () => {
  const normalized = {
    vendor_name_masked: null,
    by_category: [],
    base_total: 0,
    real_total: 0,
    declared_total: null,
    flags: [],
  };

  function comparison(count: number) {
    return {
      estimates: Array.from({ length: count }, () => normalized),
      categories: ["hall"],
      missing_by_estimate: [],
    };
  }

  it("2~5개 비교를 허용한다", () => {
    for (const count of [2, 3, 4, 5]) {
      expect(EstimateComparisonSchema.safeParse(comparison(count)).success, `${count}개`).toBe(true);
    }
  });

  it("1개 이하·6개 이상은 거부한다", () => {
    expect(EstimateComparisonSchema.safeParse(comparison(1)).success).toBe(false);
    expect(EstimateComparisonSchema.safeParse(comparison(6)).success).toBe(false);
  });

  it("플래그 목록이 스키마와 일치한다", () => {
    for (const flag of ESTIMATE_FLAGS) {
      expect(EstimateFlagSchema.safeParse(flag).success).toBe(true);
    }
    expect(EstimateFlagSchema.safeParse("unknown_flag").success).toBe(false);
  });

  it("카테고리 스키마가 정의된 값만 받는다", () => {
    expect(EstimateCategorySchema.safeParse("hall").success).toBe(true);
    expect(EstimateCategorySchema.safeParse("wedding_hall").success).toBe(false);
  });
});
