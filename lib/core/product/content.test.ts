import { describe, expect, it } from "vitest";

import {
  PRODUCT_DESCRIPTION_MAX,
  PRODUCT_DESCRIPTION_VERSION,
  PRODUCT_SUMMARY_MAX,
  descriptionBlocks,
  descriptionSource,
  isProductDescription,
  productContentProblems,
  productContentSuggestions,
  toProductDescription,
} from "./content";

describe("본문 봉투", () => {
  it("원문만 담고 판본을 붙인다 — 블록을 저장하지 않는다", () => {
    const envelope = toProductDescription("## 구성\n\n스냅 200컷");

    expect(envelope).toEqual({ v: PRODUCT_DESCRIPTION_VERSION, source: "## 구성\n\n스냅 200컷" });
    // 계산 가능한 값(blocks)이 봉투에 섞이지 않는다.
    expect(Object.keys(envelope!).sort()).toEqual(["source", "v"]);
  });

  it("빈 본문은 봉투를 만들지 않는다", () => {
    expect(toProductDescription(null)).toBeNull();
    expect(toProductDescription("")).toBeNull();
    expect(toProductDescription("   \n  ")).toBeNull();
  });

  it("모르는 모양은 본문 없음으로 다룬다", () => {
    expect(isProductDescription(null)).toBe(false);
    expect(isProductDescription("문자열")).toBe(false);
    expect(isProductDescription({ source: "판본이 없다" })).toBe(false);
    expect(isProductDescription({ v: 1 })).toBe(false);
    expect(isProductDescription([{ kind: "paragraph" }])).toBe(false);
    expect(descriptionSource({ blocks: [] })).toBeNull();
  });

  it("옛 판본도 읽는다 — 판본이 올라가도 기존 행이 사라지지 않는다", () => {
    expect(descriptionSource({ v: 0, source: "옛 글" })).toBe("옛 글");
  });

  it("블록은 저장값이 아니라 원문에서 계산된다", () => {
    const envelope = toProductDescription("## 제목\n\n본문 한 줄");
    const blocks = descriptionBlocks(envelope);

    expect(blocks[0]).toMatchObject({ kind: "heading", level: 2 });
    expect(blocks[1]?.kind).toBe("paragraph");
    expect(descriptionBlocks(null)).toEqual([]);
  });

  it("본문 속 HTML 은 블록이 되지 않는다 — 글자로 남는다(D-97)", () => {
    const blocks = descriptionBlocks(toProductDescription("<script>alert(1)</script>"));
    const serialized = JSON.stringify(blocks);

    // 문자열로 남아 있을 뿐, 어떤 블록도 '실행되는 모양'을 갖지 않는다.
    expect(serialized).toContain("script");
    expect(blocks.every((block) => block.kind !== "heading" || !block.text.includes("<"))).toBe(true);
  });
});

describe("입력 판정 — 가격 회피", () => {
  it("한 줄 소개의 가격 회피 문구를 막는다", () => {
    const problems = productContentProblems({ summary: "가격은 별도 문의 주세요" });

    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ field: "summary", code: "PRICE_EVASION" });
  });

  it("본문의 가격 회피 문구도 막는다 — 총액 강제가 본문으로 새지 않는다", () => {
    const problems = productContentProblems({ descriptionSource: "자세한 금액은 상담후결정합니다" });

    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ field: "description", code: "PRICE_EVASION" });
  });

  it("띄어쓰기로 우회할 수 없다", () => {
    expect(productContentProblems({ summary: "별 도 문 의" })).toHaveLength(1);
  });

  it("정상 문구는 통과한다 — 늘 거절하는 검사가 아니다", () => {
    expect(
      productContentProblems({
        summary: "평일 낮 예식을 위한 단독홀 패키지",
        descriptionSource: "## 포함\n\n- 대관 4시간\n- 기본 데코",
      }),
    ).toEqual([]);
  });
});

