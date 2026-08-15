import { describe, expect, it } from "vitest";

import { mergeAiConditions, quoteExists } from "./ai-merge";
import {
  applyUserConditions,
  conditionChipLabel,
  emptyFields,
  formatAmount,
  toExploreFilterInput,
  toRankFilter,
} from "./filter";
import { hasMeaningfulLeftover, isRealDate, parseSearchQuery } from "./parse";
import {
  hasRankableCondition,
  rankByFit,
  rankingCodeFor,
  scoreFit,
  type RankCandidate,
} from "./rank";
import type { SearchCondition, SearchField } from "../schemas/search";

/**
 * 조건 검색 (S7-02 · 명세서 §5.5)
 *
 * 파서·랭킹·병합은 전부 순수 함수다. **여기서 고정되지 않은 해석은 화면에서 확인할 수
 * 없다** — 같은 문장이 다르게 읽히는 회귀는 사용자가 재현할 수 없는 종류의 버그다.
 */

const ASOF = "2026-08-15";

function fieldsOf(conditions: SearchCondition[]): SearchField[] {
  return conditions.map((condition) => condition.field);
}

function valueOf(conditions: SearchCondition[], field: SearchField): unknown {
  return conditions.find((condition) => condition.field === field)?.value;
}

describe("파서 — 날짜", () => {
  it("연도까지 적은 날짜를 읽는다", () => {
    for (const text of ["2027-03-14", "2027.3.14", "2027년 3월 14일"]) {
      const { conditions } = parseSearchQuery(text, { asOf: ASOF });

      expect(valueOf(conditions, "date")).toBe("2027-03-14");
    }
  });

  it("연도를 뺀 날짜는 지나갔으면 내년으로 읽는다", () => {
    // 기준일 2026-08-15 보다 앞선 3월 14일 → 2027년.
    expect(valueOf(parseSearchQuery("3월 14일", { asOf: ASOF }).conditions, "date")).toBe(
      "2027-03-14",
    );
  });

  it("기준일 당일과 그 이후는 올해로 읽는다 (경계)", () => {
    expect(valueOf(parseSearchQuery("8월 15일", { asOf: ASOF }).conditions, "date")).toBe(
      "2026-08-15",
    );
    expect(valueOf(parseSearchQuery("8월 16일", { asOf: ASOF }).conditions, "date")).toBe(
      "2026-08-16",
    );
    expect(valueOf(parseSearchQuery("8월 14일", { asOf: ASOF }).conditions, "date")).toBe(
      "2027-08-14",
    );
  });

  it("'내년'을 말하면 기준일 연도 + 1 이다", () => {
    expect(valueOf(parseSearchQuery("내년 9월 5일", { asOf: ASOF }).conditions, "date")).toBe(
      "2027-09-05",
    );
  });

  it("없는 날짜는 조건으로 만들지 않고 이유를 남긴다", () => {
    const { conditions, rejected } = parseSearchQuery("2월 30일 강남", { asOf: ASOF });

    expect(fieldsOf(conditions)).not.toContain("date");
    expect(rejected[0].sourceText).toBe("2월 30일");
    // 조용히 버리면 사용자는 날짜가 걸린 줄 알고 결과를 읽는다.
    expect(rejected[0].reason).toContain("없는 날짜");
  });

  it("윤년 2월 29일을 가른다", () => {
    expect(isRealDate(2028, 2, 29)).toBe(true);
    expect(isRealDate(2027, 2, 29)).toBe(false);
    expect(isRealDate(2100, 2, 29)).toBe(false);
    expect(isRealDate(2000, 2, 29)).toBe(true);
  });

  it("기준일 형식이 아니면 던진다", () => {
    expect(() => parseSearchQuery("3월 14일", { asOf: "2026/08/15" })).toThrow(RangeError);
  });
});

describe("파서 — 하객 수", () => {
  it("'300인'·'하객 300명'을 읽는다", () => {
    expect(valueOf(parseSearchQuery("300인", { asOf: ASOF }).conditions, "guestCount")).toBe(300);
    expect(valueOf(parseSearchQuery("하객 300명", { asOf: ASOF }).conditions, "guestCount")).toBe(
      300,
    );
  });

  it("'1인당'은 규모가 아니라 단가 표현이라 읽지 않는다", () => {
    const { conditions } = parseSearchQuery("1인당 5만원", { asOf: ASOF });

    expect(fieldsOf(conditions)).not.toContain("guestCount");
  });
});

