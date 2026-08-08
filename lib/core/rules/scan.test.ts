import { describe, expect, it } from "vitest";

import { DETECT_RULES } from "./detect-rules";
import { matchedRuleCodes, scanDocument, segmentText, verifyCitation } from "./scan";

const CONTRACT_SAMPLE = [
  "제1조 (계약 금액)",
  "총 금액 15,000,000원(부가세 포함)으로 한다.",
  "제2조 (해지)",
  "계약 해지 시 계약금은 일체 반환하지 아니한다.",
  "제3조 (관할)",
  "본 계약의 관할 법원은 당사 소재지 법원으로 한다.",
].join("\n");

describe("segmentText", () => {
  it("빈 줄을 버리고 줄 단위로 자른다", () => {
    const segments = segmentText("첫 줄\n\n둘째 줄\n");

    expect(segments.map((s) => s.text)).toEqual(["첫 줄", "둘째 줄"]);
  });

  it("한 줄에 여러 문장이 있으면 종결 부호로 다시 자른다", () => {
    const segments = segmentText("첫 문장이다. 둘째 문장이다.");

    expect(segments.map((s) => s.text)).toEqual(["첫 문장이다.", "둘째 문장이다."]);
  });

  it("조항 번호 매김(1.)을 문장 경계로 오인하지 않는다", () => {
    const segments = segmentText("1.계약금은 총액의 10%로 한다.");

    expect(segments).toHaveLength(1);
  });

  it("index 가 원본 텍스트의 위치를 가리킨다", () => {
    const text = "첫 줄\n둘째 줄";
    const segments = segmentText(text);

    expect(segments[0].index).toBe(0);
    expect(text.slice(segments[1].index)).toBe("둘째 줄");
  });

  it("빈 문자열은 빈 배열을 만든다", () => {
    expect(segmentText("")).toEqual([]);
    expect(segmentText("   \n  \n")).toEqual([]);
  });
});

describe("scanDocument", () => {
  it("여러 조항이 섞인 계약서에서 해당 룰을 모두 찾는다", () => {
    const codes = matchedRuleCodes(scanDocument(CONTRACT_SAMPLE));

    expect(codes).toContain("R-02"); // 계약금 반환 불가
    expect(codes).toContain("R-17"); // 관할 일방 지정
    expect(codes).not.toContain("R-04"); // 총액이 기재돼 있다
  });

  it("presence 매칭은 문장을 인용 조각으로 남긴다", () => {
    const match = scanDocument(CONTRACT_SAMPLE).find((m) => m.rule_code === "R-02");

    expect(match).toBeDefined();
    expect(match?.kind).toBe("presence");
    expect(match?.clause_excerpt).toBe("계약 해지 시 계약금은 일체 반환하지 아니한다.");
    expect(match?.index).toBeGreaterThanOrEqual(0);
  });

  it("absence 매칭은 인용 조각 없이 index -1 을 쓴다", () => {
    const match = scanDocument(CONTRACT_SAMPLE).find((m) => m.rule_code === "R-20");

    expect(match).toBeDefined();
    expect(match?.kind).toBe("absence");
    expect(match?.clause_excerpt).toBe("");
    expect(match?.index).toBe(-1);
  });

  it("매칭 결과가 룰 메타데이터를 그대로 옮긴다", () => {
    const match = scanDocument(CONTRACT_SAMPLE).find((m) => m.rule_code === "R-02");
    const rule = DETECT_RULES.find((r) => r.code === "R-02");

    expect(match?.severity).toBe(rule?.severity_default);
    expect(match?.category).toBe(rule?.category);
    expect(match?.basis_ref).toBe(rule?.basis_ref);
    expect(match?.title).toBe(rule?.title);
  });

  it("빈 문서에도 예외를 던지지 않는다 (매칭 0건이어도 다음 단계로 진행)", () => {
    expect(() => scanDocument("")).not.toThrow();
  });

  it("같은 입력이면 항상 같은 결과가 나온다 (결정적)", () => {
    const first = JSON.stringify(scanDocument(CONTRACT_SAMPLE));
    const second = JSON.stringify(scanDocument(CONTRACT_SAMPLE));

    expect(first).toBe(second);
  });

  it("비활성 룰은 건너뛴다", () => {
    const disabled = DETECT_RULES.map((rule) => ({ ...rule, is_active: false }));

    expect(scanDocument(CONTRACT_SAMPLE, disabled)).toEqual([]);
  });

  it("한 룰이 만드는 후보 수를 제한한다", () => {
    const repeated = Array.from(
      { length: 12 },
      (_, i) => `제${i + 1}조 계약 해지 시 계약금은 일체 반환하지 아니한다.`,
    ).join("\n");

    const matches = scanDocument(repeated).filter((m) => m.rule_code === "R-02");

    expect(matches.length).toBeLessThanOrEqual(5);
  });

  it("requires 가 걸린 부재 룰은 주제가 없는 문서에 적용되지 않는다", () => {
    // 앨범·액자를 아예 다루지 않는 문서에는 R-12 가 붙지 않는다.
    const codes = matchedRuleCodes(scanDocument("총 금액 10,000,000원으로 한다."));

    expect(codes).not.toContain("R-12");
    expect(codes).not.toContain("R-14");
  });
});

describe("verifyCitation (§5.2 7단계 인용 대조)", () => {
  it("원문에 실재하는 인용을 통과시킨다", () => {
    expect(verifyCitation(CONTRACT_SAMPLE, "계약 해지 시 계약금은 일체 반환하지 아니한다.")).toBe(
      true,
    );
  });

  it("공백 차이는 허용한다", () => {
    expect(verifyCitation(CONTRACT_SAMPLE, "계약 해지 시  계약금은 일체 반환하지  아니한다.")).toBe(
      true,
    );
  });

  it("원문에 없는 인용을 폐기한다 (할루시네이션 차단)", () => {
    expect(verifyCitation(CONTRACT_SAMPLE, "계약금은 전액 환불한다.")).toBe(false);
  });

  it("빈 인용은 통과시키지 않는다", () => {
    expect(verifyCitation(CONTRACT_SAMPLE, "")).toBe(false);
    expect(verifyCitation(CONTRACT_SAMPLE, "   ")).toBe(false);
  });

  it("말줄임으로 잘린 인용도 앞부분이 일치하면 통과한다", () => {
    expect(verifyCitation(CONTRACT_SAMPLE, "계약 해지 시 계약금은…")).toBe(true);
  });
});