describe("입력 판정 — 연락처", () => {
  it("휴대전화 번호를 막는다", () => {
    const problems = productContentProblems({ descriptionSource: "문의는 010-1234-5678" });

    expect(problems[0]).toMatchObject({ field: "description", code: "CONTACT_INFO" });
    expect(problems[0]?.message).toContain("전화번호");
  });

  it("이메일을 막는다", () => {
    const problems = productContentProblems({ summary: "예약 sales@studio.co.kr" });

    expect(problems[0]).toMatchObject({ code: "CONTACT_INFO" });
    expect(problems[0]?.message).toContain("이메일");
  });

  it("계좌번호를 막는다", () => {
    const problems = productContentProblems({ descriptionSource: "국민은행 123456-78-901234 로 입금" });

    expect(problems.some((p) => p.code === "CONTACT_INFO")).toBe(true);
  });

  it("걸린 값 자체를 메시지에 담지 않는다", () => {
    const problems = productContentProblems({ descriptionSource: "010-1234-5678" });

    expect(problems[0]?.message).not.toContain("010-1234-5678");
  });

  it("같은 종류가 여러 번 나와도 한 번만 말한다", () => {
    const problems = productContentProblems({
      descriptionSource: "010-1111-2222 또는 010-3333-4444",
    });

    expect(problems.filter((p) => p.code === "CONTACT_INFO")).toHaveLength(1);
  });

  it("숫자가 있다고 전부 막지 않는다 — 수용 인원·구성은 통과한다", () => {
    expect(
      productContentProblems({ descriptionSource: "하객 200명까지 가능하고 스냅 300컷을 드려요." }),
    ).toEqual([]);
  });
});

describe("입력 판정 — 길이", () => {
  it("한 줄 소개 상한을 넘기면 막는다", () => {
    const problems = productContentProblems({ summary: "가".repeat(PRODUCT_SUMMARY_MAX + 1) });

    expect(problems).toEqual([
      { field: "summary", code: "TOO_LONG", message: expect.stringContaining(String(PRODUCT_SUMMARY_MAX)) },
    ]);
  });

  it("상한 경계값은 통과한다", () => {
    expect(productContentProblems({ summary: "가".repeat(PRODUCT_SUMMARY_MAX) })).toEqual([]);
    expect(
      productContentProblems({ descriptionSource: "나".repeat(PRODUCT_DESCRIPTION_MAX) }),
    ).toEqual([]);
  });

  it("길이가 넘치면 다른 사유를 겹쳐 말하지 않는다", () => {
    const problems = productContentProblems({
      summary: `별도문의 ${"가".repeat(PRODUCT_SUMMARY_MAX)}`,
    });

    expect(problems).toHaveLength(1);
    expect(problems[0]?.code).toBe("TOO_LONG");
  });

  it("비어 있는 것은 문제가 아니다 — 게시 조건이 아니라 권유다", () => {
    expect(productContentProblems({})).toEqual([]);
    expect(productContentProblems({ summary: null, descriptionSource: null })).toEqual([]);
    expect(productContentProblems({ summary: "   " })).toEqual([]);
  });
});

describe("완성도 권유", () => {
  it("비어 있으면 셋을 권한다", () => {
    const codes = productContentSuggestions({}).map((s) => s.code);

    expect(codes).toEqual(["SUMMARY_MISSING", "DESCRIPTION_MISSING", "PHOTO_MISSING"]);
  });

  it("다 채우면 아무것도 권하지 않는다 — 늘 잔소리하는 목록이 아니다", () => {
    expect(
      productContentSuggestions({
        summary: "단독홀 패키지",
        description: toProductDescription("본문"),
        photoCount: 3,
        photosMissingAltText: 0,
      }),
    ).toEqual([]);
  });

  it("사진이 있으면 설명 없는 장수를 센다", () => {
    const suggestions = productContentSuggestions({
      summary: "소개",
      description: toProductDescription("본문"),
      photoCount: 3,
      photosMissingAltText: 2,
    });

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]?.code).toBe("ALT_TEXT_MISSING");
    expect(suggestions[0]?.message).toContain("2장");
  });

  it("사진이 없으면 설명 권유를 겹쳐 말하지 않는다", () => {
    const codes = productContentSuggestions({ photoCount: 0, photosMissingAltText: 5 }).map(
      (s) => s.code,
    );

    expect(codes).toContain("PHOTO_MISSING");
    expect(codes).not.toContain("ALT_TEXT_MISSING");
  });
});
