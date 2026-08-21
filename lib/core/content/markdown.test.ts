import { describe, expect, it } from "vitest";

import {
  TOC_MIN_HEADINGS,
  anchorOf,
  excerpt,
  isInternalHref,
  parseInline,
  parseMarkdown,
  tableOfContents,
} from "./markdown";

/**
 * 본문 파서 (S7-10)
 *
 * **여기서 지켜야 하는 것은 예쁨이 아니라 안전과 정직이다.** 태그가 실행되지 않는가,
 * 쓴 글자가 사라지지 않는가, 목차 링크가 겹치지 않는가.
 */

describe("인라인 — 굵게·링크", () => {
  it("평범한 줄은 글자 하나다", () => {
    expect(parseInline("총액을 공개합니다")).toEqual([
      { kind: "text", text: "총액을 공개합니다" },
    ]);
  });

  it("굵게를 집는다", () => {
    expect(parseInline("이건 **중요**해요")).toEqual([
      { kind: "text", text: "이건 " },
      { kind: "strong", text: "중요" },
      { kind: "text", text: "해요" },
    ]);
  });

  it("내부 링크를 집는다", () => {
    expect(parseInline("[계산해 보기](/tools/penalty)")).toEqual([
      { kind: "link", text: "계산해 보기", href: "/tools/penalty" },
    ]);
  });

  it("**외부 링크는 링크로 만들지 않고 글자로 남긴다** — 지우면 쓴 문장이 사라진다", () => {
    const nodes = parseInline("[네이버](https://naver.com) 참고");

    expect(nodes[0]).toEqual({ kind: "text", text: "[네이버](https://naver.com)" });
    expect(nodes.some((node) => node.kind === "link")).toBe(false);
  });

  it("**프로토콜 상대 경로도 외부다** — `//evil.com` 은 우리 경로가 아니다", () => {
    expect(isInternalHref("//evil.com")).toBe(false);
    expect(isInternalHref("/explore")).toBe(true);
    expect(isInternalHref("javascript:alert(1)")).toBe(false);
  });

  it("빈 글자 노드를 남기지 않는다", () => {
    expect(parseInline("**전부굵게**")).toEqual([{ kind: "strong", text: "전부굵게" }]);
  });
});

describe("블록", () => {
  it("제목·문단·목록·인용을 가른다", () => {
    const blocks = parseMarkdown(
      ["## 계약 전에", "", "먼저 총액을 봅니다.", "", "- 하나", "- 둘", "", "> 참고입니다"].join("\n"),
    );

    expect(blocks.map((block) => block.kind)).toEqual([
      "heading",
      "paragraph",
      "list",
      "quote",
    ]);
  });

  it("이어진 줄은 한 문단이다", () => {
    const blocks = parseMarkdown("앞줄\n뒷줄\n\n다음 문단");

    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ kind: "paragraph" });
  });

  it("번호 목록과 글머리 목록을 섞지 않는다", () => {
    const blocks = parseMarkdown("1. 하나\n2. 둘\n- 셋");

    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ kind: "list", ordered: true });
    expect(blocks[1]).toMatchObject({ kind: "list", ordered: false });
  });

  it("표를 읽는다", () => {
    const blocks = parseMarkdown("| 항목 | 금액 |\n|---|---|\n| 대관료 | 300만 |");

    expect(blocks[0]).toEqual({
      kind: "table",
      head: ["항목", "금액"],
      rows: [["대관료", "300만"]],
    });
  });

  it("**구분선이 없으면 표가 아니다** — 파이프가 든 문장을 표로 오해하지 않는다", () => {
    expect(parseMarkdown("| 이건 표가 아니다")[0].kind).toBe("paragraph");
  });

  it("**h1 을 만들지 않는다** — 한 화면의 h1 은 글 제목 하나다", () => {
    const blocks = parseMarkdown("# 본문 제목");

    expect(blocks[0]).toMatchObject({ kind: "heading", level: 2 });
  });

  it("빈 본문은 빈 배열이다", () => {
    expect(parseMarkdown(null)).toEqual([]);
    expect(parseMarkdown("")).toEqual([]);
    expect(parseMarkdown("\n\n  \n")).toEqual([]);
  });

  it("CRLF 를 그대로 읽는다 (Windows 에서 쓴 글)", () => {
    expect(parseMarkdown("## 제목\r\n\r\n본문")).toHaveLength(2);
  });
});

