import { describe, expect, it } from "vitest";

import { AI_DISCLAIMER, DISCLAIMER_REQUIRED_PHRASE, hasLegalDisclaimer } from "./legal";

describe("법적 표현 원칙 (§7.7, CLAUDE.md §2.3)", () => {
  it("고정 고지에 필수 문구가 들어 있다", () => {
    expect(AI_DISCLAIMER).toContain(DISCLAIMER_REQUIRED_PHRASE);
    expect(hasLegalDisclaimer(AI_DISCLAIMER)).toBe(true);
  });

  it("고지에 근거 출처가 함께 적혀 있다", () => {
    expect(AI_DISCLAIMER).toContain("표준약관");
    expect(AI_DISCLAIMER).toContain("소비자분쟁해결기준");
  });

  it("필수 문구가 빠진 고지를 거부한다", () => {
    expect(hasLegalDisclaimer("참고용 정보입니다.")).toBe(false);
    expect(hasLegalDisclaimer("")).toBe(false);
  });

  it("고지에 확정적 법적 결론 표현이 없다", () => {
    for (const banned of ["위법", "무효입니다", "승소", "보장합니다"]) {
      expect(AI_DISCLAIMER).not.toContain(banned);
    }
  });
});
