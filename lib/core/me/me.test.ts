import { describe, expect, it } from "vitest";

import {
  DELETION_RETAINED_ITEMS,
  DELETION_SCOPES,
  DELETION_STATUSES,
  DeletionRequestSchema,
  ME_PENDING_SECTIONS,
  ProfileUpdateSchema,
  canCancelRequest,
  isOpenRequest,
  isWithdrawable,
  mePendingMetric,
  unlinkBlocker,
} from "../schemas/me";

describe("삭제 요청 입력", () => {
  const valid = { scope: "account", acknowledgedRetention: true };

  it("남는 기록을 확인해야 접수된다", () => {
    expect(DeletionRequestSchema.parse(valid).scope).toBe("account");
    expect(() =>
      DeletionRequestSchema.parse({ scope: "account", acknowledgedRetention: false }),
    ).toThrow();
  });

  it("확인 표시를 빠뜨리면 거부한다", () => {
    expect(() => DeletionRequestSchema.parse({ scope: "account" })).toThrow();
  });

  it("정의되지 않은 범위는 거부한다", () => {
    expect(() =>
      DeletionRequestSchema.parse({ scope: "everything", acknowledgedRetention: true }),
    ).toThrow();
  });

  it("사유는 선택이다", () => {
    expect(DeletionRequestSchema.parse(valid).reason).toBeNull();
  });

  it("계정 삭제와 기록 삭제를 다른 요구로 둔다", () => {
    expect(DELETION_SCOPES).toEqual(["account", "service_data"]);
  });
});

describe("요청 상태", () => {
  it("접수·처리 중은 열린 요청이다 — 그 사이 새 요청을 또 받지 않는다", () => {
    expect(isOpenRequest("pending")).toBe(true);
    expect(isOpenRequest("in_progress")).toBe(true);
  });

  it("끝난 요청은 열려 있지 않다", () => {
    for (const status of ["completed", "rejected", "cancelled"] as const) {
      expect(isOpenRequest(status)).toBe(false);
    }
  });

  it("접수 상태에서만 거둘 수 있다", () => {
    expect(canCancelRequest("pending")).toBe(true);
  });

  it("처리가 시작되면 거둘 수 없다 — 지킬 수 없는 약속을 하지 않는다", () => {
    for (const status of ["in_progress", "completed", "rejected", "cancelled"] as const) {
      expect(canCancelRequest(status)).toBe(false);
    }
  });

  it("상태 값 집합이 5가지다", () => {
    expect(DELETION_STATUSES).toHaveLength(5);
  });
});

describe("법정 보존 고지", () => {
  it("무엇이 남는지 항목으로 밝힌다", () => {
    expect(DELETION_RETAINED_ITEMS.length).toBeGreaterThanOrEqual(3);
    expect(DELETION_RETAINED_ITEMS.every((item) => item.reason.length > 0)).toBe(true);
  });

  it("보존 기간을 숫자로 단정하지 않는다 — 법무 검수 전이다", () => {
    const text = DELETION_RETAINED_ITEMS.map((item) => `${item.label}${item.reason}`).join(" ");

    expect(text).not.toMatch(/\d+\s*년/);
    expect(text).not.toMatch(/\d+\s*개월/);
  });
});

describe("프로필 입력", () => {
  it("이름은 비울 수 없다", () => {
    expect(() =>
      ProfileUpdateSchema.parse({ displayName: "  ", marketingOptIn: false }),
    ).toThrow();
  });

  it("연락처를 안 넘기면 그대로 둔다", () => {
    const parsed = ProfileUpdateSchema.parse({ displayName: "코난", marketingOptIn: false });

    expect(parsed.phone).toBeNull();
    expect(parsed.removePhone).toBe(false);
  });

  it("지우려면 명시해야 한다 — 빈 값과 '안 넘김'을 섞지 않는다", () => {
    const parsed = ProfileUpdateSchema.parse({
      displayName: "코난",
      marketingOptIn: false,
      removePhone: true,
    });

    expect(parsed.removePhone).toBe(true);
  });

  it("너무 짧은 연락처는 거부한다", () => {
    expect(() =>
      ProfileUpdateSchema.parse({ displayName: "코난", phone: "010", marketingOptIn: false }),
    ).toThrow();
  });
});

describe("동의", () => {
  it("마케팅만 철회할 수 있다", () => {
    expect(isWithdrawable("marketing")).toBe(true);
  });

  it("서비스 이용의 전제인 동의는 철회 대상이 아니다", () => {
    for (const type of ["terms", "privacy", "document_ai"]) {
      expect(isWithdrawable(type)).toBe(false);
    }
  });
});

describe("커플 연동 해제", () => {
  it("소유자는 나갈 수 없다 — 남는 기록의 주인이 없어진다", () => {
    expect(unlinkBlocker("owner", 2)?.code).toBe("COUPLE_OWNER_CANNOT_LEAVE");
  });

  it("연동된 배우자가 없으면 해제할 것도 없다", () => {
    expect(unlinkBlocker("partner", 1)?.code).toBe("COUPLE_NOT_LINKED");
  });

  it("배우자는 나갈 수 있다", () => {
    expect(unlinkBlocker("partner", 2)).toBeNull();
  });
});

describe("아직 없는 자리", () => {
  it("전부 담당 태스크를 밝힌다", () => {
    expect(ME_PENDING_SECTIONS.every((section) => /^S\d/.test(section.filledBy))).toBe(true);
  });

  it("**채운 자리는 목록에 없다** — 멤버십은 S7-11 이, 파기 이력은 S7-03 이 채웠다", () => {
    const keys = ME_PENDING_SECTIONS.map((section) => section.key);

    // 만들어 둔 기능을 화면이 "아직 없다" 고 말하면 없는 것과 같아진다(FIX-29).
    expect(keys).not.toContain("membership");
    expect(keys).not.toContain("purge_history");
  });

  it("0이 아니라 '아직 측정하지 않음'으로 만든다", () => {
    for (const section of ME_PENDING_SECTIONS) {
      expect(mePendingMetric(section.key).status).toBe("not_yet");
    }
  });

  it("모르는 항목은 던진다", () => {
    // 키 타입은 `string` 이다(자리가 늘었다 줄었다 한다) — 막는 자리는 런타임이다.
    expect(() => mePendingMetric("nope")).toThrow(RangeError);
  });
});
