import { describe, expect, it } from "vitest";

import {
  AVAILABILITY_LABEL,
  DEFAULT_EXPLORE_SORT,
  EXPLORE_FILTER_KEYS,
  EXPLORE_SORTS,
  ExploreFilterSchema,
  activeFilterKeys,
  availabilityOf,
  discountRateBp,
  leadTimeDays,
  occupancyRatioBp,
  rankRelaxationHints,
  withoutFilter,
  type ExploreFilter,
} from "../schemas/explore";

const parse = (input: unknown): ExploreFilter => ExploreFilterSchema.parse(input);

describe("정렬", () => {
  it("기본 정렬은 가격 낮은 순이다 — 목록 첫 줄이 가격 정찰제를 증명한다", () => {
    expect(DEFAULT_EXPLORE_SORT).toBe("price_asc");
    expect(parse({}).sort).toBe("price_asc");
  });

  it("계산할 수 없는 정렬은 열지 않는다", () => {
    expect(EXPLORE_SORTS).not.toContain("review_score");
    expect(() => ExploreFilterSchema.parse({ sort: "review_score" })).toThrow();
  });
});

describe("필터 파싱", () => {
  it("아무것도 고르지 않아도 통과한다 — 비로그인 탐색이 기본이다", () => {
    const filter = parse({});

    expect(activeFilterKeys(filter)).toEqual([]);
    expect(filter.page).toBe(1);
    expect(filter.styleTags).toEqual([]);
  });

  it("예산 하한이 상한보다 크면 거부한다", () => {
    expect(() => ExploreFilterSchema.parse({ budgetMin: 5_000_000, budgetMax: 1_000_000 })).toThrow();
  });

  it("같은 값이면 통과한다 — 경계는 포함이다", () => {
    expect(parse({ budgetMin: 1_000_000, budgetMax: 1_000_000 }).budgetMax).toBe(1_000_000);
  });

  it("날짜 없이 '자리 있는 곳만'을 켤 수 없다", () => {
    expect(() => ExploreFilterSchema.parse({ onlyAvailable: true })).toThrow();
    expect(parse({ onlyAvailable: true, date: "2027-05-05" }).onlyAvailable).toBe(true);
  });

  it("금액은 정수만 받는다 — 부동소수점을 들이지 않는다", () => {
    expect(() => ExploreFilterSchema.parse({ budgetMax: 1_000_000.5 })).toThrow();
  });

  it("날짜 형식이 틀리면 거부한다", () => {
    expect(() => ExploreFilterSchema.parse({ date: "2027/05/05" })).toThrow();
  });
});

describe("예약 가능 여부 — '모른다'와 '없다'를 구분한다", () => {
  it("슬롯이 없으면 미확인이다. 마감이 아니다", () => {
    expect(availabilityOf([])).toEqual({ kind: "unknown" });
    expect(AVAILABILITY_LABEL.unknown).not.toBe(AVAILABILITY_LABEL.full);
  });

  it("열린 슬롯이 없으면 휴무다", () => {
    expect(availabilityOf([{ status: "blocked", capacity: 2, remaining: 2 }])).toEqual({
      kind: "blocked",
    });
  });

  it("열려 있는데 잔여가 0이면 마감이다", () => {
    expect(availabilityOf([{ status: "open", capacity: 2, remaining: 0 }])).toEqual({ kind: "full" });
  });

  it("잔여가 남아 있으면 가능하고, 여러 슬롯을 합산한다", () => {
    expect(
      availabilityOf([
        { status: "open", capacity: 2, remaining: 1 },
        { status: "open", capacity: 3, remaining: 2 },
        { status: "blocked", capacity: 5, remaining: 5 },
      ]),
    ).toEqual({ kind: "available", remaining: 3, slotCount: 2 });
  });
});

