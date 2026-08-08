import { describe, expect, it } from "vitest";

import { DETECT_RULES, DETECT_RULES_VERSION, DETECT_RULE_CODES, getDetectRule } from "./detect-rules";
import { scanDocument } from "./scan";
import { RULE_CATEGORIES, RULE_SEVERITIES } from "./types";

/**
 * 부록 A 룰 20종 샘플.
 *
 * positive — 해당 룰이 **반드시** 검출돼야 하는 문서
 * negative — 해당 룰이 **검출되면 안 되는** 문서(같은 주제를 제대로 규정한 조항)
 *
 * negative 문서가 다른 룰(예: 부재 룰 R-16·R-20)을 건드리는 것은 정상이다.
 * 각 케이스는 대상 룰 코드의 유무만 본다.
 */
const RULE_SAMPLES: Record<string, { positive: string; negative: string }> = {
  "R-01": {
    positive: "취소 시 총 금액의 80%를 위약금으로 지급한다.",
    negative: "취소 시 총 금액의 10%를 위약금으로 지급한다.",
  },
  "R-02": {
    positive: "계약 해지 시 계약금은 일체 반환하지 아니한다.",
    negative: "계약 해지 시 계약금은 취소 시점에 따라 환불한다.",
  },
  "R-03": {
    positive: "취소에 따른 환불 비율은 당사 내부 규정에 따라 결정한다.",
    negative: "취소 시점별 환불 비율은 계약서 별표1에 명시한다.",
  },
  "R-04": {
    positive: "촬영 추가 컷 비용은 별도 문의 바랍니다.",
    negative: "총 금액 12,500,000원(부가세 포함)으로 확정합니다.",
  },
  "R-05": {
    positive: "원판 추가 및 보정 요청 시 추가 비용이 현장에서 발생할 수 있습니다.",
    negative: "추가 비용은 아래 표에 명시된 금액으로 한정합니다.",
  },
  "R-06": {
    positive: "최소 보증인원 350명이며 미달 시 차액을 전액 부담합니다.",
    negative: "최소 보증인원 150명이며 미달 시 차액의 50%를 부담합니다.",
  },
  "R-07": {
    positive: "식대 단가는 물가 변동에 따라 인상될 수 있습니다.",
    negative: "식대 단가는 계약 시점 금액으로 확정하며 인상하지 않습니다.",
  },
  "R-08": {
    positive: "주차비와 음향 비용은 현장에서 별도 청구됩니다.",
    negative: "주차 2시간 무료이며 음향·조명 비용은 계약 금액에 포함됩니다.",
  },
  "R-09": {
    positive: "당사는 사정에 따라 예식 장소를 변경할 수 있습니다.",
    negative: "예식 장소 변경은 양 당사자의 서면 합의로만 가능합니다.",
  },
  "R-10": {
    positive: "당사는 어떠한 경우에도 손해에 대하여 일체의 책임을 지지 아니합니다.",
    negative: "당사의 고의 또는 과실로 인한 손해는 당사가 배상합니다.",
  },
  "R-11": {
    positive: "촬영 원본 파일은 제공하지 않으며 별도 구매해야 합니다.",
    negative: "촬영 원본 파일 전량을 계약 금액에 포함하여 제공합니다.",
  },
  "R-12": {
    positive: "앨범 1권과 액자 1개를 제공합니다.",
    negative: "앨범 20페이지(12x12인치, 하드커버) 1권을 제공합니다.",
  },
  "R-13": {
    positive: "헬퍼비 15만원은 당일 현금으로 지급합니다.",
    negative: "헬퍼비 15만원은 계약 금액에 포함되어 있습니다.",
  },
  "R-14": {
    positive: "드레스는 본식 1벌, 촬영 1벌을 대여합니다.",
    negative: "드레스 피팅 2회는 무료이며 추가 대여료는 0원입니다.",
  },
  "R-15": {
    positive: "촬영 작가는 당사가 배정합니다.",
    negative: "촬영 작가 변경 시 사전 통지하며 고객은 거부할 수 있습니다.",
  },
  "R-16": {
    positive: "본 계약은 예식 서비스 제공을 목적으로 합니다.",
    negative: "업체의 납품 지체로 인한 손해는 지연배상금을 지급합니다.",
  },
  "R-17": {
    positive: "본 계약의 관할 법원은 당사 소재지 법원으로 합니다.",
    negative: "관할 법원은 민사소송법에 따릅니다.",
  },
  "R-18": {
    positive: "촬영 사진은 당사 홍보를 위해 기한 없이 사용할 수 있습니다.",
    negative: "촬영 사진의 홍보 사용은 건별 서면 동의를 받으며 언제든 철회할 수 있습니다.",
  },
  "R-19": {
    positive: "할인 적용 조건으로 후기 작성이 필수이며 부정적 리뷰 게시는 금지됩니다.",
    negative: "후기 작성은 자유이며 내용에 제한을 두지 않습니다.",
  },
  "R-20": {
    positive: "본 계약은 예식 서비스 제공을 목적으로 합니다.",
    negative: "천재지변·감염병 등 불가항력 상황에서는 위약금 없이 연기할 수 있습니다.",
  },
};