describe("파서 — 예산", () => {
  it("꼬리말이 없으면 상한으로 읽는다", () => {
    const { conditions } = parseSearchQuery("예산 3천만원", { asOf: ASOF });

    expect(valueOf(conditions, "budgetMax")).toBe(30_000_000);
    expect(fieldsOf(conditions)).not.toContain("budgetMin");
  });

  it("'이하'·'이상'이 방향을 정한다", () => {
    expect(valueOf(parseSearchQuery("3천만원 이하", { asOf: ASOF }).conditions, "budgetMax")).toBe(
      30_000_000,
    );
    expect(valueOf(parseSearchQuery("2천만원 이상", { asOf: ASOF }).conditions, "budgetMin")).toBe(
      20_000_000,
    );
  });

  it("구간을 읽는다", () => {
    const { conditions } = parseSearchQuery("2천만~3천만원", { asOf: ASOF });

    expect(valueOf(conditions, "budgetMin")).toBe(20_000_000);
    expect(valueOf(conditions, "budgetMax")).toBe(30_000_000);
  });

  it("붙어 있는 단위를 합친다 (1억5천만)", () => {
    expect(valueOf(parseSearchQuery("1억5천만원", { asOf: ASOF }).conditions, "budgetMax")).toBe(
      150_000_000,
    );
  });

  it("단위 없는 금액은 원 단위로 읽되 작은 수는 예산으로 보지 않는다", () => {
    expect(valueOf(parseSearchQuery("30000000원", { asOf: ASOF }).conditions, "budgetMax")).toBe(
      30_000_000,
    );
    expect(fieldsOf(parseSearchQuery("300원", { asOf: ASOF }).conditions)).not.toContain("budgetMax");
  });
});

describe("파서 — 사전", () => {
  it("긴 낱말을 먼저 읽는다 (웨딩드레스는 드레스 카테고리이고 찌꺼기를 남기지 않는다)", () => {
    const { conditions, leftover } = parseSearchQuery("웨딩드레스", { asOf: ASOF });

    expect(valueOf(conditions, "category")).toBe("dress");
    expect(leftover).toBe("");
  });

  it("스타일 여러 개를 모은다", () => {
    const { conditions } = parseSearchQuery("모던하고 야외인 곳", { asOf: ASOF });

    expect(valueOf(conditions, "styleTags")).toEqual(["modern", "outdoor"]);
  });

  it("지역은 행정 접미사까지 함께 먹는다", () => {
    const { conditions, leftover } = parseSearchQuery("강남구", { asOf: ASOF });

    expect(valueOf(conditions, "region")).toBe("강남");
    expect(leftover).toBe("");
  });

  it("'스드메'는 하나로 좁히지 않고 이유를 남긴다", () => {
    const { conditions, rejected } = parseSearchQuery("스드메 500만원", { asOf: ASOF });

    expect(fieldsOf(conditions)).not.toContain("category");
    expect(rejected[0].sourceText).toBe("스드메");
  });
});

describe("파서 — 혼합 입력", () => {
  it("'3월 14일 강남 300인 웨딩홀 3천만원 이하'를 전부 읽는다", () => {
    const { conditions, leftover, rejected } = parseSearchQuery(
      "3월 14일 강남 300인 웨딩홀 3천만원 이하",
      { asOf: ASOF },
    );

    expect(valueOf(conditions, "date")).toBe("2027-03-14");
    expect(valueOf(conditions, "region")).toBe("강남");
    expect(valueOf(conditions, "guestCount")).toBe(300);
    expect(valueOf(conditions, "category")).toBe("hall");
    expect(valueOf(conditions, "budgetMax")).toBe(30_000_000);
    expect(rejected).toEqual([]);
    expect(hasMeaningfulLeftover(leftover)).toBe(false);
  });

  it("같은 입력은 같은 결과를 낸다 (재현성)", () => {
    const text = "내년 5월 2일 판교 250명 예산 4천만원 클래식";

    expect(parseSearchQuery(text, { asOf: ASOF })).toEqual(parseSearchQuery(text, { asOf: ASOF }));
  });

  it("읽지 못한 조각을 남긴다", () => {
    const { leftover } = parseSearchQuery("주차 넉넉한 강남 웨딩홀", { asOf: ASOF });

    expect(leftover).toContain("주차");
    expect(hasMeaningfulLeftover(leftover)).toBe(true);
  });

  it("조사만 남으면 AI 를 부르지 않는다", () => {
    expect(hasMeaningfulLeftover("에서 의")).toBe(false);
    expect(hasMeaningfulLeftover("")).toBe(false);
  });
});

