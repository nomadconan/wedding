import { describe, expect, it } from "vitest";

import {
  RepeatRuleSchema,
  SLOT_BULK_MAX,
  SlotInputSchema,
  daysBetween,
  expandRepeatRule,
  findDuplicateSlots,
} from "../schemas/inventory";
import { CSV_TEMPLATE, parseInventoryCsv, splitCsvLine } from "./csv";

describe("SlotInputSchema (F-V-05)", () => {
  const base = { date: "2026-10-10", time: "11:00", capacity: 1 };

  it("정상 입력을 통과시킨다", () => {
    expect(SlotInputSchema.parse(base).productId).toBeNull();
  });

  it("날짜·시각 형식을 강제한다", () => {
    expect(() => SlotInputSchema.parse({ ...base, date: "2026/10/10" })).toThrow();
    expect(() => SlotInputSchema.parse({ ...base, date: "2026-13-01" })).toThrow();
    expect(() => SlotInputSchema.parse({ ...base, time: "11:00:00" })).toThrow();
    expect(() => SlotInputSchema.parse({ ...base, time: "25:00" })).toThrow();
  });

  it("정원 0을 거부한다 — 휴무는 '막음'으로 표현한다", () => {
    expect(() => SlotInputSchema.parse({ ...base, capacity: 0 })).toThrow();
    expect(() => SlotInputSchema.parse({ ...base, capacity: -1 })).toThrow();
    expect(() => SlotInputSchema.parse({ ...base, capacity: 1.5 })).toThrow();
  });
});

describe("expandRepeatRule — 반복 규칙 펼치기", () => {
  it("지정한 요일에만 슬롯을 만든다", () => {
    // 2026-10-10 은 토요일, 10-11 은 일요일이다.
    const slots = expandRepeatRule({
      from: "2026-10-10",
      to: "2026-10-16",
      weekdays: [6],
      times: ["11:00"],
      capacity: 1,
    });

    expect(slots).toHaveLength(1);
    expect(slots[0].date).toBe("2026-10-10");
  });

  it("시각 수만큼 곱해진다", () => {
    const slots = expandRepeatRule({
      from: "2026-10-10",
      to: "2026-10-17",
      weekdays: [6],
      times: ["11:00", "14:00"],
      capacity: 2,
    });

    expect(slots).toHaveLength(4);
    expect(slots.every((slot) => slot.capacity === 2)).toBe(true);
  });

  it("시각 중복은 한 번만 만든다", () => {
    const slots = expandRepeatRule({
      from: "2026-10-10",
      to: "2026-10-10",
      weekdays: [6],
      times: ["11:00", "11:00"],
      capacity: 1,
    });

    expect(slots).toHaveLength(1);
  });

  it("시작일과 종료일이 같으면 그날만 만든다 (경계)", () => {
    const slots = expandRepeatRule({
      from: "2026-10-10",
      to: "2026-10-10",
      weekdays: [0, 1, 2, 3, 4, 5, 6],
      times: ["11:00"],
      capacity: 1,
    });

    expect(slots).toHaveLength(1);
  });

  it("해당 요일이 없으면 빈 목록이다", () => {
    expect(
      expandRepeatRule({
        from: "2026-10-12",
        to: "2026-10-14",
        weekdays: [6],
        times: ["11:00"],
        capacity: 1,
      }),
    ).toHaveLength(0);
  });

  it("월을 넘겨도 날짜가 밀리지 않는다 — UTC 자정 기준으로만 계산한다", () => {
    const slots = expandRepeatRule({
      from: "2026-10-30",
      to: "2026-11-02",
      weekdays: [0, 1, 2, 3, 4, 5, 6],
      times: ["09:00"],
      capacity: 1,
    });

    expect(slots.map((slot) => slot.date)).toEqual([
      "2026-10-30",
      "2026-10-31",
      "2026-11-01",
      "2026-11-02",
    ]);
  });
});

describe("RepeatRuleSchema", () => {
  const base = {
    from: "2026-10-01",
    to: "2026-10-31",
    weekdays: [6],
    times: ["11:00"],
    capacity: 1,
  };

  it("종료일이 시작일보다 빠르면 거부한다", () => {
    expect(() => RepeatRuleSchema.parse({ ...base, from: "2026-11-01" })).toThrow();
  });

  it("같은 날은 허용한다 (경계)", () => {
    expect(() => RepeatRuleSchema.parse({ ...base, to: "2026-10-01" })).not.toThrow();
  });

  it("1년을 넘는 기간을 거부한다", () => {
    expect(() => RepeatRuleSchema.parse({ ...base, to: "2027-12-31" })).toThrow();
  });

  it("요일·시각이 비면 거부한다", () => {
    expect(() => RepeatRuleSchema.parse({ ...base, weekdays: [] })).toThrow();
    expect(() => RepeatRuleSchema.parse({ ...base, times: [] })).toThrow();
  });

  it("정의되지 않은 요일을 거부한다", () => {
    expect(() => RepeatRuleSchema.parse({ ...base, weekdays: [7] })).toThrow();
  });
});

