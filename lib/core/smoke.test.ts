import { describe, expect, it } from "vitest";

import { DETECT_RULES } from "./rules";
import { calcPenalty } from "./pricing/penalty";
import { ReportSchema } from "./schemas/report";

// T-01 스모크 테스트: lib/core 가 vitest 로 수집·실행되고,
// TypeScript·zod·모듈 해석이 정상 동작하는지만 확인한다.
// 실제 도메인 로직(위약금 경계값·검출 룰 20종) 테스트는 T-04 범위다.
describe("lib/core smoke", () => {
  it("ReportSchema 가 유효한 리포트를 통과시킨다", () => {
    const valid = {
      summary_score: 72,
      findings: [
        {
          clause_id: "art-12",
          quote: "계약 해지 시 계약금은 일체 반환하지 아니한다.",
          risk: "red",
          basis: "소비자분쟁해결기준(결혼준비대행업)",
          explain: "계약금 전액 몰취 조항은 기준 대비 소비자에게 불리할 수 있습니다.",
          negotiate_tip: "취소 시점별 환불 비율을 조항에 명시해 달라고 요청해 보세요.",
        },
      ],
      missing: [
        { rule_code: "R-20", title: "불가항력 처리 조항", why: "천재지변 시 처리 기준이 없습니다." },
      ],
    };

    const parsed = ReportSchema.parse(valid);
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.findings[0].risk).toBe("red");
  });

  it("ReportSchema 가 잘못된 위험 등급을 거부한다", () => {
    const invalid = {
      summary_score: 72,
      findings: [
        {
          clause_id: "art-12",
          quote: "...",
          risk: "critical", // 허용값: red | yellow | green
          basis: "...",
          explain: "...",
          negotiate_tip: "...",
        },
      ],
      missing: [],
    };

    expect(ReportSchema.safeParse(invalid).success).toBe(false);
  });

  it("ReportSchema 가 점수 범위(0~100)를 강제한다", () => {
    const base = { findings: [], missing: [] };

    expect(ReportSchema.safeParse({ ...base, summary_score: 0 }).success).toBe(true);
    expect(ReportSchema.safeParse({ ...base, summary_score: 100 }).success).toBe(true);
    expect(ReportSchema.safeParse({ ...base, summary_score: 101 }).success).toBe(false);
    expect(ReportSchema.safeParse({ ...base, summary_score: -1 }).success).toBe(false);
  });

  it("도메인 모듈이 정상적으로 로드된다", () => {
    expect(typeof calcPenalty).toBe("function");
    expect(Array.isArray(DETECT_RULES)).toBe(true);
  });
});
