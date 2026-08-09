import { describe, expect, it } from "vitest";

import {
  PRICE_POSITION_MIN_SAMPLE,
  bpToPercent,
  isMeasured,
  measured,
  notYet,
  pricePositionBp,
  profileGaps,
  restricted,
  slotUtilizationBp,
} from "./metric";

describe("MetricValue — '0건'과 '아직 측정하지 않음'은 다르다", () => {
  it("측정된 0과 미측정은 같은 값이 아니다", () => {
    const zero = measured(0);
    const none = notYet("문의 기능이 아직 없습니다.", "S4-12");

    expect(zero).not.toEqual(none);
    expect(isMeasured(zero)).toBe(true);
    expect(isMeasured(none)).toBe(false);
  });

  it("미측정 값은 어느 태스크에서 채워지는지 담는다", () => {
    const metric = notYet("문의 기능이 아직 없습니다.", "S4-12");

    expect(metric.status === "not_yet" && metric.filledBy).toBe("S4-12");
  });

  it("권한으로 가린 값은 미측정과 구분된다", () => {
    const hidden = restricted("정산 금액은 대표 계정만 볼 수 있습니다.");

    expect(hidden.status).toBe("restricted");
    expect(isMeasured(hidden)).toBe(false);
  });
});

describe("slotUtilizationBp — 슬롯 소진율", () => {
  const slot = (capacity: number, remaining: number, status = "open") => ({
    capacity,
    remaining,
    status,
  });

  it("정원 대비 사용된 비율을 bp 로 돌려준다", () => {
    const result = slotUtilizationBp([slot(2, 1), slot(2, 0)]);

    // 정원 4, 잔여 1 -> 3/4 = 75%
    expect(result).toEqual(measured(7500));
  });

  it("아무도 예약하지 않았으면 0% 다 — 이건 실제로 측정된 값이다", () => {
    expect(slotUtilizationBp([slot(2, 2)])).toEqual(measured(0));
  });

  it("전부 찼으면 100% 다", () => {
    expect(slotUtilizationBp([slot(2, 0)])).toEqual(measured(10_000));
  });

  it("슬롯이 없으면 0%가 아니라 '측정 불가'다", () => {
    const result = slotUtilizationBp([]);

    expect(result.status).toBe("not_yet");
    expect(result.status === "not_yet" && result.filledBy).toBe("S2-05");
  });

  it("막힌 슬롯은 분모에서 뺀다 — 팔 수 없는 자리를 넣으면 소진율이 낮게 나온다", () => {
    const result = slotUtilizationBp([slot(2, 0), slot(10, 10, "blocked")]);

    expect(result).toEqual(measured(10_000));
  });

  it("막힌 슬롯만 있으면 측정 불가다", () => {
    expect(slotUtilizationBp([slot(5, 5, "blocked")]).status).toBe("not_yet");
  });
});

describe("profileGaps — 지금 할 일", () => {
  const full = {
    address: "서울시 강남구 테헤란로 1",
    capacityMax: 300,
    facilities: ["parking"],
    intro: "소개",
    mediaCount: 2,
  };

  it("다 채우면 빈 목록이다", () => {
    expect(profileGaps(full)).toEqual([]);
  });

  it("빠진 항목만 짚어 준다", () => {
    const gaps = profileGaps({ ...full, intro: null, mediaCount: 0 });

    expect(gaps.map((gap) => gap.field)).toEqual(["intro", "media"]);
  });

  it("수용 인원 0은 '입력했다'로 본다 — null 만 미입력이다", () => {
    expect(profileGaps({ ...full, capacityMax: 0 })).toEqual([]);
  });

  it("전부 비면 다섯 항목을 모두 짚는다", () => {
    const gaps = profileGaps({
      address: null,
      capacityMax: null,
      facilities: [],
      intro: null,
      mediaCount: 0,
    });

    expect(gaps).toHaveLength(5);
  });
});

describe("pricePositionBp — 익명 집계 (§7.7)", () => {
  it("표본이 하한 미만이면 표시하지 않는다", () => {
    const result = pricePositionBp(10_000_000, [1, 2, 3, 4].map((n) => n * 1_000_000));

    expect(result.status).toBe("not_yet");
    expect(result.status === "not_yet" && result.reason).toContain("5곳 이상");
  });

  it("표본 하한이 5다", () => {
    expect(PRICE_POSITION_MIN_SAMPLE).toBe(5);
  });

  it("하한을 채우면 백분위와 표본 수를 돌려준다", () => {
    const others = [8, 9, 10, 11, 12].map((n) => n * 1_000_000);
    const result = pricePositionBp(11_000_000, others);

    expect(result.status).toBe("measured");
    if (!isMeasured(result)) return;
    // 나보다 싼 곳 3 / 5 = 60%
    expect(result.value.percentileBp).toBe(6000);
    expect(result.value.sampleSize).toBe(5);
  });

  it("결과에 개별 가격도 중앙값 금액도 담기지 않는다 — 역산을 막는다", () => {
    const others = [8, 9, 10, 11, 12].map((n) => n * 1_000_000);
    const result = pricePositionBp(10_000_000, others);

    if (!isMeasured(result)) throw new Error("측정됐어야 한다");
    expect(Object.keys(result.value).sort()).toEqual(["percentileBp", "sampleSize"]);
  });

  it("가장 싸면 0%, 가장 비싸면 100% 다 (경계)", () => {
    const others = [8, 9, 10, 11, 12].map((n) => n * 1_000_000);

    const cheapest = pricePositionBp(1_000_000, others);
    const priciest = pricePositionBp(99_000_000, others);

    expect(isMeasured(cheapest) && cheapest.value.percentileBp).toBe(0);
    expect(isMeasured(priciest) && priciest.value.percentileBp).toBe(10_000);
  });

  it("같은 가격은 '싼 곳'으로 세지 않는다", () => {
    const others = [10, 10, 10, 10, 10].map((n) => n * 1_000_000);
    const result = pricePositionBp(10_000_000, others);

    expect(isMeasured(result) && result.value.percentileBp).toBe(0);
  });
});

describe("bpToPercent", () => {
  it("bp 를 퍼센트 정수로 바꾼다", () => {
    expect(bpToPercent(7500)).toBe(75);
    expect(bpToPercent(0)).toBe(0);
    expect(bpToPercent(10_000)).toBe(100);
  });
});
