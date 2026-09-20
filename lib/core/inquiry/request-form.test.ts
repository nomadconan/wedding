import { describe, expect, it } from "vitest";

import {
  EMPTY_INQUIRY_FORM,
  INQUIRY_NOTE_MAX,
  inquiryDraftOf,
  inquiryFormProblem,
  optionalCount,
  sentSummary,
  type InquiryFormState,
} from "./request-form";

const TODAY = "2026-09-18";

const form = (overrides: Partial<InquiryFormState> = {}): InquiryFormState => ({
  ...EMPTY_INQUIRY_FORM,
  vendorIds: ["v1"],
  eventDate: "2027-05-15",
  categories: ["hall"],
  ...overrides,
});

describe("선택 입력은 0 이 아니라 null 이다", () => {
  it("빈 칸은 null — 하객 0명과 '아직 모른다' 는 다르다", () => {
    for (const blank of ["", "   "]) expect(optionalCount(blank)).toBeNull();
  });

  it("0 은 0 으로 남는다", () => {
    expect(optionalCount("0")).toBe(0);
  });

  it("숫자가 아니면 null — **지어낸 0 이 견적 조건이 되면 안 된다**", () => {
    for (const bad of ["abc", "-1", "1.5", "1,000"]) expect(optionalCount(bad)).toBeNull();
  });
});

describe("폼 → 본문", () => {
  it("빈 선택 입력을 null 로 접는다", () => {
    const draft = inquiryDraftOf(form());

    expect(draft.guestCount).toBeNull();
    expect(draft.regionCode).toBeNull();
    expect(draft.budgetTotal).toBeNull();
    expect(draft.note).toBeNull();
  });

  it("**업체 중복을 걷는다** — 화면이 3곳이라 세고 서버가 2곳으로 줄이면 상한이 갈린다", () => {
    expect(inquiryDraftOf(form({ vendorIds: ["v1", "v1", "v2"] })).vendorIds).toEqual(["v1", "v2"]);
  });

  it("카테고리 중복도 걷는다", () => {
    expect(inquiryDraftOf(form({ categories: ["hall", "hall"] })).categories).toEqual(["hall"]);
  });

  it("앞뒤 공백을 지운다", () => {
    const draft = inquiryDraftOf(form({ note: "  주차 되나요  ", regionCode: " seoul-gangnam " }));

    expect(draft.note).toBe("주차 되나요");
    expect(draft.regionCode).toBe("seoul-gangnam");
  });
});

describe("보낼 수 있는가 — 서버와 같은 순서로 본다", () => {
  const opts = { maxTargets: 5, today: TODAY };

  it("다 채우면 막지 않는다", () => {
    expect(inquiryFormProblem(form(), opts)).toBeNull();
  });

  it("날짜가 없으면 날짜부터 말한다", () => {
    expect(inquiryFormProblem(form({ eventDate: "" }), opts)).toContain("예식일");
  });

  it("카테고리가 없으면 막는다", () => {
    expect(inquiryFormProblem(form({ categories: [] }), opts)).toContain("견적이 필요한지");
  });

  it("**지난 날짜는 막는다**", () => {
    expect(inquiryFormProblem(form({ eventDate: "2026-09-17" }), opts)).toContain("지난 날짜");
  });

  // ── 경계값 ────────────────────────────────────────────────────────────────
  it("**오늘은 지난 날짜가 아니다** — 경계일 당일이 어느 쪽인가", () => {
    expect(inquiryFormProblem(form({ eventDate: TODAY }), opts)).toBeNull();
  });

  it("업체를 한 곳도 안 고르면 막는다", () => {
    expect(inquiryFormProblem(form({ vendorIds: [] }), opts)).toContain("한 곳 이상");
  });

  it("상한까지는 보낼 수 있다", () => {
    const five = ["v1", "v2", "v3", "v4", "v5"];

    expect(inquiryFormProblem(form({ vendorIds: five }), opts)).toBeNull();
  });

  it("**상한을 한 곳 넘기면 막고 상한을 말한다**", () => {
    const six = ["v1", "v2", "v3", "v4", "v5", "v6"];

    expect(inquiryFormProblem(form({ vendorIds: six }), opts)).toContain("5곳");
  });

  it("**중복은 상한에 세지 않는다** — 같은 곳을 두 번 골라도 한 곳이다", () => {
    const dupes = ["v1", "v1", "v1", "v1", "v1", "v1"];

    expect(inquiryFormProblem(form({ vendorIds: dupes }), opts)).toBeNull();
  });

  it("상한이 1이면 한 곳만 — 설정이 없을 때의 보수적 기본값(effectiveMaxTargets)", () => {
    const one = { maxTargets: 1, today: TODAY };

    expect(inquiryFormProblem(form({ vendorIds: ["v1"] }), one)).toBeNull();
    expect(inquiryFormProblem(form({ vendorIds: ["v1", "v2"] }), one)).toContain("1곳");
  });

  it("메모 상한을 넘기면 막는다", () => {
    const long = "가".repeat(INQUIRY_NOTE_MAX + 1);

    expect(inquiryFormProblem(form({ note: long }), opts)).toContain(String(INQUIRY_NOTE_MAX));
  });

  it("메모가 상한에 딱 맞으면 막지 않는다", () => {
    expect(inquiryFormProblem(form({ note: "가".repeat(INQUIRY_NOTE_MAX) }), opts)).toBeNull();
  });
});

describe("보낸 뒤 — 정직하게 센다", () => {
  it("고른 만큼 갔으면 그 수만 말한다", () => {
    expect(sentSummary({ selected: 3, targetCount: 3 })).toContain("3곳에 문의를 보냈어요");
  });

  it("**덜 갔으면 고른 수와 간 수를 둘 다 말한다** — 간 적 없는 곳에 갔다고 적지 않는다", () => {
    const text = sentSummary({ selected: 5, targetCount: 3 });

    expect(text).toContain("5곳");
    expect(text).toContain("3곳");
    expect(text).toContain("승인된 업체가 아니라");
  });

  it("한 곳도 못 갔으면 그것도 말한다", () => {
    expect(sentSummary({ selected: 2, targetCount: 0 })).toContain("0곳");
  });
});
