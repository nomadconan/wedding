import { describe, expect, it } from "vitest";

import {
  ALLOWED_TRANSITIONS,
  CLOSED_SCOPES,
  CROSS_AXIS_NOTICE,
  DELEGATABLE_SCOPES,
  DELEGATABLE_SCOPE_KEYS,
  DELEGATION_ERRORS,
  DELEGATION_MESSAGE,
  DelegationError,
  ENGAGEMENT_STATUSES,
  NO_FEE_FROM_DELEGATION_NOTICE,
  OFFER_PENDING_NOTICE,
  PHASE_DETAIL,
  PHASE_LABEL,
  effectiveScopes,
  engagementPhase,
  isDelegatableScope,
  isEffective,
  isEngagementStatus,
  revokeImpact,
  scopeLabel,
  transitionAllowed,
  validateDelegation,
  type EngagementRow,
} from "./delegation";

const NOW = new Date("2026-08-31T00:00:00.000Z");

function row(over: Partial<EngagementRow> = {}): EngagementRow {
  return {
    status: "active",
    validFrom: "2026-01-01T00:00:00.000Z",
    validTo: "2027-01-01T00:00:00.000Z",
    ...over,
  };
}

// =============================================================================
// 범위 어휘 — 지어내지 않는다 (D-167)
// =============================================================================

describe("범위 어휘", () => {
  it("11종이며 키가 중복되지 않는다", () => {
    expect(DELEGATABLE_SCOPES).toHaveLength(11);
    expect(new Set(DELEGATABLE_SCOPE_KEYS).size).toBe(11);
  });

  it("모든 범위가 여는 표를 하나 이상 밝힌다", () => {
    for (const scope of DELEGATABLE_SCOPES) {
      expect(scope.opens.length).toBeGreaterThan(0);
      expect(scope.detail.length).toBeGreaterThan(0);
    }
  });

  it("**키와 표가 1:1 이 아니다** — 장바구니·견적은 하나의 키가 둘을 연다", () => {
    const carts = DELEGATABLE_SCOPES.find((scope) => scope.key === "carts")!;
    const quotes = DELEGATABLE_SCOPES.find((scope) => scope.key === "quotes")!;

    expect(carts.opens).toEqual(["carts", "cart_items"]);
    expect(quotes.opens).toEqual(["quotes", "quote_items"]);
  });

  it("결제·대화·계약은 위임 목록에 없다 — 그러나 이유와 함께 보인다", () => {
    expect(DELEGATABLE_SCOPE_KEYS).not.toContain("payments");
    expect(DELEGATABLE_SCOPE_KEYS).not.toContain("chat_rooms");
    expect(DELEGATABLE_SCOPE_KEYS).not.toContain("contracts");
    expect(DELEGATABLE_SCOPE_KEYS).not.toContain("documents");

    // 조용히 빼지 않는다 — 막은 것에는 이유와 근거 태스크가 붙는다.
    expect(CLOSED_SCOPES.length).toBeGreaterThanOrEqual(4);
    for (const closed of CLOSED_SCOPES) {
      expect(closed.reason.length).toBeGreaterThan(0);
      expect(closed.origin).toMatch(/^S\d-\d\d$/);
    }
  });

  it("하객 범위는 제3자 정보라는 사실을 문구가 든다", () => {
    const guests = DELEGATABLE_SCOPES.find((scope) => scope.key === "guests")!;

    expect(guests.detail).toContain("제3자");
  });

  it("판정 함수와 라벨이 목록과 같은 값을 본다", () => {
    for (const key of DELEGATABLE_SCOPE_KEYS) {
      expect(isDelegatableScope(key)).toBe(true);
      expect(scopeLabel(key)).not.toBe(key);
    }

    expect(isDelegatableScope("payments")).toBe(false);
    // 모르는 키는 라벨을 지어내지 않고 그대로 돌려준다.
    expect(scopeLabel("payments")).toBe("payments");
  });
});

// =============================================================================
// 상태와 국면 — 계산 가능한 값을 저장하지 않는다
// =============================================================================

describe("상태 어휘", () => {
  it("저장하는 상태는 넷이고 **만료가 없다**", () => {
    expect(ENGAGEMENT_STATUSES).toEqual(["pending", "active", "declined", "revoked"]);
    expect(ENGAGEMENT_STATUSES).not.toContain("expired");
  });

  it("모든 국면에 라벨과 설명이 있다", () => {
    for (const phase of Object.keys(PHASE_LABEL)) {
      expect(PHASE_DETAIL[phase as keyof typeof PHASE_DETAIL].length).toBeGreaterThan(0);
    }
  });

  it("어휘 판정", () => {
    expect(isEngagementStatus("active")).toBe(true);
    expect(isEngagementStatus("expired")).toBe(false);
  });
});