describe("잔여율", () => {
  it("재고 정보가 없으면 null 이다 — 0%가 아니다", () => {
    expect(occupancyRatioBp([])).toBeNull();
    expect(occupancyRatioBp([{ status: "blocked", capacity: 4, remaining: 4 }])).toBeNull();
  });

  it("bp 정수로 돌려준다", () => {
    expect(occupancyRatioBp([{ status: "open", capacity: 4, remaining: 1 }])).toBe(2500);
    expect(occupancyRatioBp([{ status: "open", capacity: 3, remaining: 1 }])).toBe(3333);
  });

  it("잔여 0은 0bp 다. null 과 다르다", () => {
    expect(occupancyRatioBp([{ status: "open", capacity: 4, remaining: 0 }])).toBe(0);
  });
});

describe("남은 일수", () => {
  it("기준일과 예식일을 모두 인자로 받는다 — 서버가 오늘을 정하지 않는다", () => {
    expect(leadTimeDays("2026-08-09", "2026-08-09")).toBe(0);
    expect(leadTimeDays("2026-08-09", "2026-09-08")).toBe(30);
  });

  it("지난 날짜는 음수다", () => {
    expect(leadTimeDays("2026-08-09", "2026-08-08")).toBe(-1);
  });

  it("서머타임 경계에서도 일수가 밀리지 않는다", () => {
    expect(leadTimeDays("2027-03-13", "2027-03-15")).toBe(2);
  });

  it("형식이 틀리면 던진다", () => {
    expect(() => leadTimeDays("2026-8-9", "잘못된 값")).toThrow(RangeError);
  });
});

describe("할인율", () => {
  it("정가 대비 bp 로 계산한다", () => {
    expect(discountRateBp(10_000_000, 9_000_000)).toBe(1000);
  });

  it("할증이면 음수다", () => {
    expect(discountRateBp(10_000_000, 11_000_000)).toBe(-1000);
  });

  it("변동이 없으면 0이다", () => {
    expect(discountRateBp(10_000_000, 10_000_000)).toBe(0);
  });

  it("정가가 0이면 0으로 둔다 — 나눗셈을 하지 않는다", () => {
    expect(discountRateBp(0, 0)).toBe(0);
  });
});

describe("조건 풀기 힌트", () => {
  it("걸린 조건을 모두 집어낸다", () => {
    const filter = parse({
      region: "서울",
      category: "hall",
      budgetMax: 30_000_000,
      guestCount: 200,
      date: "2027-05-05",
      styleTags: ["modern"],
      onlyAvailable: true,
    });

    expect(activeFilterKeys(filter).sort()).toEqual([...EXPLORE_FILTER_KEYS].sort());
  });

  it("예산은 하한·상한 중 하나만 있어도 걸린 것으로 본다", () => {
    expect(activeFilterKeys(parse({ budgetMin: 1_000_000 }))).toEqual(["budget"]);
  });

  it("날짜를 풀면 '자리 있는 곳만'도 함께 풀린다 — 날짜 없이는 성립하지 않는다", () => {
    const filter = parse({ date: "2027-05-05", onlyAvailable: true });
    const relaxed = withoutFilter(filter, "date");

    expect(relaxed.date).toBeNull();
    expect(relaxed.onlyAvailable).toBe(false);
  });

  it("풀어도 0건인 조건은 힌트에서 뺀다", () => {
    expect(
      rankRelaxationHints([
        { key: "region", label: "지역", count: 0 },
        { key: "budget", label: "예산", count: 3 },
      ]),
    ).toEqual([{ key: "budget", label: "예산", count: 3 }]);
  });

  it("효과가 큰 조건을 먼저 제안한다", () => {
    const ranked = rankRelaxationHints([
      { key: "budget", label: "예산", count: 2 },
      { key: "region", label: "지역", count: 9 },
    ]);

    expect(ranked.map((hint) => hint.key)).toEqual(["region", "budget"]);
  });

  it("건수가 같으면 순서가 항상 같다", () => {
    const hints = [
      { key: "region" as const, label: "지역", count: 4 },
      { key: "budget" as const, label: "예산", count: 4 },
    ];

    expect(rankRelaxationHints(hints).map((hint) => hint.key)).toEqual(
      rankRelaxationHints([...hints].reverse()).map((hint) => hint.key),
    );
  });
});
