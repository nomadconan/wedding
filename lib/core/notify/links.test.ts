import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { NOTIFICATION_TEMPLATES } from "../schemas/notification";
import {
  LINKED_TEMPLATE_KEYS,
  LINK_REQUIRED_REFS,
  NOTIFICATION_LINKS,
  UNLINKED_TEMPLATES,
  isVendorViewer,
  notificationLink,
} from "./links";

const ROOT = path.resolve(__dirname, "../../..");
const TEMPLATE_KEYS = Object.keys(NOTIFICATION_TEMPLATES);

/** 정적 경로(`[` 가 없는 것)만 화면 파일을 대조할 수 있다. */
function staticHrefs(): string[] {
  const found = new Set<string>();

  for (const key of LINKED_TEMPLATE_KEYS) {
    // 참조가 없는 payload 를 넣어 본다 — 고정 화면만 링크를 돌려준다.
    for (const role of ["consumer", "vendor_owner"] as const) {
      const link = notificationLink(key, {}, role);

      if (link !== null && !link.href.includes("[")) found.add(link.href);
    }
  }

  return [...found];
}

describe("전수 — 템플릿 하나하나에 가는 곳이거나 없다는 사실이 있다", () => {
  /**
   * **C-4e 의 완료 조건이다.**
   *
   * 목록에서 빠진 것과 "링크가 없다고 정했다" 는 다른 상태이며, 화면은 둘을 똑같이
   * 다루므로(둘 다 `null`) **가르는 일은 여기서만 일어난다.**
   */
  it("모든 템플릿이 레지스트리에 있다", () => {
    const missing = TEMPLATE_KEYS.filter((key) => !(key in NOTIFICATION_LINKS));

    expect(missing, `레지스트리에 없는 템플릿: ${missing.join(", ")}`).toEqual([]);
  });

  it("레지스트리에 없는 템플릿을 적어 두지 않았다 — 양방향으로 센다", () => {
    const stale = Object.keys(NOTIFICATION_LINKS).filter((key) => !TEMPLATE_KEYS.includes(key));

    expect(stale, `템플릿이 사라졌는데 링크가 남아 있다: ${stale.join(", ")}`).toEqual([]);
  });

  it("**목록을 실제로 읽었는가** — 세기 전에 목록이 비지 않았는지 본다", () => {
    // 빈 목록은 위 두 검사를 조용히 통과시킨다(§7.0b).
    expect(TEMPLATE_KEYS.length).toBeGreaterThanOrEqual(31);
    expect(LINKED_TEMPLATE_KEYS.length + Object.keys(UNLINKED_TEMPLATES).length).toBe(
      TEMPLATE_KEYS.length,
    );
  });

  it("없다고 정한 자리에는 이유가 적혀 있다 — 빈 문자열이 아니다", () => {
    for (const [key, reason] of Object.entries(UNLINKED_TEMPLATES)) {
      expect(reason.trim().length, `${key} 의 이유가 비어 있다`).toBeGreaterThan(10);
    }
  });
});

describe("가는 곳이 실재한다", () => {
  it("정적 경로마다 page.tsx 가 있다", () => {
    const GROUPS = ["(consumer)", "(vendor)", "(admin)", "(planner)", "(auth)", "(marketing)", ""];
    const hrefs = staticHrefs();

    // 목록이 비면 for 문이 돌지 않고 통과한다(§7.0b).
    expect(hrefs.length).toBeGreaterThanOrEqual(8);

    for (const href of hrefs) {
      const found = GROUPS.some((group) =>
        existsSync(path.join(ROOT, "app", group, href.slice(1), "page.tsx")),
      );

      expect(found, `${href} 에 page.tsx 가 없다`).toBe(true);
    }
  });

  it("참조를 쓰는 경로의 동적 자리도 실재한다", () => {
    const DYNAMIC: [string, string][] = [
      ["(consumer)", "explore/[vendorId]/[productId]"],
      ["(consumer)", "chat/[roomId]"],
      ["(consumer)", "contracts/[id]"],
      ["(consumer)", "bookings/[id]"],
      ["(consumer)", "bookings/[id]/cancel"],
      ["(consumer)", "bookings/[id]/escrow"],
    ];

    for (const [group, route] of DYNAMIC) {
      expect(
        existsSync(path.join(ROOT, "app", group, route, "page.tsx")),
        `${group}/${route} 가 없다`,
      ).toBe(true);
    }
  });
});

