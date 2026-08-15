import { describe, expect, it } from "vitest";

import {
  POSTCHECK_FALLBACK,
  buildPostcheckFeedback,
  checkResponse,
  collectNumbers,
  extractNameCandidates,
  extractNumericTokens,
} from "./postcheck";

const vendorResult = {
  ranking: { code: "condition_fit" },
  rows: [
    { vendorName: "로컬 데모 웨딩홀", basePrice: 12_000_000, regionCode: "강남" },
    { vendorName: "두번째 웨딩홀", basePrice: 9_500_000, regionCode: "강남" },
  ],
  total: 2,
};

describe("수치 토큰 — 단위가 붙은 것만 본다", () => {
  it("금액·건수·백분율을 뽑는다", () => {
    const tokens = extractNumericTokens("12,000,000원이고 2건이며 5% 입니다.");

    expect(tokens.map((token) => token.kind)).toEqual(["amount", "count", "percent"]);
    expect(tokens[0].candidates).toContain(12_000_000);
  });

  it("목록 번호를 수치로 세지 않는다 — 사실 주장이 아닌 것을 반려하면 검사를 끄고 싶어진다", () => {
    expect(extractNumericTokens("1. 먼저 예산을 정해요\n2. 그다음 홀을 봐요")).toHaveLength(0);
  });

  it("만·억 표기를 값으로 푼다", () => {
    const [token] = extractNumericTokens("1200만원");

    expect(token.candidates).toContain(12_000_000);
  });

  it("백분율은 bp 로도 대조한다 — 우리 데이터는 요율을 bp 정수로 갖는다", () => {
    const [token] = extractNumericTokens("5% 입니다");

    expect(token.candidates).toEqual([5, 500]);
  });
});

describe("툴 결과에서 허용 수치를 모은다", () => {
  it("숫자와 문자열 안의 숫자를 모두 모은다", () => {
    const numbers = collectNumbers({ price: 100, date: "2027-03-14" });

    expect([...numbers]).toEqual(expect.arrayContaining([100, 2027, 3, 14]));
  });
});

describe("고유명 — 따옴표 안의 것만 대조한다", () => {
  it("작은따옴표로 감싼 이름을 뽑는다", () => {
    expect(extractNameCandidates("'로컬 데모 웨딩홀'을 추천").map((name) => name.raw)).toEqual([
      "로컬 데모 웨딩홀",
    ]);
  });
});

describe("응답 대조 — 툴 결과 위에 서 있는가", () => {
  it("툴 결과에 있는 값만 쓴 응답은 통과한다", () => {
    const verdict = checkResponse({
      text: "'로컬 데모 웨딩홀'은 12,000,000원이에요. 조건 부합도(condition_fit) 순으로 보여드렸어요.",
      toolResults: [vendorResult],
      rankingBasis: [{ code: "condition_fit", label: "조건 부합도" }],
    });

    expect(verdict.ok).toBe(true);
  });

  it("**조회하지 않은 시세를 말하면 걸린다** — 이 가드레일이 막으려는 가장 현실적인 실패다", () => {
    const verdict = checkResponse({
      text: "보통 스드메는 3000000원쯤 해요.",
      toolResults: [],
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.violations[0].kind).toBe("number");
    expect(verdict.violations[0].sentence).toContain("스드메");
  });

  it("툴 결과에 없는 금액을 걸러낸다", () => {
    const verdict = checkResponse({
      text: "'로컬 데모 웨딩홀'은 8,000,000원이에요. (condition_fit)",
      toolResults: [vendorResult],
      rankingBasis: [{ code: "condition_fit", label: "조건 부합도" }],
    });

    expect(verdict.violations.map((violation) => violation.kind)).toEqual(["number"]);
  });

  it("**모델이 더한 합계를 걸러낸다** — AI 는 산술을 하지 않는다", () => {
    const verdict = checkResponse({
      text: "두 곳을 합치면 21,500,000원이에요.",
      toolResults: [vendorResult],
    });

    expect(verdict.ok).toBe(false);
  });

  it("툴 결과에 없는 업체 이름을 걸러낸다", () => {
    const verdict = checkResponse({
      text: "'있지도 않은 웨딩홀'이 좋아요. (condition_fit)",
      toolResults: [vendorResult],
      rankingBasis: [{ code: "condition_fit", label: "조건 부합도" }],
    });

    expect(verdict.violations.some((violation) => violation.kind === "name")).toBe(true);
  });

  it("사용자가 말한 숫자를 되읽는 것은 지어낸 값이 아니다", () => {
    const verdict = checkResponse({
      text: "말씀하신 300명 기준으로 찾아볼게요.",
      toolResults: [],
      userText: "하객 300명 정도예요",
    });

    expect(verdict.ok).toBe(true);
  });

  it("업체를 부르면서 정렬 기준을 빼면 반려한다 (D-25 · §2.2)", () => {
    const verdict = checkResponse({
      text: "'로컬 데모 웨딩홀'이 12,000,000원이에요.",
      toolResults: [vendorResult],
      rankingBasis: [{ code: "condition_fit", label: "조건 부합도" }],
    });

    expect(verdict.violations.map((violation) => violation.kind)).toEqual(["ranking_basis"]);
  });

  it("기준 코드 대신 한국어 라벨을 적어도 통과한다", () => {
    const verdict = checkResponse({
      text: "'로컬 데모 웨딩홀'이 12,000,000원이에요. 조건 부합도 순입니다.",
      toolResults: [vendorResult],
      rankingBasis: [{ code: "condition_fit", label: "조건 부합도" }],
    });

    expect(verdict.ok).toBe(true);
  });

  it("순서를 정한 툴이 없으면 기준 코드를 요구하지 않는다", () => {
    const verdict = checkResponse({
      text: "'로컬 데모 웨딩홀'을 담아 두셨어요.",
      toolResults: [{ cart: [{ vendorName: "로컬 데모 웨딩홀" }] }],
    });

    expect(verdict.ok).toBe(true);
  });

  it("숫자도 이름도 없는 안내 문장은 통과한다 — 빈 결과 안내가 반려되면 안 된다", () => {
    const verdict = checkResponse({
      text: "이 지역·카테고리는 아직 비교 기준이 없어요. 조건으로 직접 찾아볼까요?",
      toolResults: [{ status: "empty", reason: "no_sample" }],
    });

    expect(verdict.ok).toBe(true);
  });
});

describe("재생성 피드백 — 무엇이 어긋났는지 적는다", () => {
  it("어긋난 토큰을 그대로 싣는다", () => {
    const feedback = buildPostcheckFeedback([
      { kind: "number", token: "8,000,000원", sentence: "" },
      { kind: "ranking_basis", token: "condition_fit", sentence: "" },
    ]);

    expect(feedback).toContain("8,000,000원");
    expect(feedback).toContain("condition_fit");
  });

  it("재실패 시 대체 문장은 수치를 담지 않는다", () => {
    expect(POSTCHECK_FALLBACK).not.toMatch(/\d/);
  });
});
