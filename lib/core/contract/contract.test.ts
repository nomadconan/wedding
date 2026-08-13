import { describe, expect, it } from "vitest";

import {
  CONTRACT_STATUSES,
  ContractError,
  PLACEHOLDER_CLAUSE_SLOTS,
  SIGNER_ROLES,
  assertNoClauseNumbers,
  canEditClauses,
  canSign,
  canonicalContent,
  contractTotalFromQuote,
  hasClauseNumber,
  isPlaceholderTemplate,
  quoteEligibility,
  requiredSignerRoles,
  signingProgress,
  signingState,
  type ClauseSlot,
  type ContractContent,
} from "./contract";

/**
 * 표준계약 · 3자 서명 (S5-04 · S5-05)
 *
 * 여기서 고정하는 것은 넷이다 —
 *  · **조항 문안이 들어오지 못한다**(§7.7 · O-03 대기)
 *  · **커플은 소유자 한 명이 서명한다**(§1.4)
 *  · **서명이 붙으면 내용이 고정된다**(D-23 — 무엇에 서명했는가)
 *  · **만료된 견적으로 계약을 만들지 않는다**
 */
const CONTENT: ContractContent = {
  templateVersion: "v0-placeholder",
  clauses: PLACEHOLDER_CLAUSE_SLOTS,
  totalAmount: 10_000_000,
  appliedFeeRateBp: 500,
  appliedPlannerFeeRateBp: 0,
  installments: [
    { seq: 1, ratioBp: 2000, amount: 2_000_000 },
    { seq: 2, ratioBp: 8000, amount: 8_000_000 },
  ],
  parties: { coupleId: "c1", vendorId: "v1", plannerId: null },
};

describe("조항 문안 — 지어내지 않는다", () => {
  it("기본 판본에는 본문이 없다 (구조만 있다)", () => {
    expect(PLACEHOLDER_CLAUSE_SLOTS.length).toBeGreaterThan(0);
    for (const slot of PLACEHOLDER_CLAUSE_SLOTS) {
      expect(slot.body).toBeUndefined();
      expect(slot.title.length).toBeGreaterThan(0);
      expect(slot.basisNote.length).toBeGreaterThan(0);
    }
  });

  it("기본 판본에 조항 번호가 없다 (T-04 의 basis_ref 가드와 같은 규칙)", () => {
    expect(() => assertNoClauseNumbers(PLACEHOLDER_CLAUSE_SLOTS)).not.toThrow();
  });

  it("조항 번호 표기를 잡아낸다 — 한글·영문", () => {
    expect(hasClauseNumber("제3조 (해지)")).toBe(true);
    expect(hasClauseNumber("제 12 조")).toBe(true);
    expect(hasClauseNumber("2항에 따라")).toBe(true);
    expect(hasClauseNumber("Article 5")).toBe(true);
    expect(hasClauseNumber("표준약관")).toBe(false);
    expect(hasClauseNumber("소비자분쟁해결기준")).toBe(false);
  });

  it("조항 번호가 섞인 슬롯은 저장 전에 거절한다", () => {
    const bad: ClauseSlot[] = [
      { code: "cancel", order: 1, title: "제5조 취소", basisNote: "표준약관" },
    ];

    expect(() => assertNoClauseNumbers(bad)).toThrow(ContractError);
  });

  it("근거 출처에 조항 번호를 넣어도 거절한다", () => {
    const bad: ClauseSlot[] = [
      { code: "cancel", order: 1, title: "취소", basisNote: "소비자분쟁해결기준 제7조" },
    ];

    expect(() => assertNoClauseNumbers(bad)).toThrow(ContractError);
  });

  it("본문에 조항 번호를 넣어도 거절한다", () => {
    const bad: ClauseSlot[] = [
      { code: "etc", order: 1, title: "기타", basisNote: "표준약관", body: "제1조에 따른다" },
    ];

    expect(() => assertNoClauseNumbers(bad)).toThrow(ContractError);
  });

  it("검수 전 판본은 플레이스홀더로 판정된다", () => {
    expect(isPlaceholderTemplate({ clauseBodyStatus: "placeholder" })).toBe(true);
    expect(isPlaceholderTemplate({ clauseBodyStatus: "reviewed" })).toBe(false);
  });
});

