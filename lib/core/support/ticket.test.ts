import { describe, expect, it } from "vitest";

import {
  SIBLING_QUEUES,
  TICKET_ACTIONS,
  TICKET_CATEGORIES,
  TICKET_STATUSES,
  TICKET_STATUS_LABEL,
  TicketActionSchema,
  TicketCreateSchema,
  USER_SANCTION_UNAVAILABLE,
  VENDOR_SANCTIONS,
  VendorSanctionSchema,
  canApply,
  elapsedHours,
  isTerminal,
  statusAfter,
  summarize,
} from "./ticket";

const UUID = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-08-28T12:00:00.000Z");

// ══════════════════════════════════════════════════════════════════════════
// 접수 — 신고자가 자기 신고를 닫을 수 없다
// ══════════════════════════════════════════════════════════════════════════

describe("TicketCreateSchema", () => {
  const valid = { category: "payment" as const, subject: "환불이 안 됩니다", body: "본문" };

  it("**상태를 함께 보내도 받지 않는다** — 그러면 운영자 큐에 뜨지 않는다(FIX-43)", () => {
    const parsed = TicketCreateSchema.safeParse({ ...valid, status: "resolved" });

    expect(parsed.success).toBe(true);
    expect(parsed.success && "status" in parsed.data).toBe(false);
  });

  it("**담당자를 지정할 수 없다** — 남의 이름으로 담당 기록이 만들어진다", () => {
    const parsed = TicketCreateSchema.safeParse({ ...valid, assigneeId: UUID });

    expect(parsed.success && "assigneeId" in parsed.data).toBe(false);
  });

  it("**처리 사유도 받지 않는다**", () => {
    const parsed = TicketCreateSchema.safeParse({ ...valid, resolution: "직접 해결" });

    expect(parsed.success && "resolution" in parsed.data).toBe(false);
  });

  it("제목이 비면 거절한다 — 목록에서 그 티켓을 다시 찾을 수 없다", () => {
    expect(TicketCreateSchema.safeParse({ ...valid, subject: "   " }).success).toBe(false);
  });

  it("본문은 비워도 된다 — 제목만으로 접수할 수 있어야 한다", () => {
    expect(TicketCreateSchema.safeParse({ ...valid, body: null }).success).toBe(true);
  });

  it("정의되지 않은 분류는 거절한다", () => {
    expect(TicketCreateSchema.safeParse({ ...valid, category: "spam" }).success).toBe(false);
    expect(TICKET_CATEGORIES).toHaveLength(7);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 처리 — 판정이 아니라 우리가 한 일
// ══════════════════════════════════════════════════════════════════════════

describe("처리 어휘", () => {
  it("**종결 어휘가 '사실·허위' 가 아니라 '조치했다·안 했다' 다**(D-24)", () => {
    expect(TICKET_STATUS_LABEL.resolved).toBe("조치함");
    expect(TICKET_STATUS_LABEL.rejected).toBe("조치하지 않음");
    expect(TICKET_STATUS_LABEL.rejected).not.toContain("허위");
  });

  it("상태 넷·조치 셋이다", () => {
    expect([...TICKET_STATUSES]).toEqual(["open", "assigned", "resolved", "rejected"]);
    expect([...TICKET_ACTIONS]).toEqual(["assign", "resolve", "reject"]);
  });

  it("종결 판정이 둘을 다 잡는다", () => {
    expect(isTerminal("resolved")).toBe(true);
    expect(isTerminal("rejected")).toBe(true);
    expect(isTerminal("open")).toBe(false);
    expect(isTerminal("assigned")).toBe(false);
  });
});

describe("TicketActionSchema", () => {
  it("**'조치하지 않음' 에도 사유가 필수다**", () => {
    expect(
      TicketActionSchema.safeParse({ ticketId: UUID, action: "reject", note: "  " }).success,
    ).toBe(false);
  });

  it("**배정에도 사유를 요구한다** — 예외를 만들면 그 자리부터 빈칸이 된다", () => {
    expect(
      TicketActionSchema.safeParse({ ticketId: UUID, action: "assign", note: "" }).success,
    ).toBe(false);
    expect(
      TicketActionSchema.safeParse({ ticketId: UUID, action: "assign", note: "제가 봅니다" })
        .success,
    ).toBe(true);
  });

  it("정의되지 않은 조치를 받지 않는다", () => {
    expect(
      TicketActionSchema.safeParse({ ticketId: UUID, action: "delete", note: "x" }).success,
    ).toBe(false);
  });
});

describe("canApply", () => {
  it.each(["resolved", "rejected"])("**종결된 티켓(%s)은 다시 만지지 않는다**", (status) => {
    for (const action of TICKET_ACTIONS) expect(canApply(status, action)).toBe(false);
  });

  it("열린 티켓은 배정·종결 둘 다 된다", () => {
    for (const action of TICKET_ACTIONS) expect(canApply("open", action)).toBe(true);
  });

  it("배정된 티켓은 담당을 바꿀 수 있다", () => {
    expect(canApply("assigned", "assign")).toBe(true);
  });

  it("조치가 상태로 이어진다", () => {
    expect(statusAfter("assign")).toBe("assigned");
    expect(statusAfter("resolve")).toBe("resolved");
    expect(statusAfter("reject")).toBe("rejected");
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 제재 — 집행할 수 있는 것만
// ══════════════════════════════════════════════════════════════════════════

describe("제재", () => {
  it("업체 제재는 둘뿐이다 (정지·해제)", () => {
    expect([...VENDOR_SANCTIONS]).toEqual(["suspend", "reinstate"]);
  });

  it("**되돌리는 데에도 사유가 필수다**", () => {
    expect(
      VendorSanctionSchema.safeParse({
        vendorId: UUID,
        sanction: "reinstate",
        reason: "",
        ticketId: null,
      }).success,
    ).toBe(false);
  });

  it("티켓 없이도 제재할 수 있다 — 다른 경로로 발견될 수 있다", () => {
    expect(
      VendorSanctionSchema.safeParse({
        vendorId: UUID,
        sanction: "suspend",
        reason: "약관 위반 확인",
        ticketId: null,
      }).success,
    ).toBe(true);
  });

  it("**사용자 제재는 만들지 않았고 그 이유를 들고 다닌다**", () => {
    expect(USER_SANCTION_UNAVAILABLE.openIssue).toBe("O-14");
    expect(USER_SANCTION_UNAVAILABLE.message).toContain("계속 서비스를 쓰게 되고");
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 큐
// ══════════════════════════════════════════════════════════════════════════

describe("summarize", () => {
  const t = (status: string, assigneeId: string | null = null) => ({ status, assigneeId });

  it("상태별로 센다", () => {
    const s = summarize([t("open"), t("open"), t("assigned", UUID), t("resolved", UUID)]);

    expect(s.open).toBe(2);
    expect(s.assigned).toBe(1);
    expect(s.resolved).toBe(1);
  });

  it("**담당자 없는 열린 티켓을 따로 센다** — 가장 먼저 봐야 하는 값이다", () => {
    const s = summarize([t("open"), t("assigned", UUID), t("resolved")]);

    expect(s.unassigned).toBe(1);
  });

  it("종결된 티켓은 담당자가 없어도 미배정으로 세지 않는다", () => {
    expect(summarize([t("resolved"), t("rejected")]).unassigned).toBe(0);
  });

  it("비어 있으면 전부 0이다 — 그것은 측정된 0이다", () => {
    const s = summarize([]);

    expect(s.open + s.assigned + s.resolved + s.rejected + s.unassigned).toBe(0);
  });
});

describe("옆 큐", () => {
  it("**셋을 가리키되 합치지 않는다** — 조치가 서로 다르다", () => {
    expect(SIBLING_QUEUES).toHaveLength(3);
    for (const queue of SIBLING_QUEUES) {
      expect(queue.href.startsWith("/admin/")).toBe(true);
      // 무엇을 하는 큐인지 적혀 있어야 "왜 여기 없나" 에 답이 된다.
      expect(queue.action.length).toBeGreaterThan(5);
    }
  });

  it("서로 다른 화면을 가리킨다", () => {
    const hrefs = SIBLING_QUEUES.map((queue) => queue.href);

    expect(new Set(hrefs).size).toBe(hrefs.length);
  });
});

describe("elapsedHours", () => {
  it("경과 시간만 낸다 — **'지연' 이라 적지 않는다**(기한이 없다)", () => {
    expect(elapsedHours("2026-08-28T02:00:00.000Z", NOW)).toBe(10);
  });

  it("미래 시각은 0으로 접는다 — 음수 경과는 뜻이 없다", () => {
    expect(elapsedHours("2026-08-29T00:00:00.000Z", NOW)).toBe(0);
  });

  it("한 시간이 안 되면 0이다", () => {
    expect(elapsedHours("2026-08-28T11:30:00.000Z", NOW)).toBe(0);
  });
});
