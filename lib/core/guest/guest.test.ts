import { describe, expect, it } from "vitest";

import {
  GUEST_ISSUE_NOTE,
  GUEST_NAME_MAX_LENGTH,
  GUEST_PARTY_SIZE_MAX,
  GUEST_PRIVACY_NOTICE,
  GUEST_SIDES,
  INVITE_STATE_NOTE,
  NO_ESTIMATE_NOTE,
  RSVP_STATUSES,
  SEATING_ISSUE_NOTE,
  canIssueInvite,
  countGuests,
  favorEstimate,
  favorNote,
  guestCountGap,
  guestIssue,
  inviteState,
  parseLayout,
  seatingIssues,
  unseatedGuestIds,
  type GuestLike,
} from "./guest";

/**
 * 하객·좌석 (S7-09)
 *
 * **여기서 붙잡는 것은 "세지 않은 것과 0" 이다.** 답례품 수량은 미응답이 남은 동안
 * 확정될 수 없고, 하나의 숫자로 답하면 사용자는 그것을 확정으로 읽는다.
 */

const guest = (over: Partial<GuestLike> = {}): GuestLike => ({
  rsvpStatus: "pending",
  partySize: 1,
  ...over,
});

describe("값 집합", () => {
  it("응답 상태 셋을 가른다 — 미응답과 불참을 합치지 않는다", () => {
    expect(RSVP_STATUSES).toEqual(["pending", "attending", "declined"]);
  });

  it("**`unassigned` 를 둔다** — 모르는 것을 한쪽으로 밀어 넣지 않는다", () => {
    expect(GUEST_SIDES).toContain("unassigned");
  });
});

describe("집계", () => {
  it("동반 인원까지 센다", () => {
    const counts = countGuests([
      guest({ rsvpStatus: "attending", partySize: 2 }),
      guest({ rsvpStatus: "attending", partySize: 1 }),
    ]);

    expect(counts).toMatchObject({ entries: 2, attending: 3, pending: 0, declined: 0 });
  });

  it("**불참의 동반 인원은 세지 않는다** — 안 오는 사람의 동반자도 안 온다", () => {
    const counts = countGuests([guest({ rsvpStatus: "declined", partySize: 4 })]);

    expect(counts.attending).toBe(0);
    expect(counts.declined).toBe(4);
    expect(counts.maxPossible).toBe(0);
  });

  it("**상한은 참석 + 미응답이다** — 불참은 상한에도 안 들어간다", () => {
    const counts = countGuests([
      guest({ rsvpStatus: "attending", partySize: 2 }),
      guest({ rsvpStatus: "pending", partySize: 3 }),
      guest({ rsvpStatus: "declined", partySize: 5 }),
    ]);

    expect(counts.maxPossible).toBe(5);
  });

  it("이상한 인원 수는 0으로 센다 (음수·소수가 합계를 망가뜨리지 않는다)", () => {
    const counts = countGuests([guest({ rsvpStatus: "attending", partySize: -3 })]);

    expect(counts.attending).toBe(0);
  });

  it("빈 명단은 전부 0이다", () => {
    expect(countGuests([])).toEqual({
      entries: 0,
      attending: 0,
      declined: 0,
      pending: 0,
      maxPossible: 0,
    });
  });

  it("**이름을 받지 않는다** — 계산에 이름이 끼면 흘러갈 길이 생긴다(§7.3)", () => {
    // 입력 타입이 rsvpStatus·partySize 뿐이라는 것을 값으로 확인한다.
    const counts = countGuests([{ rsvpStatus: "attending", partySize: 1 }]);

    expect(JSON.stringify(counts)).not.toContain("name");
  });
});