describe("당사자 — 커플은 소유자 한 명", () => {
  it("플래너를 쓰지 않으면 2자다", () => {
    expect(requiredSignerRoles({ plannerParty: false })).toEqual(["couple", "vendor"]);
  });

  it("플래너를 쓰면 3자다 (D-21)", () => {
    expect(requiredSignerRoles({ plannerParty: true })).toEqual(["couple", "vendor", "planner"]);
  });

  it("커플 역할은 하나뿐이다 — 배우자 서명을 따로 요구하지 않는다", () => {
    const roles = requiredSignerRoles({ plannerParty: true });

    expect(roles.filter((role) => role === "couple")).toHaveLength(1);
  });
});

describe("서명 진행", () => {
  const required = requiredSignerRoles({ plannerParty: true });

  it("서명한 역할과 남은 역할을 가른다", () => {
    const progress = signingProgress(
      [
        { signerRole: "couple", signedAt: "2026-09-01T00:00:00.000Z" },
        { signerRole: "vendor", signedAt: null },
      ],
      required,
    );

    expect(progress.signed).toEqual(["couple"]);
    expect(progress.pending).toEqual(["vendor", "planner"]);
    expect(progress.complete).toBe(false);
  });

  it("필요한 역할이 다 서명하면 완료다", () => {
    const progress = signingProgress(
      [
        { signerRole: "couple", signedAt: "2026-09-01T00:00:00.000Z" },
        { signerRole: "vendor", signedAt: "2026-09-01T00:00:00.000Z" },
      ],
      requiredSignerRoles({ plannerParty: false }),
    );

    expect(progress.complete).toBe(true);
  });

  it("2자 계약에 플래너가 서명해도 완료 판정은 필요한 역할만 본다", () => {
    const progress = signingProgress(
      [
        { signerRole: "couple", signedAt: "2026-09-01T00:00:00.000Z" },
        { signerRole: "planner", signedAt: "2026-09-01T00:00:00.000Z" },
      ],
      requiredSignerRoles({ plannerParty: false }),
    );

    expect(progress.complete).toBe(false);
    expect(progress.pending).toEqual(["vendor"]);
  });
});

describe("계약 상태 — 기한은 계산한다", () => {
  const now = new Date("2026-09-10T00:00:00.000Z");

  it("발행 전·확정·취소는 저장된 상태를 그대로 쓴다", () => {
    expect(signingState({ status: "draft", deadlineAt: null, complete: false, now })).toBe("draft");
    expect(signingState({ status: "active", deadlineAt: null, complete: true, now })).toBe("active");
    expect(signingState({ status: "cancelled", deadlineAt: null, complete: false, now })).toBe(
      "cancelled",
    );
  });

  it("기한이 남으면 서명 대기다", () => {
    expect(
      signingState({
        status: "issued",
        deadlineAt: "2026-09-11T00:00:00.000Z",
        complete: false,
        now,
      }),
    ).toBe("awaiting");
  });

  it("기한이 지나면 만료다 (경계 당일 포함)", () => {
    expect(
      signingState({
        status: "issued",
        deadlineAt: "2026-09-10T00:00:00.000Z",
        complete: false,
        now,
      }),
    ).toBe("expired");
  });

  it("전원 서명했으면 기한이 지나도 만료로 적지 않는다", () => {
    // 확정 처리(bookings 스냅샷 복사)가 남았을 뿐이며 서명은 기한 안에 끝났다.
    expect(
      signingState({
        status: "issued",
        deadlineAt: "2026-09-01T00:00:00.000Z",
        complete: true,
        now,
      }),
    ).toBe("awaiting");
  });

  it("만료된 계약에는 서명할 수 없다", () => {
    expect(canSign("awaiting")).toBe(true);
    expect(canSign("expired")).toBe(false);
    expect(canSign("active")).toBe(false);
    expect(canSign("draft")).toBe(false);
  });
});

describe("내용 고정 — 서명이 붙으면 못 고친다 (D-23)", () => {
  it("발행 전에는 고칠 수 있다", () => {
    expect(canEditClauses({ status: "draft", signedCount: 0 })).toBe(true);
  });

  it("발행됐지만 아무도 서명하지 않았으면 고칠 수 있다", () => {
    expect(canEditClauses({ status: "issued", signedCount: 0 })).toBe(true);
  });

  it("한 명이라도 서명했으면 못 고친다", () => {
    expect(canEditClauses({ status: "issued", signedCount: 1 })).toBe(false);
  });

  it("확정·취소된 계약은 못 고친다", () => {
    expect(canEditClauses({ status: "active", signedCount: 2 })).toBe(false);
    expect(canEditClauses({ status: "cancelled", signedCount: 0 })).toBe(false);
  });
});