describe("검출 룰 20종 — 목록 무결성 (부록 A)", () => {
  it("룰이 정확히 20종이다", () => {
    expect(DETECT_RULES).toHaveLength(20);
  });

  it("코드가 R-01~R-20 연속이며 중복이 없다", () => {
    const codes = DETECT_RULES.map((r) => r.code);
    const expected = Array.from({ length: 20 }, (_, i) => `R-${String(i + 1).padStart(2, "0")}`);

    expect(codes).toEqual(expected);
    expect(new Set(codes).size).toBe(20);
    expect(DETECT_RULE_CODES.size).toBe(20);
  });

  it("모든 룰이 정의된 카테고리·등급 값을 쓴다", () => {
    for (const rule of DETECT_RULES) {
      expect(RULE_CATEGORIES).toContain(rule.category);
      expect(RULE_SEVERITIES).toContain(rule.severity_default);
    }
  });

  it("모든 룰에 basis_ref·prompt_fragment·version 이 채워져 있다", () => {
    for (const rule of DETECT_RULES) {
      expect(rule.basis_ref.length).toBeGreaterThan(0);
      expect(rule.prompt_fragment.length).toBeGreaterThan(0);
      expect(rule.version).toBe(DETECT_RULES_VERSION);
    }
  });

  it("basis_ref 에 지어낸 조항 번호가 없다", () => {
    // 법무 검수 전까지는 '제N조', 'N항' 같은 조항 단위 표기를 쓰지 않는다.
    for (const rule of DETECT_RULES) {
      expect(rule.basis_ref).not.toMatch(/제\s*\d+\s*조/);
      expect(rule.basis_ref).not.toMatch(/\d+\s*항/);
    }
  });

  it("모든 룰이 presence 또는 absence 조건을 갖는다", () => {
    for (const rule of DETECT_RULES) {
      const hasCondition =
        (rule.detect.presence?.patterns.length ?? 0) > 0 ||
        (rule.detect.absence?.expected.length ?? 0) > 0;

      expect(hasCondition, `${rule.code} 에 검출 조건이 없습니다.`).toBe(true);
    }
  });

  it("정규식에 g 플래그가 없다 (lastIndex 상태 공유 방지)", () => {
    const allPatterns = DETECT_RULES.flatMap((rule) => [
      ...(rule.detect.presence?.patterns ?? []),
      ...(rule.detect.presence?.excludes ?? []),
      ...(rule.detect.absence?.expected ?? []),
      ...(rule.detect.absence?.requires ?? []),
    ]);

    expect(allPatterns.length).toBeGreaterThan(0);
    for (const pattern of allPatterns) {
      expect(pattern.global, `${pattern.source} 에 g 플래그가 있습니다.`).toBe(false);
    }
  });

  it("getDetectRule 이 코드로 룰을 찾는다", () => {
    expect(getDetectRule("R-01")?.category).toBe("penalty");
    expect(getDetectRule("R-99")).toBeUndefined();
  });
});

describe("검출 룰 20종 — 양성·음성 샘플", () => {
  it("20종 전부에 샘플이 정의돼 있다", () => {
    expect(Object.keys(RULE_SAMPLES)).toHaveLength(20);
    for (const rule of DETECT_RULES) {
      expect(RULE_SAMPLES[rule.code], `${rule.code} 샘플 누락`).toBeDefined();
    }
  });

  for (const rule of DETECT_RULES) {
    const sample = RULE_SAMPLES[rule.code];

    it(`${rule.code} — 양성 샘플에서 검출된다 (${rule.title})`, () => {
      const codes = scanDocument(sample.positive).map((m) => m.rule_code);
      expect(codes).toContain(rule.code);
    });

    it(`${rule.code} — 음성 샘플에서 검출되지 않는다`, () => {
      const codes = scanDocument(sample.negative).map((m) => m.rule_code);
      expect(codes).not.toContain(rule.code);
    });
  }
});
