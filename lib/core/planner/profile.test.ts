import { describe, expect, it } from "vitest";

import {
  BIO_MAX,
  CAREER_YEARS_MAX,
  FEE_NOT_HERE_NOTICE,
  HEADLINE_MAX,
  MARKET_SORTS,
  MARKET_SORT_BASIS_NOTICE,
  MARKET_SORT_LABEL,
  NEW_PLANNER_NOTICE,
  PLANNER_STATUSES,
  PLANNER_STATUS_DETAIL,
  PROFILE_FIELDS,
  PlannerProfileError,
  SELF_REPORTED_NOTICE,
  canRequestListing,
  contractMetric,
  filterMarket,
  isListed,
  reviewMetric,
  sortMarket,
  validateProfile,
  type MarketRow,
  type PlannerProfile,
} from "./profile";

function profile(over: Partial<PlannerProfile> = {}): Partial<PlannerProfile> {
  return {
    headline: "10년차 웨딩 플래너",
    bio: "스드메 위주로 진행합니다.",
    careerYears: 10,
    categories: ["studio", "dress"],
    regions: ["서울 강남"],
    ...over,
  };
}

function row(over: Partial<MarketRow> & { id: string }): MarketRow {
  return {
    careerYears: 5,
    contractCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

describe("프로필 — 요금을 담지 않는다", () => {
  it("다루는 필드에 요금이 없다", () => {
    expect(PROFILE_FIELDS).not.toContain("fee");
    expect(PROFILE_FIELDS).not.toContain("feeJson");
  });

  it("요금이 프로필에 없는 이유를 화면 문구가 말한다", () => {
    expect(FEE_NOT_HERE_NOTICE).toContain("요율 설정");
    expect(FEE_NOT_HERE_NOTICE).toContain("소급되지 않습니다");
  });
});

describe("프로필 검증 — 입력 사고만 막는다", () => {
  it("올바른 프로필은 통과한다", () => {
    expect(validateProfile(profile())).toEqual({ ok: true });
  });

  it("한 줄 소개가 없으면 거절한다", () => {
    expect(validateProfile(profile({ headline: "   " })).ok).toBe(false);
  });

  it("한 줄 소개 길이 상한을 지킨다", () => {
    const result = validateProfile(profile({ headline: "가".repeat(HEADLINE_MAX + 1) }));

    expect(result.ok === false && result.field).toBe("headline");
  });

  it("소개 길이 상한을 지킨다", () => {
    const result = validateProfile(profile({ bio: "가".repeat(BIO_MAX + 1) }));

    expect(result.ok === false && result.field).toBe("bio");
  });

  it("경력은 0년도 허용한다 — 신규 플래너를 막지 않는다", () => {
    expect(validateProfile(profile({ careerYears: 0 })).ok).toBe(true);
  });

  it("음수·소수·비현실적 경력은 거절한다", () => {
    for (const years of [-1, 3.5, CAREER_YEARS_MAX + 1]) {
      const result = validateProfile(profile({ careerYears: years }));

      expect(result.ok === false && result.field).toBe("careerYears");
    }
  });

  it("카테고리를 하나도 안 고르면 거절한다", () => {
    expect(validateProfile(profile({ categories: [] })).ok).toBe(false);
  });

  it("과금 축에 없는 카테고리는 거절한다", () => {
    const result = validateProfile({
      ...profile(),
      categories: ["helper" as never],
    });

    expect(result.ok === false && result.field).toBe("categories");
  });

  it("같은 카테고리를 두 번 고를 수 없다", () => {
    const result = validateProfile(profile({ categories: ["studio", "studio"] }));

    expect(result.ok === false && result.field).toBe("categories");
  });

  it("활동 지역이 없으면 거절한다", () => {
    expect(validateProfile(profile({ regions: [] })).ok).toBe(false);
  });

  it("경력이 자기 신고값임을 화면이 밝힌다", () => {
    expect(SELF_REPORTED_NOTICE).toContain("본인이 적은 내용");
  });
});

describe("공개 신청 — 빈 프로필을 마켓에 올리지 않는다", () => {
  it("완성된 프로필만 공개 신청할 수 있다", () => {
    expect(canRequestListing(profile())).toBe(true);
    expect(canRequestListing(profile({ categories: [] }))).toBe(false);
  });

  it("공개는 active 상태에서만이다", () => {
    expect(isListed("active")).toBe(true);
    for (const status of ["pending", "paused", "rejected"] as const) {
      expect(isListed(status)).toBe(false);
    }
  });

  it("모든 상태에 사람이 읽는 설명이 있다", () => {
    for (const status of PLANNER_STATUSES) {
      expect(PLANNER_STATUS_DETAIL[status].length).toBeGreaterThan(5);
    }
  });

  it("검토 중 설명이 '거절' 로 읽히지 않는다", () => {
    expect(PLANNER_STATUS_DETAIL.pending).toContain("확인하고 있어요");
  });
});

describe("마켓 정렬 — 실적과 사실로만 (D-25 · D-03)", () => {
  const rows = [
    row({ id: "a", contractCount: 3, careerYears: 1, createdAt: "2026-01-01T00:00:00.000Z" }),
    row({ id: "b", contractCount: 10, careerYears: 2, createdAt: "2026-02-01T00:00:00.000Z" }),
    row({ id: "c", contractCount: 3, careerYears: 20, createdAt: "2026-03-01T00:00:00.000Z" }),
  ];

  it("**'추천' 정렬이 없다** — 광고가 끼어들 자리를 만들지 않는다", () => {
    expect(MARKET_SORTS).not.toContain("recommended");
    expect(MARKET_SORTS).not.toContain("sponsored");
    expect(MARKET_SORTS).not.toContain("premium");
  });

  it("계약 건수 순으로 정렬한다", () => {
    expect(sortMarket(rows, "contracts").map((r) => r.id)).toEqual(["b", "c", "a"]);
  });

  it("동점이면 최근 등록 순으로 갈라 순서가 흔들리지 않는다", () => {
    const sorted = sortMarket(rows, "contracts");

    // a·c 는 둘 다 3건 — 최근 등록(c)이 앞선다.
    expect(sorted.map((r) => r.id).slice(1)).toEqual(["c", "a"]);
  });

  it("경력 순으로 정렬한다", () => {
    expect(sortMarket(rows, "career").map((r) => r.id)).toEqual(["c", "b", "a"]);
  });

  it("최근 등록 순으로 정렬한다", () => {
    expect(sortMarket(rows, "recent").map((r) => r.id)).toEqual(["c", "b", "a"]);
  });

  it("원본 배열을 바꾸지 않는다", () => {
    const before = rows.map((r) => r.id);
    sortMarket(rows, "career");

    expect(rows.map((r) => r.id)).toEqual(before);
  });

  it("모든 정렬 기준에 라벨이 있다", () => {
    for (const sort of MARKET_SORTS) {
      expect(MARKET_SORT_LABEL[sort].length).toBeGreaterThan(0);
    }
  });

  it("정렬 기준을 화면에 공개한다 — 광고 반영 없음을 밝힌다", () => {
    expect(MARKET_SORT_BASIS_NOTICE).toContain("광고");
    expect(MARKET_SORT_BASIS_NOTICE).toContain("반영되지 않아요");
  });
});

describe("마켓 필터", () => {
  const rows = [
    { categories: ["studio"], regions: ["서울 강남"] },
    { categories: ["hall"], regions: ["부산"] },
  ];

  it("카테고리로 거른다", () => {
    expect(filterMarket(rows, { category: "studio" })).toHaveLength(1);
  });

  it("지역으로 거른다", () => {
    expect(filterMarket(rows, { region: "부산" })).toHaveLength(1);
  });

  it("둘 다 지정하면 둘 다 만족해야 한다", () => {
    expect(filterMarket(rows, { category: "studio", region: "부산" })).toHaveLength(0);
  });

  it("조건이 없으면 전부 돌려준다", () => {
    expect(filterMarket(rows, {})).toHaveLength(2);
  });
});

describe("실적 표시 — 못 세는 것을 0으로 적지 않는다", () => {
  it("계약 건수는 값으로 적는다", () => {
    expect(contractMetric(3)).toEqual({ kind: "value", value: 3 });
  });

  it("계약 0건도 값이다 — 실제로 센 결과다", () => {
    expect(contractMetric(0)).toEqual({ kind: "value", value: 0 });
  });

  it("음수 계약 건수는 거절한다", () => {
    expect(() => contractMetric(-1)).toThrow(PlannerProfileError);
  });

  it("**리뷰는 0이 아니라 '아직 세지 않는다'** — 0은 평가가 나쁜 것처럼 읽힌다", () => {
    const metric = reviewMetric();

    expect(metric.kind).toBe("pending");
    expect(metric.kind === "pending" && metric.owner).toBe("S8-11");
  });

  it("실적 없는 플래너를 낙인찍지 않는 문구가 있다", () => {
    expect(NEW_PLANNER_NOTICE).toContain("상담으로 확인");
  });
});

describe("값 집합", () => {
  it("목록에 중복이 없다", () => {
    for (const list of [PLANNER_STATUSES, MARKET_SORTS, PROFILE_FIELDS]) {
      expect(new Set(list).size).toBe(list.length);
    }
  });
});
