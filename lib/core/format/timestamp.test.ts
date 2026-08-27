import { describe, expect, it } from "vitest";

import { UNKNOWN_TIMESTAMP, dateTimeAttr, formatDate, formatTimestamp } from "./timestamp";

describe("formatTimestamp — null 이 화면을 죽이지 않는다", () => {
  it("ISO 시각을 사람이 읽는 모양으로", () => {
    expect(formatTimestamp("2026-08-27T12:34:56.789+00:00")).toBe("2026-08-27 12:34:56");
  });

  /**
   * **이것이 버그였다.** `job_runs.started_at` 이 null 인 행 하나에
   * `/admin/privacy` 전체가 빈 화면으로 죽었다
   * (`Cannot read properties of null (reading 'replace')`).
   */
  it.each([null, undefined, ""])("%s 를 받아도 던지지 않는다", (value) => {
    expect(() => formatTimestamp(value)).not.toThrow();
    expect(formatTimestamp(value)).toBe(UNKNOWN_TIMESTAMP);
  });

  it("**빈칸으로 두지 않는다** — '방금' 과 '기록 없음' 이 겹쳐 읽히면 안 된다", () => {
    expect(formatTimestamp(null)).not.toBe("");
    expect(UNKNOWN_TIMESTAMP.length).toBeGreaterThan(0);
  });

  it("짧은 값도 자르다 죽지 않는다", () => {
    expect(formatTimestamp("2026-08-27")).toBe("2026-08-27");
  });

  it("**시간대를 바꾸지 않는다** — 두 사람이 같은 기록을 다르게 읽으면 안 된다", () => {
    // 입력의 시·분·초가 그대로 나온다. 로컬 변환이 있으면 이 값이 달라진다.
    expect(formatTimestamp("2026-01-01T00:00:00.000+00:00")).toBe("2026-01-01 00:00:00");
  });
});

describe("formatDate", () => {
  it("날짜만 잘라 낸다", () => {
    expect(formatDate("2026-08-27T12:34:56.789+00:00")).toBe("2026-08-27");
  });

  it.each([null, undefined, ""])("%s 도 안전하다", (value) => {
    expect(formatDate(value)).toBe(UNKNOWN_TIMESTAMP);
  });
});

describe("dateTimeAttr", () => {
  it("값이 있으면 그대로 넘긴다", () => {
    expect(dateTimeAttr("2026-08-27T00:00:00Z")).toBe("2026-08-27T00:00:00Z");
  });

  it("**비어 있으면 속성을 빼도록 undefined 를 준다** — `dateTime=\"\"` 는 유효하지 않다", () => {
    expect(dateTimeAttr(null)).toBeUndefined();
    expect(dateTimeAttr("")).toBeUndefined();
  });
});