describe("참조가 모자라면 링크를 만들지 않는다", () => {
  it.each(Object.entries(LINK_REQUIRED_REFS))(
    "%s 는 %s 가 없으면 링크가 없다",
    (key, ref) => {
      expect(notificationLink(key, {}, "consumer")).toBeNull();
      expect(notificationLink(key, { [ref]: "   " }, "consumer")).toBeNull();
      expect(notificationLink(key, { [ref]: 42 }, "consumer")).toBeNull();

      const link = notificationLink(key, { [ref]: "abc" }, "consumer");

      expect(link).not.toBeNull();
      expect(link?.href).toContain("abc");
    },
  );

  it("상품 주문 기한은 **둘 다** 있어야 간다", () => {
    expect(notificationLink("task_due.order", { productId: "p1" }, "consumer")).toBeNull();
    expect(notificationLink("task_due.order", { vendorId: "v1" }, "consumer")).toBeNull();
    expect(
      notificationLink("task_due.order", { vendorId: "v1", productId: "p1" }, "consumer")?.href,
    ).toBe("/explore/v1/p1");
  });

  it("커플이 보는 채팅은 방 참조가 없으면 가지 않는다", () => {
    expect(notificationLink("chat.new_message", {}, "consumer")).toBeNull();
    expect(notificationLink("chat.new_message", { roomId: "r1" }, "consumer")?.href).toBe(
      "/chat/r1",
    );
  });
});

describe("읽는 사람에 따라 갈리는 여섯", () => {
  const BOTH_SIDES = [
    "schedule.confirmed",
    "schedule.cancelled",
    "schedule.confirm_request",
    "schedule.resolved",
    "schedule.disputed",
  ];

  it.each(BOTH_SIDES)("%s 는 면마다 다른 곳으로 간다", (key) => {
    expect(notificationLink(key, {}, "consumer")?.href).toBe("/consultations");
    expect(notificationLink(key, {}, "couple_partner")?.href).toBe("/consultations");
    expect(notificationLink(key, {}, "vendor_owner")?.href).toBe("/vendor/consultations");
    expect(notificationLink(key, {}, "vendor_staff")?.href).toBe("/vendor/consultations");
  });

  it("채팅은 업체에게 방 참조 없이도 간다 — 업체 화면이 목록 겸 대화다", () => {
    expect(notificationLink("chat.new_message", {}, "vendor_owner")?.href).toBe("/vendor/chat");
    expect(notificationLink("chat.new_message", { roomId: "r1" }, "vendor_staff")?.href).toBe(
      "/vendor/chat",
    );
  });

  it("역할을 안 주면 소비자 쪽으로 간다 — 이 화면의 기본 독자다", () => {
    expect(notificationLink("schedule.confirmed", {})?.href).toBe("/consultations");
  });

  it("업체 독자는 두 역할뿐이다 — 플래너·운영자를 업체로 보지 않는다", () => {
    expect(isVendorViewer("vendor_owner")).toBe(true);
    expect(isVendorViewer("vendor_staff")).toBe(true);
    for (const role of ["consumer", "couple_partner", "planner", "ops", "admin", "guest", null] as const) {
      expect(isVendorViewer(role), `${String(role)} 가 업체로 잡혔다`).toBe(false);
    }
  });
});

