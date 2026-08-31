import { describe, expect, it } from "vitest";

import { ESTIMATE_CATEGORIES } from "../schemas/estimate";
import {
  COLD_START_NOTE,
  COLD_START_OPEN_ISSUE,
  FEE_TIMING_NOTICE,
  PLANNER_CATEGORIES,
  PLANNER_CATEGORY_LABEL,
  AMOUNT_UNKNOWN,
  RANKING_BASIS_NOTICE,
  RANKING_FORMULA_PENDING_NOTICE,
  RANKING_METRICS,
  SCOPE_CHANGE_ERRORS,
  SCOPE_CHANGE_MESSAGE,
  SCOPE_CROSS_AXIS_NOTICE,
  SCOPE_ENFORCED_AT,
  SCOPE_ENFORCEMENT_NOTICE,
  SCOPE_RATE_UNKNOWN_NOTICE,
  SCOPE_STATUSES,
  diffScopes,
  isPlannerCategory,
  isUnknownAmount,
  scopeFeeLine,
  scopeFeeTotal,
  validateScopeSelection,
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

// 위임 범위의 어휘는 **`delegation.ts` 하나가 든다**(S6-03 이 여기서 지웠다).
// 같은 사실을 두 파일이 다르게 적고 있었고 화면은 저쪽만 쓰고 있었다 —
// 읽히지 않는 목록이 진실 행세를 하던 상태다. 그쪽 테스트가 정책과 대조한다.
describe("위임 범위 어휘를 이 파일이 들지 않는다 (D-43 — 과금 축만 든다)", () => {
  it("모듈이 위임 목록을 내보내지 않는다", async () => {
    const scope = await import("./scope");

    expect("PLANNER_VISIBILITY" in scope).toBe(false);
    expect("VISIBILITY_NOTICE" in scope).toBe(false);
  });

  it("위임 목록은 delegation.ts 가 든다", async () => {
    const delegation = await import("./delegation");

    expect(delegation.DELEGATABLE_SCOPES.length).toBe(11);
    expect(delegation.CLOSED_SCOPES.length).toBeGreaterThanOrEqual(4);
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

// =============================================================================
// S6-03 — 선택의 변경과 총액 영향 (F-C-31)
// =============================================================================

describe("선택 판정 — 위임이 전제다", () => {
  const delegated = ["p1", "p2"];

  it("위임받은 플래너면 통과한다", () => {
    expect(
      validateScopeSelection([{ category: "dress", plannerId: "p1" }], delegated),
    ).toEqual({ ok: true });
  });

  it("**위임 없는 플래너는 막는다** — 보지도 못하는 플래너에게 수수료가 붙는다", () => {
    const result = validateScopeSelection([{ category: "dress", plannerId: "p9" }], delegated);

    expect(result).toEqual({ ok: false, errors: ["planner_not_delegated"] });
  });

  it("판매가가 없는 카테고리는 고를 수 없다", () => {
    const result = validateScopeSelection(
      [{ category: "helper" as never, plannerId: "p1" }],
      delegated,
    );

    expect(result).toEqual({ ok: false, errors: ["category_unknown"] });
  });

  it("**한 카테고리에 둘을 지정할 수 없다** — 같은 항목에 수수료가 두 번 붙는다", () => {
    const result = validateScopeSelection(
      [
        { category: "dress", plannerId: "p1" },
        { category: "dress", plannerId: "p2" },
      ],
      delegated,
    );

    expect(result).toEqual({ ok: false, errors: ["category_duplicated"] });
  });

  it("빈 선택은 정상이다 — 아무 카테고리도 안 쓰는 상태가 있다(D-43)", () => {
    expect(validateScopeSelection([], delegated)).toEqual({ ok: true });
  });

  it("모든 오류 코드에 문구가 있다", () => {
    for (const code of SCOPE_CHANGE_ERRORS) {
      expect(SCOPE_CHANGE_MESSAGE[code].length).toBeGreaterThan(0);
    }
  });
});

describe("차이 — 무엇을 켜고 무엇을 끄는가", () => {
  const current: ScopeRow[] = [
    row({ category: "dress", plannerId: "p1" }),
    row({ category: "makeup", plannerId: "p1" }),
    // 이력이다 — 세지 않는다.
    row({ category: "hall", plannerId: "p2", status: "released", releasedAt: "2026-08-02T00:00:00.000Z" }),
  ];

  it("새로 고른 것만 select 로 나온다", () => {
    const diff = diffScopes(current, [
      { category: "dress", plannerId: "p1" },
      { category: "makeup", plannerId: "p1" },
      { category: "studio", plannerId: "p1" },
    ]);

    expect(diff.select).toEqual([{ category: "studio", plannerId: "p1" }]);
    expect(diff.release).toEqual([]);
    expect(diff.unchanged).toHaveLength(2);
  });

  it("뺀 것만 release 로 나온다", () => {
    const diff = diffScopes(current, [{ category: "dress", plannerId: "p1" }]);

    expect(diff.release).toEqual([{ category: "makeup", plannerId: "p1" }]);
    expect(diff.select).toEqual([]);
  });

  it("**플래너를 바꾸면 해제 + 새 선택이다** — 한 행에 두 사람을 적지 않는다(D-23)", () => {
    const diff = diffScopes(current, [
      { category: "dress", plannerId: "p2" },
      { category: "makeup", plannerId: "p1" },
    ]);

    expect(diff.release).toEqual([{ category: "dress", plannerId: "p1" }]);
    expect(diff.select).toEqual([{ category: "dress", plannerId: "p2" }]);
  });

  it("해제된 이력은 지금 상태로 세지 않는다", () => {
    const diff = diffScopes(current, [
      { category: "dress", plannerId: "p1" },
      { category: "makeup", plannerId: "p1" },
    ]);

    // hall 은 이미 released 이므로 다시 뺄 것이 없다.
    expect(diff.release).toEqual([]);
  });

  it("아무것도 안 고르면 전부 해제다", () => {
    const diff = diffScopes(current, []);

    expect(diff.release.map((item) => item.category).sort()).toEqual(["dress", "makeup"]);
    expect(diff.select).toEqual([]);
  });

  it("결과의 순서는 카테고리 목록 순서다 — 화면이 매번 다르게 그리지 않는다", () => {
    const diff = diffScopes([], [
      { category: "makeup", plannerId: "p1" },
      { category: "hall", plannerId: "p1" },
    ]);

    expect(diff.select.map((item) => item.category)).toEqual(["hall", "makeup"]);
  });
});

describe("총액 영향 — 0과 미정을 가른다 (함정 2)", () => {
  it("고르지 않은 카테고리는 **0원**이다", () => {
    const line = scopeFeeLine({
      category: "dress",
      selected: false,
      plannerId: null,
      itemCount: 1,
      salePriceTotal: 3_000_000,
      rateBp: 900,
    });

    expect(line.fee).toBe(0);
  });

  it("고른 카테고리는 판매가에 요율을 곱한다", () => {
    const line = scopeFeeLine({
      category: "dress",
      selected: true,
      plannerId: "p1",
      itemCount: 1,
      salePriceTotal: 3_000_000,
      rateBp: 900,
    });

    expect(line.fee).toBe(270_000);
  });

  it("**요율이 없으면 0이 아니라 미정이다** — 0으로 접으면 '플래너가 공짜' 로 읽힌다", () => {
    const line = scopeFeeLine({
      category: "dress",
      selected: true,
      plannerId: "p1",
      itemCount: 1,
      salePriceTotal: 3_000_000,
      rateBp: null,
    });

    expect(line.fee).toBe(AMOUNT_UNKNOWN);
    expect(isUnknownAmount(line.fee)).toBe(true);
  });

  it("담긴 항목이 없으면 0원이다 — 그것은 '모른다' 가 아니다", () => {
    const line = scopeFeeLine({
      category: "dress",
      selected: true,
      plannerId: "p1",
      itemCount: 0,
      salePriceTotal: 0,
      rateBp: 900,
    });

    expect(line.fee).toBe(0);
  });

  it("합계는 한 줄이라도 미정이면 미정이다", () => {
    const lines = [
      scopeFeeLine({
        category: "dress",
        selected: true,
        plannerId: "p1",
        itemCount: 1,
        salePriceTotal: 3_000_000,
        rateBp: 900,
      }),
      scopeFeeLine({
        category: "hall",
        selected: true,
        plannerId: "p1",
        itemCount: 1,
        salePriceTotal: 20_000_000,
        rateBp: null,
      }),
    ];

    expect(isUnknownAmount(scopeFeeTotal(lines))).toBe(true);
  });

  it("전부 알면 합계도 숫자다", () => {
    const lines = [
      scopeFeeLine({
        category: "dress",
        selected: true,
        plannerId: "p1",
        itemCount: 1,
        salePriceTotal: 3_000_000,
        rateBp: 900,
      }),
      scopeFeeLine({
        category: "hall",
        selected: false,
        plannerId: null,
        itemCount: 1,
        salePriceTotal: 20_000_000,
        rateBp: 900,
      }),
    ];

    expect(scopeFeeTotal(lines)).toBe(270_000);
  });
});

describe("집행 시점과 문구", () => {
  it("**집행은 계약 발행이다** — 화면이 그것을 적는다(D-17)", () => {
    expect(SCOPE_ENFORCED_AT).toBe("contract_issue");
    expect(SCOPE_ENFORCEMENT_NOTICE).toContain("계약");
  });

  it("요율 미정 문구가 '0원이 아니다' 를 말한다(함정 2)", () => {
    expect(SCOPE_RATE_UNKNOWN_NOTICE).toContain("0원");
  });

  it("두 축이 다르다는 문구를 이 파일도 든다(D-43)", () => {
    expect(SCOPE_CROSS_AXIS_NOTICE).toContain("다른 축");
  });
});