describe("국면 — has_planner_scope 와 같은 답을 내야 한다", () => {
  it("수락 전에는 열리지 않는다", () => {
    expect(engagementPhase(row({ status: "pending" }), NOW)).toBe("awaiting");
    expect(isEffective(row({ status: "pending" }), NOW)).toBe(false);
  });

  it("시작 전이면 scheduled 다", () => {
    expect(
      engagementPhase(row({ validFrom: "2026-12-01T00:00:00.000Z" }), NOW),
    ).toBe("scheduled");
  });

  it("기간이 지나면 상태가 active 여도 열리지 않는다", () => {
    const expired = row({ validTo: "2026-08-01T00:00:00.000Z" });

    expect(engagementPhase(expired, NOW)).toBe("expired");
    expect(isEffective(expired, NOW)).toBe(false);
  });

  it("기간 안이면 effective 다", () => {
    expect(engagementPhase(row(), NOW)).toBe("effective");
    expect(isEffective(row(), NOW)).toBe(true);
  });

  // 경계값 — `has_planner_scope` 는 `valid_from <= now` 와 `valid_to >= now` 다.
  // 경계 당일이 어느 쪽에 속하는지가 "오늘 보이는가" 를 가른다.
  it("시작 시각 정각은 **열린다**", () => {
    expect(isEffective(row({ validFrom: NOW.toISOString() }), NOW)).toBe(true);
  });

  it("종료 시각 정각은 **아직 열려 있다** — 지난 뒤부터 닫힌다", () => {
    expect(isEffective(row({ validTo: NOW.toISOString() }), NOW)).toBe(true);
    expect(isEffective(row({ validTo: "2026-08-30T23:59:59.999Z" }), NOW)).toBe(false);
  });

  it("기간이 없으면 무기한으로 읽는다 — DB CHECK 이 살아 있는 위임에 이것을 막는다", () => {
    expect(isEffective(row({ validFrom: null, validTo: null }), NOW)).toBe(true);
  });

  it("거절·해제는 기간과 무관하다", () => {
    expect(engagementPhase(row({ status: "declined" }), NOW)).toBe("declined");
    expect(engagementPhase(row({ status: "revoked" }), NOW)).toBe("revoked");
  });

  it("모르는 상태는 조용히 통과시키지 않는다", () => {
    expect(() => engagementPhase(row({ status: "actived" }), NOW)).toThrow(DelegationError);
  });
});

describe("effectiveScopes — 열려 있는 위임만 센다", () => {
  it("만료·대기 위임은 아무것도 내놓지 않는다", () => {
    expect(
      effectiveScopes(
        [
          { ...row({ status: "pending" }), scopes: ["couples", "budgets"] },
          { ...row({ validTo: "2026-01-02T00:00:00.000Z" }), scopes: ["guests"] },
        ],
        NOW,
      ),
    ).toEqual([]);
  });

  it("여러 위임의 범위를 합치되 목록 순서로 정렬한다", () => {
    expect(
      effectiveScopes(
        [
          { ...row(), scopes: ["guests", "couples"] },
          { ...row(), scopes: ["budgets", "couples"] },
        ],
        NOW,
      ),
    ).toEqual(["couples", "budgets", "guests"]);
  });

  it("어휘에 없는 키는 버린다 — 화면이 열리지 않는 것을 열렸다고 적지 않는다", () => {
    expect(effectiveScopes([{ ...row(), scopes: ["payments"] }], NOW)).toEqual([]);
  });
});

// =============================================================================
// 전이 — 허용 값을 나열한다
// =============================================================================

describe("전이", () => {
  it("수락·거절은 플래너의 것이고 회수는 커플의 것이다", () => {
    expect(transitionAllowed("pending", "active", "planner")).toBe(true);
    expect(transitionAllowed("pending", "declined", "planner")).toBe(true);
    expect(transitionAllowed("active", "revoked", "couple")).toBe(true);
    expect(transitionAllowed("pending", "revoked", "couple")).toBe(true);
  });

  it("**플래너가 스스로 수락 뒤 범위를 넓히는 전이는 없다** — 자기 수수료를 늘리는 행위다", () => {
    expect(transitionAllowed("pending", "active", "couple")).toBe(false);
    expect(transitionAllowed("active", "revoked", "planner")).toBe(false);
    expect(transitionAllowed("revoked", "active", "planner")).toBe(false);
    expect(transitionAllowed("declined", "active", "planner")).toBe(false);
  });

  it("끝난 위임은 되살아나지 않는다 — 재위임은 새 행이다(D-23)", () => {
    for (const rule of ALLOWED_TRANSITIONS) {
      expect(["declined", "revoked"]).not.toContain(rule.from);
    }
  });

  it("전이 목록이 저장 상태 어휘 안에서만 움직인다", () => {
    for (const rule of ALLOWED_TRANSITIONS) {
      expect(ENGAGEMENT_STATUSES).toContain(rule.from);
      expect(ENGAGEMENT_STATUSES).toContain(rule.to);
    }
  });
});

