import { describe, expect, it } from "vitest";

import { ESTIMATE_CATEGORIES } from "../schemas/estimate";
import {
  COLD_START_NOTE,
  COLD_START_OPEN_ISSUE,
  FEE_TIMING_NOTICE,
  PLANNER_CATEGORIES,
  PLANNER_CATEGORY_LABEL,
  PLANNER_VISIBILITY,
  RANKING_BASIS_NOTICE,
  RANKING_FORMULA_PENDING_NOTICE,
  RANKING_METRICS,
  SCOPE_STATUSES,
  isPlannerCategory,
  plannerFeeApplies,
  rankingMetricAvailability,
  releaseImpact,
  scopeMismatch,
  selectedCategories,
  usableRankingMetrics,
  type ScopeRow,
} from "./scope";

function row(over: Partial<ScopeRow> & { category: string }): ScopeRow {
  return {
    plannerId: "11111111-1111-1111-1111-111111111111",
    status: "selected",
    selectedAt: "2026-08-01T00:00:00.000Z",
    releasedAt: null,
    ...over,
  };
}

describe("카테고리 — 견적 항목의 부분집합이다", () => {
  it("플래너 카테고리가 모두 견적 카테고리에 있다", () => {
    for (const category of PLANNER_CATEGORIES) {
      expect(ESTIMATE_CATEGORIES).toContain(category);
    }
  });

  it("판매가가 없는 항목(헬퍼비)은 대상이 아니다", () => {
    expect(isPlannerCategory("helper")).toBe(false);
    expect(isPlannerCategory("meal")).toBe(false);
  });

  it("모든 카테고리에 라벨이 있다", () => {
    for (const category of PLANNER_CATEGORIES) {
      expect(PLANNER_CATEGORY_LABEL[category].length).toBeGreaterThan(0);
    }
  });

  it("목록에 중복이 없다", () => {
    expect(new Set(PLANNER_CATEGORIES).size).toBe(PLANNER_CATEGORIES.length);
    expect(new Set(SCOPE_STATUSES).size).toBe(SCOPE_STATUSES.length);
  });
});

describe("선택 — 카테고리별로 개별이다 (F-C-31)", () => {
  it("선택된 카테고리만 센다", () => {
    const rows = [
      row({ category: "studio" }),
      row({ category: "dress" }),
      row({ category: "hall", status: "released", releasedAt: "2026-08-10T00:00:00.000Z" }),
    ];

    expect(selectedCategories(rows).sort()).toEqual(["dress", "studio"]);
  });

  it("해제 이력이 여러 건 있어도 지금 선택만 센다", () => {
    const rows = [
      row({ category: "dress", status: "released", releasedAt: "2026-07-01T00:00:00.000Z" }),
      row({ category: "dress", status: "released", releasedAt: "2026-07-20T00:00:00.000Z" }),
      row({ category: "dress" }),
    ];

    expect(selectedCategories(rows)).toEqual(["dress"]);
  });

  it("모르는 카테고리는 무시한다", () => {
    expect(selectedCategories([row({ category: "unknown" })])).toEqual([]);
  });

  it("선택한 카테고리에만 수수료가 붙는다", () => {
    const scopes = [row({ category: "studio" })];

    expect(plannerFeeApplies({ category: "studio", scopes })).toBe(true);
    expect(plannerFeeApplies({ category: "hall", scopes })).toBe(false);
  });

  it("해제된 카테고리에는 붙지 않는다", () => {
    const scopes = [row({ category: "studio", status: "released", releasedAt: "2026-08-10T00:00:00.000Z" })];

    expect(plannerFeeApplies({ category: "studio", scopes })).toBe(false);
  });
});

describe("장바구니 항목 토글과의 어긋남", () => {
  it("카테고리는 껐는데 항목이 켜져 있으면 드러낸다", () => {
    const result = scopeMismatch({
      items: [{ category: "hall", plannerSelected: true }],
      scopes: [],
    });

    expect(result).toEqual([{ category: "hall", itemOn: true }]);
  });

  it("카테고리는 켰는데 항목이 꺼져 있어도 드러낸다", () => {
    const result = scopeMismatch({
      items: [{ category: "studio", plannerSelected: false }],
      scopes: [row({ category: "studio" })],
    });

    expect(result).toEqual([{ category: "studio", itemOn: false }]);
  });

  it("일치하면 어긋남이 없다", () => {
    const result = scopeMismatch({
      items: [{ category: "studio", plannerSelected: true }],
      scopes: [row({ category: "studio" })],
    });

    expect(result).toEqual([]);
  });

  it("모르는 카테고리 항목은 보지 않는다", () => {
    expect(
      scopeMismatch({ items: [{ category: "helper", plannerSelected: true }], scopes: [] }),
    ).toEqual([]);
  });
});

