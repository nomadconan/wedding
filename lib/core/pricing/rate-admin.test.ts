import { describe, expect, it } from "vitest";

import { RATE_SCOPES } from "../schemas/rates";
import {
  ALL_RATE_SCOPES,
  COMMISSION_SCOPES,
  NO_RATE_BODY,
  PLANNER_SCOPES,
  RATE_TYPES,
  RateAdminError,
  endRate,
  findOverlaps,
  formatRateBp,
  rateState,
  simulationScopeKeys,
  validateRate,
  type RateDraft,
  type RateRow,
} from "./rate-admin";

const NOW = new Date("2026-08-14T00:00:00.000Z");
const VENDOR = "11111111-1111-1111-1111-111111111111";

function row(over: Partial<RateRow> & { id: string }): RateRow {
  return {
    scopeType: "global",
    scopeKey: null,
    feeRateBp: 500,
    effectiveFrom: "2026-01-01T00:00:00.000Z",
    effectiveTo: null,
    ...over,
  };
}

function draft(over: Partial<RateDraft> = {}): RateDraft {
  return {
    type: "commission",
    scopeType: "global",
    scopeKey: null,
    feeRateBp: 500,
    effectiveFrom: "2026-01-01T00:00:00.000Z",
    effectiveTo: null,
    ...over,
  };
}

describe("이력 상태 — 저장하지 않고 계산한다", () => {
  it("시작 전이면 예정이다", () => {
    expect(
      rateState({ effectiveFrom: "2026-09-01T00:00:00.000Z", effectiveTo: null, now: NOW }),
    ).toBe("scheduled");
  });

  it("시작했고 끝나지 않았으면 적용 중이다", () => {
    expect(
      rateState({ effectiveFrom: "2026-01-01T00:00:00.000Z", effectiveTo: null, now: NOW }),
    ).toBe("active");
  });

  it("종료 시각 그 순간부터 끝난 것으로 본다 — 반개구간이다", () => {
    expect(
      rateState({
        effectiveFrom: "2026-01-01T00:00:00.000Z",
        effectiveTo: NOW.toISOString(),
        now: NOW,
      }),
    ).toBe("ended");
  });

  it("시작 시각 그 순간부터 적용된다", () => {
    expect(
      rateState({ effectiveFrom: NOW.toISOString(), effectiveTo: null, now: NOW }),
    ).toBe("active");
  });
});