// =============================================================================
// 랭킹
// =============================================================================

const CANDIDATE: RankCandidate = {
  productId: "p1",
  basePrice: 30_000_000,
  regionCode: "서울 강남",
  styleTags: ["modern", "luxury"],
  capacityMin: 100,
  capacityMax: 400,
  availabilityKind: "available",
};

describe("랭킹 — 조건 부합도", () => {
  it("걸린 조건만 채점한다", () => {
    const { score, max, details } = scoreFit(CANDIDATE, {
      region: null,
      guestCount: 300,
      date: null,
      styleTags: [],
    });

    expect(details).toHaveLength(1);
    expect(max).toBe(2);
    expect(score).toBe(2);
  });

  it("지역은 완전 일치 2점, 부분 일치 1점", () => {
    const exact = scoreFit({ ...CANDIDATE, regionCode: "강남" }, filterWith({ region: "강남" }));
    const partial = scoreFit(CANDIDATE, filterWith({ region: "강남" }));

    expect(exact.score).toBe(2);
    expect(partial.score).toBe(1);
  });

  it("자리 미확인은 감점이 아니라 0점이고 '모른다'로 남는다", () => {
    const unknown = scoreFit(
      { ...CANDIDATE, availabilityKind: "unknown" },
      filterWith({ date: "2027-03-14" }),
    );

    expect(unknown.score).toBe(0);
    expect(unknown.details[0].matched).toBeNull();
    expect(unknown.details[0].note).toContain("확인할 수 없어요");
  });

  it("자리 있음은 3점, 마감·휴무는 0점이되 '아니오'로 적는다", () => {
    expect(scoreFit(CANDIDATE, filterWith({ date: "2027-03-14" })).score).toBe(3);

    const full = scoreFit({ ...CANDIDATE, availabilityKind: "full" }, filterWith({ date: "2027-03-14" }));
    expect(full.score).toBe(0);
    expect(full.details[0].matched).toBe(false);
  });

  it("수용 인원은 양쪽을 밝히고 들어맞을 때 2점, 한쪽만이면 1점, 미등록이면 0점 (경계)", () => {
    const filter = filterWith({ guestCount: 400 });

    // 상한 경계값 당일 — 400명은 100~400 안이다.
    expect(scoreFit(CANDIDATE, filter).details[0].points).toBe(2);
    expect(scoreFit({ ...CANDIDATE, capacityMax: 399 }, filter).details[0].points).toBe(0);
    expect(scoreFit({ ...CANDIDATE, capacityMax: null }, filter).details[0].points).toBe(1);

    const undeclared = scoreFit(
      { ...CANDIDATE, capacityMin: null, capacityMax: null },
      filter,
    ).details[0];
    expect(undeclared.points).toBe(0);
    expect(undeclared.matched).toBeNull();
  });

  it("스타일은 겹친 개수만큼 가점한다", () => {
    const filter = filterWith({ styleTags: ["modern", "luxury", "outdoor"] });
    const { score, max } = scoreFit(CANDIDATE, filter);

    expect(score).toBe(4);
    expect(max).toBe(6);
  });

  it("동점이면 가격 낮은 순, 그것도 같으면 id 순이다", () => {
    const rows: RankCandidate[] = [
      { ...CANDIDATE, productId: "b", basePrice: 20_000_000 },
      { ...CANDIDATE, productId: "a", basePrice: 20_000_000 },
      { ...CANDIDATE, productId: "c", basePrice: 10_000_000 },
    ];

    expect(rankByFit(rows, filterWith({ region: "강남" }))).toEqual(["c", "a", "b"]);
  });

  it("부합도가 높으면 더 비싸도 앞에 온다", () => {
    const rows: RankCandidate[] = [
      { ...CANDIDATE, productId: "cheap", basePrice: 1, availabilityKind: "unknown" },
      { ...CANDIDATE, productId: "fit", basePrice: 99_000_000, availabilityKind: "available" },
    ];

    expect(rankByFit(rows, filterWith({ date: "2027-03-14" }))[0]).toBe("fit");
  });

  it("채점할 조건이 없으면 기준 코드는 price_asc 다", () => {
    const none = filterWith({});

    expect(hasRankableCondition(none)).toBe(false);
    expect(rankingCodeFor(none)).toBe("price_asc");
    expect(rankingCodeFor(filterWith({ region: "강남" }))).toBe("condition_fit");
  });

  it("조건이 없으면 순서는 가격 낮은 순이다", () => {
    const rows: RankCandidate[] = [
      { ...CANDIDATE, productId: "b", basePrice: 30_000_000 },
      { ...CANDIDATE, productId: "a", basePrice: 10_000_000 },
    ];

    expect(rankByFit(rows, filterWith({}))).toEqual(["a", "b"]);
  });
});

