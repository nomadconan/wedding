import { afterEach, describe, expect, it } from "vitest";

import { EXTRACTION_MIN_CHARS } from "@/lib/core/report/pipeline";

import { ExtractAdapterError, extractText, resolveExtractAdapter } from "./extract";

/**
 * 추출 어댑터 계약 (S7-03)
 *
 * `lib/core` 가 아닌 것을 시험하는 이유는 다른 어댑터들과 같다 — **깨지면 사용자는
 * 계약서를 올렸는데 서비스는 아무것도 읽지 못한 채 리포트를 만든다.** "위험 없음"
 * 처럼 보이는 빈 리포트가 이 파이프라인에서 가장 나쁜 실패다.
 */
const original = { adapter: process.env.EXTRACT_ADAPTER, env: process.env.NODE_ENV };

afterEach(() => {
  process.env.EXTRACT_ADAPTER = original.adapter;
  // NODE_ENV 는 읽기 전용 타입이라 캐스팅해 되돌린다.
  (process.env as Record<string, string | undefined>).NODE_ENV = original.env;
});

const bytesOf = (text: string) => new TextEncoder().encode(text);
const longEnough = "계약서 본문입니다. ".repeat(30);

describe("어댑터 선택", () => {
  it("기본은 plain 이다", () => {
    delete process.env.EXTRACT_ADAPTER;

    expect(resolveExtractAdapter()).toBe("plain");
  });

  it("모르는 값을 조용히 넘기지 않는다", () => {
    process.env.EXTRACT_ADAPTER = "ocr";

    expect(() => resolveExtractAdapter()).toThrow(ExtractAdapterError);
  });

  it("**프로덕션에서 stub 을 거부한다**", () => {
    process.env.EXTRACT_ADAPTER = "stub";
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";

    expect(() => resolveExtractAdapter()).toThrow(/프로덕션/);
  });
});

describe("텍스트 추출", () => {
  it("text/plain 을 실제로 읽는다 — 흉내가 아니다", () => {
    process.env.EXTRACT_ADAPTER = "plain";
    const result = extractText({ bytes: bytesOf(longEnough), mime: "text/plain" });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.text).toContain("계약서 본문");
  });

  it("PDF·이미지는 **명시적으로** 못 읽는다고 답한다", () => {
    process.env.EXTRACT_ADAPTER = "plain";

    for (const mime of ["application/pdf", "image/png", "image/jpeg"]) {
      const result = extractText({ bytes: bytesOf(longEnough), mime });

      expect(result.ok, mime).toBe(false);
      if (!result.ok) expect(result.reason).toBe("unsupported");
    }
  });

  it("**빈 문자열을 성공으로 돌려주지 않는다** — 그 문서는 '위험 없음' 처럼 보인다", () => {
    process.env.EXTRACT_ADAPTER = "plain";
    const result = extractText({ bytes: bytesOf("   "), mime: "text/plain" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("empty");
  });

  it("너무 짧으면 재촬영 사유로 답한다", () => {
    process.env.EXTRACT_ADAPTER = "plain";
    const result = extractText({ bytes: bytesOf("계약"), mime: "text/plain" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("too_short");
  });

  it("품질 기준을 파이프라인과 공유한다 — 두 벌이면 한쪽만 고쳐진다", () => {
    process.env.EXTRACT_ADAPTER = "plain";
    const result = extractText({
      bytes: bytesOf("가".repeat(EXTRACTION_MIN_CHARS)),
      mime: "text/plain",
    });

    expect(result.ok).toBe(true);
  });

  it("stub 은 읽는 척하지 않는다", () => {
    process.env.EXTRACT_ADAPTER = "stub";
    const result = extractText({ bytes: bytesOf(longEnough), mime: "text/plain" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.adapter).toBe("stub");
  });
});