describe("daysBetween", () => {
  it("양끝을 포함해 센다", () => {
    expect(daysBetween("2026-10-10", "2026-10-10")).toBe(1);
    expect(daysBetween("2026-10-10", "2026-10-12")).toBe(3);
  });
});

describe("findDuplicateSlots — 같은 자리 중복", () => {
  it("같은 상품·날짜·시각이 둘이면 잡는다", () => {
    const slots = [
      { date: "2026-10-10", time: "11:00", capacity: 1, productId: null },
      { date: "2026-10-10", time: "11:00", capacity: 2, productId: null },
    ];

    expect(findDuplicateSlots(slots)).toEqual(["2026-10-10 11:00"]);
  });

  it("상품이 다르면 중복이 아니다", () => {
    const slots = [
      { date: "2026-10-10", time: "11:00", capacity: 1, productId: null },
      { date: "2026-10-10", time: "11:00", capacity: 1, productId: "11111111-1111-4111-8111-111111111111" },
    ];

    expect(findDuplicateSlots(slots)).toEqual([]);
  });

  it("시각이 다르면 중복이 아니다", () => {
    const slots = [
      { date: "2026-10-10", time: "11:00", capacity: 1, productId: null },
      { date: "2026-10-10", time: "14:00", capacity: 1, productId: null },
    ];

    expect(findDuplicateSlots(slots)).toEqual([]);
  });
});

describe("splitCsvLine", () => {
  it("쉼표로 나눈다", () => {
    expect(splitCsvLine("2026-10-10,11:00,1,")).toEqual(["2026-10-10", "11:00", "1", ""]);
  });

  it("따옴표 안의 쉼표는 값의 일부다", () => {
    expect(splitCsvLine('"a,b",c')).toEqual(["a,b", "c"]);
  });

  it("엑셀의 \"\" 이스케이프를 처리한다", () => {
    expect(splitCsvLine('"큰 ""따옴표""",x')).toEqual(['큰 "따옴표"', "x"]);
  });
});

describe("parseInventoryCsv — 부분 반영하지 않는다", () => {
  it("템플릿을 그대로 통과시킨다", () => {
    const result = parseInventoryCsv(CSV_TEMPLATE);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.slots).toHaveLength(3);
    expect(result.slots[2].capacity).toBe(2);
  });

  it("열 순서가 달라도 이름으로 찾는다", () => {
    const result = parseInventoryCsv("capacity,date,time\n2,2026-10-10,11:00");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.slots[0]).toMatchObject({ date: "2026-10-10", capacity: 2 });
  });

  it("헤더가 없으면 헤더 줄을 지목한다", () => {
    const result = parseInventoryCsv("날짜,시각,정원\n2026-10-10,11:00,1");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0].line).toBe(1);
  });

  it("한 행이라도 틀리면 전체를 거부한다", () => {
    const result = parseInventoryCsv(
      "date,time,capacity\n2026-10-10,11:00,1\n2026-13-99,11:00,1\n2026-10-12,11:00,1",
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((error) => error.line === 3)).toBe(true);
  });

  it("오류에 사람이 세는 줄 번호가 붙는다", () => {
    const result = parseInventoryCsv("date,time,capacity\n2026-10-10,11:00,0");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0].line).toBe(2);
    expect(result.errors[0].message).toContain("정원");
  });

  it("정원 빈 칸을 0으로 바꾸지 않는다 — 누락과 0은 다른 실수다", () => {
    const result = parseInventoryCsv("date,time,capacity\n2026-10-10,11:00,");

    expect(result.ok).toBe(false);
  });

  it("빈 줄과 BOM 을 무시한다", () => {
    const result = parseInventoryCsv("﻿date,time,capacity\n\n2026-10-10,11:00,1\n\n");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.slots).toHaveLength(1);
  });

  it("데이터 행이 없으면 실패다", () => {
    expect(parseInventoryCsv("date,time,capacity").ok).toBe(false);
    expect(parseInventoryCsv("").ok).toBe(false);
  });
});

describe("일괄 상한", () => {
  it("한 번에 만들 수 있는 슬롯 수가 정해져 있다", () => {
    expect(SLOT_BULK_MAX).toBe(2000);
  });
});