function filterWith(overrides: Partial<ReturnType<typeof emptyRankFilter>>) {
  return { ...emptyRankFilter(), ...overrides };
}

function emptyRankFilter() {
  return { region: null as string | null, guestCount: null as number | null, date: null as string | null, styleTags: [] as string[] };
}

// =============================================================================
// AI 보조 병합
// =============================================================================

const TEXT = "주차 넉넉한 강남 웨딩홀";

function ruleResultOf(text: string) {
  return parseSearchQuery(text, { asOf: ASOF });
}

describe("AI 병합 — 세 관문", () => {
  it("근거가 입력에 없는 조건은 개별 폐기한다 (인용 대조)", () => {
    const outcome = mergeAiConditions({
      text: TEXT,
      rule: ruleResultOf(TEXT),
      raw: { conditions: [{ field: "guestCount", value: 300, sourceText: "300명" }] },
    });

    expect(outcome.accepted).toEqual([]);
    expect(outcome.discarded[0].reason).toBe("quote_mismatch");
  });

  it("근거가 실재하면 조건이 된다", () => {
    const outcome = mergeAiConditions({
      text: "야외에서 하고 싶어요",
      rule: ruleResultOf("주차 넉넉한 곳"),
      raw: { conditions: [{ field: "styleTags", value: ["outdoor"], sourceText: "야외" }] },
    });

    expect(outcome.accepted).toHaveLength(1);
    expect(outcome.accepted[0].origin).toBe("ai");
  });

  it("룰이 이미 읽은 필드는 덮지 않는다", () => {
    const rule = ruleResultOf(TEXT);
    const outcome = mergeAiConditions({
      text: TEXT,
      rule,
      raw: { conditions: [{ field: "region", value: "강남", sourceText: "강남" }] },
    });

    expect(outcome.discarded[0].reason).toBe("rule_wins");
    expect(valueOf(outcome.conditions, "region")).toBe("강남");
  });

  it("열거값에 없는 코드는 버린다", () => {
    const outcome = mergeAiConditions({
      text: "펫 동반 가능한 곳",
      rule: ruleResultOf("펫 동반 가능한 곳"),
      raw: { conditions: [{ field: "styleTags", value: ["pet_friendly"], sourceText: "펫 동반" }] },
    });

    expect(outcome.accepted).toEqual([]);
    expect(outcome.discarded[0].reason).toBe("invalid_value");
  });

  it("지역은 값 자체도 입력에 있어야 한다", () => {
    const outcome = mergeAiConditions({
      text: "강남 근처 어디든",
      rule: { conditions: [], leftover: "강남 근처 어디든", rejected: [] },
      raw: { conditions: [{ field: "region", value: "서초", sourceText: "근처" }] },
    });

    expect(outcome.accepted).toEqual([]);
    expect(outcome.discarded[0].reason).toBe("invalid_value");
  });

  it("숫자를 문자열로 내는 것까지는 받아 준다", () => {
    const outcome = mergeAiConditions({
      text: "하객 이백명 정도",
      rule: { conditions: [], leftover: "하객 이백명 정도", rejected: [] },
      raw: { conditions: [{ field: "guestCount", value: "200", sourceText: "이백명" }] },
    });

    expect(outcome.accepted[0].value).toBe(200);
  });

  it("모양이 어긋나면 조건이 아니라 응답 전체를 되돌린다 (재시도 재료)", () => {
    const outcome = mergeAiConditions({
      text: TEXT,
      rule: ruleResultOf(TEXT),
      raw: { conditions: "웨딩홀이요" },
    });

    expect(outcome.schemaError).not.toBeNull();
    expect(outcome.conditions).toEqual(ruleResultOf(TEXT).conditions);
  });

  it("응답을 JSON 으로도 못 읽었으면 룰 결과만 남는다", () => {
    const outcome = mergeAiConditions({ text: TEXT, rule: ruleResultOf(TEXT), raw: null });

    expect(outcome.schemaError).not.toBeNull();
    expect(fieldsOf(outcome.conditions)).toEqual(fieldsOf(ruleResultOf(TEXT).conditions));
  });

  it("예산 하한이 상한보다 크면 AI 가 만든 쪽을 버린다", () => {
    const rule = parseSearchQuery("2천만원 이하", { asOf: ASOF });
    const outcome = mergeAiConditions({
      text: "2천만원 이하 최소 5천만원",
      rule,
      raw: { conditions: [{ field: "budgetMin", value: 50_000_000, sourceText: "최소 5천만원" }] },
    });

    expect(fieldsOf(outcome.conditions)).not.toContain("budgetMin");
    expect(outcome.discarded.some((item) => item.reason === "invalid_value")).toBe(true);
  });

  it("인용 대조는 공백·대소문자 차이를 문제 삼지 않는다", () => {
    expect(quoteExists("강남  웨딩홀", "강남 웨딩홀")).toBe(true);
    expect(quoteExists("강남 웨딩홀", "서초 웨딩홀")).toBe(false);
    expect(quoteExists("Garden 스타일", "garden")).toBe(true);
  });
});