describe("한쪽에만 가는 알림은 갈리지 않는다", () => {
  /**
   * **발송부가 근거다.** `notifyInquiryReceived` 는 업체 담당자에게만,
   * `notifyCouple` 은 커플 멤버에게만 보낸다 — 화면 구조로 추측하지 않는다.
   */
  it.each([
    ["inquiry.received", "/vendor/inquiries"],
    ["schedule.requested", "/vendor/consultations"],
    ["settlement.confirmed", "/vendor/settlements"],
    ["settlement.paid", "/vendor/settlements"],
    ["escrow.released_vendor", "/vendor/escrow"],
    ["inquiry.quote_arrived", "/inquiries"],
    ["inquiry.declined", "/inquiries"],
    ["schedule.approved", "/consultations"],
    ["schedule.rejected", "/consultations"],
    ["task_due.remind", "/checklist"],
    ["dday.remind", "/checklist"],
    ["price_change.drop", "/wishlist"],
    ["couple_invite.accepted", "/me"],
  ])("%s 는 누가 읽어도 %s 다", (key, href) => {
    expect(notificationLink(key, {}, "consumer")?.href).toBe(href);
    expect(notificationLink(key, {}, "vendor_owner")?.href).toBe(href);
  });
});

describe("업체 초대에는 가는 곳이 없다 — 토큰을 payload 에 담지 않기 때문이다", () => {
  it("링크가 없고, 토큰을 줘도 만들어지지 않는다", () => {
    expect(notificationLink("vendor_invite.received", { inviteId: "i1" })).toBeNull();
    // 누군가 토큰을 실어도 링크가 생기면 안 된다 — 규칙이 코드로 서 있어야 한다.
    expect(notificationLink("vendor_invite.received", { token: "t1" })).toBeNull();
  });

  it("이유가 남아 있다", () => {
    expect(UNLINKED_TEMPLATES["vendor_invite.received"]).toContain("토큰");
  });
});

describe("발송부가 링크에 필요한 참조를 실제로 싣는다", () => {
  /**
   * **레지스트리만 맞아서는 소용없다.** 발송부가 참조를 안 실으면 링크는 조용히
   * `null` 이 되고, 그건 누른 사람만 아는 고장이다. 그래서 발송 코드를 읽어 본다.
   */
  const read = (rel: string): string => readFileSync(path.join(ROOT, rel), "utf8");

  it("해지 알림이 예약 참조를 싣는다", () => {
    expect(read("lib/cancellation/actions.ts")).toContain("bookingId: context.bookingId");
  });

  it("안전거래 알림이 예약 참조를 싣는다", () => {
    expect(read("lib/escrow/actions.ts")).toMatch(/params:\s*\{\s*\.\.\.params,\s*bookingId\s*\}/);
  });

  it("결제 성공·실패 알림이 예약 참조를 싣는다 — 두 곳 다", () => {
    const source = read("lib/payments/charge.ts");
    const occurrences = source.match(/bookingId: context\.bookingId,/g) ?? [];

    expect(occurrences.length).toBeGreaterThanOrEqual(2);
  });

  it("**결제 멱등 열쇠가 payload 모양에 매이지 않는다** — 참조를 하나 더 실었다고 다시 보내면 안 된다", () => {
    // **주석이 아니라 열쇠를 만드는 줄을 본다** — 설명에 옛 표현이 남아 있어도
    // 통과해야 하고, 코드가 되돌아가면 떨어져야 한다.
    const dedupeLines = (read("lib/payments/charge.ts").match(/^\s*dedupeKey:.*$/gm) ?? []).join(
      "\n",
    );

    expect(dedupeLines.length, "dedupeKey 줄을 못 찾았다").toBeGreaterThan(0);
    expect(dedupeLines).not.toContain("JSON.stringify");
  });

  it("계약 알림이 계약 참조를 싣는다", () => {
    expect(read("lib/contract/actions.ts")).toMatch(/contractId/);
  });
});

describe("모르는 키는 던지지 않는다", () => {
  it("알림함 하나가 화면 전체를 500 으로 만들지 않는다", () => {
    expect(notificationLink("없는.키", { a: 1 })).toBeNull();
    expect(notificationLink(null, null)).toBeNull();
    expect(notificationLink("task_due.remind", null)?.href).toBe("/checklist");
  });
});
