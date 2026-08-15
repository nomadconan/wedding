import { describe, expect, it } from "vitest";

import { AI_DISCLAIMER } from "../legal";
import { DETECT_RULE_CODES } from "../rules/detect-rules";
import { verifyCitation } from "../rules/scan";
import type { RuleMatch } from "../rules/types";
import { ReportSchema } from "../schemas/report";
import {
  ANALYSIS_STATUS_LABEL,
  DOCUMENT_ACCEPTED_MIMES,
  EXTRACTION_MIN_CHARS,
  EXTRACTION_NOTICE,
  NO_SCRIPT_NOTE,
  PURGE_AFTER_HOURS,
  REPORT_SOURCE_NOTICE,
  buildRuleOnlyReport,
  checkExtraction,
  isResumable,
  isTerminal,
  mergeModelFindings,
  purgeScheduledAt,
  purgeState,
  riskScore,
  ruleOnlySummary,
  severityCounts,
  sortBySeverity,
  validateUpload,
} from "./pipeline";

const match = (over: Partial<RuleMatch> = {}): RuleMatch => ({
  rule_code: "R-01",
  title: "위약금률이 기준 대비 과다",
  category: "penalty",
  severity: "high",
  basis_ref: "소비자분쟁해결기준(예식업)",
  kind: "presence",
  clause_excerpt: "위약금은 총 금액의 80%로 한다",
  index: 10,
  ...over,
});

const finding = (over: Record<string, unknown> = {}) => ({
  rule_code: "R-01",
  severity: "high" as const,
  clause_excerpt: "위약금은 총 금액의 80%로 한다",
  issue: "기준보다 높습니다",
  basis_ref: "소비자분쟁해결기준(예식업)",
  negotiation_script: "기준에 맞춰 조정해 주세요",
  ...over,
});

describe("업로드 검사 (§5.2 1단계)", () => {
  it("**동의를 가장 먼저 본다** — 동의 없는 업로드가 서버까지 오면 안 된다", () => {
    const rejection = validateUpload({ mime: "image/png", size: 999_999_999, consented: false });

    expect(rejection?.reason).toBe("consent");
  });

  it("읽을 수 없는 형식은 올리기 전에 막는다", () => {
    expect(validateUpload({ mime: "application/pdf", size: 100, consented: true })?.reason).toBe(
      "mime",
    );
  });

  it("20MB 를 넘기면 막는다", () => {
    expect(
      validateUpload({ mime: "text/plain", size: 20 * 1024 * 1024 + 1, consented: true })?.reason,
    ).toBe("too_large");
  });

  it("정상 업로드는 통과한다", () => {
    expect(validateUpload({ mime: "text/plain", size: 1_000, consented: true })).toBeNull();
  });

  it("받는 형식 목록에 **읽어 낼 수 있는 것만** 있다", () => {
    expect([...DOCUMENT_ACCEPTED_MIMES]).toEqual(["text/plain"]);
  });
});

describe("추출 품질 (§5.2 2단계)", () => {
  it("빈 텍스트와 짧은 텍스트를 구분한다", () => {
    expect(checkExtraction("   ")).toEqual({ ok: false, reason: "empty" });
    expect(checkExtraction("계약서")).toEqual({ ok: false, reason: "too_short" });
  });

  it("충분히 길면 통과하고 글자 수를 돌려준다", () => {
    const verdict = checkExtraction("가".repeat(EXTRACTION_MIN_CHARS));

    expect(verdict).toEqual({ ok: true, chars: EXTRACTION_MIN_CHARS });
  });

  it("사유마다 다음에 할 일을 알려준다 — '실패' 만 남기지 않는다", () => {
    for (const notice of Object.values(EXTRACTION_NOTICE)) {
      expect(notice.length).toBeGreaterThan(10);
    }
  });
});

describe("인용 대조 후 병합 (§5.2 7단계)", () => {
  const maskedText = "제7조 위약금은 총 금액의 80%로 한다. 제8조 계약금은 반환하지 아니한다.";

  it("원문에 실재하는 finding 만 남긴다", () => {
    const outcome = mergeModelFindings({
      findings: [finding(), finding({ rule_code: "R-02", clause_excerpt: "지어낸 조항입니다" })],
      maskedText,
      verifyCitation,
      knownRuleCodes: DETECT_RULE_CODES,
    });

    expect(outcome.findings).toHaveLength(1);
    expect(outcome.discarded).toEqual([{ rule_code: "R-02", reason: "citation_mismatch" }]);
  });

  it("**하나가 지어졌다고 나머지를 버리지 않는다** — 개별 폐기다", () => {
    const outcome = mergeModelFindings({
      findings: [
        finding({ clause_excerpt: "없는 문장" }),
        finding({ rule_code: "R-02", clause_excerpt: "계약금은 반환하지 아니한다" }),
      ],
      maskedText,
      verifyCitation,
      knownRuleCodes: DETECT_RULE_CODES,
    });

    expect(outcome.findings.map((item) => item.rule_code)).toEqual(["R-02"]);
  });

  it("정의되지 않은 룰 코드를 버린다", () => {
    const outcome = mergeModelFindings({
      findings: [finding({ rule_code: "R-99" })],
      maskedText,
      verifyCitation,
      knownRuleCodes: DETECT_RULE_CODES,
    });

    expect(outcome.discarded).toEqual([{ rule_code: "R-99", reason: "unknown_rule" }]);
  });

  it("**조항 번호를 지어내면 버린다** — 법무 검수 전까지 번호를 말하지 않는다 (부록 D ②)", () => {
    const outcome = mergeModelFindings({
      findings: [finding({ basis_ref: "소비자분쟁해결기준 제 15 조" })],
      maskedText,
      verifyCitation,
      knownRuleCodes: DETECT_RULE_CODES,
    });

    expect(outcome.findings).toHaveLength(0);
    expect(outcome.discarded[0].reason).toBe("invented_clause_number");
  });

  it("룰이 못 찾은 조항도 모델이 낼 수 있다 — 정규식이 놓친 자리를 메우라고 부른 것이다", () => {
    const outcome = mergeModelFindings({
      findings: [finding({ rule_code: "R-02", clause_excerpt: "계약금은 반환하지 아니한다" })],
      maskedText,
      verifyCitation,
      knownRuleCodes: DETECT_RULE_CODES,
    });

    expect(outcome.findings).toHaveLength(1);
  });
});