describe("겹침 — DB 가 막지만 화면이 먼저 알려준다", () => {
  const existing = [
    row({ id: "r1", effectiveFrom: "2026-01-01T00:00:00.000Z", effectiveTo: "2026-06-01T00:00:00.000Z" }),
  ];

  it("기간이 겹치면 충돌 행을 함께 돌려준다", () => {
    const result = findOverlaps({
      candidate: { ...row({ id: "new" }), effectiveFrom: "2026-03-01T00:00:00.000Z", effectiveTo: null, id: undefined },
      existing,
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.conflicts.map((r) => r.id)).toEqual(["r1"]);
    expect(result.ok === false && result.detail).toContain("겹치는 요율이 1건");
  });

  it("끝과 시작이 같으면 겹치지 않는다 — 그 순간의 요율은 하나여야 한다", () => {
    const result = findOverlaps({
      candidate: {
        ...row({ id: "x" }),
        id: undefined,
        effectiveFrom: "2026-06-01T00:00:00.000Z",
        effectiveTo: null,
      },
      existing,
    });

    expect(result.ok).toBe(true);
  });

  it("범위가 다르면 겹치지 않는다", () => {
    const result = findOverlaps({
      candidate: {
        ...row({ id: "x" }),
        id: undefined,
        scopeType: "vendor",
        scopeKey: VENDOR,
        effectiveFrom: "2026-03-01T00:00:00.000Z",
        effectiveTo: null,
      },
      existing,
    });

    expect(result.ok).toBe(true);
  });

  it("같은 범위라도 대상이 다르면 겹치지 않는다", () => {
    const result = findOverlaps({
      candidate: {
        ...row({ id: "x" }),
        id: undefined,
        scopeType: "category",
        scopeKey: "hall",
        effectiveFrom: "2026-03-01T00:00:00.000Z",
        effectiveTo: null,
      },
      existing: [row({ id: "r2", scopeType: "category", scopeKey: "studio" })],
    });

    expect(result.ok).toBe(true);
  });

  it("자기 자신은 겹침이 아니다 (수정할 때)", () => {
    const result = findOverlaps({
      candidate: { ...existing[0], effectiveTo: null },
      existing,
    });

    expect(result.ok).toBe(true);
  });

  it("무기한끼리는 언제나 겹친다", () => {
    const result = findOverlaps({
      candidate: { ...row({ id: "x" }), id: undefined, effectiveFrom: "2027-01-01T00:00:00.000Z" },
      existing: [row({ id: "r3", effectiveTo: null })],
    });

    expect(result.ok).toBe(false);
  });

  it("종료가 시작보다 앞서면 던진다", () => {
    expect(() =>
      findOverlaps({
        candidate: {
          ...row({ id: "x" }),
          id: undefined,
          effectiveFrom: "2026-06-01T00:00:00.000Z",
          effectiveTo: "2026-01-01T00:00:00.000Z",
        },
        existing: [],
      }),
    ).toThrow(RateAdminError);
  });
});

describe("입력 검증 — 스키마 경계까지만, 업무 상한은 운영 결정이다", () => {
  it("올바른 입력은 통과한다", () => {
    expect(validateRate(draft())).toEqual({ ok: true });
  });

  it("**업무 상한을 두지 않는다** — 100% 도 스키마상 통과한다(O-02)", () => {
    expect(validateRate(draft({ feeRateBp: 10_000 })).ok).toBe(true);
    expect(validateRate(draft({ feeRateBp: 0 })).ok).toBe(true);
  });

  it("0~10000bp 를 벗어나면 입력 사고로 본다", () => {
    expect(validateRate(draft({ feeRateBp: 10_001 })).ok).toBe(false);
    expect(validateRate(draft({ feeRateBp: -1 })).ok).toBe(false);
  });

  it("소수 요율은 거절한다 — bp 정수만 쓴다", () => {
    const result = validateRate(draft({ feeRateBp: 5.5 }));

    expect(result.ok === false && result.field).toBe("feeRateBp");
  });

  it("전역 요율에 대상을 지정할 수 없다", () => {
    const result = validateRate(draft({ scopeKey: "hall" }));

    expect(result.ok === false && result.field).toBe("scopeKey");
  });

  it("전역이 아니면 대상이 필요하다", () => {
    const result = validateRate(draft({ scopeType: "category", scopeKey: null }));

    expect(result.ok === false && result.field).toBe("scopeKey");
  });

  it("업체·플래너 대상은 uuid 형식이어야 한다", () => {
    expect(validateRate(draft({ scopeType: "vendor", scopeKey: "not-uuid" })).ok).toBe(false);
    expect(validateRate(draft({ scopeType: "vendor", scopeKey: VENDOR })).ok).toBe(true);
  });

  it("업체 요율에 planner 범위를 쓸 수 없다", () => {
    const result = validateRate(draft({ scopeType: "planner", scopeKey: VENDOR }));

    expect(result.ok === false && result.field).toBe("scopeType");
  });

  it("플래너 요율에 vendor 범위를 쓸 수 없다", () => {
    const result = validateRate(
      draft({ type: "planner", scopeType: "vendor", scopeKey: VENDOR }),
    );

    expect(result.ok === false && result.field).toBe("scopeType");
  });

  it("종료가 시작보다 앞서면 거절한다", () => {
    const result = validateRate(
      draft({ effectiveFrom: "2026-06-01T00:00:00.000Z", effectiveTo: "2026-01-01T00:00:00.000Z" }),
    );

    expect(result.ok === false && result.field).toBe("effectiveTo");
  });

  it("같은 시각으로 끝낼 수 없다 — 구간이 비어 버린다", () => {
    const at = "2026-06-01T00:00:00.000Z";

    expect(validateRate(draft({ effectiveFrom: at, effectiveTo: at })).ok).toBe(false);
  });
});

describe("종료 — 지우지 않고 닫는다 (D-23)", () => {
  it("적용 중인 요율을 끝낼 수 있다", () => {
    const result = endRate({
      effectiveFrom: "2026-01-01T00:00:00.000Z",
      effectiveTo: null,
      endAt: NOW.toISOString(),
    });

    expect(result.ok === true && result.effectiveTo).toBe(NOW.toISOString());
  });

  it("이미 끝난 요율은 다시 끝내지 않는다", () => {
    const result = endRate({
      effectiveFrom: "2026-01-01T00:00:00.000Z",
      effectiveTo: "2026-06-01T00:00:00.000Z",
      endAt: NOW.toISOString(),
    });

    expect(result.ok === false && result.reason).toBe("already_ended");
  });

  it("시작보다 앞선 시점으로 끝낼 수 없다", () => {
    const result = endRate({
      effectiveFrom: "2026-09-01T00:00:00.000Z",
      effectiveTo: null,
      endAt: NOW.toISOString(),
    });

    expect(result.ok === false && result.reason).toBe("before_start");
  });
});

describe("표시·시뮬레이터", () => {
  it("bp 를 퍼센트로 적는다", () => {
    expect(formatRateBp(500)).toBe("5.00%");
    expect(formatRateBp(1_250)).toBe("12.50%");
    expect(formatRateBp(0)).toBe("0.00%");
  });

  it("소수 bp 는 거절한다", () => {
    expect(() => formatRateBp(5.5)).toThrow(RateAdminError);
  });

  it("업체 요율 조회는 vendor·category 키를 만든다", () => {
    expect(
      simulationScopeKeys({ type: "commission", vendorId: VENDOR, category: "hall", at: "" }),
    ).toEqual({ vendor: VENDOR, category: "hall" });
  });

  it("플래너 요율 조회는 planner 키를 만든다 — vendor 를 넣지 않는다", () => {
    expect(
      simulationScopeKeys({ type: "planner", plannerId: VENDOR, vendorId: VENDOR, at: "" }),
    ).toEqual({ planner: VENDOR });
  });

  it("대상이 없으면 빈 키다 — 전역만 후보가 된다", () => {
    expect(simulationScopeKeys({ type: "commission", at: "" })).toEqual({});
  });
});

describe("값 집합과 문구", () => {
  it("스코프 목록이 스키마 상수와 같다", () => {
    expect(ALL_RATE_SCOPES).toEqual(RATE_SCOPES);
  });

  it("업체·플래너 스코프가 서로의 전용 값을 갖지 않는다", () => {
    expect(COMMISSION_SCOPES).not.toContain("planner");
    expect(PLANNER_SCOPES).not.toContain("vendor");
  });

  it("요율 종류는 둘이다", () => {
    expect(RATE_TYPES).toEqual(["commission", "planner"]);
  });

  it("요율이 없을 때의 안내가 '고장' 이 아니라 '아직 안 넣은 값' 을 말한다", () => {
    expect(NO_RATE_BODY).toContain("아직 정해지지 않았다면");
    expect(NO_RATE_BODY).not.toContain("오류");
    expect(NO_RATE_BODY).not.toContain("실패");
  });
});