// =============================================================================
// 조건 → 필터
// =============================================================================

describe("조건 → 필터", () => {
  const parsed = parseSearchQuery("3월 14일 강남 300인 웨딩홀 3천만원 이하", { asOf: ASOF })
    .conditions;

  it("사용자가 고른 값이 파싱 결과를 이긴다", () => {
    const merged = applyUserConditions({
      parsed,
      user: [{ field: "region", value: "판교", sourceText: "판교", origin: "user" }],
      dropped: [],
    });

    expect(valueOf(merged, "region")).toBe("판교");
    expect(merged.filter((condition) => condition.field === "region")).toHaveLength(1);
  });

  it("지운 조건은 다시 붙지 않는다", () => {
    const merged = applyUserConditions({ parsed, user: [], dropped: ["guestCount"] });

    expect(fieldsOf(merged)).not.toContain("guestCount");
  });

  it("탐색 필터 입력으로 옮긴다 — 자리 있는 곳만은 켜지 않는다", () => {
    const input = toExploreFilterInput(parsed, 2);

    expect(input).toMatchObject({
      region: "강남",
      category: "hall",
      guestCount: 300,
      date: "2027-03-14",
      budgetMax: 30_000_000,
      onlyAvailable: false,
      sort: "price_asc",
      page: 2,
    });
  });

  it("랭킹 필터는 같은 값에서 나온다", () => {
    expect(toRankFilter(parsed)).toEqual({
      region: "강남",
      guestCount: 300,
      date: "2027-03-14",
      styleTags: [],
    });
  });

  it("칩에 해석까지 적는다", () => {
    const labels = parsed.map(conditionChipLabel);

    expect(labels).toContain("예산 · 3,000만원 이하");
    expect(labels).toContain("하객 · 300명");
    expect(labels).toContain("카테고리 · 웨딩홀");
  });

  it("금액은 딱 떨어질 때만 단위로 줄인다", () => {
    expect(formatAmount(30_000_000)).toBe("3,000만원");
    expect(formatAmount(100_000_000)).toBe("1억원");
    expect(formatAmount(30_005_000)).toBe("30,005,000원");
  });

  it("비어 있는 조건을 알려 준다 (예산은 한 칸으로 센다)", () => {
    expect(emptyFields(parsed)).toEqual(["styleTags"]);
    expect(emptyFields([])).toEqual(["region", "category", "budgetMin", "guestCount", "date", "styleTags"]);
  });
});