describe("위험 점수 — 결정적 계산", () => {
  it("같은 findings 면 항상 같은 점수다", () => {
    const findings = [{ severity: "high" as const }, { severity: "mid" as const }];

    expect(riskScore(findings)).toBe(riskScore(findings));
    expect(riskScore(findings)).toBe(30);
  });

  it("100 을 넘지 않는다", () => {
    expect(riskScore(Array.from({ length: 20 }, () => ({ severity: "high" as const })))).toBe(100);
  });

  it("찾은 것이 없으면 0 이다", () => {
    expect(riskScore([])).toBe(0);
  });
});

describe("룰만으로 만든 리포트", () => {
  it("ReportSchema 를 통과한다 — 화면이 같은 모양을 그린다", () => {
    const report = buildRuleOnlyReport([match(), match({ rule_code: "R-04", kind: "absence", clause_excerpt: "" })]);

    expect(ReportSchema.safeParse(report).success).toBe(true);
  });

  it("**협상 문구를 지어내지 않는다**", () => {
    const report = buildRuleOnlyReport([match()]);

    expect(report.findings[0].negotiation_script).toBe(NO_SCRIPT_NOTE);
  });

  it("부재 룰은 인용할 문장이 없어 제목으로 대신한다", () => {
    const report = buildRuleOnlyReport([match({ kind: "absence", clause_excerpt: "" })]);

    expect(report.findings[0].clause_excerpt).toBe(match().title);
    expect(report.missing_clauses).toHaveLength(1);
  });

  it("법적 고지가 붙는다 (CLAUDE.md §2.3)", () => {
    expect(buildRuleOnlyReport([]).disclaimer).toBe(AI_DISCLAIMER);
  });

  it("**'위험 없음' 이라고 말하지 않는다** — 못 찾은 것과 없는 것은 다르다", () => {
    const summary = ruleOnlySummary([]);

    expect(summary).not.toContain("위험 없");
    expect(summary).toContain("찾지 못한");
  });

  it("찾았으면 카테고리별 건수를 적는다", () => {
    expect(ruleOnlySummary([match(), match({ rule_code: "R-05", category: "price" })])).toContain(
      "2건",
    );
  });

  it("룰만으로 만들었다는 사실을 화면이 말한다", () => {
    expect(REPORT_SOURCE_NOTICE.rules_only).toContain("검출 룰만으로");
  });
});

describe("화면 조립", () => {
  it("등급이 높은 순으로, 같으면 코드 순으로 고정된다", () => {
    const sorted = sortBySeverity([
      { severity: "low" as const, rule_code: "R-03" },
      { severity: "high" as const, rule_code: "R-07" },
      { severity: "high" as const, rule_code: "R-02" },
    ]);

    expect(sorted.map((item) => item.rule_code)).toEqual(["R-02", "R-07", "R-03"]);
  });

  it("등급별 건수를 센다", () => {
    expect(severityCounts([{ severity: "high" }, { severity: "high" }, { severity: "low" }])).toEqual(
      { high: 2, mid: 0, low: 1 },
    );
  });
});

describe("분석 상태", () => {
  it("끝난 상태를 구분한다", () => {
    expect(isTerminal("done")).toBe(true);
    expect(isTerminal("running")).toBe(false);
  });

  it("**끊긴 분석은 폴링이 되살린다** — 실행이 잘려도 영영 남지 않는다", () => {
    const now = Date.parse("2026-08-15T00:02:00Z");

    expect(isResumable({ status: "running", updatedAt: "2026-08-15T00:00:00Z", now })).toBe(true);
    expect(isResumable({ status: "running", updatedAt: "2026-08-15T00:01:59Z", now })).toBe(false);
  });

  it("끝난 분석은 되살리지 않는다", () => {
    expect(
      isResumable({ status: "done", updatedAt: "2020-01-01T00:00:00Z", now: Date.now() }),
    ).toBe(false);
  });

  it("상태마다 사람이 읽는 말이 있다", () => {
    for (const label of Object.values(ANALYSIS_STATUS_LABEL)) {
      expect(label.length).toBeGreaterThan(0);
    }
  });
});

describe("파기 (§5.2 8단계 · CLAUDE.md §5.1)", () => {
  it("업로드 24시간 뒤가 기한이다", () => {
    const at = purgeScheduledAt(Date.parse("2026-08-15T00:00:00Z"));

    expect(at).toBe("2026-08-16T00:00:00.000Z");
    expect(PURGE_AFTER_HOURS).toBe(24);
  });

  it("파기 완료를 실패로 읽히게 하지 않는다", () => {
    expect(purgeState(null)).toBe("scheduled");
    expect(purgeState("2026-08-15T00:00:00Z")).toBe("purged");
  });
});
