import { describe, expect, it } from "vitest";

import { MARKET_SORTS, MARKET_SORT_LABEL, sortMarket } from "./profile";
import {
  RANKING_INTRO,
  RANKING_LIST_ELSEWHERE_NOTICE,
  RANKING_METRICS,
  RANKING_METRIC_STATE_LABEL,
  RANKING_SORTS,
  RANKING_TITLE,
  rankingDisclosure,
  rankingMetricRow,
} from "./ranking";

describe("공개하는 정렬 기준", () => {
  const disclosure = rankingDisclosure();

  it("**목록이 실제로 쓰는 정렬과 같다** — 공개한 기준과 실제 순서가 갈리면 안 된다", () => {
    expect(disclosure.sorts.map((row) => row.sort)).toEqual([...MARKET_SORTS]);
  });

  it("각 정렬이 **무엇으로 정해지는지** 밝힌다", () => {
    for (const row of disclosure.sorts) {
      expect(row.basis.length).toBeGreaterThan(5);
      expect(row.label).toBe(MARKET_SORT_LABEL[row.sort]);
    }
  });

  it("실적 지표와 사실 정보를 가른다 — 둘 다 광고와 무관하다", () => {
    const kinds = Object.fromEntries(disclosure.sorts.map((row) => [row.sort, row.kind]));

    expect(kinds).toEqual({ contracts: "performance", career: "fact", recent: "fact" });
  });

  it("**추천·프리미엄 같은 기준이 없다**(D-03 · §2.2)", () => {
    for (const row of RANKING_SORTS) {
      expect(["recommended", "sponsored", "premium", "featured"]).not.toContain(row.sort);
    }
  });

  it("광고가 순서에 반영되지 않음을 문구가 말한다", () => {
    expect(disclosure.notices.basis).toContain("광고");
    expect(disclosure.notices.sortBasis).toContain("광고");
  });
});

describe("지표 공개 — 못 세는 이유를 두 종류로 가른다", () => {
  const disclosure = rankingDisclosure();

  it("다섯 지표를 하나도 빠뜨리지 않는다 — 빠뜨리면 '없는 지표' 가 된다", () => {
    expect(disclosure.metrics.map((row) => row.metric)).toEqual([...RANKING_METRICS]);
  });

  it("**지금 세는 것은 계약 건수 하나**다", () => {
    expect(disclosure.counted).toEqual(["contracts"]);

    const contracts = disclosure.metrics.find((row) => row.metric === "contracts")!;

    expect(contracts.state).toBe("counted");
    expect(contracts.state === "counted" && contracts.source).toBe("planner_settlements");
  });

  it("**채우는 경로가 없는 것은 담당 태스크를 밝힌다** — 언제 열리는지 답할 수 있어야 한다", () => {
    for (const metric of ["consultations", "reviews", "profile_views"] as const) {
      const row = disclosure.metrics.find((item) => item.metric === metric)!;

      expect(row.state).toBe("pending");
      expect(row.state === "pending" && row.owner).toMatch(/^S\d-\d\d$/);
    }
  });

  it("**따로 셀 수 없는 것은 무엇과 같은 행을 세는지 밝힌다** — '곧 생긴다' 로 적지 않는다", () => {
    const row = disclosure.metrics.find((item) => item.metric === "bookings")!;

    expect(row.state).toBe("not_distinct");
    expect(row.state === "not_distinct" && row.sameAs).toBe("contracts");
    expect(row.state === "not_distinct" && row.sameAsLabel).toBe("계약 건수");
  });

  it("**못 세는 것을 0으로 적지 않는다** — 상태 라벨 셋이 서로 다르다", () => {
    const labels = Object.values(RANKING_METRIC_STATE_LABEL);

    expect(new Set(labels).size).toBe(3);
    for (const label of labels) expect(label).not.toContain("0");
  });

  it("판정을 다시 만들지 않는다 — scope.ts 의 함수를 그대로 쓴다", async () => {
    const scope = await import("./scope");

    expect(rankingMetricRow("contracts").state).toBe(
      scope.rankingMetricAvailability("contracts").available ? "counted" : "pending",
    );
  });
});

describe("지어내지 않은 것 둘 (O-13)", () => {
  const disclosure = rankingDisclosure();

  it("**종합 점수를 만들지 않았다** — 값으로 들고 다녀 API 본문에도 나간다", () => {
    expect(disclosure.compositeScore).toBe(false);
  });

  it("산정식이 미결이라는 사실과 오픈 이슈 번호를 함께 낸다", () => {
    expect(disclosure.formulaPending.openIssue).toBe("O-13");
    expect(disclosure.formulaPending.note).toContain("아직 정해지지 않았");
  });

  it("**콜드스타트에 대응하지 않고 물음만 보인다**", () => {
    expect(disclosure.coldStart.openIssue).toBe("O-13");
    expect(disclosure.coldStart.note).toContain("진입 장벽");
  });

  it("지표가 하나뿐이면 합산할 것이 없다 — 그 사실이 자료에 드러난다", () => {
    expect(disclosure.counted.length).toBe(1);
    expect(disclosure.compositeScore).toBe(false);
  });
});

describe("목록을 여기서 다시 그리지 않는다", () => {
  it("**순서를 만드는 함수는 S6-02 의 것 하나뿐이다**", () => {
    const rows = [
      { id: "a", careerYears: 1, contractCount: 2, createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "b", careerYears: 9, contractCount: 2, createdAt: "2026-02-01T00:00:00.000Z" },
    ];

    // 동점이면 최근 등록 순 — 이 규칙도 S6-02 가 이미 고정했다.
    expect(sortMarket(rows, "contracts").map((row) => row.id)).toEqual(["b", "a"]);
  });

  it("기준 화면이 목록을 들지 않는다는 사실을 문구가 말한다", () => {
    expect(RANKING_LIST_ELSEWHERE_NOTICE).toContain("플래너 찾기");
    expect(RANKING_TITLE).toContain("기준");
    expect(RANKING_INTRO).toContain("광고");
  });
});