// =============================================================================
// 폼 판정
// =============================================================================

describe("위임 폼", () => {
  const period = { validFrom: "2026-09-01T00:00:00.000Z", validTo: "2027-06-01T00:00:00.000Z" };

  it("범위와 기간이 갖춰지면 통과한다", () => {
    expect(validateDelegation({ scopes: ["couples", "budgets"], ...period }, NOW)).toEqual({
      ok: true,
    });
  });

  it("**범위가 비면 막는다** — 아무것도 열지 않는 위임은 장식이다", () => {
    const result = validateDelegation({ scopes: [], ...period }, NOW);

    expect(result).toEqual({ ok: false, errors: ["scope_empty"] });
  });

  it("어휘 밖의 범위를 막는다", () => {
    const result = validateDelegation({ scopes: ["couples", "payments"], ...period }, NOW);

    expect(result).toEqual({ ok: false, errors: ["scope_unknown"] });
  });

  it("**기간에는 끝이 있어야 한다**(D-166) — 무기한은 해제를 기억해야만 끝난다", () => {
    const result = validateDelegation(
      { scopes: ["couples"], validFrom: period.validFrom, validTo: "" },
      NOW,
    );

    expect(result).toEqual({ ok: false, errors: ["period_missing"] });
  });

  it("종료가 시작보다 앞서면 막는다", () => {
    const result = validateDelegation(
      { scopes: ["couples"], validFrom: "2027-01-01T00:00:00.000Z", validTo: "2026-12-01T00:00:00.000Z" },
      NOW,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContain("period_order");
  });

  it("이미 지난 기간으로는 위임할 수 없다", () => {
    const result = validateDelegation(
      { scopes: ["couples"], validFrom: "2026-01-01T00:00:00.000Z", validTo: "2026-02-01T00:00:00.000Z" },
      NOW,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContain("period_past");
  });

  it("**막은 이유를 한 번에 모아 돌려준다** — 하나씩 알리면 고치기를 반복한다", () => {
    const result = validateDelegation({ scopes: [], validFrom: "", validTo: "" }, NOW);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toEqual(["scope_empty", "period_missing"]);
  });

  it("모든 오류 코드에 문구가 있다", () => {
    for (const code of DELEGATION_ERRORS) {
      expect(DELEGATION_MESSAGE[code].length).toBeGreaterThan(0);
    }
  });

  it("**기간 상한을 만들지 않는다** — 운영 파라미터를 코드가 고르지 않는다(§7.4)", () => {
    expect(
      validateDelegation(
        { scopes: ["couples"], validFrom: "2026-09-01T00:00:00.000Z", validTo: "2036-09-01T00:00:00.000Z" },
        NOW,
      ),
    ).toEqual({ ok: true });
  });
});

// =============================================================================
// 해제의 영향 — 축이 둘이다 (D-43)
// =============================================================================

describe("해제", () => {
  it("열람만 끊고 카테고리 선택·기존 계약 수수료는 건드리지 않는다", () => {
    const impact = revokeImpact();

    expect(impact.readingStops).toBe(true);
    expect(impact.categoriesUnchanged).toBe(true);
    expect(impact.settledFeesUnchanged).toBe(true);
  });

  it("**두 축이 다르다는 사실을 문구가 든다** — 자동으로 끄지 않고 안내한다", () => {
    const notes = revokeImpact().notes.join(" ");

    expect(notes).toContain("카테고리");
    expect(CROSS_AXIS_NOTICE).toContain("서로 다른 설정");
  });

  it("위임만으로는 수수료가 생기지 않는다는 사실을 별도 문구가 든다(D-17)", () => {
    expect(NO_FEE_FROM_DELEGATION_NOTICE).toContain("계약");
  });

  it("제안만으로는 열리지 않는다는 사실을 문구가 든다(D-165)", () => {
    expect(OFFER_PENDING_NOTICE).toContain("수락");
  });
});
