// AI 계약서 검토 출력 스키마 (명세서 §5.2 ReportSchema, §5.1 공통 원칙)
//
//  * AI 출력은 **반드시** 이 스키마로 검증한다. 실패 시 1회 재시도, 재실패 시 '분석 실패'.
//    부분 결과를 노출하지 않는다(§5.1).
//  * rule_code 는 detect_rules.code(= DETECT_RULES)와 일치해야 한다.
//  * severity 값은 types/database.ts 의 finding_severity enum 과 같다.
//  * disclaimer 는 상시 고정 고지다 — 누락되거나 문구가 바뀌면 검증 실패다(CLAUDE.md §2.3).

import { z } from "zod";

import { AI_DISCLAIMER, hasLegalDisclaimer } from "../legal";
import { DETECT_RULE_CODES } from "../rules/detect-rules";
import { RULE_SEVERITIES } from "../rules/types";

/** finding_severity enum(high|mid|low)과 동일. */
export const SeveritySchema = z.enum(RULE_SEVERITIES);

export const FindingSchema = z.object({
  /** detect_rules.code 와 일치해야 한다. */
  rule_code: z
    .string()
    .regex(/^R-\d{2}$/, "rule_code 는 'R-01' 형식이어야 합니다.")
    .refine((code) => DETECT_RULE_CODES.has(code), {
      message: "정의되지 않은 rule_code 입니다. detect_rules 와 동기화가 필요합니다.",
    }),
  severity: SeveritySchema,
  /** 마스킹 원문에 실재해야 통과(§5.2 7단계 인용 대조). */
  clause_excerpt: z.string().min(1).max(500),
  /** 무엇이 문제인가. */
  issue: z.string().min(1).max(500),
  /** 표준약관 / 소비자분쟁해결기준 조항. */
  basis_ref: z.string().min(1).max(200),
  /** 사용자가 그대로 쓸 수 있는 요청 문구. */
  negotiation_script: z.string().min(1).max(500),
});

export const ReportSchema = z.object({
  risk_score: z.number().int().min(0).max(100),
  summary: z.string().min(1).max(2000),
  findings: z.array(FindingSchema),
  /** 있어야 하는데 없는 조항. */
  missing_clauses: z.array(z.string().min(1).max(200)),
  /**
   * 협상 우선순위 문구.
   * §5.2 의 구조 요약에는 없지만 리포트 화면(§6.2)이 요구하는 필드다.
   * 미지정 시 빈 배열로 채워 스키마 요구 집합이 §5.2 의 상위집합이 되게 한다.
   */
  negotiation_points: z.array(z.string().min(1).max(300)).default([]),
  /** 상시 고정 문구. */
  disclaimer: z
    .string()
    .default(AI_DISCLAIMER)
    .refine(hasLegalDisclaimer, {
      message: "AI 결과에는 '법률 자문이 아닙니다' 고지가 반드시 포함돼야 합니다.",
    }),
});

export type Finding = z.infer<typeof FindingSchema>;
export type Report = z.infer<typeof ReportSchema>;
export type Severity = z.infer<typeof SeveritySchema>;

/** 리포트 입력(파싱 전) 타입 — default 가 적용되기 전 형태. */
export type ReportInput = z.input<typeof ReportSchema>;

export { AI_DISCLAIMER } from "../legal";
