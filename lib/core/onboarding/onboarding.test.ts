import { describe, expect, it } from "vitest";

import {
  INVITE_CODE_LENGTH,
  INVITE_TTL_HOURS,
  InviteActionSchema,
  ONBOARDING_QUESTIONS,
  OnboardingAnswerInputSchema,
  answerIssues,
  inviteBlocker,
  isOnboardingComplete,
  onboardingProgress,
  toAnswerJson,
  toCoupleFields,
  type OnboardingAnswer,
} from "../schemas/onboarding";

describe("온보딩 문항", () => {
  it("6문항이다 (F-C-01)", () => {
    expect(ONBOARDING_QUESTIONS).toHaveLength(6);
    expect(ONBOARDING_QUESTIONS).toEqual([
      "wedding_date",
      "region",
      "budget",
      "guest_count",
      "style",
      "stage",
    ]);
  });
});

describe("'미정'과 '아직 안 정함'은 다르다", () => {
  it("예식일 미정은 유효한 답변이다", () => {
    expect(() =>
      OnboardingAnswerInputSchema.parse({ question: "wedding_date", undecided: true, date: null }),
    ).not.toThrow();
  });

  it("미정인데 날짜가 있으면 거부한다 — 어느 쪽을 믿을지 알 수 없다", () => {
    expect(
      answerIssues({ question: "wedding_date", undecided: true, date: "2027-05-05" }),
    ).toHaveLength(1);
  });

  it("미정이 아닌데 날짜가 없으면 거부한다", () => {
    expect(answerIssues({ question: "wedding_date", undecided: false, date: null })).toHaveLength(1);
  });

  it("예산 0원은 미정이 아니다 — '예산을 안 쓴다'는 답이다", () => {
    expect(answerIssues({ question: "budget", undecided: false, totalBudget: 0 })).toEqual([]);
    expect(answerIssues({ question: "budget", undecided: true, totalBudget: 0 })).toHaveLength(1);
  });

  it("하객 수도 같은 규칙이다", () => {
    expect(answerIssues({ question: "guest_count", undecided: true, guestCount: null })).toEqual([]);
    expect(answerIssues({ question: "guest_count", undecided: false, guestCount: null })).toHaveLength(1);
  });

  it("스타일은 하나 이상 골라야 한다", () => {
    expect(answerIssues({ question: "style", styleTags: [] })).toHaveLength(1);
    expect(answerIssues({ question: "style", styleTags: ["modern"] })).toEqual([]);
  });

  it("정의되지 않은 스타일·단계를 거부한다", () => {
    expect(() =>
      OnboardingAnswerInputSchema.parse({ question: "style", styleTags: ["vintage"] }),
    ).toThrow();
    expect(() =>
      OnboardingAnswerInputSchema.parse({ question: "stage", prepStage: "done" }),
    ).toThrow();
  });

  it("날짜 형식을 강제한다", () => {
    expect(() =>
      OnboardingAnswerInputSchema.parse({ question: "wedding_date", undecided: false, date: "2027/05/05" }),
    ).toThrow();
  });
});

describe("toAnswerJson / toCoupleFields", () => {
  it("문항 키는 컬럼이 가지므로 answer_json 에서 뺀다", () => {
    expect(toAnswerJson({ question: "region", regionCode: "서울 강남" })).toEqual({
      regionCode: "서울 강남",
    });
  });

  it("답변을 couples 컬럼으로 옮긴다", () => {
    const answers: OnboardingAnswer[] = [
      { question: "wedding_date", undecided: false, date: "2027-05-05" },
      { question: "region", regionCode: "서울 강남" },
      { question: "budget", undecided: false, totalBudget: 40_000_000 },
      { question: "guest_count", undecided: false, guestCount: 200 },
      { question: "style", styleTags: ["modern", "natural"] },
      { question: "stage", prepStage: "venue_hunting" },
    ];

    expect(toCoupleFields(answers)).toEqual({
      wedding_date: "2027-05-05",
      region_code: "서울 강남",
      total_budget: 40_000_000,
      guest_count: 200,
      style_tags: ["modern", "natural"],
    });
  });

  it("미정 답변은 컬럼에서 null 이다 — 답변 여부는 answers 테이블이 갖는다", () => {
    const fields = toCoupleFields([
      { question: "wedding_date", undecided: true, date: null },
      { question: "budget", undecided: true, totalBudget: null },
    ]);

    expect(fields.wedding_date).toBeNull();
    expect(fields.total_budget).toBeNull();
  });

  it("답하지 않은 문항도 null 이다 — 구분은 행의 존재로 한다", () => {
    expect(toCoupleFields([])).toEqual({
      wedding_date: null,
      region_code: null,
      total_budget: null,
      guest_count: null,
      style_tags: [],
    });
  });
});