describe("**태그를 실행 가능한 무엇으로도 바꾸지 않는다**", () => {
  it("script 는 글자로 남는다", () => {
    const blocks = parseMarkdown("<script>alert(1)</script>");

    // 화면은 이 구조를 React 요소로 그린다 — 문자열 HTML 이 아니므로 실행될 수 없다.
    expect(blocks[0]).toEqual({
      kind: "paragraph",
      nodes: [{ kind: "text", text: "<script>alert(1)</script>" }],
    });
  });

  it("링크 자리에 스크립트를 넣어도 링크가 되지 않는다", () => {
    const nodes = parseInline("[누르기](javascript:alert(1))");

    expect(nodes.every((node) => node.kind !== "link")).toBe(true);
  });

  it("이미지 문법은 링크가 아니라 글자다", () => {
    const blocks = parseMarkdown("![대체글](https://evil.com/x.png)");

    expect(blocks[0]).toMatchObject({ kind: "paragraph" });
    expect(JSON.stringify(blocks)).not.toContain('"link"');
  });
});

describe("앵커·목차", () => {
  it("한글을 그대로 둔다", () => {
    expect(anchorOf("계약 전에 볼 것")).toBe("계약-전에-볼-것");
  });

  it("기호를 걷고 빈 값이면 기본 이름을 준다", () => {
    expect(anchorOf("!!!")).toBe("section");
    expect(anchorOf("  총액(VAT 포함)  ")).toBe("총액vat-포함");
  });

  it("**같은 제목이 겹치면 뒤엣것에 번호가 붙는다** — 목차 링크가 겹치면 안 된다", () => {
    const blocks = parseMarkdown("## 정리\n\n가\n\n## 정리\n\n나");
    const anchors = tableOfContents(blocks).map((entry) => entry.anchor);

    expect(anchors).toEqual(["정리", "정리-2"]);
    expect(new Set(anchors).size).toBe(anchors.length);
  });

  it("**제목이 하나뿐이면 목차를 만들지 않는다** — 항목 하나짜리 목차는 장식이다", () => {
    expect(tableOfContents(parseMarkdown("## 하나\n\n본문"))).toEqual([]);
    expect(TOC_MIN_HEADINGS).toBe(2);
  });

  it("깊이를 함께 준다", () => {
    const toc = tableOfContents(parseMarkdown("## 큰\n\n가\n\n### 작은\n\n나"));

    expect(toc.map((entry) => entry.level)).toEqual([2, 3]);
  });
});

describe("요약", () => {
  it("첫 문단만 쓴다", () => {
    expect(excerpt(parseMarkdown("## 제목\n\n첫 문단입니다.\n\n둘째 문단"))).toBe("첫 문단입니다.");
  });

  it("**잘리면 잘렸다는 사실을 보인다**", () => {
    const long = "가".repeat(200);
    const result = excerpt(parseMarkdown(long), 20);

    expect(result).toHaveLength(20);
    expect(result?.endsWith("…")).toBe(true);
  });

  it("문단이 없으면 null 이다 — 지어내지 않는다", () => {
    expect(excerpt(parseMarkdown("## 제목만"))).toBeNull();
    expect(excerpt([])).toBeNull();
  });

  it("굵게·링크의 글자는 요약에 그대로 들어간다", () => {
    expect(excerpt(parseMarkdown("**총액**을 [봅니다](/explore)"))).toBe("총액을 봅니다");
  });
});