describe("답례품 수량 — 하나의 숫자로 답하지 않는다", () => {
  it("확정·상한·미응답 셋을 낸다", () => {
    const estimate = favorEstimate(
      countGuests([
        guest({ rsvpStatus: "attending", partySize: 2 }),
        guest({ rsvpStatus: "pending", partySize: 3 }),
      ]),
    );

    expect(estimate).toEqual({ confirmed: 2, upperBound: 5, pending: 3, settled: false });
  });

  it("응답이 다 오면 상한과 확정이 같다", () => {
    const estimate = favorEstimate(countGuests([guest({ rsvpStatus: "attending", partySize: 2 })]));

    expect(estimate.settled).toBe(true);
    expect(estimate.confirmed).toBe(estimate.upperBound);
  });

  it("**참석 0 · 미응답 있음 → '아직 답이 없다' 로 적는다**", () => {
    const counts = countGuests([guest({ rsvpStatus: "pending", partySize: 2 })]);
    const note = favorNote(favorEstimate(counts), counts.entries);

    expect(note).toContain("응답을 기다리는 중");
    expect(note).toContain("최대 2명");
  });

  it("**참석 0 · 응답 완료 → '확정된 0' 이라고 적는다**", () => {
    const counts = countGuests([guest({ rsvpStatus: "declined", partySize: 2 })]);
    const note = favorNote(favorEstimate(counts), counts.entries);

    expect(note).toContain("확정된 값");
    expect(note).not.toContain("기다리는 중");
  });

  it("명단이 비면 그 사실을 먼저 말한다", () => {
    const counts = countGuests([]);

    expect(favorNote(favorEstimate(counts), counts.entries)).toContain("명단이 비어 있어요");
  });
});

describe("예상 하객 수와의 대조", () => {
  it("예상값이 있으면 차이를 낸다", () => {
    const counts = countGuests([guest({ rsvpStatus: "attending", partySize: 150 })]);

    expect(guestCountGap({ estimate: 200, counts })).toEqual({
      known: true,
      estimate: 200,
      maxPossible: 150,
      diff: -50,
    });
  });

  it("**예상값이 없으면 0과 견주지 않는다** — 그건 설정이 빈 것이지 사실이 아니다", () => {
    const counts = countGuests([guest({ rsvpStatus: "attending", partySize: 1 })]);

    expect(guestCountGap({ estimate: null, counts })).toEqual({
      known: false,
      reason: "no_estimate",
    });
    expect(guestCountGap({ estimate: 0, counts }).known).toBe(false);
    expect(NO_ESTIMATE_NOTE).toContain("0명과 다릅니다");
  });
});

describe("좌석 배치 초안", () => {
  const layout = {
    tables: [
      { id: "t1", name: "1번", capacity: 2, guestIds: ["g1", "g2"] },
      { id: "t2", name: "2번", capacity: 2, guestIds: ["g3"] },
    ],
  };

  it("모양이 틀려도 읽는다 — 오타 하나로 화면이 죽지 않는다", () => {
    expect(parseLayout(null)).toEqual({ tables: [] });
    expect(parseLayout({ tables: "문자열" })).toEqual({ tables: [] });
    expect(parseLayout({ tables: [{ name: "id 없음" }] })).toEqual({ tables: [] });
  });

  it("정원 초과를 **막지 않고 알린다**", () => {
    const issues = seatingIssues({
      layout: { tables: [{ id: "t1", name: "1번", capacity: 2, guestIds: ["a", "b", "c"] }] },
      guestIds: ["a", "b", "c"],
    });

    expect(issues).toContainEqual({ code: "over_capacity", tableId: "t1", assigned: 3, capacity: 2 });
  });

  it("**같은 하객이 두 테이블에 앉으면 알린다** — 인쇄하면 되돌릴 수 없다", () => {
    const issues = seatingIssues({
      layout: {
        tables: [
          { id: "t1", name: "1번", capacity: 5, guestIds: ["a"] },
          { id: "t2", name: "2번", capacity: 5, guestIds: ["a"] },
        ],
      },
      guestIds: ["a"],
    });

    expect(issues.some((issue) => issue.code === "duplicate_guest")).toBe(true);
  });

  it("명단에서 지워진 하객이 배정에 남아 있으면 알린다", () => {
    const issues = seatingIssues({ layout, guestIds: ["g1", "g2"] });

    expect(issues).toContainEqual({ code: "unknown_guest", guestId: "g3" });
  });

  it("정원을 모르면(0) 초과로 보지 않는다", () => {
    const issues = seatingIssues({
      layout: { tables: [{ id: "t1", name: "1번", capacity: 0, guestIds: ["a", "b", "c"] }] },
      guestIds: ["a", "b", "c"],
    });

    expect(issues).toEqual([]);
  });

  it("**앉지 않은 하객은 계산한다** — 저장하지 않는다", () => {
    expect(unseatedGuestIds({ layout, guestIds: ["g1", "g2", "g3", "g4"] })).toEqual(["g4"]);
  });

  it("모든 사유에 설명이 있다", () => {
    for (const code of ["over_capacity", "duplicate_guest", "unknown_guest"] as const) {
      expect(SEATING_ISSUE_NOTE[code].length).toBeGreaterThan(0);
    }
  });

  it("**배정에 이름을 담지 않는다** — id 만 갖는다", () => {
    expect(JSON.stringify(layout)).not.toContain("name\":\"홍");
    expect(Object.keys(layout.tables[0])).toEqual(["id", "name", "capacity", "guestIds"]);
  });
});