describe("정본 문자열 — 같은 입력이면 같은 문자열", () => {
  it("두 번 만들면 같다", () => {
    expect(canonicalContent(CONTENT)).toBe(canonicalContent(CONTENT));
  });

  it("조항 순서가 뒤섞여 들어와도 같은 문자열이다", () => {
    const shuffled: ContractContent = {
      ...CONTENT,
      clauses: [...PLACEHOLDER_CLAUSE_SLOTS].reverse(),
    };

    expect(canonicalContent(shuffled)).toBe(canonicalContent(CONTENT));
  });

  it("회차 순서가 뒤섞여도 같은 문자열이다", () => {
    const shuffled: ContractContent = {
      ...CONTENT,
      installments: [...CONTENT.installments].reverse(),
    };

    expect(canonicalContent(shuffled)).toBe(canonicalContent(CONTENT));
  });

  it("금액이 1원 달라지면 다른 문자열이다", () => {
    expect(canonicalContent({ ...CONTENT, totalAmount: 10_000_001 })).not.toBe(
      canonicalContent(CONTENT),
    );
  });

  it("요율이 달라지면 다른 문자열이다", () => {
    expect(canonicalContent({ ...CONTENT, appliedFeeRateBp: 501 })).not.toBe(
      canonicalContent(CONTENT),
    );
  });

  it("플래너 당사자 유무가 달라지면 다른 문자열이다", () => {
    expect(
      canonicalContent({ ...CONTENT, parties: { ...CONTENT.parties, plannerId: "p1" } }),
    ).not.toBe(canonicalContent(CONTENT));
  });

  it("조항 본문이 채워지면 다른 문자열이다 (검수 후 판본은 다른 정본이다)", () => {
    const reviewed: ContractContent = {
      ...CONTENT,
      clauses: PLACEHOLDER_CLAUSE_SLOTS.map((slot) =>
        slot.code === "cancel" ? { ...slot, body: "검수된 문안" } : slot,
      ),
    };

    expect(canonicalContent(reviewed)).not.toBe(canonicalContent(CONTENT));
  });
});

describe("견적 → 계약", () => {
  const now = new Date("2026-09-10T00:00:00.000Z");

  it("수락된 유효 견적은 발행할 수 있다", () => {
    expect(
      quoteEligibility({
        status: "accepted",
        validUntil: "2026-09-20T00:00:00.000Z",
        now,
        hasActiveContract: false,
      }),
    ).toEqual({ ok: true });
  });

  it("수락되지 않은 견적으로는 발행하지 않는다", () => {
    for (const status of ["draft", "sent", "declined", "withdrawn"]) {
      expect(
        quoteEligibility({ status, validUntil: null, now, hasActiveContract: false }),
      ).toMatchObject({ ok: false, reason: "not_accepted" });
    }
  });

  it("만료된 견적으로는 발행하지 않는다", () => {
    expect(
      quoteEligibility({
        status: "accepted",
        validUntil: "2026-09-10T00:00:00.000Z",
        now,
        hasActiveContract: false,
      }),
    ).toMatchObject({ ok: false, reason: "expired" });
  });

  it("유효기간이 없는 견적은 기간으로 막지 않는다", () => {
    expect(
      quoteEligibility({ status: "accepted", validUntil: null, now, hasActiveContract: false }),
    ).toEqual({ ok: true });
  });

  it("이미 유효한 계약이 있으면 발행하지 않는다 (예약당 하나 · D-21)", () => {
    expect(
      quoteEligibility({
        status: "accepted",
        validUntil: "2026-09-20T00:00:00.000Z",
        now,
        hasActiveContract: true,
      }),
    ).toMatchObject({ ok: false, reason: "already_contracted" });
  });

  it("총액은 견적 총액을 그대로 쓴다 — 항목을 다시 더하지 않는다", () => {
    expect(contractTotalFromQuote({ totalAmount: 12_345_678 })).toBe(12_345_678);
    expect(() => contractTotalFromQuote({ totalAmount: -1 })).toThrow(ContractError);
    expect(() => contractTotalFromQuote({ totalAmount: 1.5 })).toThrow(ContractError);
  });
});

describe("값 집합", () => {
  it("상태에 '서명 중'이 없다 — 세면 나오는 값을 저장하지 않는다", () => {
    expect(CONTRACT_STATUSES).not.toContain("signing");
    expect(CONTRACT_STATUSES).not.toContain("partially_signed");
  });

  it("역할·상태 목록에 중복이 없다", () => {
    expect(new Set(SIGNER_ROLES).size).toBe(SIGNER_ROLES.length);
    expect(new Set(CONTRACT_STATUSES).size).toBe(CONTRACT_STATUSES.length);
  });
});
