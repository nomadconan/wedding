// AI 계약서 검토 출력 스키마 (docs/03 확정 설계)
import { z } from "zod";

export const FindingSchema = z.object({
  clause_id: z.string(),
  quote: z.string().max(200),          // 원문 인용 — 검증기에서 원문 대조 필수
  risk: z.enum(["red", "yellow", "green"]),
  basis: z.string(),                    // 근거 기준 출처 (표준약관 조항 등)
  explain: z.string().max(300),
  negotiate_tip: z.string().max(200),
});

export const ReportSchema = z.object({
  summary_score: z.number().int().min(0).max(100),
  findings: z.array(FindingSchema),
  missing: z.array(z.object({ rule_code: z.string(), title: z.string(), why: z.string() })),
});

export type Report = z.infer<typeof ReportSchema>;
export type Finding = z.infer<typeof FindingSchema>;