describe("초대 링크 — 만료를 예식일이 정한다", () => {
  it("예식일 전에는 열려 있다", () => {
    expect(inviteState({ weddingDate: "2026-10-10", hasToken: true, today: "2026-08-21" })).toBe(
      "live",
    );
  });

  it("**예식일 당일까지 받는다**", () => {
    expect(inviteState({ weddingDate: "2026-10-10", hasToken: true, today: "2026-10-10" })).toBe(
      "live",
    );
    expect(inviteState({ weddingDate: "2026-10-10", hasToken: true, today: "2026-10-11" })).toBe(
      "closed",
    );
  });

  it("**예식일이 없으면 링크를 만들지 않는다** — 언제까지 받을지 모르는 채로 여는 것은 영구 공개다", () => {
    expect(inviteState({ weddingDate: null, hasToken: true, today: "2026-08-21" })).toBe(
      "no_wedding_date",
    );
    expect(canIssueInvite(null)).toBe(false);
    expect(canIssueInvite("2026-10-10")).toBe(true);
  });

  it("발급 전과 만료를 가른다 — 다음에 할 일이 다르다", () => {
    expect(inviteState({ weddingDate: "2026-10-10", hasToken: false, today: "2026-08-21" })).toBe(
      "not_issued",
    );
  });

  it("모든 상태에 설명이 있다", () => {
    for (const state of ["live", "closed", "no_wedding_date", "not_issued"] as const) {
      expect(INVITE_STATE_NOTE[state].length).toBeGreaterThan(0);
    }
  });

  it("타임스탬프가 와도 날짜만 견준다", () => {
    expect(
      inviteState({ weddingDate: "2026-10-10T00:00:00.000Z", hasToken: true, today: "2026-10-10" }),
    ).toBe("live");
  });
});

describe("입력 검증", () => {
  it("이름이 비면 막는다", () => {
    expect(guestIssue({ name: "  ", partySize: 1, side: "groom" })).toBe("empty_name");
  });

  it("길이 상한이 있다", () => {
    expect(
      guestIssue({ name: "가".repeat(GUEST_NAME_MAX_LENGTH), partySize: 1, side: "groom" }),
    ).toBeNull();
    expect(
      guestIssue({ name: "가".repeat(GUEST_NAME_MAX_LENGTH + 1), partySize: 1, side: "groom" }),
    ).toBe("name_too_long");
  });

  it("인원 수 경계를 본다", () => {
    expect(guestIssue({ name: "가", partySize: 0, side: "groom" })).toBe("bad_party_size");
    expect(guestIssue({ name: "가", partySize: 1, side: "groom" })).toBeNull();
    expect(guestIssue({ name: "가", partySize: GUEST_PARTY_SIZE_MAX, side: "groom" })).toBeNull();
    expect(guestIssue({ name: "가", partySize: GUEST_PARTY_SIZE_MAX + 1, side: "groom" })).toBe(
      "bad_party_size",
    );
    expect(guestIssue({ name: "가", partySize: 1.5, side: "groom" })).toBe("bad_party_size");
  });

  it("어휘 밖 side 를 막는다", () => {
    expect(guestIssue({ name: "가", partySize: 1, side: "없는쪽" })).toBe("bad_side");
  });

  it("모든 사유에 설명이 있다", () => {
    for (const issue of ["empty_name", "name_too_long", "bad_party_size", "bad_side"] as const) {
      expect(GUEST_ISSUE_NOTE[issue].length).toBeGreaterThan(0);
    }
  });
});

describe("문구", () => {
  it("**누가 이름을 볼 수 있는지 화면이 적는다**", () => {
    expect(GUEST_PRIVACY_NOTICE).toContain("플래너");
    expect(GUEST_PRIVACY_NOTICE).toContain("업체에는 인원 수만");
  });
});