describe("진행률 — 뒤로 가기를 허용하므로 순서와 무관하다", () => {
  it("답한 개수로 센다", () => {
    const progress = onboardingProgress(["region", "budget"]);

    expect(progress).toMatchObject({ answered: 2, total: 6, percent: 33 });
  });

  it("다음 문항은 답하지 않은 것 중 첫 번째다", () => {
    expect(onboardingProgress(["wedding_date"]).nextQuestion).toBe("region");
    expect(onboardingProgress(["region"]).nextQuestion).toBe("wedding_date");
  });

  it("중복 답변을 두 번 세지 않는다", () => {
    expect(onboardingProgress(["region", "region"]).answered).toBe(1);
  });

  it("다 채우면 완료이고 다음 문항이 없다", () => {
    const all = [...ONBOARDING_QUESTIONS];

    expect(isOnboardingComplete(all)).toBe(true);
    expect(onboardingProgress(all).nextQuestion).toBeNull();
    expect(onboardingProgress(all).percent).toBe(100);
  });

  it("하나라도 빠지면 완료가 아니다", () => {
    expect(isOnboardingComplete(["wedding_date", "region", "budget", "guest_count", "style"])).toBe(
      false,
    );
  });
});

describe("초대 코드 (F-C-02)", () => {
  const now = "2026-08-09T00:00:00Z";

  it("코드는 8자이고 헷갈리는 글자를 뺀다", () => {
    expect(INVITE_CODE_LENGTH).toBe(8);
    expect(() => InviteActionSchema.parse({ action: "accept", code: "ABCD2345" })).not.toThrow();
    // O·0·I·1 은 알파벳에 없다
    expect(() => InviteActionSchema.parse({ action: "accept", code: "ABCD0O1I" })).toThrow();
  });

  it("소문자를 대문자로 정규화한다 — 사람이 옮겨 적는 코드다", () => {
    const parsed = InviteActionSchema.parse({ action: "accept", code: " abcd2345 " });

    expect(parsed.action === "accept" && parsed.code).toBe("ABCD2345");
  });

  it("길이가 다르면 거부한다", () => {
    expect(() => InviteActionSchema.parse({ action: "accept", code: "ABCD234" })).toThrow();
  });

  it("만료 기간이 정해져 있다", () => {
    expect(INVITE_TTL_HOURS).toBe(24);
  });

  it("쓸 수 있는 코드는 막지 않는다", () => {
    expect(
      inviteBlocker({ expiresAt: "2026-08-10T00:00:00Z", acceptedBy: null }, now),
    ).toBeNull();
  });

  it("이미 쓴 코드를 막는다", () => {
    const blocker = inviteBlocker(
      { expiresAt: "2026-08-10T00:00:00Z", acceptedBy: "user-1" },
      now,
    );

    expect(blocker?.code).toBe("ALREADY_USED");
  });

  it("만료된 코드를 막는다", () => {
    const blocker = inviteBlocker({ expiresAt: "2026-08-08T23:59:59Z", acceptedBy: null }, now);

    expect(blocker?.code).toBe("EXPIRED");
  });

  it("만료 시각 정각은 만료로 본다 (경계)", () => {
    expect(inviteBlocker({ expiresAt: now, acceptedBy: null }, now)?.code).toBe("EXPIRED");
  });

  it("사용 여부를 만료보다 먼저 본다 — 더 구체적인 사유다", () => {
    const blocker = inviteBlocker(
      { expiresAt: "2026-08-08T00:00:00Z", acceptedBy: "user-1" },
      now,
    );

    expect(blocker?.code).toBe("ALREADY_USED");
  });
});