describe("해제 — 이미 성사된 계약은 건드리지 않는다 (D-16 · D-17)", () => {
  const impact = releaseImpact();

  it("앞으로의 계약에만 영향을 준다", () => {
    expect(impact.futureFeeStops).toBe(true);
    expect(impact.settledFeesUnchanged).toBe(true);
  });

  it("이미 확정된 수수료가 바뀌지 않는다는 것을 문구가 말한다", () => {
    expect(impact.notes.join()).toContain("이미 확정된 계약의 수수료는 그대로");
  });

  it("열람 권한은 함께 끊기지 않는다 — 다른 축이다", () => {
    expect(impact.visibilityUnchanged).toBe(true);
    expect(impact.notes.join()).toContain("위임도 함께 해제");
  });
});

describe("위임 후 볼 수 있는 것 — 이미 갈라 둔 경계", () => {
  it("장바구니는 읽기만이다 (S3-04)", () => {
    const rule = PLANNER_VISIBILITY.find((item) => item.scope === "carts");

    expect(rule?.access).toBe("read");
    expect(rule?.origin).toBe("S3-04");
  });

  it("채팅은 막혀 있다 (S4-01)", () => {
    const rule = PLANNER_VISIBILITY.find((item) => item.scope === "chat_rooms");

    expect(rule?.access).toBe("none");
    expect(rule?.reason).toContain("대화 참여가 아닙니다");
  });

  it("상담은 열려 있다 (S4-07)", () => {
    expect(PLANNER_VISIBILITY.find((item) => item.scope === "consultations")?.access).toBe("read");
  });

  it("결제·계약은 위임만으로 열리지 않는다", () => {
    for (const scope of ["payments", "contracts"]) {
      expect(PLANNER_VISIBILITY.find((item) => item.scope === scope)?.access).toBe("none");
    }
  });

  it("모든 항목이 근거 태스크를 밝힌다", () => {
    for (const rule of PLANNER_VISIBILITY) {
      expect(rule.origin).toMatch(/^S\d/);
      expect(rule.reason.length).toBeGreaterThan(10);
    }
  });
});

describe("랭킹 — 못 세는 것을 0으로 적지 않는다 (D-25 · O-13)", () => {
  it("계약 건수는 지금 셀 수 있다", () => {
    const result = rankingMetricAvailability("contracts");

    expect(result.available).toBe(true);
    expect(result.available === true && result.source).toBe("planner_settlements");
  });

  it("나머지 지표는 담당 태스크와 함께 보류된다", () => {
    for (const metric of ["consultations", "bookings", "reviews", "profile_views"] as const) {
      const result = rankingMetricAvailability(metric);

      expect(result.available).toBe(false);
      expect(result.available === false && result.owner).toMatch(/^S\d/);
      expect(result.available === false && result.reason.length).toBeGreaterThan(5);
    }
  });

  it("지금 쓸 수 있는 지표는 하나뿐이다 — 종합 점수를 만들 수 없다", () => {
    expect(usableRankingMetrics()).toEqual(["contracts"]);
  });

  it("모든 지표에 라벨이 있다", () => {
    expect(RANKING_METRICS.length).toBe(5);
  });

  it("산정 기준을 화면에 공개한다 — 광고가 순서에 반영되지 않음을 밝힌다", () => {
    expect(RANKING_BASIS_NOTICE).toContain("실적 지표로만");
    expect(RANKING_BASIS_NOTICE).toContain("광고");
  });

  it("가중치를 지어내지 않았다는 사실을 문구가 말한다", () => {
    expect(RANKING_FORMULA_PENDING_NOTICE).toContain("O-13");
    expect(RANKING_FORMULA_PENDING_NOTICE).toContain("아직 정해지지 않았");
  });

  it("콜드스타트를 오픈 이슈로 붙잡아 둔다", () => {
    expect(COLD_START_OPEN_ISSUE).toBe("O-13");
    expect(COLD_START_NOTE).toContain("진입 장벽");
  });
});

describe("수수료 발생 시점 문구 (D-17)", () => {
  it("상담만으로는 발생하지 않는다는 것을 말한다", () => {
    expect(FEE_TIMING_NOTICE).toContain("계약이 성사된 뒤");
    expect(FEE_TIMING_NOTICE).toContain("상담만 받고 계약하지 않으면");
  });
});
