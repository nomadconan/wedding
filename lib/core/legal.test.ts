import { describe, expect, it } from "vitest";

import {
  AI_DISCLAIMER,
  DISCLAIMER_REQUIRED_PHRASE,
  NO_PAID_RANKING_CLAIM,
  NO_PAID_RANKING_DETAIL,
  NO_PAID_RANKING_SHORT,
  hasLegalDisclaimer,
} from "./legal";

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

describe("광고·유료 노출 주장 (D-25)", () => {
  it("'유료 노출 없음' 처럼 넓은 말을 쓰지 않는다 — 업체는 수수료를 낸다", () => {
    expect(NO_PAID_RANKING_CLAIM).not.toContain("유료 노출 없음");
    expect(NO_PAID_RANKING_SHORT).not.toContain("유료 노출 없음");
  });

  it("지키는 만큼만 말한다 — 주장의 대상이 '순위'다", () => {
    expect(NO_PAID_RANKING_CLAIM).toContain("순위");
    expect(NO_PAID_RANKING_SHORT).toContain("광고");
  });

  it("무엇을 받지 않는지 항목으로 밝힌다", () => {
    for (const item of ["상위 노출비", "배너 광고비", "리베이트"]) {
      expect(NO_PAID_RANKING_DETAIL).toContain(item);
    }
  });

  it("수익원을 감추지 않는다", () => {
    expect(NO_PAID_RANKING_DETAIL).toContain("수수료");
    expect(NO_PAID_RANKING_DETAIL).toContain("멤버십");
  });
});
